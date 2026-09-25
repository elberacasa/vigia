/**
 * HTTP plumbing of the read API: conditional requests (weak ETag + Last-Modified), cache headers, CORS for reads.
 *
 * The ETag hashes the content without the envelope's `generatedAt`, so an unchanged answer revalidates to 304 even
 * though each response says when it was generated (a weak validator: the bytes differ, the meaning does not).
 * Last-Modified is the newest time the data itself carries when there is one (a series' newest fetch), otherwise the
 * first time this server produced the current content.
 */

export interface CorsPolicy {
	readonly enabled: boolean;
}

const EXPOSED = "etag, last-modified, retry-after, content-disposition";

export function corsHeaders(cors: CorsPolicy): Record<string, string> {
	return cors.enabled ? { "access-control-allow-origin": "*", "access-control-expose-headers": EXPOSED } : {};
}

/** OPTIONS on /api/v1/*: a preflight answer (reads only), or a bare 204 when CORS is off. */
export function preflight(cors: CorsPolicy): Response {
	return new Response(null, {
		status: 204,
		headers: cors.enabled
			? {
					"access-control-allow-origin": "*",
					"access-control-allow-methods": "GET, HEAD, OPTIONS",
					"access-control-allow-headers": "accept, if-none-match, if-modified-since",
					"access-control-max-age": "86400",
					allow: "GET, HEAD, OPTIONS",
				}
			: { allow: "GET, HEAD, OPTIONS" },
	});
}

export function weakEtag(content: string): string {
	return `W/"${Bun.hash(content).toString(16)}"`;
}

/** First time each content version was produced, per resource (bounded memory). */
export class FirstSeen {
	readonly #seen = new Map<string, { etag: string; at: number }>();
	constructor(readonly max = 2_000) {}
	at(resource: string, etag: string, now: number): number {
		const hit = this.#seen.get(resource);
		if (hit && hit.etag === etag) return hit.at;
		if (this.#seen.size >= this.max) this.#seen.delete(this.#seen.keys().next().value as string);
		this.#seen.set(resource, { etag, at: now });
		return now;
	}
}

function matches(header: string | null, etag: string): boolean {
	if (!header) return false;
	if (header.trim() === "*") return true;
	const bare = etag.replace(/^W\//, "");
	return header.split(",").some((t) => t.trim().replace(/^W\//, "") === bare);
}

/** Whether a GET/HEAD may be answered 304 (RFC 9110 §13.2.2: If-None-Match wins over If-Modified-Since). */
export function notModified(request: Request, etag: string, lastModified: number): boolean {
	const inm = request.headers.get("if-none-match");
	if (inm !== null) return matches(inm, etag);
	const ims = request.headers.get("if-modified-since");
	if (!ims) return false;
	const since = Date.parse(ims);
	return Number.isFinite(since) && Math.floor(lastModified / 1000) * 1000 <= since;
}

export interface Representation {
	readonly body: string;
	readonly contentType: string;
	readonly etag: string;
	readonly lastModified: number;
	readonly maxAge: number;
	readonly headers?: Record<string, string>;
}

export function send(request: Request, r: Representation, cors: CorsPolicy): Response {
	const headers: Record<string, string> = {
		etag: r.etag,
		"last-modified": new Date(r.lastModified).toUTCString(),
		"cache-control": `public, max-age=${r.maxAge}`,
		vary: "accept",
		...corsHeaders(cors),
		...r.headers,
	};
	if (notModified(request, r.etag, r.lastModified)) return new Response(null, { status: 304, headers });
	return new Response(request.method === "HEAD" ? null : r.body, {
		headers: { ...headers, "content-type": r.contentType },
	});
}

export function fail(
	status: number,
	message: string,
	cors: CorsPolicy,
	extra: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			...corsHeaders(cors),
			...extra,
		},
	});
}

/** ?format=csv, or an Accept header that prefers text/csv over JSON. */
export function wantsCsv(request: Request, url: URL): boolean {
	const f = url.searchParams.get("format");
	if (f !== null) return f.toLowerCase() === "csv";
	const accept = request.headers.get("accept") ?? "";
	return /\btext\/csv\b/.test(accept) && !/\bapplication\/json\b/.test(accept);
}
