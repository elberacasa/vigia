/**
 * How many people live in a place or near a point: two sources shown side by side, never blended.
 *
 * - INE census 2011 per municipality (via OCHA COD-PS, CC BY-IGO 3.0): official, but 15 years old and from before
 *   the emigration of the following decade.
 * - WorldPop Global2 2026 (CC BY 4.0): a modelled estimate at ~1 km, summed per municipality and parish by
 *   scripts/ontology/population.py, and kept as a 0.025° grid (~2.8 km) for "people within R km of a point".
 *
 * Every figure here is computed by Vigía (a sum) and says so; none is a count of people affected by anything.
 */
import { distanceKm } from "../geo/index.ts";
import populationJson from "./data/population.json" with { type: "json" };
import type { Registry } from "./registry.ts";
import type { Entity } from "./types.ts";
import type { PopulationView } from "./view.ts";

type PopulationFile = {
	meta: {
		census2011: { attribution: string; licence: string; note: string };
		worldpop2026: {
			source: { attribution: string; licence: string };
			method: string;
			note: string;
			gridTotal: number;
		};
	};
	census2011: Record<string, number>;
	worldpop2026: { municipalities: Record<string, number>; parishes: Record<string, number> };
	grid: { originLon: number; originLat: number; cellDeg: number; key: number[]; people: number[] };
};

const DATA = populationJson as unknown as PopulationFile;
export const POPULATION_META = DATA.meta;

export const CENSUS_SOURCE = DATA.meta.census2011.attribution;
export const WORLDPOP_SOURCE = DATA.meta.worldpop2026.source.attribution;

/** Grid rows (by block row index): columns and people, columns ascending. */
let rows: Map<number, { cols: number[]; people: number[] }> | null = null;

function grid(): Map<number, { cols: number[]; people: number[] }> {
	if (rows) return rows;
	const out = new Map<number, { cols: number[]; people: number[] }>();
	let key = 0;
	DATA.grid.key.forEach((delta, i) => {
		key += delta;
		const r = Math.floor(key / 100_000);
		const c = key % 100_000;
		const row = out.get(r) ?? { cols: [], people: [] };
		row.cols.push(c);
		row.people.push(DATA.grid.people[i] ?? 0);
		out.set(r, row);
	});
	rows = out;
	return out;
}

/** WorldPop 2026 people in grid blocks whose centre is within `km` of the point (the grid's own rule). */
export function peopleWithin(lat: number, lon: number, km: number): number {
	const { originLat, originLon, cellDeg } = DATA.grid;
	const dLat = km / 111.32;
	const dLon = km / (111.32 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
	const r0 = Math.max(0, Math.floor((originLat - (lat + dLat)) / cellDeg));
	const r1 = Math.floor((originLat - (lat - dLat)) / cellDeg);
	const c0 = Math.floor((lon - dLon - originLon) / cellDeg);
	const c1 = Math.floor((lon + dLon - originLon) / cellDeg);
	let sum = 0;
	for (let r = r0; r <= r1; r++) {
		const row = grid().get(r);
		if (!row) continue;
		const cLat = originLat - (r + 0.5) * cellDeg;
		for (let i = 0; i < row.cols.length; i++) {
			const c = row.cols[i] as number;
			if (c < c0 || c > c1) continue;
			const cLon = originLon + (c + 0.5) * cellDeg;
			if (distanceKm(lat, lon, cLat, cLon) <= km) sum += row.people[i] as number;
		}
	}
	return sum;
}

/** The radii a quake's "people nearby" is stated at. */
export const QUAKE_RADII_KM: readonly number[] = [10, 25, 50];

export const GRID_METHOD =
	"Suma de los bloques de ~2,8 km de WorldPop 2026 cuyo centro está a esa distancia o menos (calculado por Vigía).";

const CENSUS_NOTE =
	"Censo de 2011 (INE), la última cifra oficial por municipio: no refleja la emigración posterior.";
const WORLDPOP_NOTE = "Estimación modelada por WorldPop para 2026; no es un censo.";

/** Census 2011 and WorldPop 2026 for a place entity (country, state, municipality, parish); null for others. */
export function populationOf(reg: Registry, e: Entity): PopulationView | null {
	const pcode = e.codes.pcode;
	if (!pcode) return null;
	const munis =
		e.type === "municipality"
			? [e]
			: e.type === "state" || e.type === "country"
				? reg.within(e.id).filter((x) => x.type === "municipality")
				: [];
	const sum = (xs: readonly (number | undefined)[]) =>
		xs.every((x) => x === undefined) ? null : xs.reduce<number>((s, x) => s + (x ?? 0), 0);
	let census: number | null = null;
	let worldpop: number | null = null;
	if (e.type === "parish") {
		worldpop = DATA.worldpop2026.parishes[pcode] ?? null;
	} else {
		census = sum(munis.map((m) => DATA.census2011[m.codes.pcode ?? ""]));
		worldpop = sum(munis.map((m) => DATA.worldpop2026.municipalities[m.codes.pcode ?? ""]));
		// Dependencias Federales has no municipalities: its islands' people sit on OCHA's placeholder unit VE2501.
		const islands = { census: DATA.census2011.VE2501, worldpop: DATA.worldpop2026.municipalities.VE2501 };
		if (e.type === "state" && pcode === "VE25") {
			census = islands.census ?? null;
			worldpop = islands.worldpop ?? null;
		}
		if (e.type === "country") {
			census = (census ?? 0) + (islands.census ?? 0);
			worldpop = (worldpop ?? 0) + (islands.worldpop ?? 0);
		}
	}
	if (census === null && worldpop === null) return null;
	const summed = e.type !== "municipality" && e.type !== "parish";
	return {
		census2011:
			census === null
				? null
				: { people: census, source: CENSUS_SOURCE, licence: DATA.meta.census2011.licence, note: CENSUS_NOTE },
		worldpop2026:
			worldpop === null
				? null
				: {
						people: worldpop,
						source: WORLDPOP_SOURCE,
						licence: DATA.meta.worldpop2026.source.licence,
						note: WORLDPOP_NOTE,
					},
		computed: true,
		method: summed
			? `Suma de sus ${munis.length} municipios en cada fuente (calculado por Vigía). ${DATA.meta.worldpop2026.method}`
			: DATA.meta.worldpop2026.method,
	};
}

/** The census 2011 and WorldPop totals of a state by ISO code (for "people in the affected state"). */
export function statePeople(
	reg: Registry,
	iso: string,
): { census2011: number | null; worldpop2026: number | null } {
	const s = reg.byCode(`iso:${iso}`);
	const p = s ? populationOf(reg, s) : null;
	return { census2011: p?.census2011?.people ?? null, worldpop2026: p?.worldpop2026?.people ?? null };
}
