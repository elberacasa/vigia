import {
	gibsNightlights,
	KEEP_NIGHTS,
	NASA_GIBS,
	type NightLights,
	type NightMosaic,
	type RegionLight,
} from "../adapters/gibs-nightlights/index.ts";
import type { Store, StoredObservation } from "../core/store.ts";
import type { Bounds } from "../imaging/frame.ts";
import type { Panel } from "../server/panels.ts";

/**
 * Night lights per state, each night against the same state's own recent nights: the median of up to 14
 * previous nights (at least 7 to compare). All arithmetic here, tested; the UI only formats.
 */

const DAY = 86_400_000;
/** Fewer previous nights than this: no baseline, no % change. */
export const MIN_BASELINE_NIGHTS = 7;
/** Baselines below this (nW/(cm²·sr), state mean) are too dark for a meaningful percentage. */
export const MIN_BASELINE_RADIANCE = 0.02;

export type Quality = "clear" | "partly" | "cloudy" | "unknown";

export const QUALITY_NOTE: Record<Quality, string> = {
	clear: "Noche despejada sobre el estado: el valor es de esta noche.",
	partly: "Parcialmente nublado: parte del valor repite noches anteriores (relleno por nubes).",
	cloudy:
		"Mayormente nublado: el valor repite sobre todo noches anteriores; no sirve para ver un apagón de esta noche.",
	unknown: "Sin máscara de nubes para esta noche: puede incluir noches anteriores por nubes.",
};

export function quality(clearFraction: number | null): Quality {
	if (clearFraction === null) return "unknown";
	if (clearFraction >= 0.8) return "clear";
	// Below 60 % clear, most of the figure is older nights: not comparable.
	if (clearFraction >= 0.6) return "partly";
	return "cloudy";
}

export type NightRegionView = {
	/** ISO 3166-2, or "VE" for the country. */
	iso: string;
	name: string;
	/** Mean radiance of the state's pixels this night, nW/(cm²·sr), clipped at the ceiling (an index). */
	radianceIndex: number | null;
	/** Median of the previous clear nights' radianceIndex (clear or partly clear for a state; clear for "VE"). */
	baseline: number | null;
	baselineNights: number;
	/** (radianceIndex − baseline) / baseline × 100; null without a usable baseline. */
	pctChange: number | null;
	/** True when the figure is of this night (clear or partly clear) and has a usable baseline. */
	comparable: boolean;
	/** Share of the state's pixels seen clear by that night's cloud mask. */
	clearFraction: number | null;
	quality: Quality;
	qualityNote: string;
	/** Share of the state's pixels at the ceiling (saturated city cores). */
	saturatedFraction: number | null;
	pixels: number;
};

export type NightlightsView = {
	feed: string;
	product: string;
	attribution: string;
	/** GIBS's required acknowledgement, verbatim. */
	acknowledgement: string;
	/** GIBS date of the night (UTC day of the overpass). */
	date: string | null;
	/** Approximate overpass time (≈01:30 Venezuela), epoch ms. */
	observedAt: number | null;
	fetchedAt: number | null;
	sourceUrl: string | null;
	image: { key: string; url: string; bounds: Bounds; width: number; height: number } | null;
	unit: string;
	ceiling: number | null;
	national: NightRegionView | null;
	/** Comparable states first (largest drop first), then the rest by % change, then those without one. */
	states: NightRegionView[];
	/** Nights with a picture, oldest first (for a slider), each with its satellite. */
	nights: { date: string; url: string; observedAt: number; satellite: string }[];
	caveats: string[];
};

export const CAVEATS = [
	"Una imagen por noche, del paso del satélite hacia la 01:30 hora de Venezuela: un apagón que terminó antes no se ve.",
	"Producto con relleno por nubes: donde estuvo nublado repite la última noche despejada.",
	"Cada noche es de NOAA-20; si NASA no publica la de NOAA-20, se usa la de Suomi NPP (mismo producto, pasa unos 50 min después) y se indica.",
	"Índice de radiancia leído de la paleta publicada por NASA GIBS (clases de 0,1 a 0,6 nW/cm²·sr, tope 38,2): útil para comparar noches, no es una medición calibrada.",
];

function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const s = [...values].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? (s[mid] ?? null) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** One value per night: the latest stored revision of each date. */
function byDate<V extends NightLights>(
	obs: readonly StoredObservation<NightLights>[],
): Map<string, StoredObservation<V>> {
	const out = new Map<string, StoredObservation<V>>();
	for (const o of obs) out.set(o.value.date, o as StoredObservation<V>);
	return out;
}

/**
 * The baseline is the median of previous nights seen through clear sky only (clear or partly clear for a state;
 * clear for the whole country, `strict`): a cloud-filled night repeats older nights, and mixing those in made a
 * normal clear night read as +100 %. With `strict`, the % itself is only given for a clear night.
 */
