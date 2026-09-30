/**
 * The crowd-report routes and their write guard (SECURITY.md, "Crowd reports").
 *
 *   GET  /api/crowd             what to ask, the answers, the limits, the rules and exactly what is stored
 *   GET  /api/crowd/challenge   a proof-of-work challenge
 *   POST /api/crowd/reports     {municipality, answers: {luz|agua|internet|gasolina: si|no|intermitente}, challenge, nonce}
 *
 * The published counts are read like every other figure: `/api/panels/crowd`, `/api/v1/panels/crowd`, and each
 * entity's "now" block and timeline.
 *
 * Every other write in Vigía is for the person at the machine (loopback, same origin, session cookie) and a public
 * mirror refuses them all. A crowd report is the one anonymous write: nobody has a session, on a mirror or on a
 * household's phones. So the guard is built for anonymous writes instead:
 * - it must come from Vigía's own page: JSON only (a cross-site form cannot send it without a CORS preflight, which
 *   this route never grants), an Origin naming the Host it was sent to, and Sec-Fetch-Site "same-origin" when the
 *   browser sends it;
 * - on a person's own Vigía, only from this machine or the local network (a private, loopback or link-local
 *   address), and the Host must be a name for this machine or an IP literal, so a page that rebinds its own domain to
 *   a LAN address (DNS rebinding) cannot pass the Origin check;
 * - on a public mirror, only from a public address: a private or loopback peer means an undeclared reverse proxy, and
 *   every visitor would share one fingerprint and one limit; the mirror must declare it (VIGIA_TRUST_PROXY);
 * - then the service's own checks: rate limits, the proof of work, the flood rules.
 */

import { isIP } from "node:net";
import type { Json } from "../core/types.ts";
import { isPublicAddress } from "../userfeeds/net.ts";
import { CROWD_RULES, type CrowdMode } from "./rules.ts";
import type { CrowdService } from "./service.ts";

export type Refusal = { status: 400 | 403 | 413 | 415 | 503; code: string; error: string };

const HOST_NAMES = /^(localhost|[\w-]+\.localhost)$/i;

/** A Host header naming this machine or an address literal (never a DNS name another site could rebind). */
export function hostIsLiteral(host: string): boolean {
	const name = host
		.toLowerCase()
		.replace(/:\d+$/, "")
		.replace(/^\[(.*)\]$/, "$1");
	return HOST_NAMES.test(name) || isIP(name) !== 0;
}

const PROXY =
	"Este espejo no identifica a sus visitantes (falta declarar su proxy con VIGIA_TRUST_PROXY, o el proxy no envía X-Forwarded-For): los reportes están desactivados para no mezclar a todos en uno.";

/** Why an anonymous crowd write is refused before its body is read, or null. */
export function crowdWriteRefusal(
	request: Request,
	ip: string,
	mode: CrowdMode,
	trustedProxy: (ip: string) => boolean = () => false,
): Refusal | null {
	const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
	if (type !== "application/json") return { status: 415, code: "json", error: "Se espera JSON." };
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (!Number.isFinite(declared) || declared > CROWD_RULES.maxBodyBytes)
		return { status: 413, code: "size", error: "Reporte demasiado grande." };
	let host = request.headers.get("host") ?? "";
	if (!host)
		try {
			host = new URL(request.url).host;
		} catch {
			host = "";
		}
	const origin = request.headers.get("origin");
	let originHost = "";
	try {
		originHost = origin ? new URL(origin).host : "";
	} catch {
		originHost = "";
	}
	if (!host || !origin || originHost.toLowerCase() !== host.toLowerCase())
		return { status: 403, code: "origin", error: "Origen no permitido." };
	const site = request.headers.get("sec-fetch-site");
	if (site !== null && site !== "same-origin")
		return { status: 403, code: "origin", error: "Origen no permitido." };
	if (mode === "local") {
		if (isPublicAddress(ip))
			return {
				status: 403,
				code: "remote",
				error: "Este Vigía es personal: solo recibe reportes desde este equipo o su red local.",
			};
		if (!hostIsLiteral(host)) return { status: 403, code: "origin", error: "Origen no permitido." };
	} else if (!isPublicAddress(ip) || trustedProxy(ip)) {
		// A private peer is an undeclared proxy; a declared proxy as the client means it sent no X-Forwarded-For.
		return { status: 503, code: "proxy", error: PROXY };
	}
	return null;
}

/** Reads at most `maxBodyBytes` of the body (a chunked body declares no length): past it, undefined. */
async function readBody(request: Request): Promise<unknown> {
	const reader = request.body?.getReader();
	if (!reader) return undefined;
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > CROWD_RULES.maxBodyBytes) {
				await reader.cancel().catch(() => {});
				return undefined;
			}
			chunks.push(value);
		}
	} catch {
		return undefined;
	}
	const bytes = new Uint8Array(size);
	let at = 0;
	for (const c of chunks) {
		bytes.set(c, at);
		at += c.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
	} catch {
		return undefined;
	}
}

type JsonFn = (data: unknown, status?: number, headers?: Record<string, string>) => Response;

/** Returns the response for a crowd route, or null when the path is not one. */
export async function crowdRoute(
	crowd: CrowdService | undefined,
	request: Request,
	path: string,
	ip: string,
	json: JsonFn,
): Promise<Response | null> {
	if (path !== "/api/crowd" && !path.startsWith("/api/crowd/")) return null;
	const method = request.method;
	if (!crowd) return json({ error: "Los reportes de usuarios no están disponibles aquí.", code: "off" }, 404);
	const fail = (r: { status: number; code: string; error: string; retryAfter?: number }) =>
		json(
			{ error: r.error, code: r.code },
			r.status,
			r.retryAfter ? { "retry-after": String(r.retryAfter) } : {},
		);

	if (path === "/api/crowd" && method === "GET") return json(crowd.info());
	if (path === "/api/crowd/challenge" && method === "GET") {
		const c = crowd.challenge(ip);
		return c.ok ? json(c.challenge as Json) : fail(c);
	}
	if (path === "/api/crowd/reports" && method === "POST") {
		if (!crowd.enabled)
			return fail({
				status: 404,
				code: "off",
				error: "Los reportes de usuarios están desactivados en este Vigía.",
			});
		const refusal = crowdWriteRefusal(request, ip, crowd.mode, crowd.trustedProxy);
		if (refusal) return fail(refusal);
		const body = await readBody(request);
		if (body === undefined) return fail({ status: 400, code: "invalid", error: "Reporte no válido." });
		const out = crowd.submit(body, ip);
		// Every accepted answer reads "received": whether it was counted, held, or replaced an earlier answer from the
		// same address is not told back in real time (behind a shared address it would tell one person about another's
		// report). What was held is public anyway, per bucket, as "posible manipulación".
		return out.ok
			? json({
					ok: true,
					municipality: out.municipality,
					results: out.results.map((r) => ({ service: r.service, answer: r.answer, status: "received" })),
					publishedFrom: out.publishedFrom,
				})
			: fail(out);
	}
	const known = ["/api/crowd", "/api/crowd/challenge", "/api/crowd/reports"].includes(path);
	return json({ error: known ? "Método no permitido." : "Ruta desconocida." }, known ? 405 : 404);
}
