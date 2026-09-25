import { streamOrigins } from "../adapters/radio-streams/stations.ts";
import type { AlertService } from "../alerts/service.ts";
import type { KeyStore } from "../config/keys.ts";
import { readCookie, sameToken, sessionCookieName } from "../config/session.ts";
import { BLOB_KEY, BLOB_SOURCE, type BlobReader } from "../core/blobs.ts";
import { computeHealth, type FeedHealth } from "../core/health.ts";
import type { Scheduler, SchedulerEvent } from "../core/scheduler.ts";
import type { Store } from "../core/store.ts";
import type { Adapter, HttpLike, Json } from "../core/types.ts";
import { chain } from "../intel/chain.ts";
import { atlasMeta } from "../sources/atlas-meta.ts";
import type { KeySpec } from "../sources/keyspec.ts";
import type { UserFeeds } from "../userfeeds/service.ts";
import type { DeployConfig } from "./config.ts";
import { customRoutes } from "./custom-routes.ts";
import { createHistoryService } from "./history.ts";
import { digestsRoute, evidenceRoute, incidentsRoute, terminalRoute, wantsText } from "./intel-routes.ts";
import { etagMatches, packLicences, strongEtag } from "./meta.ts";
import { Metrics, routeFamily } from "./metrics.ts";
import { apiDocsPage } from "./pages/api-docs.ts";
import { reportPage } from "./pages/report.ts";
import { htmlResponse } from "./pages/shell.ts";
import type { PanelCache } from "./panels.ts";
import { ConnectionCap, RateLimiter } from "./ratelimit.ts";
import { decodeSegment } from "./uri.ts";
import { createV1 } from "./v1/routes.ts";
import { type Visibility, visibility } from "./visibility.ts";

export interface AppDeps {
	readonly store: Store;
	readonly scheduler: Scheduler;
	readonly adapters: readonly Adapter[];
	readonly keys: KeyStore;
	readonly keySpecs: readonly KeySpec[];
	/** Changes the AI section's settings (persisted). */
	readonly setAi?: (next: {
		news?: "off" | "local" | "jev";
		brief?: "off" | "anthropic" | "claude-code" | "ollama";
		ollamaModel?: string;
		budgetUsd?: Record<string, number>;
	}) => void;
	/** Writes today's brief with the chosen model (on demand; may cost money). */
	readonly writeBrief?: () => Promise<unknown>;
	/**
	 * "¿Está bloqueado?": one domain's blocking history (src/panels/netwatch-lookup.ts). `live: false` forbids the
	 * live OONI query (the request did not come from Vigía's own page).
	 */
	readonly lookupDomain?: (domain: string, options: { live: boolean }) => Promise<unknown>;
	/** Turns a feed on or off (persisted). Absent: toggling is not available. */
	readonly setFeedEnabled?: (id: string, on: boolean) => void;
	readonly panels: PanelCache;
	readonly http: HttpLike;
	/** Images stored by adapters (satellite frames, night-lights mosaics), served same-origin. */
	readonly blobs?: BlobReader;
	readonly now?: () => number;
	/** Serves the built web client; returns null when the path is not a static file. */
	readonly staticFile?: (path: string) => Promise<Response | null>;
	readonly version: string;
	/** Serving the local network (`--host 0.0.0.0`): any Host may read; writes still need a loopback Host. */
	readonly lan?: boolean;
	/**
	 * The local session token (config/session.ts). `GET /?token=…` exchanges it for an HttpOnly cookie, and every
	 * write needs that cookie on top of the loopback, Host and Origin checks.
	 */
	readonly sessionToken: string;
	/** "Mis fuentes": feeds the user added (src/userfeeds); their adapters join the health and meta lists. */
	readonly userFeeds?: UserFeeds;
	/** "Mis alertas": the rule engine's service (src/alerts). */
	readonly alerts?: AlertService;
	/**
	 * Deployment (src/server/config.ts): "public" is a read-only mirror (every write refused, no token exchange, any
	 * Host); `cors` opens /api/v1 to other origins; `metrics` says who may read /metrics. Defaults: local, off, loopback.
	 */
	readonly deploy?: Partial<Pick<DeployConfig, "mode" | "cors" | "metrics">>;
}

/** Every write in public mode (docs/OPERATIONS.md). */
export const PUBLIC_REFUSAL =
	"Este Vigía es un espejo público de solo lectura: aquí no se pueden cambiar claves ni ajustes.";

