import { isIP } from "node:net";
import { z } from "zod";
import { ipv6Hextets } from "../userfeeds/net.ts";

/**
 * How this Vigía is deployed, from flags and environment variables, validated once at start with clear Spanish
 * errors. Flags win over the environment.
 *
 * - `local` (default): one person's machine. Reads are open to this machine (and the LAN with `--host 0.0.0.0`);
 *   writes need loopback, same origin and the session cookie from the terminal's link.
 * - `public`: a read-only mirror an institution hosts for everyone. Every write is refused regardless of cookie,
 *   the terminal link's token is never exchanged, any Host is served (behind a reverse proxy), and CORS is open for
 *   the read API.
 */

export const Mode = z.enum(["local", "public"]);
export type Mode = z.infer<typeof Mode>;

export interface DeployConfig {
	readonly mode: Mode;
	readonly port: number;
	readonly host: string;
	/** `access-control-allow-origin: *` on /api/v1 (GET, HEAD, OPTIONS only; never credentials). */
	readonly cors: boolean;
	/** Who may read /metrics: nobody, this machine only (loopback peer and loopback Host), or anyone. */
	readonly metrics: "off" | "loopback" | "open";
	/** Log lines as plain text or one JSON object per line. */
	readonly logFormat: "text" | "json";
	/**
	 * Behind a reverse proxy: the proxies whose X-Forwarded-For is believed ("loopback", IPv4 addresses or CIDR ranges,
	 * IPv6 addresses), so rate limits are per visitor and not one bucket for everyone. Empty: nobody's.
	 */
	readonly trustProxy: readonly string[];
	readonly noFetch: boolean;
	readonly noOpen: boolean;
	/**
	 * The second route to the BCV rate, the maintainer's public bcv-api service (the project's decision, 2026-09-25:
	 * on by default on every deployment, public mirrors included; a read-only GET of a public endpoint that sends no
	 * user data). `VIGIA_BCV_API=0` turns it off here whatever config.json says.
	 */
	readonly bcvApi: boolean;
	/**
	 * Crowd reports ("¿tienes luz, agua, internet, gasolina?", src/crowd): on by default in both modes; `--no-crowd` or
	 * `VIGIA_CROWD=0` turns them off on this instance (nothing is taken; what was published stays in the archive).
	 */
	readonly crowd: boolean;
	/**
	 * "Conexión limitada" forced from the command line or environment (`--data-saver`, `VIGIA_DATA_SAVER=1|0`): heavy
	 * feeds off (src/core/bandwidth.ts). Undefined: the user's setting decides (off until they choose). A public mirror
	 * leaves it off unless its operator sets it: the bandwidth is the operator's, not the visitors'.
	 */
	readonly dataSaver: boolean | undefined;
}

export class ConfigError extends Error {
	override readonly name = "ConfigError";
}

type Env = Readonly<Record<string, string | undefined>>;

const TRUE = /^(1|true|si|sí|yes|on)$/i;
const FALSE = /^(0|false|no|off)$/i;

function bool(name: string, raw: string | undefined): boolean | undefined {
	if (raw === undefined || raw === "") return undefined;
	if (TRUE.test(raw)) return true;
	if (FALSE.test(raw)) return false;
	throw new ConfigError(`${name} debe ser 1 o 0 (recibido: «${raw}»).`);
}

function flagValue(args: readonly string[], name: string): string | undefined {
	const i = args.indexOf(name);
	if (i === -1) return undefined;
	const value = args[i + 1];
	if (value === undefined || value.startsWith("--")) throw new ConfigError(`Falta el valor de ${name}.`);
	return value;
}

function oneOf<T extends string>(name: string, raw: string, allowed: readonly T[]): T {
	if ((allowed as readonly string[]).includes(raw)) return raw as T;
	throw new ConfigError(`${name} debe ser ${allowed.map((a) => `«${a}»`).join(" o ")} (recibido: «${raw}»).`);
}

