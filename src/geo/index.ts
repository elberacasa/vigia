/**
 * Where is this point? State and municipality by point-in-polygon on the official boundaries (INE via OCHA
 * COD-AB, CC BY-IGO 3.0), neighbouring country from Natural Earth, and a Spanish description relative to the
 * nearest town (GeoNames, CC BY 4.0). Pure and synchronous; data is loaded once.
 */
import contextJson from "./data/context.geo.json" with { type: "json" };
import gazetteerJson from "./data/gazetteer.json" with { type: "json" };
import municipalitiesJson from "./data/municipalities.geo.json" with { type: "json" };
import statesMetaJson from "./data/states-meta.json" with { type: "json" };

type Ring = readonly (readonly number[])[];
type Polygon = readonly Ring[];
interface Geometry {
	type: string;
	coordinates: unknown;
}
interface Shape {
	readonly polygons: readonly Polygon[];
	readonly bbox: readonly [number, number, number, number];
}

export interface StateInfo {
	readonly code: string;
	readonly iso: string;
	readonly name: string;
	readonly label: { readonly lat: number; readonly lon: number };
	readonly capital: string;
	readonly areaKm2: number;
}

export interface Place {
	readonly name: string;
	readonly kind: "state" | "municipality" | "city" | "sector";
	readonly stateCode: string;
	readonly municipalityCode?: string;
	readonly lat: number;
	readonly lon: number;
	readonly population?: number;
}

export interface Located {
	/** Inside Venezuela's mainland/islands per the official boundaries. */
	readonly inVenezuela: boolean;
	readonly state?: StateInfo;
	readonly municipality?: { readonly code: string; readonly name: string };
	/** Neighbouring country or territory (Spanish name) when outside Venezuela. */
	readonly country?: string;
}

function toPolygons(geometry: Geometry): Polygon[] {
	if (geometry.type === "Polygon") return [geometry.coordinates as Polygon];
	if (geometry.type === "MultiPolygon") return geometry.coordinates as Polygon[];
	return [];
}

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

function inRing(ring: Ring, x: number, y: number): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [xi = 0, yi = 0] = ring[i] ?? [];
		const [xj = 0, yj = 0] = ring[j] ?? [];
		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

export function inShape(shape: Shape, lon: number, lat: number): boolean {
	const [a, b, c, d] = shape.bbox;
	if (lon < a || lon > c || lat < b || lat > d) return false;
	for (const poly of shape.polygons) {
		const [outer, ...holes] = poly;
		if (outer && inRing(outer, lon, lat) && !holes.some((h) => inRing(h, lon, lat))) return true;
	}
	return false;
}

interface FeatureCollection {
	features: { properties: Record<string, unknown>; geometry: Geometry }[];
}

const STATES: readonly StateInfo[] = (
	statesMetaJson as unknown as {
		states: {
			code: string;
			iso3166_2: string;
			name: string;
			labelPoint: { lat: number; lon: number };
			capital: { name: string } | null;
			areaKm2: number;
		}[];
	}
).states.map((s) => ({
	code: s.code,
	iso: s.iso3166_2,
	name: s.name,
	label: s.labelPoint,
	capital: s.capital?.name ?? "",
	areaKm2: s.areaKm2,
}));
const STATE_BY_CODE = new Map(STATES.map((s) => [s.code, s]));
const STATE_BY_ISO = new Map(STATES.map((s) => [s.iso, s]));

const MUNICIPALITIES = (municipalitiesJson as unknown as FeatureCollection).features.map((f) => {
	const polygons = toPolygons(f.geometry);
	return {
		code: String(f.properties.code),
		name: String(f.properties.name),
		stateCode: String(f.properties.state_code),
		shape: { polygons, bbox: bboxOf(polygons) } satisfies Shape,
	};
});

const NEIGHBOURS = (contextJson as unknown as FeatureCollection).features
	.filter((f) => f.properties.kind === "country")
	.map((f) => {
		const polygons = toPolygons(f.geometry);
		return { name: String(f.properties.name), shape: { polygons, bbox: bboxOf(polygons) } satisfies Shape };
	});

export const PLACES: readonly Place[] = (
	gazetteerJson as unknown as {
		entries: (Place & { variants?: string[]; curatedVariants?: string[] })[];
	}
).entries.map((e) => {
	const place: {
		-readonly [K in keyof Place]: Place[K];
	} = { name: e.name, kind: e.kind, stateCode: e.stateCode, lat: e.lat, lon: e.lon };
	if (e.municipalityCode) place.municipalityCode = e.municipalityCode;
	if (e.population) place.population = e.population;
	return place;
});