export function regionView(
	current: RegionLight,
	previous: readonly RegionLight[],
	strict = false,
): NightRegionView {
	const seen = (p: RegionLight) => {
		const q = quality(p.clearFraction);
		return q === "clear" || (!strict && q === "partly");
	};
	const baselineValues = previous
		.filter(seen)
		.map((p) => p.radiance)
		.filter((r): r is number => r !== null);
	const baselineNights = baselineValues.length;
	const baseline = median(baselineValues);
	const q = quality(current.clearFraction);
	const usable =
		baseline !== null &&
		baselineNights >= MIN_BASELINE_NIGHTS &&
		baseline >= MIN_BASELINE_RADIANCE &&
		current.radiance !== null &&
		(!strict || q === "clear");
	const pctChange =
		usable && current.radiance !== null ? ((current.radiance - baseline) / baseline) * 100 : null;
	return {
		iso: current.iso,
		name: current.name,
		radianceIndex: current.radiance,
		baseline,
		baselineNights,
		pctChange,
		comparable: pctChange !== null && (q === "clear" || q === "partly"),
		clearFraction: current.clearFraction,
		quality: q,
		qualityNote: QUALITY_NOTE[q],
		saturatedFraction: current.saturatedFraction,
		pixels: current.pixels,
	};
}

export function nightlightsView(store: Store, now: number): NightlightsView {
	const source = gibsNightlights.id;
	const mosaics = byDate<NightMosaic>(store.history<NightLights>(source, "mosaic", now - 30 * DAY, now, 500));
	const dates = [...mosaics.keys()].sort();
	const latestDate = dates.at(-1) ?? null;
	const latest = latestDate ? (mosaics.get(latestDate) ?? null) : null;
	const empty: NightlightsView = {
		feed: source,
		product: "VIIRS NOAA-20 Black Marble, relleno por nubes (NASA GIBS)",
		attribution: "NASA GIBS / Black Marble (VIIRS, NOAA-20)",
		acknowledgement: NASA_GIBS.attribution,
		date: null,
		observedAt: null,
		fetchedAt: null,
		sourceUrl: null,
		image: null,
		unit: "nW/(cm² sr)",
		ceiling: null,
		national: null,
		states: [],
		nights: [],
		caveats: CAVEATS,
	};
	if (!latest || !latestDate) return empty;

	const windowStart = latest.observedAt - KEEP_NIGHTS * DAY - DAY / 2;
	const region = (series: string, strict = false): NightRegionView | null => {
		const nights = byDate<RegionLight>(
			store.history<NightLights>(source, series, windowStart, latest.observedAt),
		);
		const current = nights.get(latestDate)?.value;
		if (!current) return null;
		const previous = [...nights.entries()]
			.filter(([date]) => date < latestDate)
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.slice(-KEEP_NIGHTS)
			.map(([, o]) => o.value);
		return regionView(current, previous, strict);
	};

	const stateSeries = store
		.latestPerSeries<NightLights>(source, latest.observedAt, 100)
		.map((o) => o.series)
		.filter((s) => s.startsWith("state:"));
	const states = stateSeries
		.map((series) => region(series))
		.filter((s): s is NightRegionView => s !== null)
		.sort((a, b) => {
			// A cloudy state's figure repeats older nights: it must never rank as tonight's largest drop.
			if (a.comparable !== b.comparable) return a.comparable ? -1 : 1;
			if (a.pctChange === null || b.pctChange === null) {
				return a.pctChange === null ? (b.pctChange === null ? a.name.localeCompare(b.name, "es") : 1) : -1;
			}
			return a.pctChange - b.pctChange;
		});

	const m = latest.value;
	const satellite = m.satellite ?? "NOAA-20";
	return {
		...empty,
		product: `VIIRS ${satellite} Black Marble, relleno por nubes (NASA GIBS)`,
		attribution: `NASA GIBS / Black Marble (VIIRS, ${satellite})`,
		date: latestDate,
		observedAt: latest.observedAt,
		fetchedAt: latest.fetchedAt,
		sourceUrl: latest.sourceUrl,
		image: {
			key: m.key,
			url: `/api/blobs/${source}/${m.key}`,
			bounds: { ...m.bounds },
			width: m.width,
			height: m.height,
		},
		unit: m.unit,
		ceiling: m.ceiling,
		// The country compares clear nights only: a national % over half-cloudy nights is not a reading.
		national: region("country:VE", true),
		states,
		// Only nights whose pictures are still kept (14 nights back from the newest), even after an outage.
		nights: dates
			.map((date) => mosaics.get(date) as StoredObservation<NightMosaic>)
			.filter((o) => o.observedAt > latest.observedAt - KEEP_NIGHTS * DAY)
			.map((o) => ({
				date: o.value.date,
				url: `/api/blobs/${source}/${o.value.key}`,
				observedAt: o.observedAt,
				satellite: o.value.satellite ?? "NOAA-20",
			})),
	};
}

export const nightlightsPanel: Panel<NightlightsView> = {
	id: "nightlights",
	sources: [gibsNightlights.id],
	compute: (store: Store, now: number) => nightlightsView(store, now),
};
