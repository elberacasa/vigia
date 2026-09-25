/**
 * How far is a point from Venezuela? Distance to the nearest edge of the official state polygons (INE via OCHA
 * COD-AB), 0 inside. Used to tell "near Venezuela" from "far away" for quakes, fires and storms. Internal state
 * borders are included in the edge set, which is harmless: from outside, the nearest edge is always on the outer
 * boundary. Pure and synchronous; the edges are built once.
 */
import statesJson from "./data/states.geo.json" with { type: "json" };
import { locate } from "./index.ts";

const EARTH_KM = 6371;
const RAD = Math.PI / 180;

interface Edge {
	readonly x1: number;
	readonly y1: number;
	readonly x2: number;
	readonly y2: number;
}

type Ring = readonly (readonly number[])[];

const EDGES: readonly Edge[] = (() => {
	const out: Edge[] = [];
	const features = (
		statesJson as unknown as { features: { geometry: { type: string; coordinates: unknown } }[] }
	).features;
	for (const f of features) {
		const polys =
			f.geometry.type === "Polygon"
				? [f.geometry.coordinates as readonly Ring[]]
				: f.geometry.type === "MultiPolygon"
					? (f.geometry.coordinates as readonly (readonly Ring[])[])
					: [];
		for (const poly of polys)
			for (const ring of poly)
				for (let i = 1; i < ring.length; i++) {
					const [x1 = 0, y1 = 0] = ring[i - 1] ?? [];
					const [x2 = 0, y2 = 0] = ring[i] ?? [];
					out.push({ x1, y1, x2, y2 });
				}
	}
	return out;
})();

/**
 * Great-circle-accurate enough distance (km) from a point to a segment: the segment is projected on a plane
 * tangent at the point (equirectangular at the point's latitude). Error is well under 1 % below ~500 km and a few
 * percent at 3,000 km, which is far finer than any rule that uses it.
 */
function pointSegmentKm(lat: number, lon: number, e: Edge): number {
	const k = Math.cos(lat * RAD);
	const ax = (e.x1 - lon) * k;
	const ay = e.y1 - lat;
	const bx = (e.x2 - lon) * k;
	const by = e.y2 - lat;
	const dx = bx - ax;
	const dy = by - ay;
	const len2 = dx * dx + dy * dy;
	const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
	const px = ax + t * dx;
	const py = ay + t * dy;
	return Math.sqrt(px * px + py * py) * RAD * EARTH_KM;
}

/** Kilometres from the point to Venezuela's territory (0 when inside, per the official boundaries). */
export function distanceToVenezuelaKm(lat: number, lon: number): number {
	return locate(lat, lon).inVenezuela ? 0 : nearestVenezuelaPoint(lat, lon).km;
}

/** Nearest point of Venezuela's boundary (for bearings, e.g. "is this storm moving toward Venezuela?"). */
export function nearestVenezuelaPoint(lat: number, lon: number): { lat: number; lon: number; km: number } {
	let best = { lat, lon, km: Number.POSITIVE_INFINITY };
	const k = Math.cos(lat * RAD);
	for (const e of EDGES) {
		const d = pointSegmentKm(lat, lon, e);
		if (d < best.km) {
			const ax = (e.x1 - lon) * k;
			const ay = e.y1 - lat;
			const dx = (e.x2 - e.x1) * k;
			const dy = e.y2 - e.y1;
			const len2 = dx * dx + dy * dy;
			const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
			best = { lat: e.y1 + t * (e.y2 - e.y1), lon: e.x1 + t * (e.x2 - e.x1), km: d };
		}
	}
	return best;
}