/** Reads and validates the deployment configuration. Throws ConfigError with a message meant for the terminal. */
const VALUE_FLAGS = ["--port", "--host", "--mode", "--metrics", "--log"] as const;
// "--dev" is passed by `bun run dev` (the watch mode lives in Bun itself).
const BOOLEAN_FLAGS = [
	"--public",
	"--cors",
	"--trust-proxy",
	"--no-fetch",
	"--no-open",
	"--no-crowd",
	"--data-saver",
	"--dev",
] as const;

/**
 * Options the server does not know, so a typo (`--prot 8080`) stops with a message instead of silently starting
 * with the defaults. Values of the value flags are skipped.
 */
export function unknownOptions(args: readonly string[]): string[] {
	const unknown: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i] ?? "";
		if ((VALUE_FLAGS as readonly string[]).includes(a)) i++;
		else if (!(BOOLEAN_FLAGS as readonly string[]).includes(a)) unknown.push(a);
	}
	return unknown;
}

export function loadConfig(args: readonly string[], env: Env = process.env): DeployConfig {
	const modeRaw = args.includes("--public")
		? "public"
		: (flagValue(args, "--mode") ?? env.VIGIA_MODE ?? "local");
	const mode = oneOf("El modo (--mode o VIGIA_MODE)", modeRaw, Mode.options);

	const portRaw = flagValue(args, "--port") ?? env.VIGIA_PORT ?? "7722";
	const port = Number(portRaw);
	if (!/^\d+$/.test(portRaw) || !Number.isInteger(port) || port < 1 || port > 65_535)
		throw new ConfigError(`Puerto no válido: «${portRaw}». Usa un número entre 1 y 65535.`);

	const host = flagValue(args, "--host") ?? env.VIGIA_HOST ?? "127.0.0.1";
	if (!/^[\w.:[\]-]{1,255}$/.test(host)) throw new ConfigError(`Dirección no válida: «${host}».`);

	const cors = args.includes("--cors") ? true : (bool("VIGIA_CORS", env.VIGIA_CORS) ?? mode === "public");

	const metricsRaw = flagValue(args, "--metrics") ?? env.VIGIA_METRICS ?? "loopback";
	const metrics = oneOf("El acceso a las métricas (--metrics o VIGIA_METRICS)", metricsRaw, [
		"off",
		"loopback",
		"open",
	] as const);

	const logRaw = flagValue(args, "--log") ?? env.VIGIA_LOG_FORMAT ?? "text";
	const logFormat = oneOf("El formato de registro (--log o VIGIA_LOG_FORMAT)", logRaw, [
		"text",
		"json",
	] as const);

	const trustProxy = args.includes("--trust-proxy") ? ["loopback"] : proxies(env.VIGIA_TRUST_PROXY);
	const noFetch = args.includes("--no-fetch") || (bool("VIGIA_NO_FETCH", env.VIGIA_NO_FETCH) ?? false);
	// A public mirror is a server: it never opens a browser.
	const noOpen =
		mode === "public" || args.includes("--no-open") || (bool("VIGIA_NO_OPEN", env.VIGIA_NO_OPEN) ?? false);

	const bcvApi = bool("VIGIA_BCV_API", env.VIGIA_BCV_API) ?? true;
	const crowd = args.includes("--no-crowd") ? false : (bool("VIGIA_CROWD", env.VIGIA_CROWD) ?? true);

	const dataSaver = args.includes("--data-saver") ? true : bool("VIGIA_DATA_SAVER", env.VIGIA_DATA_SAVER);

	return {
		mode,
		port,
		host,
		cors,
		metrics,
		logFormat,
		trustProxy,
		noFetch,
		noOpen,
		bcvApi,
		crowd,
		dataSaver,
	};
}

