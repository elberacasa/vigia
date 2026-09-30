/**
 * The pictures of the read API (v1): the time machine's stills and one camera's strip.
 *
 *   GET /api/v1/stills?at=                          TV frames, YouTube thumbnails and camera stills at a moment
 *   GET /api/v1/cameras/{id}/stills?from=&to=&limit=  one camera's stills in a window (≤ 3 days), oldest first
 *
 * Same rules as the rest of v1: read-only, rate-limited (both count as heavy requests), cacheable. The images
 * themselves are served by /api/blobs/… from this server; nothing here points the browser at a third party.
 */
import type { Store } from "../../core/store.ts";
import { cameraStrip, stillsView } from "../../panels/stills.ts";
import type { EntityRouteHelpers } from "./entities.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_LOOKBACK_MS = 400 * DAY;
const MAX_STRIP_MS = 3 * DAY;
const CAMERA = /^\/api\/v1\/cameras\/([a-z0-9-]{1,60})\/stills$/;

export interface StillsRouteDeps {
	readonly store: Store;
	readonly now: () => number;
}

export function stillsRoutes(
	deps: StillsRouteDeps,
	h: EntityRouteHelpers,
): (request: Request, url: URL, path: string) => Response | null {
	return (request, url, path) => {
		if (path === "/api/v1/stills") {
			const now = deps.now();
			const at = h.intParam(url, "at", now - MAX_LOOKBACK_MS, now, now);
			if (at === null)
				return h.fail(400, "at debe ser un entero (Unix ms); se acota a los últimos 400 días.");
			const view = stillsView(deps.store, at);
			// A moment over an hour back no longer changes (every round of it is stored); a recent one may.
			const past = at < now - 3_600_000;
			return h.json(request, `${path}${url.search}`, view, null, past ? 300 : 30);
		}
		const m = CAMERA.exec(path);
		if (!m?.[1]) return null;
		const now = deps.now();
		const to = h.intParam(url, "to", 0, now, now);
		if (to === null) return h.fail(400, "to debe ser un entero (Unix ms).");
		const from = h.intParam(url, "from", to - MAX_STRIP_MS, to, to - 6 * HOUR);
		if (from === null)
			return h.fail(400, "from debe ser un entero (Unix ms); se acota a 3 días antes de to.");
		const limit = h.intParam(url, "limit", 1, 500, 200);
		if (limit === null) return h.fail(400, "limit debe ser un entero (se acota a 1–500).");
		const strip = cameraStrip(deps.store, m[1], from, to, limit);
		if (!strip) return h.fail(404, "Cámara desconocida. Ver /api/v1/panels/cameras.");
		return h.json(request, `${path}${url.search}`, { ...strip, from, to }, null, 60);
	};
}
