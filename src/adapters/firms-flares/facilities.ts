import facilitiesJson from "./facilities.json" with { type: "json" };

/**
 * The fixed list of oil and gas facilities Vigía watches for flaring (built by `build-facilities.ts` from the
 * World Bank GFMR flare-site list and OpenStreetMap outlines), and the rule that assigns a VIIRS detection to one.
 *
 * Rule: refineries and complexes count detections inside their OSM outline or within `bufferKm` of its edge;
 * fields count detections within `siteRadiusKm` of one of their GFMR flare sites. A VIIRS I-band pixel is 375 m
 * at nadir and ~800 m at the swath edge, plus geolocation error, hence ~1–1.5 km. A point that qualifies for two
 * facilities goes to the nearer one (distance 0 inside an outline).
 */

export type FacilityKind = "refinery" | "complex" | "oil-field" | "gas-field";

export type Facility = {
	id: string;
	nameEs: string;
	nameEn: string;
	kind: FacilityKind;
	/** ISO 3166-2, null offshore. */
	state: string | null;
	operatorEs: string;
	noteEs?: string;
	fieldsEs?: string[];
	centroid: { lat: number; lon: number };
	/** [lat, lon] ring, refineries and complexes. */
	outline?: [number, number][];
	bufferKm?: number;
	/** [lat, lon] GFMR flare sites, fields. */
	sites?: [number, number][];
	siteRadiusKm?: number;
	/** GFMR's estimate of gas flared, million m³ per year. */
	ggfrMillionM3?: Record<string, number>;
	sources: { label: string; url: string }[];
};

export const FACILITY_LIST = facilitiesJson as unknown as {
	builtAt: string;
	rule: string;
	sources: { label: string; url: string }[];
	facilities: Facility[];
};

export const FACILITIES: readonly Facility[] = FACILITY_LIST.facilities;

const KM_PER_DEG = 111.32;

/** Local equirectangular projection around `lat0`: accurate to well under 1 % at these distances. */
function project(lat: number, lon: number, lat0: number): [number, number] {
	return [lon * KM_PER_DEG * Math.cos((lat0 * Math.PI) / 180), lat * KM_PER_DEG];
}

function segmentKm(p: [number, number], a: [number, number], b: [number, number]): number {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const len2 = dx * dx + dy * dy;
	const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
	return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Distance from a point to a [lat, lon] ring, km; 0 inside it. */
export function distanceToOutlineKm(lat: number, lon: number, ring: readonly [number, number][]): number {
	if (ring.length < 3) return Number.POSITIVE_INFINITY;
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [yi, xi] = ring[i] as [number, number];
		const [yj, xj] = ring[j] as [number, number];
		if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
	}
	if (inside) return 0;
	const p = project(lat, lon, lat);
	let best = Number.POSITIVE_INFINITY;
	for (let i = 0; i < ring.length; i++) {
		const a = ring[i] as [number, number];
		const b = ring[(i + 1) % ring.length] as [number, number];
		best = Math.min(best, segmentKm(p, project(a[0], a[1], lat), project(b[0], b[1], lat)));
	}
	return best;
}

function distanceToSitesKm(lat: number, lon: number, sites: readonly [number, number][]): number {
	const p = project(lat, lon, lat);
	let best = Number.POSITIVE_INFINITY;
	for (const [slat, slon] of sites) {
		if (Math.abs(slat - lat) > 0.1 || Math.abs(slon - lon) > 0.1) continue;
		const q = project(slat, slon, lat);
		best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1]));
	}
	return best;
}

/** Rough box around each facility, to skip the exact test for far points (most of a 7-day file). */
const BOXES = FACILITIES.map((f) => {
	const pts = f.outline ?? f.sites ?? [];
	const margin = 0.03;
	return {
		f,
		south: Math.min(...pts.map((p) => p[0])) - margin,
		north: Math.max(...pts.map((p) => p[0])) + margin,
		west: Math.min(...pts.map((p) => p[1])) - margin,
		east: Math.max(...pts.map((p) => p[1])) + margin,
	};
});

/** The facility a detection belongs to, and how far it is from it (0 inside an outline), or null. */
export function facilityFor(
	lat: number,
	lon: number,
	list: readonly Facility[] = FACILITIES,
): { facility: Facility; km: number } | null {
	const boxes = list === FACILITIES ? BOXES : null;
	let best: { facility: Facility; km: number } | null = null;
	for (const [i, f] of list.entries()) {
		const box = boxes?.[i];
		if (box && (lat < box.south || lat > box.north || lon < box.west || lon > box.east)) continue;
		let km = Number.POSITIVE_INFINITY;
		if (f.outline) {
			const d = distanceToOutlineKm(lat, lon, f.outline);
			if (d <= (f.bufferKm ?? 0)) km = d;
		}
		if (f.sites) {
			const d = distanceToSitesKm(lat, lon, f.sites);
			if (d <= (f.siteRadiusKm ?? 0)) km = Math.min(km, d);
		}
		if (km !== Number.POSITIVE_INFINITY && (!best || km < best.km)) best = { facility: f, km };
	}
	return best;
}
