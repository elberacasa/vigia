import statesJson from "../../geo/data/states.geo.json" with { type: "json" };
import { stateByIso } from "../../geo/index.ts";
import { gibsDegPerPx, VENEZUELA_FRAME } from "../../imaging/frame.ts";
import { CROP, LEVEL } from "./grid.ts";

/**
 * Which state each pixel of the 1708 × 1536 frame belongs to, by the pixel's centre, rasterised once from the
 * official state boundaries (INE via OCHA COD-AB, src/geo/data/states.geo.json) with an even-odd scanline
 * fill (holes and multipart states handled). 0 = outside Venezuela.
 */

export type StateRef = {
	readonly iso: string;
	readonly name: string;
	readonly label: { readonly lat: number; readonly lon: number };
};

type Ring = readonly (readonly number[])[];
type Feature = {
	properties: { iso3166_2: string };
	geometry: { type: "Polygon"; coordinates: Ring[] } | { type: "MultiPolygon"; coordinates: Ring[][] };
};

let cached: { labels: Uint8Array; states: StateRef[] } | null = null;

export function stateMask(): { readonly labels: Uint8Array; readonly states: readonly StateRef[] } {
	if (cached) return cached;
	const deg = gibsDegPerPx(LEVEL);
	const { width, height } = CROP;
	const labels = new Uint8Array(width * height);
	const states: StateRef[] = [];
	const features = (statesJson as unknown as { features: Feature[] }).features;
	for (const feature of features) {
		const iso = feature.properties.iso3166_2;
		const info = stateByIso(iso);
		states.push({ iso, name: info?.name ?? iso, label: info ? { ...info.label } : { lat: 0, lon: 0 } });
		const label = states.length;
		const rings =
			feature.geometry.type === "Polygon"
				? feature.geometry.coordinates
				: feature.geometry.coordinates.flat();
		const crossings: number[][] = Array.from({ length: height }, () => []);
		for (const ring of rings) {
			for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
				const [lonA = 0, latA = 0] = ring[j] ?? [];
				const [lonB = 0, latB = 0] = ring[i] ?? [];
				const xa = (lonA - VENEZUELA_FRAME.west) / deg;
				const ya = (VENEZUELA_FRAME.north - latA) / deg;
				const xb = (lonB - VENEZUELA_FRAME.west) / deg;
				const yb = (VENEZUELA_FRAME.north - latB) / deg;
				if (ya === yb) continue;
				const top = Math.min(ya, yb);
				const bottom = Math.max(ya, yb);
				// Rows whose centre (r + 0.5) lies in [top, bottom).
				const first = Math.max(0, Math.ceil(top - 0.5));
				const last = Math.min(height - 1, Math.ceil(bottom - 0.5) - 1);
				for (let r = first; r <= last; r++) {
					const yc = r + 0.5;
					crossings[r]?.push(xa + ((yc - ya) / (yb - ya)) * (xb - xa));
				}
			}
		}
		for (let r = 0; r < height; r++) {
			const xs = crossings[r];
			if (!xs || xs.length < 2) continue;
			xs.sort((a, b) => a - b);
			for (let k = 0; k + 1 < xs.length; k += 2) {
				// Columns whose centre (c + 0.5) lies in [xs[k], xs[k+1]).
				const from = Math.max(0, Math.ceil((xs[k] ?? 0) - 0.5));
				const to = Math.min(width - 1, Math.ceil((xs[k + 1] ?? 0) - 0.5) - 1);
				if (to >= from) labels.fill(label, r * width + from, r * width + to + 1);
			}
		}
	}
	cached = { labels, states };
	return cached;
}
