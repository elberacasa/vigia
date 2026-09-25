import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ACCEPT_ENCODING, BodyError, NO_AUTO_DECOMPRESS, readBody } from "../core/body.ts";
import { decodeText, USER_AGENT } from "../core/http.ts";
import { HttpError, type RawResponse } from "../core/types.ts";

/**
 * The network path for feeds a user adds by hand. A user-typed URL is untrusted input that makes this server open a
 * connection, so every hop is checked (SSRF):
 *
 * - only http: and https:, no user:password@, default ports (80, 443) or 8080/8443, a dotted public host name or a
 *   public IP literal; intranet suffixes (.local, .internal, .lan, .home.arpa, .localhost, .onion) are refused;
 * - the host is resolved here and EVERY address it resolves to must be public unicast (no loopback, private,
 *   link-local, CGNAT, multicast, documentation, benchmarking, NAT64/6to4/Teredo, IPv4-mapped private…);
 * - the connection goes to the checked address itself (the URL's host becomes the Host header and the TLS server
 *   name, so the certificate is still verified against the name), so a DNS answer that changes between the check
 *   and the connection (rebinding) cannot redirect it;
 * - redirects are never followed automatically: each Location is checked the same way, at most 3 hops;
 * - a 2 MB byte cap, a 15 s timeout, and a minimum gap between two requests to the same host.
 */

export const MAX_FEED_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
/** The whole call (pacing, every hop, the body) never takes longer than this. */
const TOTAL_MS = 30_000;
const MAX_REDIRECTS = 3;
const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);
const BLOCKED_SUFFIXES = [
	".local",
	".localhost",
	".internal",
	".intranet",
	".lan",
	".home.arpa",
	".onion",
	".corp",
];

/* ---------- Addresses ---------- */

function ipv4Parts(ip: string): number[] | null {
	const parts = ip.split(".");
	if (parts.length !== 4) return null;
	const out: number[] = [];
	for (const p of parts) {
		if (!/^\d{1,3}$/.test(p)) return null;
		const n = Number(p);
		if (n > 255) return null;
		out.push(n);
	}
	return out;
}

function publicV4(ip: string): boolean {
	const p = ipv4Parts(ip);
	if (!p) return false;
	const [a = 0, b = 0, c = 0] = p;
	if (a === 0 || a === 10 || a === 127) return false; // "this network", private, loopback
	if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
	if (a === 169 && b === 254) return false; // link-local (cloud metadata lives here)
	if (a === 172 && b >= 16 && b <= 31) return false; // private
	if (a === 192 && b === 168) return false; // private
	if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF assignments, TEST-NET-1
	if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay anycast
	if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
	if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
	if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
	if (a >= 224) return false; // multicast, reserved, broadcast
	return true;
}

/** Expands an IPv6 address (with an optional embedded IPv4 tail) to 8 hextets, or null. */
export function ipv6Hextets(ip: string): number[] | null {
	let s = ip.toLowerCase();
	const zone = s.indexOf("%");
	if (zone !== -1) s = s.slice(0, zone);
	let tail: number[] = [];
	const lastColon = s.lastIndexOf(":");
	if (s.slice(lastColon + 1).includes(".")) {
		const v4 = ipv4Parts(s.slice(lastColon + 1));
		if (!v4) return null;
		tail = [((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0)];
		s = `${s.slice(0, lastColon + 1)}0:0`;
	}
	const halves = s.split("::");
	if (halves.length > 2) return null;
	const parse = (part: string) => (part === "" ? [] : part.split(":"));
	const head = parse(halves[0] ?? "");
	const rest = halves.length === 2 ? parse(halves[1] ?? "") : [];
	const missing = 8 - head.length - rest.length;
	if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
	const words = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
	const out: number[] = [];
	for (const w of words) {
		if (!/^[0-9a-f]{1,4}$/.test(w)) return null;
		out.push(Number.parseInt(w, 16));
	}
	if (tail.length) {
		out[6] = tail[0] ?? 0;
		out[7] = tail[1] ?? 0;
	}
	return out.length === 8 ? out : null;
}

function publicV6(ip: string): boolean {
	const h = ipv6Hextets(ip);
	if (!h) return false;
	const [h0 = 0, h1 = 0, h2 = 0, h3 = 0, h4 = 0, h5 = 0, h6 = 0, h7 = 0] = h;
	// IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the IPv4 inside.
	if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && (h5 === 0xffff || h5 === 0)) {
		if (h5 === 0 && h6 === 0) return false; // ::, ::1 and the rest of ::/96
		return publicV4(`${h6 >> 8}.${h6 & 255}.${h7 >> 8}.${h7 & 255}`);
	}
	// Only global unicast 2000::/3 is public; everything else (ULA fc00::/7, link-local fe80::/10, multicast
	// ff00::/8, discard 100::/64, NAT64 64:ff9b::/96…) is refused.
	if ((h0 & 0xe000) !== 0x2000) return false;
	if (h0 === 0x2001 && h1 < 0x200) return false; // 2001::/23 IETF protocol assignments (Teredo 2001::/32 …)
	if (h0 === 0x2001 && h1 === 0x0db8) return false; // documentation
	if (h0 === 0x2002) return false; // 6to4: would tunnel to an arbitrary IPv4
	if (h0 === 0x3fff && h1 < 0x1000) return false; // documentation 3fff::/20
	return true;
}