/** Feeds a deployment setting turns off whatever the user's settings say (today only `VIGIA_BCV_API=0`). */
export function deployDisables(
	adapterId: string,
	deploy: { readonly bcvApi?: boolean } | undefined,
): boolean {
	return adapterId === "bcv-api" && deploy?.bcvApi === false;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4(text: string): number | null {
	const m = IPV4.exec(text);
	if (!m) return null;
	const parts = m.slice(1).map(Number);
	if (parts.some((p) => p > 255)) return null;
	return (((parts[0] ?? 0) << 24) | ((parts[1] ?? 0) << 16) | ((parts[2] ?? 0) << 8) | (parts[3] ?? 0)) >>> 0;
}

/** VIGIA_TRUST_PROXY: "1" (a proxy on this machine), or a comma list of addresses and IPv4 CIDR ranges. */
function proxies(raw: string | undefined): string[] {
	if (raw === undefined || raw.trim() === "" || FALSE.test(raw.trim())) return [];
	if (TRUE.test(raw.trim())) return ["loopback"];
	const list = raw
		.split(",")
		.map((p) => p.trim())
		.filter(Boolean);
	for (const p of list) {
		const [addr = "", bits] = p.split("/");
		const okV4 =
			ipv4(addr) !== null && (bits === undefined || (/^\d{1,2}$/.test(bits) && Number(bits) <= 32));
		const okV6 = isIP(addr) === 6 && (bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= 128));
		if (p !== "loopback" && !okV4 && !okV6)
			throw new ConfigError(
				`VIGIA_TRUST_PROXY: «${p}» no es una dirección ni un rango (ejemplos: 1, 172.16.0.0/12, 10.0.0.2).`,
			);
	}
	return list;
}

const isLoopbackIp = (ip: string) => ip === "::1" || ip.startsWith("127.");

/** Whether `peer` is one of the trusted proxies. */
export function trusted(peer: string, proxies: readonly string[]): boolean {
	const ip = peer.startsWith("::ffff:") ? peer.slice(7) : peer;
	for (const p of proxies) {
		if (p === "loopback") {
			if (isLoopbackIp(ip)) return true;
			continue;
		}
		const [addr = "", bits] = p.split("/");
		const want = ipv4(addr);
		const have = ipv4(ip);
		if (want !== null && have !== null) {
			const n = bits === undefined ? 32 : Number(bits);
			const mask = n === 0 ? 0 : (0xffffffff << (32 - n)) >>> 0;
			if ((want & mask) === (have & mask)) return true;
		} else if (
			want === null &&
			have === null &&
			sameV6Prefix(addr, ip, bits === undefined ? 128 : Number(bits))
		)
			return true;
	}
	return false;
}

/** Whether two IPv6 addresses share their first `bits` bits. */
function sameV6Prefix(a: string, b: string, bits: number): boolean {
	const x = ipv6Hextets(a);
	const y = ipv6Hextets(b);
	if (!x || !y || !Number.isInteger(bits) || bits < 0 || bits > 128) return false;
	for (let i = 0; i < 8; i++) {
		const take = Math.max(0, Math.min(16, bits - i * 16));
		if (take === 0) break;
		const mask = (0xffff << (16 - take)) & 0xffff;
		if (((x[i] ?? 0) & mask) !== ((y[i] ?? 0) & mask)) return false;
	}
	return true;
}

/**
 * The address rate limits and write checks see. Only a trusted proxy is believed about who the client is: the
 * X-Forwarded-For entries are read from the right (the ones trusted proxies appended), skipping every trusted proxy
 * (a CDN in front of nginx, both declared), and the first address that is not one is the client. Entries to its
 * left are whatever the client sent. A malformed entry stops the walk at the peer. If every entry is a trusted
 * proxy, the last one examined is returned (the crowd guard refuses that: the client is unknown).
 */
export function clientAddress(peer: string, forwardedFor: string | null, proxies: readonly string[]): string {
	if (proxies.length === 0 || !forwardedFor || !trusted(peer, proxies)) return peer;
	let current = peer;
	for (const raw of forwardedFor.split(",").reverse()) {
		const hop = raw.trim();
		if (!/^[\da-fA-F:.]{2,45}$/.test(hop) || isIP(hop) === 0) return peer;
		current = hop;
		if (!trusted(hop, proxies)) return hop;
	}
	return current;
}
