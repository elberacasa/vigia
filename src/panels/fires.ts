import {
	FIRMS_LICENCE,
	type FireDetection,
	type FireFile,
	type FirmsValue,
	NEAR_BORDER_KM,
} from "../adapters/firms-fires/index.ts";
import persistentJson from "../adapters/firms-fires/persistent-sources.json" with { type: "json" };
import type { Store, StoredObservation } from "../core/store.ts";
import { distanceKm, stateByIso, states } from "../geo/index.ts";
import type { Panel } from "../server/panels.ts";

/**
 * Fires: VIIRS NOAA-20 hot-pixel detections in the last 24 h and 48 h, per state, counted in code.
 *
 * Gas flares and industry: oil fields in Monagas and Anzoátegui, the Paraguaná and El Palito refineries and other
 * plants are hot every night, and would otherwise dominate the counts. `persistent-sources.json` lists places
 * with detections on ≥ 4 of 8 days in a 7-day file (derive-persistent.ts); from the 2026-09-17..24 file it found
 * 42, of which 18 in Monagas, 13 in Anzoátegui, 3 in Falcón, and 81 of the largest source's 96 detections were at
 * night, as a flare's are and a vegetation fire's are not. A detection within the source's radius + 1 km (a VIIRS
 * I-band pixel is 375 m at nadir and ~800 m at the swath edge, plus geolocation error) is labelled "persistent"
 * and counted separately. The label is "probable flare or industry", never "not a fire".
 */

const FEED = "firms-fires";
const HOUR = 3_600_000;
/** Margin added to each persistent source's radius, km (see above). */
export const PERSISTENT_MARGIN_KM = 1;

type PersistentSource = {
	id: string;
	lat: number;
	lon: number;
	radiusKm: number;
	days: number;
	detections: number;
	nightDetections: number;
	state: string | null;
	country: string | null;
};

const PERSISTENT = persistentJson as unknown as {
	derivedFrom: string;
	dates: string[];
	rule: string;
	sources: PersistentSource[];
};

/** The persistent source a detection belongs to, if any. */
export function persistentSourceFor(
	lat: number,
	lon: number,
	sources: readonly PersistentSource[] = PERSISTENT.sources,
): string | null {
	for (const s of sources) {
		if (Math.abs(s.lat - lat) > 0.1 || Math.abs(s.lon - lon) > 0.1) continue;
		if (distanceKm(lat, lon, s.lat, s.lon) <= s.radiusKm + PERSISTENT_MARGIN_KM) return s.id;
	}
	return null;
}

export type FireCounts = {
	last24h: number;
	last48h: number;
	/** Of last24h: at a persistent heat source (probable flare or industry). */
	persistent24h: number;
	/** Of last24h: FIRMS confidence class "low". */
	lowConfidence24h: number;
};

export type FireStateRow = FireCounts & {
	stateIso: string;
	stateName: string;
	/** last24h minus persistent24h: the figure the ranking uses. */
	likelyFires24h: number;
};

export type FirePoint = {
	at: number;
	lat: number;
	lon: number;
	stateIso: string | null;
	placeEs: string;
	frpMW: number;
	confidenceClass: string;
	daynight: string;
	persistentSource: string | null;
	url: string;
};

export type FiresView = {
	venezuela: FireCounts;
	/** Every state (all 25), sorted by likelyFires24h, then last24h. */
	byState: FireStateRow[];
	/** States with at least one likely fire in 24 h, top 5. */
	topStates: FireStateRow[];
	/** Outside Venezuela within NEAR_BORDER_KM, by country ("mar" for the sea). */
	nearBorder: { country: string; last24h: number; last48h: number }[];
	/** Highest radiative power in 24 h in Venezuela, persistent sources excluded, top 10. */
	strongest: FirePoint[];
	file: {
		product: string;
		oldestAcqAt: number;
		newestAcqAt: number;
		spanHours: number;
		fetchedAt: number;
		noteEs: string;
	} | null;
	persistent: { count: number; derivedFrom: string; dates: string[]; rule: string; noteEs: string };
	newestDetectionAt: number | null;
	nearBorderKm: number;
	feed: string;
	sourceUrl: string;
	attribution: string;
	licence: string;
};

const emptyCounts = (): FireCounts => ({ last24h: 0, last48h: 0, persistent24h: 0, lowConfidence24h: 0 });

