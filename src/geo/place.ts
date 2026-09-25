/**
 * One call for "where is this point?" as the earth adapters need it: state (ISO), inside Venezuela or not,
 * neighbouring country, distance to Venezuelan territory, and a Spanish description.
 *
 * It corrects one gap of the boundary data: the official municipal polygons leave Lake Maracaibo and the
 * Tablazo bay as holes, so a point on the lake (oil platforms, their gas flares, lake quakes) came out as "not in
 * Venezuela, 46 km away, in the sea". The lake is Venezuelan internal water entirely surrounded by Zulia, so
 * water inside its box (measured by scanning `locate` on a 0.05° grid: 9.05–10.95 °N, 72.10–71.05 °W; the Gulf
 * of Venezuela starts at 11.0 °N) is assigned to Zulia and described as the lake.
 */
import { distanceToVenezuelaKm } from "./distance.ts";
import { describe, locate, stateByIso } from "./index.ts";

export const LAKE_MARACAIBO = {
	minLat: 9.0,
	maxLat: 10.97,
	minLon: -72.15,
	maxLon: -70.95,
	state: "VE-V",
} as const;

export type PointPlace = {
	readonly inVenezuela: boolean;
	/** ISO 3166-2 state code, e.g. "VE-V". */
	readonly state: string | null;
	readonly country: string | null;
	/** Kilometres to Venezuelan territory (0 inside, lake included). */
	readonly borderKm: number;
	/** Named inland water the point is on, e.g. "Lago de Maracaibo". */
	readonly water: string | null;
	readonly placeEs: string;
};

export function inLakeMaracaibo(lat: number, lon: number): boolean {
	const b = LAKE_MARACAIBO;
	return lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon;
}

export function placeOf(lat: number, lon: number): PointPlace {
	const where = locate(lat, lon);
	if (where.inVenezuela) {
		return {
			inVenezuela: true,
			state: where.state?.iso ?? null,
			country: null,
			borderKm: 0,
			water: null,
			placeEs: describe(lat, lon),
		};
	}
	if (!where.country && inLakeMaracaibo(lat, lon)) {
		const zulia = stateByIso(LAKE_MARACAIBO.state);
		return {
			inVenezuela: true,
			state: zulia?.iso ?? LAKE_MARACAIBO.state,
			country: null,
			borderKm: 0,
			water: "Lago de Maracaibo",
			placeEs: describe(lat, lon).replace(/^En el mar, /, "En el Lago de Maracaibo, "),
		};
	}
	return {
		inVenezuela: false,
		state: null,
		country: where.country ?? null,
		borderKm: Math.round(distanceToVenezuelaKm(lat, lon) * 10) / 10,
		water: null,
		placeEs: describe(lat, lon),
	};
}
