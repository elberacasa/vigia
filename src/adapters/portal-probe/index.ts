import { lookup } from "node:dns/promises";
import { connect } from "node:tls";
import { z } from "zod";
import type { Adapter, FetchContext, Licence, Observation, RawResponse } from "../../core/types.ts";
import { HttpError, SchemaError } from "../../core/types.ts";
import { BCV_CHAIN_PEM } from "../bcv-official/tls.ts";

/**
 * Are Venezuela's public-service portals reachable FROM THIS COMPUTER? Every 15 minutes, for a small fixed list
 * of institutional home pages, Vigía does what one visitor's browser does: resolve the name with the system
 * resolver, open one TLS connection to read the certificate's expiry, and GET the home page (redirects followed).
 * No other path, no scanning, no ports beyond 443/80.
 *
 * Vantage point matters: many .gob.ve sites refuse or ignore foreign IPs (CNE's DNS returns no address to
 * resolvers outside Venezuela; SENIAT, IVSS, TSJ reset TLS from abroad; verified 2026-09-24 from outside
 * Venezuela). So "no responde desde aquí" is NOT "caído", and the UI says where the probe ran from.
 *
 * Opt-in: the probe runs from the user's own connection and identifies as Vigía, so the sites' operators see the
 * user's IP polling them. Off until the user turns it on (the reason is shown in the guide).
 *
 * One synthetic raw response per site (`application/vnd.vigia.probe+json`): the probe's own record, replayed by
 * tests like any recorded fixture. Licence: our own measurement (CC0).
 */

export const PROBE_LICENCE: Licence = {
	id: "vigia-probe-cc0",
	name: "Medición propia de Vigía (CC0)",
	url: "https://creativecommons.org/publicdomain/zero/1.0/",
	attribution: "Medición: Vigía, desde este equipo",
	commercial: true,
};

export type Portal = {
	readonly id: string;
	readonly name: string;
	/** Who runs it, in plain words. */
	readonly what: string;
	readonly url: string;
	/** Extra CA for sites with a broken chain (the BCV's, shipped and pinned in bcv-official). */
	readonly ca?: string;
};

export const PORTALS: readonly Portal[] = [
	{ id: "bcv", name: "BCV", what: "Banco Central", url: "https://www.bcv.org.ve/", ca: BCV_CHAIN_PEM },
	{ id: "cne", name: "CNE", what: "Consejo Nacional Electoral", url: "https://www.cne.gob.ve/" },
	{ id: "seniat", name: "SENIAT", what: "Impuestos", url: "https://www.seniat.gob.ve/" },
	{ id: "saime", name: "SAIME", what: "Identificación y pasaportes", url: "https://www.saime.gob.ve/" },
	{ id: "patria", name: "Patria", what: "Plataforma Patria (bonos)", url: "https://www.patria.org.ve/" },
	{ id: "ivss", name: "IVSS", what: "Seguro Social", url: "https://www.ivss.gob.ve/" },
	{ id: "corpoelec", name: "Corpoelec", what: "Electricidad", url: "https://www.corpoelec.gob.ve/" },
	{ id: "cantv", name: "CANTV", what: "Telefonía e internet (estatal)", url: "https://www.cantv.com.ve/" },
	{
		id: "movilnet",
		name: "Movilnet",
		what: "Telefonía móvil (estatal)",
		url: "https://www.movilnet.com.ve/",
	},
	{
		id: "conatel",
		name: "Conatel",
		what: "Regulador de telecomunicaciones",
		url: "https://www.conatel.gob.ve/",
	},
	{ id: "tsj", name: "TSJ", what: "Tribunal Supremo", url: "https://www.tsj.gob.ve/" },
	{ id: "an", name: "Asamblea Nacional", what: "Parlamento", url: "https://www.asambleanacional.gob.ve/" },
	{ id: "ine", name: "INE", what: "Estadísticas", url: "https://www.ine.gob.ve/" },
];

const TIMEOUT_MS = 15_000;
/** Enough for any real home page; a larger body still counts as an answer ("odd-response"). */
const MAX_BYTES = 6 * 1024 * 1024;

export type ProbeRecord = {
	readonly portal: string;
	readonly host: string;
	readonly at: number;
	readonly dns: { readonly addresses: string[]; readonly error: string | null; readonly ms: number };
	readonly http: {
		readonly status: number | null;
		readonly finalUrl: string | null;
		readonly ms: number;
		readonly error: string | null;
	};
	readonly tls: {
		readonly validTo: number | null;
		readonly authorized: boolean | null;
		readonly error: string | null;
	} | null;
};

