import { type GoesFrame, goesNsa, LOOP_FRAMES } from "../adapters/goes-nsa/index.ts";
import type { Store } from "../core/store.ts";
import type { Bounds } from "../imaging/frame.ts";
import type { Panel } from "../server/panels.ts";

/** Frames further than this before the newest one are not part of the loop. */
const LOOP_WINDOW_MS = LOOP_FRAMES * 10 * 60_000 + 5 * 60_000;

export const NIGHT_NOTE =
	"De noche, GeoColor muestra las nubes en infrarrojo sobre una capa fija de luces de ciudades: esas luces no son en vivo y no indican apagones.";

export type SatelliteFrameView = {
	key: string;
	/** Same-origin image URL. */
	url: string;
	/** Scan start (epoch ms). */
	observedAt: number;
	fetchedAt: number;
	lighting: "day" | "night" | "mixed";
	/** Any part of this frame is at night: its city lights are NOAA's fixed layer, not a live signal. */
	staticCityLights: boolean;
	/** The original frame at NOAA. */
	sourceUrl: string;
};

export type SatelliteView = {
	feed: string;
	product: string;
	attribution: string;
	homepage: string;
	/** Image bounds (plate carrée, pixel edges): stretch every frame to them. */
	bounds: Bounds | null;
	width: number | null;
	height: number | null;
	/** Oldest first, at most 24 (4 hours at one frame every 10 minutes). */
	frames: SatelliteFrameView[];
	newest: SatelliteFrameView | null;
	/** now − newest scan start, at compute time. */
	newestAgeMs: number | null;
	/** Shown whenever any frame of the loop has night in it. */
	nightNote: string | null;
};

export function satelliteView(store: Store, now: number): SatelliteView {
	const history = store.history<GoesFrame>(goesNsa.id, "geocolor", now - 24 * 3_600_000, now, 1_000);
	// One frame per scan time; a later revision (reprocessed) replaces an earlier one.
	const byScan = new Map<number, (typeof history)[number]>();
	for (const o of history) byScan.set(o.observedAt, o);
	const all = [...byScan.values()].sort((a, b) => a.observedAt - b.observedAt);
	const newestAt = all.at(-1)?.observedAt ?? 0;
	const frames: SatelliteFrameView[] = all
		.filter((o) => o.observedAt > newestAt - LOOP_WINDOW_MS)
		.slice(-LOOP_FRAMES)
		.map((o) => ({
			key: o.value.key,
			url: `/api/blobs/${goesNsa.id}/${o.value.key}`,
			observedAt: o.observedAt,
			fetchedAt: o.fetchedAt,
			lighting: o.value.lighting,
			staticCityLights: o.value.staticCityLights,
			sourceUrl: o.sourceUrl,
		}));
	const newest = frames.at(-1) ?? null;
	const newestValue = all.at(-1)?.value ?? null;
	return {
		feed: goesNsa.id,
		product: "GOES-19 ABI GeoColor",
		attribution: "NOAA/NESDIS/STAR, GOES-19",
		homepage: goesNsa.homepage,
		bounds: newestValue ? { ...newestValue.bounds } : null,
		width: newestValue?.width ?? null,
		height: newestValue?.height ?? null,
		frames,
		newest,
		newestAgeMs: newest ? now - newest.observedAt : null,
		nightNote: frames.some((f) => f.staticCityLights) ? NIGHT_NOTE : null,
	};
}

export const satellitePanel: Panel<SatelliteView> = {
	id: "satellite",
	sources: [goesNsa.id],
	compute: (store: Store, now: number) => satelliteView(store, now),
};
