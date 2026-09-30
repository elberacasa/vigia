/**
 * The entity routes of the read API (v1): search, one entity, its timeline, and "what is at this point".
 *
 *   GET /api/v1/entities?q=&type=&limit=          search by name, alias or code (or list one type without q)
 *   GET /api/v1/entities/{id}                     the entity page as data (src/ontology/view.ts EntityView)
 *   GET /api/v1/entities/{id}/timeline?from=&to=&limit=   events linked to it in the archive
 *   GET /api/v1/locate?lat=&lon=                  parish, municipality and state of a point, facilities near it
 *
 * Same rules as the rest of v1: read-only, rate-limited by the caller (the timeline counts as a heavy request),
 * cacheable, and never the raw rows of a source whose terms forbid it (timeline items from those sources carry a
 * summary and a link, no figures).
 */
import {
	type EntityContext,
	entityView,
	locateView,
	refOf,
	searchView,
	TIMELINE_KINDS,
	TIMELINE_MAX,
	timelineView,
} from "../../ontology/entity-view.ts";
import type { LinkIndex } from "../../ontology/links-store.ts";
import { ENTITY_TYPES, type EntityType } from "../../ontology/types.ts";

const DAY = 86_400_000;
/** The longest timeline window one request may ask for. */
const MAX_TIMELINE_WINDOW_MS = 400 * DAY;
/** Work the link index may do inside a request to catch up with new rows (the rest runs in the background). */
const SYNC_BUDGET_MS = 30;

export interface EntityRouteHelpers {
	json(
		request: Request,
		resource: string,
		data: Record<string, unknown>,
		lastModified: number | null,
		maxAge?: number,
		validated?: unknown,
	): Response;
	fail(status: number, message: string, extra?: Record<string, string>): Response;
	intParam(url: URL, name: string, min: number, max: number, fallback: number): number | null;
}

export interface EntityRouteDeps {
	readonly context: () => EntityContext;
	readonly links: LinkIndex;
	readonly now: () => number;
}

const ID = /^\/api\/v1\/entities\/([a-z0-9][a-z0-9.-]{0,150})(\/timeline)?$/;

/** Links whatever arrived since the last request, within a small time budget. */
function catchUp(links: LinkIndex): void {
	const started = performance.now();
	for (const _ of links.syncSteps(2_000, SYNC_BUDGET_MS))
		if (performance.now() - started >= SYNC_BUDGET_MS) break;
}

export function entityRoutes(
	deps: EntityRouteDeps,
	h: EntityRouteHelpers,
): (request: Request, url: URL, path: string) => Response | null {
	return (request, url, path) => {
		if (path === "/api/v1/entities") {
			const q = (url.searchParams.get("q") ?? "").trim();
			const type = url.searchParams.get("type");
			if (q.length > 100) return h.fail(400, "q admite hasta 100 caracteres.");
			if (type !== null && !ENTITY_TYPES.includes(type as EntityType))
				return h.fail(400, `type debe ser uno de: ${ENTITY_TYPES.join(", ")}.`);
			const limit = h.intParam(url, "limit", 1, q ? 50 : 500, 20);
			if (limit === null) return h.fail(400, "limit debe ser un entero.");
			if (!q && type === null) return h.fail(400, "Indica q (texto a buscar) o type (para listar un tipo).");
			const ctx = deps.context();
			const all = q ? [] : ctx.registry.all.filter((e) => e.type === type);
			const view = q
				? searchView(ctx.registry, q, (type as EntityType | null) ?? null, limit)
				: {
						query: "",
						type: type as EntityType,
						truncated: all.length > limit,
						results: all.slice(0, limit).map((e) => {
							const parent = ctx.registry.get(e.parents[0] ?? "");
							return { entity: refOf(e), parent: parent ? refOf(parent) : null, score: 0, matched: "" };
						}),
					};
			return h.json(request, `${path}${url.search}`, view, null, 300);
		}

		if (path === "/api/v1/locate") {
			const lat = Number(url.searchParams.get("lat"));
			const lon = Number(url.searchParams.get("lon"));
			const raw = [url.searchParams.get("lat"), url.searchParams.get("lon")];
			if (raw.some((x) => x === null || x.trim() === "") || !Number.isFinite(lat) || !Number.isFinite(lon))
				return h.fail(400, "lat y lon deben ser números.");
			if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return h.fail(400, "lat o lon fuera de rango.");
			const r = (x: number) => Math.round(x * 1e5) / 1e5;
			const ctx = deps.context();
			return h.json(
				request,
				`${path}?lat=${r(lat)}&lon=${r(lon)}`,
				locateView(ctx, r(lat), r(lon)),
				null,
				3_600,
			);
		}

		const m = ID.exec(path);
		if (!m?.[1]) return null;
		const id = m[1];
		const ctx = deps.context();
		if (!ctx.registry.get(id)) return h.fail(404, "Entidad desconocida. Búscala en /api/v1/entities?q=…");
		catchUp(deps.links);

		if (m[2]) {
			const now = deps.now();
			const to = h.intParam(url, "to", 0, Number.MAX_SAFE_INTEGER, now);
			if (to === null) return h.fail(400, "to debe ser un entero (Unix ms).");
			const from = h.intParam(url, "from", to - MAX_TIMELINE_WINDOW_MS, to, to - 7 * DAY);
			if (from === null) return h.fail(400, "from debe ser un entero (Unix ms).");
			const limit = h.intParam(url, "limit", 1, TIMELINE_MAX, 100);
			if (limit === null) return h.fail(400, "limit debe ser un entero.");
			const kinds = url.searchParams.get("kinds")?.split(",").filter(Boolean);
			const unknown = kinds?.filter((k) => !Object.hasOwn(TIMELINE_KINDS, k)) ?? [];
			if (unknown.length) return h.fail(400, `kinds admite: ${Object.keys(TIMELINE_KINDS).join(", ")}.`);
			const view = timelineView(ctx, id, from, to, limit, kinds);
			if (!view) return h.fail(404, "Entidad desconocida.");
			const newest = view.items.reduce((x, i) => Math.max(x, i.fetchedAt), 0) || null;
			return h.json(request, `${path}${url.search}`, view, newest, 30, {
				// The default window moves with the clock; the items are what a client revalidates.
				// A revision (a quake's new magnitude) keeps its link and time but changes its title or figures.
				items: view.items.map((i) => [i.url, i.observedAt, i.rule, i.title.es, i.figures]),
				truncated: view.truncated,
				backlog: view.backlog,
			});
		}

		const view = entityView(ctx, id);
		if (!view) return h.fail(404, "Entidad desconocida.");
		// `asOf` changes on every request; the content is what the validator follows.
		return h.json(request, path, view, null, 30, { ...view, asOf: 0 });
	};
}