/** What the probe needs from the network, injectable for tests. */
export interface Prober {
	resolve(host: string): Promise<string[]>;
	certificate(
		host: string,
		timeoutMs: number,
	): Promise<{ validTo: number | null; authorized: boolean; error: string | null }>;
	now(): number;
	elapsed(): number;
}

export const nodeProber: Prober = {
	async resolve(host) {
		const all = await lookup(host, { all: true });
		return all.map((a) => a.address);
	},
	certificate(host, timeoutMs) {
		return new Promise((resolve, reject) => {
			// Reading the certificate is the point, so an invalid chain must not abort the handshake; nothing is sent.
			const socket = connect({ host, port: 443, servername: host, rejectUnauthorized: false });
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new Error("timeout"));
			}, timeoutMs);
			socket.once("secureConnect", () => {
				clearTimeout(timer);
				const cert = socket.getPeerCertificate();
				const validTo = cert?.valid_to ? Date.parse(cert.valid_to) : Number.NaN;
				const error = socket.authorizationError ? String(socket.authorizationError) : null;
				resolve({ validTo: Number.isFinite(validTo) ? validTo : null, authorized: socket.authorized, error });
				socket.end();
			});
			socket.once("error", (e) => {
				clearTimeout(timer);
				reject(e);
			});
		});
	},
	now: Date.now,
	elapsed: () => performance.now(),
};

/** A short, stable reason for a network failure (never the raw message, which can carry local details). */
export function reason(error: unknown): string {
	const text = `${(error as { code?: string })?.code ?? ""} ${error instanceof Error ? error.message : String(error)}`;
	if (/ENOTFOUND|EAI_AGAIN|ENODATA|ESERVFAIL|getaddrinfo|DNS/i.test(text)) return "dns";
	if (/timed? ?out|timeout|ETIMEDOUT|abort/i.test(text)) return "timeout";
	if (/ECONNREFUSED|refused/i.test(text)) return "refused";
	if (/ECONNRESET|reset|socket hang up|closed/i.test(text)) return "reset";
	if (/certificate|CERT|SSL|TLS|self.signed|UNABLE_TO/i.test(text)) return "tls";
	if (/unreachable|EHOSTUNREACH|ENETUNREACH/i.test(text)) return "unreachable";
	if (/exceeded|too large/i.test(text)) return "too-large";
	// The server answered, but with HTTP our client will not parse (CANTV's home page, 2026-09-24).
	if (/UnsupportedTransferEncoding|Malformed|InvalidHTTP|Invalid HTTP|parse/i.test(text))
		return "bad-response";
	return "other";
}

const ALL_STATUSES = Array.from({ length: 500 }, (_, i) => i + 100);

export async function probe(portal: Portal, ctx: FetchContext, prober: Prober): Promise<ProbeRecord> {
	const host = new URL(portal.url).hostname;
	const at = prober.now();
	let t0 = prober.elapsed();
	let dns: ProbeRecord["dns"];
	try {
		const addresses = [...new Set(await prober.resolve(host))].sort();
		dns = { addresses, error: null, ms: Math.round(prober.elapsed() - t0) };
	} catch (e) {
		dns = { addresses: [], error: reason(e), ms: Math.round(prober.elapsed() - t0) };
	}
	let tls: ProbeRecord["tls"] = null;
	if (portal.url.startsWith("https:") && dns.error === null) {
		try {
			const c = await prober.certificate(host, TIMEOUT_MS);
			tls = { validTo: c.validTo, authorized: c.authorized, error: c.error };
		} catch (e) {
			tls = { validTo: null, authorized: null, error: reason(e) };
		}
	}
	t0 = prober.elapsed();
	let http: ProbeRecord["http"];
	if (dns.error !== null) {
		http = { status: null, finalUrl: null, ms: 0, error: "dns" };
	} else {
		try {
			const res = await ctx.http.request(portal.url, {
				headers: { accept: "text/html" },
				retries: 0,
				timeoutMs: TIMEOUT_MS,
				maxBytes: MAX_BYTES,
				okStatuses: ALL_STATUSES,
				hostGapMs: 1_000,
				signal: ctx.signal,
				...(portal.ca ? { ca: portal.ca } : {}),
			});
			http = { status: res.status, finalUrl: res.url, ms: Math.round(prober.elapsed() - t0), error: null };
		} catch (e) {
			const why = e instanceof HttpError && e.status > 0 ? `http-${e.status}` : reason(e);
			http = { status: null, finalUrl: null, ms: Math.round(prober.elapsed() - t0), error: why };
		}
	}
	return { portal: portal.id, host, at, dns, http, tls };
}

export type PortalState = "ok" | "odd-response" | "refuses" | "server-error" | "no-answer" | "no-dns";