/** Whether an IP address (v4 or v6, as a string) is public unicast, i.e. safe for this server to connect to. */
export function isPublicAddress(ip: string): boolean {
	const kind = isIP(ip.replace(/%.*$/, ""));
	if (kind === 4) return publicV4(ip);
	if (kind === 6) return publicV6(ip);
	return false;
}

/* ---------- URLs ---------- */

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** Checks a feed URL's shape (no network). The addresses are checked by `resolvePublic` at every hop. */
export function checkFeedUrl(raw: string, base?: URL): UrlCheck {
	if (raw.length > 2_048) return { ok: false, reason: "La dirección es demasiado larga." };
	let url: URL;
	try {
		url = base ? new URL(raw, base) : new URL(raw.trim());
	} catch {
		return { ok: false, reason: "No es una dirección web válida." };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		return { ok: false, reason: "Solo se aceptan direcciones http:// o https://." };
	if (url.username || url.password)
		return { ok: false, reason: "La dirección no puede llevar usuario ni contraseña." };
	if (!ALLOWED_PORTS.has(url.port))
		return { ok: false, reason: "Solo se aceptan los puertos web habituales (80, 443, 8080, 8443)." };
	const host = url.hostname.toLowerCase().replace(/\.$/, "");
	const literal = host.startsWith("[") ? host.slice(1, -1) : host;
	if (isIP(literal)) {
		if (!isPublicAddress(literal))
			return { ok: false, reason: "Esa dirección es de una red privada o local." };
		return { ok: true, url };
	}
	if (!host.includes(".") || BLOCKED_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s)))
		return { ok: false, reason: "Esa dirección es de una red privada o local." };
	// A numeric-looking name that is not a valid IP (0x7f.1, 2130706433) is how filters are bypassed: refuse it.
	if (/^[\d.x]+$/i.test(host)) return { ok: false, reason: "No es una dirección web válida." };
	return { ok: true, url };
}

export type Resolver = (host: string) => Promise<readonly string[]>;

