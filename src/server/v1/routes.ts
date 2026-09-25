import type { FeedHealth } from "../../core/health.ts";
import type { Store, StoredObservation } from "../../core/store.ts";
import type { Adapter, Json } from "../../core/types.ts";
import { incidentHistory } from "../../intel/archive.ts";
import { CHAIN_FORMAT, chain } from "../../intel/chain.ts";
import type { IncidentsView } from "../../panels/incidents.ts";
import type { Mode } from "../config.ts";
import type { ConnectivityHistory, HistoryService } from "../history.ts";
import type { PanelCache } from "../panels.ts";
import { RateLimiter } from "../ratelimit.ts";
import { decodeSegment } from "../uri.ts";
import { type Cell, iso, toCsv } from "./csv.ts";
import { type FigureRow, panelFigures } from "./figures.ts";
import { type CorsPolicy, FirstSeen, fail, preflight, send, wantsCsv, weakEtag } from "./http.ts";
import { OPERATIONS, openApiDocument } from "./openapi.ts";
import { API_VERSION } from "./schemas.ts";

/**
 * The public read API, version 1 (`/api/v1/…`). Read-only, versioned, documented by an OpenAPI 3.1 document generated
 * from the response schemas, cacheable (weak ETag, Last-Modified, 304), CORS for reads when configured, and rate
 * limited per client. It never exposes keys, settings or the rows of sources whose terms forbid redistribution
 * (`licence.raw === false`): those appear only through what Vigía derives from them (panels, figures, history).
 */

