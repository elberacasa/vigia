/**
 * Where a point is, down to the parish: state and municipality from the official municipal polygons (src/geo),
 * the Lake Maracaibo rule (src/geo/place.ts), and the parish from OCHA COD-AB's admin-3 polygons (CC BY-IGO 3.0),
 * simplified separately (scripts/ontology/build.ts). Pure and synchronous; the parish shapes load once.
 *
 * The two layers were simplified independently, so near a municipal border a point can fall in municipality A and
 * in a sliver of a parish of B. The parish is therefore looked up only among A's parishes; when none of their
 * simplified shapes contains the point, the nearest of them (by boundary vertex) is taken and marked "nearest".
 */
import { distanceKm, inShape, locate, nearestMunicipality, stateByCode } from "../geo/index.ts";
import { inLakeMaracaibo, LAKE_MARACAIBO } from "../geo/place.ts";
import parishesJson from "./data/parishes.geo.json" with { type: "json" };

type Ring = readonly (readonly number[])[];
type Polygon = readonly Ring[];

export type ParishInfo = {
	readonly code: string;
	readonly name: string;
	/** Municipality P-code. */
	readonly municipality: string;
	/** Label point (OCHA's admin label point; inside the parish). */
	readonly lat: number;
	readonly lon: number;
	readonly areaKm2: number;
};

type ParishShape = ParishInfo & {
	readonly polygons: readonly Polygon[];
	readonly bbox: readonly [number, number, number, number];
};

function bboxOf(polygons: readonly Polygon[]): [number, number, number, number] {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const poly of polygons)
		for (const [x = 0, y = 0] of poly[0] ?? []) {
			minX = Math.min(minX, x);
			minY = Math.min(minY, y);
			maxX = Math.max(maxX, x);
			maxY = Math.max(maxY, y);
		}
	return [minX, minY, maxX, maxY];
}

let byMunicipality: Map<string, ParishShape[]> | null = null;

function shapes(): Map<string, ParishShape[]> {
	if (byMunicipality) return byMunicipality;
	const out = new Map<string, ParishShape[]>();
	const doc = parishesJson as unknown as {
		features: {
			properties: {
				code: string;
				name: string;
				m: string;
				lat: number;
				lon: number;
				areaKm2: number;
			};
			geometry: { type: string; coordinates: unknown };
		}[];
	};
	for (const f of doc.features) {
		const g = f.geometry;
		const polygons =
			g.type === "Polygon"
				? [g.coordinates as Polygon]
				: g.type === "MultiPolygon"
					? (g.coordinates as Polygon[])
					: [];
		const p = f.properties;
		const shape: ParishShape = {
			code: p.code,
			name: p.name,
			municipality: p.m,
			lat: p.lat,
			lon: p.lon,
			areaKm2: p.areaKm2,
			polygons,
			bbox: bboxOf(polygons),
		};
		out.set(p.m, [...(out.get(p.m) ?? []), shape]);
	}
	byMunicipality = out;
	return out;
}

/** Every parish, by municipality P-code order of the file. */
export function parishes(): ParishInfo[] {
	return [...shapes().values()].flat().map(({ polygons: _p, bbox: _b, ...info }) => info);
}

export type PointPlace = {
	/** ISO 3166-2 state, or null outside Venezuela. */
	readonly state: string | null;
	/** Municipality P-code (never OCHA's placeholder VE2501), or null. */
	readonly municipality: string | null;
	readonly parish: string | null;
	/**
	 * inside: in the polygons. lake: on Lake Maracaibo (Zulia, no municipality). snapped: outside the simplified
	 * coast but within `snapKm` of a municipality. outside: none of those.
	 */
	readonly how: "inside" | "lake" | "snapped" | "outside";
	/** The parish is the nearest of the municipality's, not one whose shape contains the point. */
	readonly parishNearest: boolean;
};

function parishIn(municipality: string, lat: number, lon: number): { code: string; nearest: boolean } | null {
	const list = shapes().get(municipality);
	if (!list?.length) return null;
	for (const p of list) if (inShape(p, lon, lat)) return { code: p.code, nearest: false };
	let best: { code: string; km: number } | null = null;
	for (const p of list)
		for (const poly of p.polygons)
			for (const [x = 0, y = 0] of poly[0] ?? []) {
				const km = distanceKm(lat, lon, y, x);
				if (!best || km < best.km) best = { code: p.code, km };
			}
	return best ? { code: best.code, nearest: true } : null;
}

const PLACEHOLDER_MUNICIPALITY = "VE2501";

/**
 * State, municipality and parish of a point. `snapKm` (default 0) lets a point just off the simplified coast take
 * the nearest municipality: build.ts uses it for coastal facilities; observations are linked with 0, like the
 * panels, so a detection at sea is never filed under a coastal town.
 */
export function placeAt(lat: number, lon: number, snapKm = 0): PointPlace {
	const where = locate(lat, lon);
	if (where.inVenezuela && where.municipality) {
		const code = where.municipality.code;
		const state = where.state?.iso ?? null;
		if (code === PLACEHOLDER_MUNICIPALITY)
			return { state, municipality: null, parish: null, how: "inside", parishNearest: false };
		const parish = parishIn(code, lat, lon);
		return {
			state,
			municipality: code,
			parish: parish?.code ?? null,
			how: "inside",
			parishNearest: parish?.nearest ?? false,
		};
	}
	if (!where.country && inLakeMaracaibo(lat, lon))
		return {
			state: LAKE_MARACAIBO.state,
			municipality: null,
			parish: null,
			how: "lake",
			parishNearest: false,
		};
	if (snapKm > 0 && !where.country) {
		const near = nearestMunicipality(lat, lon, snapKm);
		if (near) {
			const stateCode = near.code.slice(0, 4);
			const state = stateByCode(stateCode)?.iso ?? null;
			if (near.code === PLACEHOLDER_MUNICIPALITY)
				return { state, municipality: null, parish: null, how: "snapped", parishNearest: false };
			const parish = parishIn(near.code, lat, lon);
			return {
				state,
				municipality: near.code,
				parish: parish?.code ?? null,
				how: "snapped",
				parishNearest: parish?.nearest ?? false,
			};
		}
	}
	return { state: null, municipality: null, parish: null, how: "outside", parishNearest: false };
}