export function firesView(store: Store, now: number): FiresView {
	const all = store.latestPerSeries<FirmsValue>(FEED, now - 48 * HOUR, 50_000);
	const detections = all.filter(
		(o): o is StoredObservation<FireDetection> => o.value.kind === "detection" && o.observedAt <= now,
	);
	const fileObs = store.latest<FirmsValue>(FEED, "firms:file");
	const file = fileObs && fileObs.value.kind === "file" ? (fileObs as StoredObservation<FireFile>) : null;

	const ve = emptyCounts();
	const perState = new Map<string, FireCounts>(states().map((s) => [s.iso, emptyCounts()]));
	const near = new Map<string, { last24h: number; last48h: number }>();
	const strongest: FirePoint[] = [];
	let newest: number | null = null;

	for (const o of detections) {
		const v = o.value;
		const in24 = o.observedAt >= now - 24 * HOUR;
		const lat = o.location?.lat ?? 0;
		const lon = o.location?.lon ?? 0;
		if (!v.inVenezuela) {
			const key = v.country ?? "mar";
			const c = near.get(key) ?? { last24h: 0, last48h: 0 };
			c.last48h++;
			if (in24) c.last24h++;
			near.set(key, c);
			continue;
		}
		newest = newest === null ? o.observedAt : Math.max(newest, o.observedAt);
		const persistent = persistentSourceFor(lat, lon);
		const state = o.location?.state ?? null;
		for (const c of [ve, state ? perState.get(state) : undefined]) {
			if (!c) continue;
			c.last48h++;
			if (!in24) continue;
			c.last24h++;
			if (persistent) c.persistent24h++;
			if (v.confidenceClass === "low") c.lowConfidence24h++;
		}
		if (in24 && !persistent) {
			strongest.push({
				at: o.observedAt,
				lat,
				lon,
				stateIso: state,
				placeEs: v.placeEs,
				frpMW: v.frpMW,
				confidenceClass: v.confidenceClass,
				daynight: v.daynight,
				persistentSource: null,
				url: o.sourceUrl,
			});
		}
	}

	const byState: FireStateRow[] = [...perState].map(([iso, c]) => ({
		stateIso: iso,
		stateName: stateByIso(iso)?.name ?? iso,
		...c,
		likelyFires24h: c.last24h - c.persistent24h,
	}));
	byState.sort(
		(a, b) =>
			b.likelyFires24h - a.likelyFires24h ||
			b.last24h - a.last24h ||
			a.stateName.localeCompare(b.stateName, "es"),
	);
	strongest.sort((a, b) => b.frpMW - a.frpMW || b.at - a.at);

	return {
		venezuela: ve,
		byState,
		topStates: byState.filter((s) => s.likelyFires24h > 0).slice(0, 5),
		nearBorder: [...near]
			.map(([country, c]) => ({ country, ...c }))
			.sort((a, b) => b.last24h - a.last24h || a.country.localeCompare(b.country, "es")),
		strongest: strongest.slice(0, 10),
		file: file
			? {
					product: file.value.product,
					oldestAcqAt: file.value.oldestAcqAt,
					newestAcqAt: file.value.newestAcqAt,
					spanHours: Math.round(((file.value.newestAcqAt - file.value.oldestAcqAt) / HOUR) * 10) / 10,
					fetchedAt: file.fetchedAt,
					noteEs:
						"El archivo «24h» de FIRMS empieza a las 00:00 UTC de ayer, así que cubre hasta ~47 h; Vigía cuenta por hora de adquisición.",
				}
			: null,
		persistent: {
			count: PERSISTENT.sources.length,
			derivedFrom: PERSISTENT.derivedFrom,
			dates: PERSISTENT.dates,
			rule: PERSISTENT.rule,
			noteEs:
				"Focos en lugares calientes casi todos los días (mechurrios de gas, refinerías, industria): se cuentan aparte como «persistentes». No prueba que no haya incendio.",
		},
		newestDetectionAt: newest,
		nearBorderKm: NEAR_BORDER_KM,
		feed: FEED,
		sourceUrl: "https://firms.modaps.eosdis.nasa.gov/map/",
		attribution: FIRMS_LICENCE.attribution,
		licence: FIRMS_LICENCE.id,
	};
}

export const firesPanel: Panel<FiresView> = {
	id: "fires",
	sources: [FEED],
	compute: (store: Store, now: number) => firesView(store, now),
};