/** Shown by the UI as is when a write arrives without the session cookie. */
export const SESSION_REFUSAL =
	"Abre Vigía desde el enlace que muestra la terminal: este navegador no tiene permiso para cambiar ajustes.";

/**
 * "En vivo" (web/src/panels/LiveTv.tsx) is the only third-party content: YouTube's official player, framed from
 * youtube-nocookie.com only after a press, and the radio stations' own stream hosts in an <audio> element.
 */
export const FRAME_SRC = "https://www.youtube-nocookie.com";
export const MEDIA_SRC = ["'self'", ...streamOrigins()].join(" ");

const SECURITY_HEADERS: Record<string, string> = {
	"content-security-policy": `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-src ${FRAME_SRC}; media-src ${MEDIA_SRC}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"cross-origin-opener-policy": "same-origin",
	"permissions-policy": "geolocation=(), camera=(), microphone=()",
};

/**
 * Whether a GET came from Vigía's own page (or was typed into the address bar), so it may trigger outbound calls.
 * Browsers send Sec-Fetch-Site on every request and a page cannot forge it; without it (an old browser, curl), the
 * Origin or Referer must name this host. Another website's <img src="http://localhost:7722/api/…"> fails both.
 */
export function sameOriginRequest(request: Request): boolean {
	const site = request.headers.get("sec-fetch-site");
	if (site !== null) return site === "same-origin" || site === "none";
	const host = request.headers.get("host") ?? new URL(request.url).host;
	const from = request.headers.get("origin") ?? request.headers.get("referer");
	if (!from) return false;
	try {
		return new URL(from).host === host;
	} catch {
		return false;
	}
}

const STREAMS_PER_CLIENT = 6;
const STREAMS_GLOBAL = 1_000;
const MAX_HISTORY_WINDOW_MS = 400 * 24 * 3_600_000;

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
	});
}

export function problem(status: number, message: string): Response {
	return json({ error: message }, status);
}

export interface App {
	fetch(request: Request, clientIp: string): Promise<Response>;
	/** Prometheus metrics (also served at /metrics to whoever `deploy.metrics` allows). */
	metricsText(): string;
	/** Push a scheduler event to every open stream. */
	publish(event: SchedulerEvent): void;
	health(includePrivate?: boolean): FeedHealth[];
	closeStreams(): void;
	/** Fills the connectivity history archive in the background (see HistoryService.warm). */
	warmHistory(): Promise<number>;
	/** Push any other event (e.g. a fired alert) to every open stream. */
	notify(payload: Json): void;
}

/** Refusal for sources whose terms allow only derived results (see Licence.raw). */
const NO_RAW =
	"Los términos de esta fuente no permiten redistribuir sus datos; Vigía solo muestra resultados derivados.";

export function createApp(deps: AppDeps): App {
	const now = deps.now ?? Date.now;
	const apiLimiter = new RateLimiter(240, 4, now);
	const writeLimiter = new RateLimiter(10, 0.2, now);
	// Replays read archived hours and compute the rest in slices, one at a time (src/server/history.ts); on top of
	// that, a smaller bucket per client and one shared by everyone. Answers are cached 60 s.
	const historyLimiter = new RateLimiter(20, 0.2, now);
	const historyGlobal = new RateLimiter(60, 1, now);
	const history = createHistoryService(deps.store, now);
	let warming: Promise<number> | null = null;
	/** One warm-up at a time; a failure is logged, never thrown into a request. */
	const warmHistory = (): Promise<number> => {
		warming ??= history
			.warm()
			.catch((error: unknown) => {
				console.error("[vigia] historial:", error instanceof Error ? error.message : error);
				return 0;
			})
			.finally(() => {
				warming = null;
			});
		return warming;
	};
	const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
	/** Live streams: 6 per client (IPv6 by /64) and 1,000 in all, so no one client can hold every slot (review 4 M9). */
	const streamSlots = new ConnectionCap(STREAMS_PER_CLIENT, STREAMS_GLOBAL);
	const releaseStream = new Map<ReadableStreamDefaultController<Uint8Array>, () => void>();
	const dropStream = (controller: ReadableStreamDefaultController<Uint8Array>) => {
		streams.delete(controller);
		releaseStream.get(controller)?.();
		releaseStream.delete(controller);
	};
	const encoder = new TextEncoder();
	const adapterById = new Map(deps.adapters.map((a) => [a.id, a]));
	const specById = new Map(deps.keySpecs.map((k) => [k.id, k]));
	const cookieName = sessionCookieName(deps.sessionToken);
	const mode = deps.deploy?.mode ?? "local";
	const metricsAccess = deps.deploy?.metrics ?? "loopback";
	const metrics = new Metrics(now());
	// Personal features exist only on a user's own Vigía, never on a public read-only mirror.
	const userFeeds = mode === "public" ? undefined : deps.userFeeds;
	const alertsService = mode === "public" ? undefined : deps.alerts;
	const allAdapters = (): readonly Adapter[] =>
		userFeeds ? [...deps.adapters, ...userFeeds.adapters()] : deps.adapters;
	const custom = customRoutes({ userFeeds, alerts: alertsService }, now);

	/**
	 * The user's own feeds and alert rules are personal. On this machine only loopback reaches the server anyway;
	 * serving the local network (`lan`), they are shown only to a browser holding the session cookie.
	 */
	const privateOk = (request: Request): boolean =>
		!deps.lan || sameToken(deps.sessionToken, readCookie(request.headers.get("cookie"), cookieName));
	/** What this request may read (visibility.ts): every read route asks it. */
	const visible = (request: Request): Visibility =>
		visibility(privateOk(request), (id) => userFeeds?.isMine(id) ?? false);
	/** What anyone may read: the public API, metrics and the printable report. */
	const everyone = visibility(false, (id) => userFeeds?.isMine(id) ?? false);

	const health = (includePrivate = true): FeedHealth[] => {
		const t = now();
		return (includePrivate ? allAdapters() : deps.adapters).map((adapter) =>
			computeHealth({
				adapter,
				locked: deps.scheduler.isLocked(adapter),
				enabled: deps.scheduler.isEnabled(adapter),
				runtime: deps.scheduler.runtime(adapter.id),
				runs: deps.store.recentRuns(adapter.id, 50),
				lastSuccessAt: deps.store.lastSuccessAt(adapter.id),
				newestObservedAt: deps.store.newestObservedAt(adapter.id),
				now: t,
			}),
		);
	};

	const atlas = atlasMeta(deps.adapters, deps.panels.panels, (id) => deps.store.firstRunAt(id));
	const feedsMeta = (includePrivate: boolean) => [
		...deps.adapters.map((a) => ({
			id: a.id,
			layer: a.layer,
			name: a.name,
			provider: a.provider,
			homepage: a.homepage,
			licence: a.licence,
			keys: a.keys,
			intervalMs: a.intervalMs,
			freshness: a.freshness,
			optIn: a.optIn ?? null,
			...atlas(a.id),
		})),
		...(includePrivate ? (userFeeds?.list() ?? []) : []).map((f) => {
			const a = userFeeds?.adapters().find((x) => x.id === f.id);
			return {
				id: f.id,
				layer: "news",
				name: a?.name ?? { es: f.name, en: f.name },
				provider: f.name,
				homepage: a?.homepage ?? f.url,
				licence: a?.licence ?? null,
				keys: [],
				intervalMs: f.intervalMin * 60_000,
				freshness: a?.freshness ?? null,
				optIn: null,
				...userFeeds?.meta(f),
			};
		}),
	];

	// The public API serves Vigía's own panels only: the user's "Mis fuentes" panel is personal.
	const v1 = createV1({
		store: deps.store,
		panels: {
			get panels() {
				return everyone.panels(deps.panels.panels);
			},
			get: (id: string) => (everyone.panel(id) ? deps.panels.get(id) : undefined),
		},
		adapters: deps.adapters,
		// v1 is the public read API: built-in feeds only, never the user's own (they are not in deps.adapters).
		health: () => health(false),
		history,
		version: deps.version,
		mode,
		cors: deps.deploy?.cors ?? false,
		now,
	});

	/** Streams of browsers that may see personal events (a fired alert); see privateOk. */
	const privateStreams = new WeakSet<ReadableStreamDefaultController<Uint8Array>>();
	const send = (payload: Json, onlyPrivate = false) => {
		const chunk = encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
		for (const controller of streams) {
			if (onlyPrivate && !privateStreams.has(controller)) continue;
			try {
				controller.enqueue(chunk);
			} catch {
				dropStream(controller);
			}
		}
	};

	const heartbeat = setInterval(() => {
		const chunk = encoder.encode(`: ${now()}\n\n`);
		for (const controller of streams) {
			try {
				controller.enqueue(chunk);
			} catch {
				dropStream(controller);
			}
		}
	}, 25_000);
	heartbeat.unref?.();

	/**
	 * Mutating endpoints are only for the person at this machine: loopback, same origin, and the session cookie
	 * that only a browser opened from the terminal's link holds (a reverse proxy on this machine passes the first
	 * two). Returns the refusal, or null.
	 */
	const allowWrite = (request: Request, ip: string): Response | null => {
		if (mode === "public") return json({ error: PUBLIC_REFUSAL, code: "public" }, 403);
		const reason = writeRefusal(request, ip);
		if (reason) return problem(403, reason);
		if (!sameToken(deps.sessionToken, readCookie(request.headers.get("cookie"), cookieName))) {
			return json({ error: SESSION_REFUSAL, code: "session" }, 403);
		}
		return null;
	};

	const writeRefusal = (request: Request, ip: string): string | null => {
		if (!isLoopback(ip)) return "Solo se pueden cambiar claves desde este mismo equipo.";
		const origin = request.headers.get("origin");
		const host = request.headers.get("host") ?? new URL(request.url).host;
		// A loopback Host defeats DNS rebinding: a page on attacker.example that rebinds to 127.0.0.1 still sends
		// Host: attacker.example (and a matching Origin), so the same-origin test alone would pass.
		if (!host || !isLoopbackHost(host)) return "Origen no permitido.";
		let originHost = "";
		try {
			originHost = origin ? new URL(origin).host : "";
		} catch {
			originHost = "";
		}
		if (!origin || originHost !== host) return "Origen no permitido.";
		if (request.headers.get("content-type")?.split(";")[0] !== "application/json") return "Se espera JSON.";
		return null;
	};

	const stream = (ip: string, personal: boolean): Response => {
		const release = streamSlots.open(ip);
		if (!release) return json({ error: "Demasiadas conexiones abiertas." }, 429, { "retry-after": "30" });
		let self: ReadableStreamDefaultController<Uint8Array> | null = null;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				self = controller;
				streams.add(controller);
				releaseStream.set(controller, release);
				if (personal) privateStreams.add(controller);
				controller.enqueue(encoder.encode("retry: 5000\n\n"));
			},
			cancel() {
				if (self) dropStream(self);
				release();
			},
		});
		return new Response(body, {
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-store",
				"x-accel-buffering": "no",
			},
		});
	};

	/**
	 * GET /api/blobs/:source/:key. Segments are matched raw (no percent-decoding) against strict patterns
	 * with no dots or slashes, so no path can leave the blob directory. A key names immutable bytes.
	 */
	const blob = async (request: Request, path: string): Promise<Response> => {
		const [source = "", key = "", ...rest] = path.slice("/api/blobs/".length).split("/");
		if (rest.length > 0 || !BLOB_SOURCE.test(source) || !BLOB_KEY.test(key) || !adapterById.has(source)) {
			return problem(404, "Imagen desconocida.");
		}
		const found = deps.blobs?.read(source, key);
		if (!found) return problem(404, "Imagen no encontrada.");
		const headers = {
			"cache-control": "public, max-age=31536000, immutable",
			etag: `"${found.meta.sha256}"`,
			"cross-origin-resource-policy": "same-origin",
		};
		const match = request.headers.get("if-none-match");
		if (match?.split(",").some((tag) => tag.trim().replace(/^W\//, "") === headers.etag)) {
			return new Response(null, { status: 304, headers });
		}
		const file = Bun.file(found.path);
		// Evicted or truncated between the metadata read and now: not found, never partial bytes.
		if (file.size !== found.meta.bytes) return problem(404, "Imagen no encontrada.");
		return new Response(request.method === "HEAD" ? null : file, {
			headers: { ...headers, "content-type": found.meta.contentType, "content-length": String(file.size) },
		});
	};

	const route = async (request: Request, ip: string): Promise<Response> => {
		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method;

		// The terminal's link: trade the token for the session cookie and drop it from the address bar (and from
		// history). A wrong token is dropped the same way, without a cookie.
		if (mode === "local" && method === "GET" && url.searchParams.has("token") && !path.startsWith("/api/")) {
			const given = url.searchParams.get("token");
			url.searchParams.delete("token");
			// Collapse leading slashes so "//host" can never become an off-site redirect.
			const location = `/${path.replace(/^\/+/, "")}${url.search}`;
			const headers: Record<string, string> = { location, "cache-control": "no-store" };
			if (sameToken(deps.sessionToken, given)) {
				headers["set-cookie"] =
					`${cookieName}=${deps.sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=34560000`;
			}
			return new Response(null, { status: 303, headers });
		}

		if (method === "GET" && (path === "/ahora.txt" || (path === "/" && wantsText(request)))) {
			if (!apiLimiter.take(ip)) return problem(429, "Demasiadas solicitudes. Espera un momento.");
			return terminalRoute(deps, url, now(), health(visible(request).personal));
		}

		// The public read API (src/server/v1), its docs, the printable report and the operators' metrics.
		if (path === "/api/v1" || path.startsWith("/api/v1/")) return v1(request, url, ip);
		if ((method === "GET" || method === "HEAD") && (path === "/api" || path === "/api/")) {
			if (!apiLimiter.take(ip)) return problem(429, "Demasiadas solicitudes. Espera un momento.");
			const html = apiDocsPage({
				version: deps.version,
				origin: url.origin,
				cors: deps.deploy?.cors ?? false,
				mode,
			});
			return htmlResponse(html, 300, request);
		}
		if ((method === "GET" || method === "HEAD") && (path === "/informe" || path === "/informe/")) {
			if (!apiLimiter.take(ip, 5)) return problem(429, "Demasiadas solicitudes. Espera un momento.");
			const brief = deps.panels.get("brief");
			const incidents = deps.panels.get("incidents");
			const used = new Set<string>();
			for (const id of ["brief", "incidents"])
				for (const s of deps.panels.panels.find((p) => p.id === id)?.sources ?? []) used.add(s);
			const html = reportPage({
				now: now(),
				version: deps.version,
				origin: url.origin,
				brief,
				ai: deps.panels.get("ai"),
				incidents,
				// Vigía's own feeds only: the user's are not part of its count (review 4 L3).
				health: health(false),
				adapters: deps.adapters,
				usedFeeds: [...used],
				chainHead: chain(deps.store).at(-1) ?? null,
			});
			return htmlResponse(html, 0, request);
		}
		if (method === "GET" && path === "/metrics") {
			const host = request.headers.get("host") ?? url.host;
			const allowed =
				metricsAccess === "open" || (metricsAccess === "loopback" && isLoopback(ip) && isLoopbackHost(host));
			if (!allowed) return problem(404, "No encontrado.");
			return new Response(
				metrics.render({
					health: health(false),
					streams: streams.size,
					version: deps.version,
					mode,
					now: now(),
				}),
				{
					headers: {
						"content-type": "text/plain; version=0.0.4; charset=utf-8",
						"cache-control": "no-store",
					},
				},
			);
		}

		if (path.startsWith("/api/")) {
			if (!apiLimiter.take(ip)) return problem(429, "Demasiadas solicitudes. Espera un momento.");

			if (method === "GET" && path === "/api/meta") {
				const personal = visible(request).personal;
				const body = JSON.stringify({ version: deps.version, mode, ...packLicences(feedsMeta(personal)) });
				const etag = strongEtag(body);
				// The user's own feed list changes at a click: always revalidate it. Vigía's list changes on upgrade.
				const headers = {
					etag,
					"cache-control": personal ? "private, no-cache" : "private, max-age=60, stale-while-revalidate=600",
				};
				if (etagMatches(request.headers.get("if-none-match"), etag))
					return new Response(null, { status: 304, headers });
				return new Response(body, {
					headers: { "content-type": "application/json; charset=utf-8", ...headers },
				});
			}
			if (method === "GET" && path === "/api/health")
				return json({ now: now(), feeds: health(visible(request).personal) });
			if (method === "GET" && path === "/api/panels") {
				// ?only=a,b or ?except=a,b lets a slow phone fetch the small panels first and the heavy lists after.
				const only = url.searchParams.get("only")?.split(",").filter(Boolean);
				const except = new Set(url.searchParams.get("except")?.split(",").filter(Boolean) ?? []);
				const shown = new Set(
					visible(request)
						.panels(deps.panels.panels)
						.map((p) => p.id),
				);
				for (const p of deps.panels.panels) if (!shown.has(p.id)) except.add(p.id);
				const all = deps.panels.all(only ? new Set(only) : undefined, except);
				return json({ now: now(), panels: all });
			}
			if (method === "GET" && path.startsWith("/api/panels/")) {
				const id = decodeSegment(path.slice("/api/panels/".length));
				if (id === null) return problem(400, "Panel no válido.");
				const value = visible(request).panel(id) ? deps.panels.get(id) : undefined;
				return value === undefined ? problem(404, "Panel desconocido.") : json({ now: now(), panel: value });
			}
			if (method === "GET" && path === "/api/incidents") return incidentsRoute(deps, url, now());
			if (method === "GET" && path === "/api/archive/digests") return digestsRoute(deps, url, now());
			if (method === "GET" && path === "/api/evidence")
				return evidenceRoute(deps, url, now(), ip, visible(request));
			if (method === "GET" && path === "/api/stream") return stream(ip, visible(request).personal);
			if (method === "GET" && path === "/api/bloqueos" && deps.lookupDomain) {
				const domain = (url.searchParams.get("dominio") ?? "").slice(0, 300);
				// Stored answers are open to anyone; a live OONI query only for Vigía's own page (review 3 M1).
				const lookup = await deps.lookupDomain(domain, { live: sameOriginRequest(request) });
				// Only a malformed domain comes back without one.
				const invalid = typeof lookup === "object" && lookup !== null && !("domain" in lookup);
				return json({ now: now(), lookup }, invalid ? 400 : 200);
			}

			const replay = /^\/api\/history\/([\w-]+)$/.exec(path);
			if (method === "GET" && replay?.[1]) {
				if (!historyLimiter.take(ip) || !historyGlobal.take("all"))
					return problem(429, "Demasiadas consultas de historial. Espera un momento.");
				const r = await history.handle(replay[1], url.searchParams);
				const headers: Record<string, string> = {};
				if (r.cacheSeconds) headers["cache-control"] = `private, max-age=${r.cacheSeconds}`;
				if (r.retryAfter) headers["retry-after"] = String(r.retryAfter);
				return json(r.body, r.status, headers);
			}

			if ((method === "GET" || method === "HEAD") && path.startsWith("/api/blobs/"))
				return blob(request, path);

			const latest = /^\/api\/feeds\/([\w.-]+)\/latest$/.exec(path);
			if (method === "GET" && latest?.[1]) {
				if (!adapterById.has(latest[1])) return problem(404, "Fuente desconocida.");
				if (adapterById.get(latest[1])?.licence.raw === false) return problem(403, NO_RAW);
				const since = clampInt(url.searchParams.get("since"), 0, Number.MAX_SAFE_INTEGER, 0);
				const limit = clampInt(url.searchParams.get("limit"), 1, 1_000, 200);
				return json({ now: now(), observations: deps.store.latestPerSeries(latest[1], since, limit) });
			}

			const series = /^\/api\/feeds\/([\w.-]+)\/series\/(.+)$/.exec(path);
			if (method === "GET" && series?.[1] && series[2]) {
				if (!adapterById.has(series[1])) return problem(404, "Fuente desconocida.");
				if (adapterById.get(series[1])?.licence.raw === false) return problem(403, NO_RAW);
				const name = decodeSegment(series[2]);
				if (name === null) return problem(400, "Serie no válida.");
				const to = clampInt(url.searchParams.get("to"), 0, Number.MAX_SAFE_INTEGER, now());
				const from = clampInt(
					url.searchParams.get("from"),
					to - MAX_HISTORY_WINDOW_MS,
					to,
					to - 7 * 86_400_000,
				);
				return json({
					now: now(),
					observations: deps.store.history(series[1], name, from, to),
				});
			}

			if (method === "GET" && path === "/api/keys") {
				return json({
					keys: deps.keySpecs.map((spec) => ({
						id: spec.id,
						set: deps.keys.has(spec.id),
						origin: deps.keys.origin(spec.id),
						provider: spec.provider,
						name: spec.name,
						cost: spec.cost,
						signupUrl: spec.signupUrl,
						unlocks: spec.unlocks,
						minutes: spec.minutes,
						steps: spec.steps,
						feeds: deps.adapters.filter((a) => a.keys.includes(spec.id)).map((a) => a.id),
					})),
				});
			}

			const keyPath = /^\/api\/keys\/([\w-]+)$/.exec(path);
			if (keyPath?.[1] && (method === "POST" || method === "DELETE")) {
				const refusal = allowWrite(request, ip);
				if (refusal) return refusal;
				if (!writeLimiter.take(ip)) return problem(429, "Demasiados intentos. Espera un minuto.");
				const spec = specById.get(keyPath[1]);
				if (!spec) return problem(404, "Clave desconocida.");
				if (method === "DELETE") {
					deps.keys.remove(spec.id);
					return json({ ok: true });
				}
				const body: unknown = await request.json().catch(() => null);
				const value =
					body && typeof body === "object" && "value" in body && typeof body.value === "string"
						? body.value.trim()
						: "";
				if (value.length < 4 || value.length > 512 || /\s/.test(value)) {
					return problem(400, "La clave no tiene un formato válido.");
				}
				const reason = await spec
					.validate(value, deps.http)
					.catch(() => "No se pudo verificar la clave ahora.");
				if (reason !== null) return json({ ok: false, reason }, 422);
				deps.keys.set(spec.id, value);
				const unlocked = deps.adapters.filter((a) => a.keys.includes(spec.id)).map((a) => a.id);
				for (const id of unlocked) deps.scheduler.trigger(id);
				return json({ ok: true, unlocked });
			}

			if (path === "/api/ai/settings" && method === "POST") {
				const refusal = allowWrite(request, ip);
				if (refusal) return refusal;
				if (!writeLimiter.take(ip)) return problem(429, "Demasiados intentos. Espera un minuto.");
				if (!deps.setAi) return problem(404, "Ruta desconocida.");
				const body: unknown = await request.json().catch(() => null);
				const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
				const next: {
					news?: "off" | "local" | "jev";
					brief?: "off" | "anthropic" | "claude-code" | "ollama";
					ollamaModel?: string;
					budgetUsd?: Record<string, number>;
				} = {};
				if (b.brief !== undefined) {
					if (
						b.brief !== "off" &&
						b.brief !== "anthropic" &&
						b.brief !== "claude-code" &&
						b.brief !== "ollama"
					) {
						return problem(400, "Opción no válida.");
					}
					next.brief = b.brief;
				}
				if (b.ollamaModel !== undefined) {
					if (typeof b.ollamaModel !== "string" || !/^[\w.:-]{1,64}$/.test(b.ollamaModel)) {
						return problem(400, "Nombre de modelo no válido.");
					}
					next.ollamaModel = b.ollamaModel;
				}
				if (b.news !== undefined) {
					if (b.news !== "off" && b.news !== "local" && b.news !== "jev")
						return problem(400, "Opción no válida.");
					next.news = b.news;
				}
				if (b.budgetUsd !== undefined) {
					const budget = b.budgetUsd as Record<string, unknown>;
					const clean: Record<string, number> = {};
					for (const [k, v] of Object.entries(budget ?? {})) {
						if (
							!/^[a-z]{2,20}$/.test(k) ||
							typeof v !== "number" ||
							!Number.isFinite(v) ||
							v < 0 ||
							v > 1_000
						) {
							return problem(400, "Presupuesto no válido (0–1000 US$).");
						}
						clean[k] = v;
					}
					next.budgetUsd = clean;
				}
				deps.setAi(next);
				return json({ ok: true });
			}

			if (path === "/api/ai/brief" && method === "POST") {
				const refusal = allowWrite(request, ip);
				if (refusal) return refusal;
				if (!writeLimiter.take(ip)) return problem(429, "Demasiados intentos. Espera un minuto.");
				if (!deps.writeBrief) return problem(404, "Ruta desconocida.");
				try {
					return json({ ok: true, brief: await deps.writeBrief() });
				} catch (error) {
					return json({ ok: false, reason: error instanceof Error ? error.message : String(error) }, 422);
				}
			}

			const toggle = /^\/api\/feeds\/([\w.-]+)\/enabled$/.exec(path);
			if (toggle?.[1] && method === "POST") {
				const refusal = allowWrite(request, ip);
				if (refusal) return refusal;
				if (!writeLimiter.take(ip)) return problem(429, "Demasiados intentos. Espera un minuto.");
				const adapter = adapterById.get(toggle[1]);
				if (!adapter || !deps.setFeedEnabled) return problem(404, "Fuente desconocida.");
				const body: unknown = await request.json().catch(() => null);
				if (!body || typeof body !== "object" || !("on" in body) || typeof body.on !== "boolean") {
					return problem(400, 'Se espera {"on": true|false}.');
				}
				deps.setFeedEnabled(adapter.id, body.on);
				if (body.on) deps.scheduler.trigger(adapter.id);
				return json({ ok: true, id: adapter.id, on: body.on });
			}

			const personal = await custom({
				request,
				path,
				method,
				ip,
				allowWrite: () => allowWrite(request, ip),
				privateOk: privateOk(request),
				takeWrite: () => writeLimiter.take(ip),
				now: now(),
				json,
			});
			if (personal) return personal;

			return problem(404, "Ruta desconocida.");
		}

		if (method !== "GET" && method !== "HEAD") return problem(405, "Método no permitido.");
		const file = await deps.staticFile?.(path);
		return file ?? problem(404, "No encontrado.");
	};

	return {
		async fetch(request, ip) {
			const started = performance.now();
			let response: Response;
			try {
				const host = request.headers.get("host") ?? parseUrl(request.url)?.host ?? "";
				response = !parseUrl(request.url)
					? problem(400, "Solicitud no válida.")
					: !deps.lan && mode === "local" && !isLoopbackHost(host)
						? problem(421, "Vigía solo responde en localhost. Abre http://localhost con el mismo puerto.")
						: await route(request, ip);
			} catch (error) {
				// A malformed escape anywhere a route forgot decodeSegment is still the client's error, not ours.
				if (error instanceof URIError) response = problem(400, "Solicitud no válida.");
				else {
					console.error("[server]", error instanceof Error ? error.message : error);
					response = problem(500, "Error interno.");
				}
			}
			for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
				if (!response.headers.has(k)) response.headers.set(k, v);
			}
			const out = await compress(request, response);
			const path = parseUrl(request.url)?.pathname ?? "/";
			metrics.observeRequest(routeFamily(path), out.status, (performance.now() - started) / 1000);
			return out;
		},
		metricsText: () =>
			metrics.render({
				health: health(false),
				streams: streams.size,
				version: deps.version,
				mode,
				now: now(),
			}),
		publish(event) {
			// A user's own feed is personal: no metrics label, and its run events only reach the user's browser.
			const mine = userFeeds?.isMine(event.source) ?? false;
			const run = deps.store.recentRuns(event.source, 1)[0];
			if (!mine)
				metrics.observeRun(
					event.source,
					event.ok,
					event.inserted,
					run && run.finishedAt === event.at ? (run.finishedAt - run.startedAt) / 1000 : null,
				);
			// New IODA bins: archive the hours they settle, in the background, before anyone asks.
			if (event.source === "ioda-states" && event.inserted > 0) void warmHistory();
			const panels = event.inserted > 0 ? deps.panels.invalidate(event.source) : [];
			send(
				{
					type: event.type,
					source: event.source,
					ok: event.ok,
					inserted: event.inserted,
					panels,
					at: event.at,
				},
				mine,
			);
		},
		health,
		warmHistory,
		// Fired alerts are personal (only the user's browser), and a public mirror has none.
		notify: (payload) => {
			if (alertsService) send(payload, true);
		},
		closeStreams() {
			clearInterval(heartbeat);
			for (const controller of streams) {
				try {
					controller.close();
				} catch {
					// already closed
				}
			}
			streams.clear();
			for (const release of releaseStream.values()) release();
			releaseStream.clear();
		},
	};
}

const COMPRESSIBLE =
	/^(application\/(json|javascript|manifest\+json)|text\/(html|css|javascript|plain|csv)|image\/svg\+xml)/;

/**
 * Gzip for text responses over 1 KB (slow Venezuelan connections: the panels JSON shrinks ~8×). Streams (SSE)
 * are never buffered.
 */
export async function compress(request: Request, response: Response): Promise<Response> {
	const type = response.headers.get("content-type") ?? "";
	if (!COMPRESSIBLE.test(type) || response.headers.has("content-encoding") || !response.body) return response;
	if (!/\bgzip\b/.test(request.headers.get("accept-encoding") ?? "")) return response;
	const body = new Uint8Array(await response.arrayBuffer());
	const headers = new Headers(response.headers);
	headers.append("vary", "accept-encoding");
	if (body.byteLength < 1024) return new Response(body, { status: response.status, headers });
	const gz = Bun.gzipSync(body, { level: 6 });
	headers.set("content-encoding", "gzip");
	// Another representation, another strong tag (RFC 9110 8.8.3); etagMatches accepts either on revalidation.
	const etag = headers.get("etag");
	if (etag?.startsWith('"')) headers.set("etag", `${etag.slice(0, -1)}-gz"`);
	headers.set("content-length", String(gz.byteLength));
	return new Response(gz, { status: response.status, headers });
}

/** Host header naming this machine: localhost, *.localhost, 127.x.x.x or [::1], with any port. */
export function isLoopbackHost(host: string): boolean {
	const name = host.toLowerCase().replace(/:\d+$/, "");
	return (
		name === "localhost" ||
		name.endsWith(".localhost") ||
		name === "[::1]" ||
		/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)
	);
}

export function isLoopback(ip: string): boolean {
	return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip.startsWith("127.");
}

function parseUrl(raw: string): URL | null {
	try {
		return new URL(raw);
	} catch {
		return null;
	}
}

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
	if (raw === null) return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(n)));
}