export type PortalReading = {
	readonly portal: string;
	readonly host: string;
	readonly state: PortalState;
	readonly httpStatus: number | null;
	/** Host the home page redirected to, when different. */
	readonly redirectHost: string | null;
	readonly latencyMs: number | null;
	readonly error: string | null;
	readonly addresses: string[];
	readonly tlsValidTo: number | null;
	readonly tlsAuthorized: boolean | null;
	readonly tlsError: string | null;
};

export function stateOf(r: ProbeRecord): PortalState {
	if (r.dns.error !== null) return "no-dns";
	const s = r.http.status;
	if (s === null)
		return r.http.error === "bad-response" || r.http.error === "too-large" ? "odd-response" : "no-answer";
	if (s >= 500) return "server-error";
	if (s >= 400) return "refuses";
	return "ok";
}

const Record_ = z.object({
	portal: z.string(),
	host: z.string(),
	at: z.number(),
	dns: z.object({ addresses: z.array(z.string()), error: z.string().nullable(), ms: z.number() }),
	http: z.object({
		status: z.number().int().nullable(),
		finalUrl: z.string().nullable(),
		ms: z.number(),
		error: z.string().nullable(),
	}),
	tls: z
		.object({
			validTo: z.number().nullable(),
			authorized: z.boolean().nullable(),
			error: z.string().nullable(),
		})
		.nullable(),
});

export function makePortalProbe(prober: Prober): Adapter<PortalReading> {
	return {
		id: "portal-probe",
		layer: "internet",
		name: {
			es: "Portales públicos, medidos desde este equipo",
			en: "Public portals, measured from this computer",
		},
		provider: "Vigía (medición propia)",
		homepage: "https://www.bcv.org.ve/",
		licence: PROBE_LICENCE,
		keys: [],
		intervalMs: 15 * 60_000,
		freshness: { fetchMs: 45 * 60_000, dataMs: 45 * 60_000 },
		optIn: {
			es:
				"Tu equipo visitará cada 15 minutos la página de inicio de 13 portales públicos (BCV, CNE, SENIAT, SAIME, " +
				"Patria, CANTV…) identificándose como Vigía: sus operadores verán tu dirección IP. Solo la portada, sin " +
				"escaneos. Si estás en Venezuela y eso te expone, déjala apagada.",
			en:
				"Every 15 minutes your computer will visit the home page of 13 public portals (BCV, CNE, SENIAT, SAIME, " +
				"Patria, CANTV…) identifying as Vigía: their operators will see your IP address. Home pages only, no " +
				"scanning. If you are in Venezuela and that exposes you, leave it off.",
		},

		async fetch(ctx) {
			const out: RawResponse[] = [];
			for (const portal of PORTALS) {
				const record = await probe(portal, ctx, prober);
				out.push({
					url: portal.url,
					status: 200,
					contentType: "application/vnd.vigia.probe+json",
					body: JSON.stringify(record),
					fetchedAt: prober.now(),
				});
			}
			return out;
		},

		normalise(raws) {
			const out: Observation<PortalReading>[] = [];
			for (const raw of raws) {
				let json: unknown;
				try {
					json = JSON.parse(raw.body);
				} catch {
					continue;
				}
				const p = Record_.safeParse(json);
				if (!p.success) continue;
				const r = p.data;
				const portal = PORTALS.find((x) => x.id === r.portal);
				if (!portal) continue;
				let redirectHost: string | null = null;
				try {
					const h = r.http.finalUrl ? new URL(r.http.finalUrl).hostname : null;
					redirectHost = h && h !== r.host ? h : null;
				} catch {
					redirectHost = null;
				}
				const state = stateOf(r);
				out.push({
					source: "portal-probe",
					series: `portal:${portal.id}`,
					sourceUrl: portal.url,
					fetchedAt: raw.fetchedAt,
					observedAt: Math.min(r.at, raw.fetchedAt),
					licence: PROBE_LICENCE.id,
					value: {
						portal: portal.id,
						host: r.host,
						state,
						httpStatus: r.http.status,
						redirectHost,
						latencyMs: r.http.status !== null ? r.http.ms : null,
						error: r.http.error ?? r.dns.error,
						addresses: r.dns.addresses.slice(0, 8),
						tlsValidTo: r.tls?.validTo ?? null,
						tlsAuthorized: r.tls?.authorized ?? null,
						tlsError: r.tls?.error ?? null,
					},
					confidence: 1,
					basis: "measurement",
				});
			}
			if (raws.length > 0 && out.length === 0)
				throw new SchemaError("Sondeo de portales: ningún registro válido");
			return out;
		},
	};
}

export const portalProbe = makePortalProbe(nodeProber);