export const systemResolver: Resolver = async (host) =>
	(await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** Resolves a host and returns its first address only when every address it has is public. */
export async function resolvePublic(host: string, resolve: Resolver): Promise<string> {
	const literal = host.startsWith("[") ? host.slice(1, -1) : host;
	if (isIP(literal)) {
		if (!isPublicAddress(literal)) throw new HttpError("dirección privada o local", 0, host);
		return literal;
	}
	let addresses: readonly string[];
	try {
		addresses = await resolve(literal);
	} catch {
		throw new HttpError("no se encontró el sitio (DNS)", 0, host);
	}
	if (!addresses.length) throw new HttpError("no se encontró el sitio (DNS)", 0, host);
	// All or nothing: a name that also points inside the network is refused, whatever address comes first.
	if (!addresses.every(isPublicAddress))
		throw new HttpError("el sitio apunta a una red privada o local", 0, host);
	return addresses[0] as string;
}

/* ---------- Fetching ---------- */

export interface SafeHttpOptions {
	readonly fetchImpl?: typeof fetch;
	readonly resolve?: Resolver;
	readonly now?: () => number;
	/** Minimum gap between two requests to the same host, ms. */
	readonly hostGapMs?: number;
	readonly maxBytes?: number;
}

/**
 * The fetcher for user feeds. One GET per call, no retries (the scheduler's breaker backs off a failing feed),
 * redirects checked hop by hop, connection pinned to the checked address.
 */
export class SafeHttp {
	readonly #fetch: typeof fetch;
	readonly #resolve: Resolver;
	readonly #now: () => number;
	readonly #gap: number;
	readonly #maxBytes: number;
	readonly #nextAt = new Map<string, number>();

	constructor(options: SafeHttpOptions = {}) {
		this.#fetch = options.fetchImpl ?? fetch;
		this.#resolve = options.resolve ?? systemResolver;
		this.#now = options.now ?? Date.now;
		this.#gap = options.hostGapMs ?? 5_000;
		this.#maxBytes = options.maxBytes ?? MAX_FEED_BYTES;
	}

	async get(raw: string, signal?: AbortSignal): Promise<RawResponse> {
		const deadline = AbortSignal.timeout(TOTAL_MS);
		const outer = signal ? AbortSignal.any([deadline, signal]) : deadline;
		let check = checkFeedUrl(raw);
		for (let hop = 0; ; hop++) {
			if (!check.ok) throw new HttpError(check.reason, 0, raw);
			const url = check.url;
			await this.#pace(url.hostname, outer);
			const address = await resolvePublic(url.hostname, this.#resolve);
			const target = new URL(url);
			target.hostname = address.includes(":") ? `[${address}]` : address;
			const init: RequestInit & { tls?: { serverName: string }; decompress?: boolean } = {
				method: "GET",
				redirect: "manual",
				// No pooled connection: the pool is keyed by the IP now in the URL, and two feeds on one CDN address
				// must not share a connection negotiated for the other name.
				keepalive: false,
				// Bun's own decoding is unbounded (a 64 KB zstd body became 4 GB); decoded here under the cap instead.
				...NO_AUTO_DECOMPRESS,
				signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), outer]),
				headers: {
					host: url.host,
					"user-agent": USER_AGENT,
					accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5",
					"accept-language": "es-VE,es;q=0.9,en;q=0.5",
					"accept-encoding": ACCEPT_ENCODING,
				},
			};
			if (url.protocol === "https:") init.tls = { serverName: url.hostname };
			let response: Response;
			try {
				response = await this.#fetch(target.toString(), init);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				throw new HttpError(`sin respuesta: ${reason.slice(0, 160)}`, 0, url.toString());
			}
			if (response.status >= 300 && response.status < 400) {
				await response.body?.cancel();
				const location = response.headers.get("location");
				if (!location)
					throw new HttpError(`redirección ${response.status} sin destino`, response.status, raw);
				if (hop >= MAX_REDIRECTS) throw new HttpError("demasiadas redirecciones", response.status, raw);
				check = checkFeedUrl(location, url);
				continue;
			}
			if (response.status !== 200) {
				await response.body?.cancel();
				throw new HttpError(`respuesta ${response.status}`, response.status, url.toString());
			}
			const bytes = await readCapped(response, this.#maxBytes, url.toString());
			return {
				url: url.toString(),
				status: response.status,
				contentType: response.headers.get("content-type") ?? "",
				body: decodeText(bytes, response),
				fetchedAt: this.#now(),
			};
		}
	}

	async #pace(host: string, signal?: AbortSignal): Promise<void> {
		const now = this.#now();
		const at = Math.max(now, this.#nextAt.get(host) ?? 0);
		this.#nextAt.set(host, at + this.#gap);
		if (this.#nextAt.size > 500) {
			for (const [h, t] of this.#nextAt) if (t < now) this.#nextAt.delete(h);
		}
		const wait = at - now;
		if (wait > 0) {
			await new Promise<void>((resolve, reject) => {
				const abort = () => {
					clearTimeout(timer);
					reject(new HttpError("cancelado o sin tiempo", 0, host));
				};
				const timer = setTimeout(() => {
					signal?.removeEventListener("abort", abort);
					resolve();
				}, wait);
				signal?.addEventListener("abort", abort, { once: true });
			});
		}
	}
}

async function readCapped(response: Response, maxBytes: number, url: string): Promise<Uint8Array> {
	try {
		return await readBody(response, { maxBytes });
	} catch (error) {
		if (!(error instanceof BodyError)) throw error;
		const message =
			error.kind === "too-large"
				? `el feed pesa más de ${Math.round(maxBytes / 1_048_576)} MB`
				: error.kind === "corrupt"
					? "el feed llegó comprimido y dañado"
					: `compresión no admitida (${response.headers.get("content-encoding")?.slice(0, 40) ?? ""})`;
		throw new HttpError(message, 0, url);
	}
}