/** Towns worth naming in a description: cities and municipal seats, not tiny sectors. */
const REFERENCE_TOWNS = PLACES.filter((p) => p.kind === "city");

export function states(): readonly StateInfo[] {
	return STATES;
}

export function stateByIso(iso: string): StateInfo | undefined {
	return STATE_BY_ISO.get(iso);
}

export function stateByCode(code: string): StateInfo | undefined {
	return STATE_BY_CODE.get(code);
}

export function locate(lat: number, lon: number): Located {
	for (const m of MUNICIPALITIES) {
		if (inShape(m.shape, lon, lat)) {
			const state = STATE_BY_CODE.get(m.stateCode);
			return {
				inVenezuela: true,
				...(state ? { state } : {}),
				municipality: { code: m.code, name: m.name },
			};
		}
	}
	for (const n of NEIGHBOURS) if (inShape(n.shape, lon, lat)) return { inVenezuela: false, country: n.name };
	return { inVenezuela: false };
}

/**
 * Distance from a point to a state, km: 0 inside it, else to the nearest vertex of its municipal boundaries (the
 * simplified boundaries' vertices are a few km apart, so this is approximate to about that). Null for an unknown state.
 */
export function distanceToStateKm(iso: string, lat: number, lon: number): number | null {
	const state = STATE_BY_ISO.get(iso);
	if (!state) return null;
	if (locate(lat, lon).state?.iso === iso) return 0;
	let best = Number.POSITIVE_INFINITY;
	for (const m of MUNICIPALITIES) {
		if (m.stateCode !== state.code) continue;
		for (const poly of m.shape.polygons)
			for (const [x = 0, y = 0] of poly[0] ?? []) best = Math.min(best, distanceKm(lat, lon, y, x));
	}
	return Number.isFinite(best) ? best : null;
}

const EARTH_KM = 6371;
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const r = Math.PI / 180;
	const dLat = (lat2 - lat1) * r;
	const dLon = (lon2 - lon1) * r;
	const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
	return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

const POINTS_ES = [
	"N",
	"NNE",
	"NE",
	"ENE",
	"E",
	"ESE",
	"SE",
	"SSE",
	"S",
	"SSO",
	"SO",
	"OSO",
	"O",
	"ONO",
	"NO",
	"NNO",
];

/** 16-point compass direction from `from` to `to`, Spanish abbreviations (O for oeste). */
export function bearingEs(fromLat: number, fromLon: number, toLat: number, toLon: number): string {
	const r = Math.PI / 180;
	const y = Math.sin((toLon - fromLon) * r) * Math.cos(toLat * r);
	const x =
		Math.cos(fromLat * r) * Math.sin(toLat * r) -
		Math.sin(fromLat * r) * Math.cos(toLat * r) * Math.cos((toLon - fromLon) * r);
	const deg = (Math.atan2(y, x) / r + 360) % 360;
	return POINTS_ES[Math.round(deg / 22.5) % 16] ?? "N";
}

export function nearestTown(lat: number, lon: number): { place: Place; km: number } | null {
	let best: { place: Place; km: number } | null = null;
	for (const place of REFERENCE_TOWNS) {
		const km = distanceKm(lat, lon, place.lat, place.lon);
		if (!best || km < best.km) best = { place, km };
	}
	return best;
}

/**
 * Spanish description of a point: "a 45 km al NNO de Duaca (Lara)", "en Maracaibo (Zulia)",
 * "en el mar, a 30 km al N de Güiria (Sucre)", "Colombia, a 60 km al SO de San Cristóbal (Táchira)".
 */
export function describe(lat: number, lon: number): string {
	const where = locate(lat, lon);
	const near = nearestTown(lat, lon);
	if (!near) return where.country ?? "Fuera de Venezuela";
	const town = `${near.place.name} (${STATE_BY_CODE.get(near.place.stateCode)?.name ?? ""})`;
	const km = Math.round(near.km);
	const rel =
		km < 5 ? `en ${town}` : `a ${km} km al ${bearingEs(near.place.lat, near.place.lon, lat, lon)} de ${town}`;
	if (where.inVenezuela) return rel;
	if (where.country) return `${where.country}, ${rel}`;
	return `En el mar, ${rel}`;
}