export interface V1Deps {
	readonly store: Store;
	/** Panels served by v1 (the app passes the built-in ones only, never the user's own "user-news"). */
	readonly panels: Pick<PanelCache, "panels" | "get">;
	readonly adapters: readonly Adapter[];
	readonly health: () => FeedHealth[];
	readonly history: HistoryService;
	readonly version: string;
	readonly mode: Mode;
	readonly cors: boolean;
	readonly now: () => number;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_WINDOW_MS = 400 * DAY;
const MAX_SERIES_ROWS = 5_000;
const NO_RAW =
	"Los términos de esta fuente no permiten redistribuir sus datos; Vigía solo publica resultados derivados (paneles y cifras).";
const SLOW = "Demasiadas solicitudes. Espera un momento.";

const OBS_HEADER = [
	"source",
	"series",
	"observed_at",
	"fetched_at",
	"value",
	"source_url",
	"licence",
	"licence_url",
	"attribution",
	"confidence",
	"basis",
	"lat",
	"lon",
	"state",
	"place",
] as const;

const FIG_HEADER = [
	"panel",
	"path",
	"label",
	"value",
	"feed",
	"source_url",
	"observed_at",
	"fetched_at",
	"stale",
	"licence",
	"licence_url",
	"attribution",
	"panel_sources",
] as const;

export type V1Handler = (request: Request, url: URL, ip: string) => Promise<Response>;

export function createV1(deps: V1Deps): V1Handler {
	const cors: CorsPolicy = { enabled: deps.cors };
	const adapterById = new Map(deps.adapters.map((a) => [a.id, a]));
	const panelsOf = new Map<string, string[]>();
	for (const p of deps.panels.panels)
		for (const s of p.sources) panelsOf.set(s, [...(panelsOf.get(s) ?? []), p.id]);
	const firstSeen = new FirstSeen();
	// Per client: a burst of 120 and 2 a second; exports and replays cost more tokens.
	const limiter = new RateLimiter(120, 2, deps.now);
	const everyone = new RateLimiter(1_000, 50, deps.now);

	const envelope = (data: Record<string, unknown>) => ({
		apiVersion: API_VERSION,
		generatedAt: deps.now(),
		...data,
	});

	/** A JSON answer with validators; `lastModified` null: first time this server produced this content. */
	const jsonAnswer = (
		request: Request,
		resource: string,
		data: Record<string, unknown>,
		lastModified: number | null,
		maxAge = 30,
		/** What the validator follows, when not all of `data` (a moving window's bounds, a computation time). */
		validated: unknown = data,
	): Response => {
		const content = JSON.stringify(validated);
		const etag = weakEtag(`json|${content}`);
		const t = deps.now();
		return send(
			request,
			{
				body: JSON.stringify(envelope(data)),
				contentType: "application/json; charset=utf-8",
				etag,
				lastModified: lastModified ?? firstSeen.at(resource, etag, t),
				maxAge,
			},
			cors,
		);
	};

	const csvAnswer = (
		request: Request,
		resource: string,
		filename: string,
		csv: string,
		lastModified: number | null,
		maxAge = 30,
	): Response => {
		const etag = weakEtag(`csv|${csv}`);
		return send(
			request,
			{
				body: csv,
				contentType: "text/csv; charset=utf-8; header=present",
				etag,
				lastModified: lastModified ?? firstSeen.at(`${resource}|csv`, etag, deps.now()),
				maxAge,
				headers: { "content-disposition": `attachment; filename="${filename}"` },
			},
			cors,
		);
	};

	const stamp = () => new Date(deps.now()).toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");

	const sourceMeta = (a: Adapter) => ({
		id: a.id,
		layer: a.layer,
		name: { es: a.name.es, en: a.name.en },
		provider: a.provider,
		homepage: a.homepage,
		licence: {
			id: a.licence.id,
			name: a.licence.name,
			url: a.licence.url,
			attribution: a.licence.attribution,
			commercial: a.licence.commercial,
			raw: a.licence.raw !== false,
		},
		keys: [...a.keys],
		intervalMs: a.intervalMs,
		freshness: { fetchMs: a.freshness.fetchMs, dataMs: a.freshness.dataMs },
		optIn: a.optIn ? { es: a.optIn.es, en: a.optIn.en } : null,
		note: a.note ? { es: a.note.es, en: a.note.en } : null,
		panels: panelsOf.get(a.id) ?? [],
		rawAvailable: a.licence.raw !== false,
	});

	const obsJson = (o: StoredObservation) => {
		const out: Record<string, unknown> = {
			source: o.source,
			series: o.series,
			observedAt: o.observedAt,
			fetchedAt: o.fetchedAt,
			value: o.value,
			sourceUrl: o.sourceUrl,
			licence: o.licence,
			confidence: o.confidence,
			basis: o.basis,
		};
		if (o.location) out.location = o.location;
		return out;
	};

	const obsRow = (o: StoredObservation): Cell[] => {
		const a = adapterById.get(o.source);
		return [
			o.source,
			o.series,
			iso(o.observedAt),
			iso(o.fetchedAt),
			typeof o.value === "number" || typeof o.value === "string" ? o.value : JSON.stringify(o.value),
			o.sourceUrl,
			o.licence,
			a?.licence.url,
			a?.licence.attribution,
			o.confidence,
			o.basis,
			o.location?.lat,
			o.location?.lon,
			o.location?.state,
			o.location?.place,
		];
	};

	const figRow = (f: FigureRow): Cell[] => [
		f.panel,
		f.path,
		f.label,
		f.value,
		f.feed,
		f.sourceUrl,
		iso(f.observedAt),
		iso(f.fetchedAt),
		f.stale,
		f.licence,
		f.licenceUrl,
		f.attribution,
		f.panelSources.join(" "),
	];

	const figuresOf = (id: string): FigureRow[] | null => {
		const panel = deps.panels.panels.find((p) => p.id === id);
		if (!panel) return null;
		return panelFigures(panel.id, deps.panels.get(panel.id), panel.sources, adapterById);
	};

	const figures = (request: Request, url: URL, resource: string, rows: FigureRow[], name: string) => {
		const cap = 50_000;
		const truncated = rows.length > cap;
		const kept = truncated ? rows.slice(0, cap) : rows;
		if (wantsCsv(request, url))
			return csvAnswer(
				request,
				resource,
				`vigia-cifras-${name}-${stamp()}.csv`,
				toCsv(FIG_HEADER, kept.map(figRow)),
				null,
			);
		return jsonAnswer(request, resource, { figures: kept, truncated }, null);
	};

	const rawGate = (id: string): Response | null => {
		const a = adapterById.get(id);
		if (!a) return fail(404, "Fuente desconocida.", cors);
		if (a.licence.raw === false) return fail(403, NO_RAW, cors);
		return null;
	};

	const intParam = (url: URL, name: string, min: number, max: number, fallback: number): number | null => {
		const raw = url.searchParams.get(name);
		if (raw === null || raw === "") return fallback;
		if (!/^-?\d{1,16}$/.test(raw)) return null;
		return Math.min(max, Math.max(min, Number(raw)));
	};

	const counts = (health: readonly FeedHealth[]) => {
		const out: Record<string, number> = {};
		for (const h of health) out[h.state] = (out[h.state] ?? 0) + 1;
		return out;
	};

	return async (request, url, ip) => {
		const method = request.method;
		if (method === "OPTIONS") return preflight(cors);
		if (method !== "GET" && method !== "HEAD")
			return fail(405, "La API pública es de solo lectura.", cors, { allow: "GET, HEAD, OPTIONS" });
		const path = url.pathname.replace(/\/+$/, "") || "/";
		const heavy = /\/(figures|series|history)(\/|$)/.test(path) || wantsCsv(request, url) ? 5 : 1;
		if (!limiter.take(ip, heavy) || !everyone.take("all", heavy))
			return fail(429, SLOW, cors, { "retry-after": "5" });
		const format = url.searchParams.get("format");
		if (format !== null && !/^(json|csv)$/i.test(format))
			return fail(400, "format debe ser json o csv.", cors);

		if (path === "/api/v1") {
			return jsonAnswer(
				request,
				path,
				{
					name: "Vigía",
					version: deps.version,
					mode: deps.mode,
					docs: "/api",
					openapi: "/api/v1/openapi.json",
					endpoints: OPERATIONS.map((o) => ({ path: o.path, summary: o.summary })),
				},
				null,
				300,
			);
		}
		if (path === "/api/v1/openapi.json") {
			const doc = JSON.stringify(openApiDocument(deps.version));
			return send(
				request,
				{
					body: doc,
					contentType: "application/json; charset=utf-8",
					etag: weakEtag(doc),
					lastModified: firstSeen.at(path, weakEtag(doc), deps.now()),
					maxAge: 3_600,
				},
				cors,
			);
		}
		if (path === "/api/v1/sources") {
			return jsonAnswer(request, path, { sources: deps.adapters.map(sourceMeta) }, null, 300);
		}
		if (path === "/api/v1/health") {
			const health = deps.health();
			return jsonAnswer(request, path, { counts: counts(health), feeds: health }, null, 15);
		}
		if (path === "/api/v1/panels") {
			return jsonAnswer(
				request,
				path,
				{
					panels: deps.panels.panels.map((p) => ({
						id: p.id,
						sources: [...p.sources],
						links: {
							self: `/api/v1/panels/${p.id}`,
							figures: `/api/v1/panels/${p.id}/figures`,
							csv: `/api/v1/panels/${p.id}/figures?format=csv`,
						},
					})),
				},
				null,
				300,
			);
		}
		if (path === "/api/v1/figures") {
			const rows = deps.panels.panels.flatMap((p) => figuresOf(p.id) ?? []);
			return figures(request, url, path, rows, "todas");
		}
		if (path === "/api/v1/incidents") {
			const view = deps.panels.get("incidents") as IncidentsView | undefined;
			if (!view)
				return fail(503, "Los incidentes no están disponibles ahora.", cors, { "retry-after": "30" });
			return jsonAnswer(
				request,
				path,
				{ asOf: view.asOf, counts: view.counts, incidents: view.incidents, rules: view.rules },
				null,
			);
		}
		if (path === "/api/v1/history/connectivity") {
			const r = await deps.history.handle("connectivity", url.searchParams);
			if (r.status !== 200) {
				const message =
					r.body && typeof r.body === "object" && "error" in r.body ? String(r.body.error) : "Error.";
				return fail(r.status, message, cors, r.retryAfter ? { "retry-after": String(r.retryAfter) } : {});
			}
			const h = r.body as ConnectivityHistory;
			if (wantsCsv(request, url)) {
				const rows: Cell[][] = [];
				const levels: Record<string, string> = { n: "normal", d: "drop", s: "severe", x: "no-data" };
				for (const [state, codes] of Object.entries(h.states))
					h.times.forEach((t, i) => {
						rows.push([
							iso(t),
							state,
							levels[codes[i] ?? "x"] ?? "no-data",
							h.step,
							h.feed,
							h.sourceUrl,
							h.licence,
							h.attribution,
							iso(h.computedAt),
						]);
					});
				const header = [
					"time",
					"state",
					"level",
					"step",
					"feed",
					"source_url",
					"licence",
					"attribution",
					"computed_at",
				];
				return csvAnswer(
					request,
					`${path}${url.search}`,
					`vigia-conectividad-${h.step}-${stamp()}.csv`,
					toCsv(header, rows),
					null,
					60,
				);
			}
			// computedAt changes on every recomputation; the content (levels) is what the validator follows.
			return jsonAnswer(request, `${path}${url.search}`, { history: h }, null, 60, { ...h, computedAt: 0 });
		}
		if (path === "/api/v1/archive/digests") {
			const day = /^\d{4}-\d{2}-\d{2}$/;
			const from = url.searchParams.get("from");
			const to = url.searchParams.get("to");
			if ((from !== null && !day.test(from)) || (to !== null && !day.test(to)))
				return fail(400, "Fechas en formato AAAA-MM-DD.", cors);
			const entries = chain(deps.store, from ?? "0000-00-00", to ?? "9999-99-99");
			return jsonAnswer(
				request,
				`${path}${url.search}`,
				{
					format: CHAIN_FORMAT,
					method:
						"Cada día UTC de observaciones recibidas se sella en un árbol de Merkle (SHA-256) y se encadena al día anterior. Compruébelo con: vigia verify",
					head: (entries.at(-1) ?? null) as unknown as Json,
					entries: entries as unknown as Json[],
				},
				null,
				300,
			);
		}

		const incident = /^\/api\/v1\/incidents\/([\w:.+-]{1,200})$/.exec(path);
		if (incident?.[1]) {
			const id = incident[1];
			const view = deps.panels.get("incidents") as IncidentsView | undefined;
			const history = incidentHistory(deps.store, id, deps.now());
			const listed = view?.incidents.find((i) => i.id === id) ?? null;
			if (!listed && history.length === 0) return fail(404, "Incidente desconocido.", cors);
			const revisions = history.map((i) => ({
				lastEvidenceAt: i.lastEvidenceAt,
				startAt: i.startAt,
				families: i.families,
				corroboration: i.corroboration,
				reportsOnly: i.reportsOnly,
				evidenceTotal: i.evidenceTotal,
				evidence: i.evidence.map((e) => e.id),
			}));
			return jsonAnswer(
				request,
				path,
				{
					incident: listed ?? history.at(-1) ?? null,
					history: revisions,
					rules: view?.rules ?? { es: [], en: [] },
				},
				null,
			);
		}

		const panelFig = /^\/api\/v1\/panels\/([\w-]{1,80})\/figures$/.exec(path);
		if (panelFig?.[1]) {
			const rows = figuresOf(panelFig[1]);
			if (!rows) return fail(404, "Panel desconocido.", cors);
			return figures(request, url, path, rows, panelFig[1]);
		}

		const panel = /^\/api\/v1\/panels\/([\w-]{1,80})$/.exec(path);
		if (panel?.[1]) {
			const p = deps.panels.panels.find((x) => x.id === panel[1]);
			const value = p ? deps.panels.get(p.id) : undefined;
			if (!p || value === undefined) return fail(404, "Panel desconocido.", cors);
			return jsonAnswer(request, path, { id: p.id, sources: [...p.sources], panel: value }, null);
		}

		const one = /^\/api\/v1\/sources\/([\w.-]{1,80})$/.exec(path);
		if (one?.[1]) {
			const a = adapterById.get(one[1]);
			const h = deps.health().find((x) => x.id === one[1]);
			if (!a || !h) return fail(404, "Fuente desconocida.", cors);
			return jsonAnswer(request, path, { source: sourceMeta(a), health: h }, null, 15);
		}

		const list = /^\/api\/v1\/sources\/([\w.-]{1,80})\/series$/.exec(path);
		if (list?.[1]) {
			const refusal = rawGate(list[1]);
			if (refusal) return refusal;
			const since = intParam(url, "since", 0, Number.MAX_SAFE_INTEGER, 0);
			const limit = intParam(url, "limit", 1, 1_000, 200);
			if (since === null || limit === null) return fail(400, "since y limit deben ser enteros.", cors);
			const rows = deps.store.latestPerSeries(list[1], since, limit);
			const newest = rows.reduce((m, o) => Math.max(m, o.fetchedAt), 0) || null;
			if (wantsCsv(request, url))
				return csvAnswer(
					request,
					`${path}${url.search}`,
					`vigia-${list[1]}-series-${stamp()}.csv`,
					toCsv(OBS_HEADER, rows.map(obsRow)),
					newest,
				);
			return jsonAnswer(
				request,
				`${path}${url.search}`,
				{ source: list[1], observations: rows.map(obsJson) },
				newest,
			);
		}

		const series = /^\/api\/v1\/sources\/([\w.-]{1,80})\/series\/([^/]{1,300})$/.exec(path);
		if (series?.[1] && series[2]) {
			const refusal = rawGate(series[1]);
			if (refusal) return refusal;
			const name = decodeSegment(series[2]);
			if (name === null) return fail(400, "Serie no válida.", cors);
			const to = intParam(url, "to", 0, Number.MAX_SAFE_INTEGER, deps.now());
			if (to === null) return fail(400, "to debe ser un entero (Unix ms).", cors);
			const from = intParam(url, "from", to - MAX_WINDOW_MS, to, to - 7 * DAY);
			if (from === null) return fail(400, "from debe ser un entero (Unix ms).", cors);
			const rows = deps.store.history(series[1], name, from, to, MAX_SERIES_ROWS + 1);
			const truncated = rows.length > MAX_SERIES_ROWS;
			const kept = truncated ? rows.slice(0, MAX_SERIES_ROWS) : rows;
			const newest = kept.reduce((m, o) => Math.max(m, o.fetchedAt), 0) || null;
			if (wantsCsv(request, url)) {
				const safe = name.replace(/[^\w.-]/g, "_").slice(0, 60);
				return csvAnswer(
					request,
					`${path}${url.search}`,
					`vigia-${series[1]}-${safe}-${stamp()}.csv`,
					toCsv(OBS_HEADER, kept.map(obsRow)),
					newest,
				);
			}
			return jsonAnswer(
				request,
				`${path}${url.search}`,
				{ source: series[1], series: name, from, to, observations: kept.map(obsJson), truncated },
				newest,
				30,
				// The default window moves with the clock; the rows are what a client revalidates.
				{ source: series[1], series: name, rows: kept.map((o) => o.id), truncated },
			);
		}

		return fail(404, "Ruta desconocida. Consulta /api para ver la documentación.", cors);
	};
}
