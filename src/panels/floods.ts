import { type FloodDay, type FloodStats, modisFloods, worldviewUrl } from "../adapters/modis-floods/index.ts";
import type { Store } from "../core/store.ts";
import { municipalities, stateByCode, stateByIso } from "../geo/index.ts";
import type { Panel } from "../server/panels.ts";

/**
 * "¿Dónde hay agua fuera de su sitio?" NASA's MODIS flood product (2-day composite) as the `modis-floods` adapter
 * stores it: the newest day's flood seen per state and municipality, how much of each was hidden by cloud (the
 * product's "insufficient data"), the last 30 days for the country, and 0.1° cells for the map. Every area is a
 * satellite classification counted by Vigía on a one-in-four sample of 250 m pixels, never "flooded land" as fact.
 */

const DAY = 86_400_000;

export const LABEL =
	"Agua clasificada como «inundación» por el producto de inundaciones de NASA (MODIS Terra y Aqua, compuesto de 2 días)";
export const METHOD =
	"calculado por Vigía: píxeles de 250 m (1 de cada 4, muestra exacta de NASA GIBS) × su área; «nubes» es la clase «datos insuficientes» del producto";
export const CAVEAT =
	"Con nubes el satélite no ve el suelo: una zona cubierta no es una zona seca. NASA advierte falsas detecciones por sombras de nubes y de relieve; «inundación recurrente» es agua que aparece casi todos los años en esta época.";

export type FloodRegion = {
	floodKm2: number;
	recurringKm2: number;
	/** Share of the region under "insufficient data" (cloud), %. */
	cloudPct: number;
	/** Share not seen at all: cloud plus no product, %. The figure to show next to every area. */
	unseenPct: number;
	areaKm2: number;
};

export type FloodsView = {
	now: number;
	label: string;
	method: string;
	caveat: string;
	feed: string;
	attribution: string;
	/** The newest stored day, or null. */
	day: {
		date: string;
		observedAt: number;
		fetchedAt: number;
		stale: boolean;
		sourceUrl: string;
		venezuela: FloodRegion;
		/** States with flood or recurring flood, most flood first; then the rest only by cloud (all 25 listed). */
		states: (FloodRegion & { iso: string; name: string })[];
		/** Municipalities with flood or recurring flood, most flood first (at most 40). */
		municipalities: (FloodRegion & { code: string; name: string; state: string; stateName: string })[];
		/** [lat, lon, floodKm2, recurringKm2] per 0.1° cell (south-west corner). */
		cells: [number, number, number, number][];
	} | null;
	/** The last 30 stored days, oldest first. */
	series: { date: string; floodKm2: number; recurringKm2: number; cloudPct: number; unseenPct: number }[];
};

const region = (s: FloodStats): FloodRegion => ({
	floodKm2: s.floodKm2,
	recurringKm2: s.recurringKm2,
	cloudPct: s.areaKm2 > 0 ? Math.round((s.insufficientKm2 / s.areaKm2) * 1000) / 10 : 0,
	unseenPct: s.areaKm2 > 0 ? Math.round(((s.insufficientKm2 + s.nodataKm2) / s.areaKm2) * 1000) / 10 : 0,
	areaKm2: s.areaKm2,
});

type Row = { observedAt: number; fetchedAt: number; value: FloodDay };

/** Pure: the view from the stored days (newest revision per day). */
export function floodsViewOf(rows: readonly Row[], now: number): Omit<FloodsView, "feed" | "attribution"> {
	const byDay = new Map<string, Row>();
	for (const r of rows) byDay.set(r.value.date, r);
	const days = [...byDay.values()].sort((a, b) => a.observedAt - b.observedAt);
	const newest = days.at(-1) ?? null;
	const names = new Map(municipalities().map((m) => [m.code, m.name]));
	const budget = modisFloods.freshness.dataMs ?? 4 * DAY;
	return {
		now,
		label: LABEL,
		method: METHOD,
		caveat: CAVEAT,
		day: newest
			? {
					date: newest.value.date,
					observedAt: newest.observedAt,
					fetchedAt: newest.fetchedAt,
					stale: now - newest.observedAt > budget,
					sourceUrl: worldviewUrl(newest.value.date),
					venezuela: region(newest.value.venezuela),
					states: Object.entries(newest.value.states)
						.map(([iso, s]) => ({ iso, name: stateByIso(iso)?.name ?? iso, ...region(s) }))
						.sort(
							(a, b) =>
								b.floodKm2 - a.floodKm2 ||
								b.recurringKm2 - a.recurringKm2 ||
								b.cloudPct - a.cloudPct ||
								a.iso.localeCompare(b.iso),
						),
					municipalities: Object.entries(newest.value.municipalities)
						.map(([code, s]) => {
							const iso = stateByCodePrefix(code);
							return {
								code,
								name: names.get(code) ?? code,
								state: iso,
								stateName: stateByIso(iso)?.name ?? iso,
								...region(s),
							};
						})
						.sort(
							(a, b) =>
								b.floodKm2 - a.floodKm2 || b.recurringKm2 - a.recurringKm2 || a.code.localeCompare(b.code),
						)
						.slice(0, 40),
					cells: newest.value.cells,
				}
			: null,
		series: days
			.filter((d) => d.observedAt > now - 30 * DAY)
			.map((d) => ({ date: d.value.date, ...pick(region(d.value.venezuela)) })),
	};
}

const pick = (r: FloodRegion) => ({
	floodKm2: r.floodKm2,
	recurringKm2: r.recurringKm2,
	cloudPct: r.cloudPct,
	unseenPct: r.unseenPct,
});

/** "VE1501" → "VE-M" (a municipality's P-code starts with its state's). */
function stateByCodePrefix(code: string): string {
	return stateByCode(code.slice(0, 4))?.iso ?? code.slice(0, 4);
}

export function floodsView(store: Store, now: number): FloodsView {
	const rows = store.history<FloodDay>(modisFloods.id, "day", now - 31 * DAY, now, 100);
	return { ...floodsViewOf(rows, now), feed: modisFloods.id, attribution: modisFloods.licence.attribution };
}

export const floodsPanel: Panel<FloodsView> = {
	id: "floods",
	onDemand: true,
	sources: [modisFloods.id],
	compute: (store, now) => floodsView(store, now),
};
