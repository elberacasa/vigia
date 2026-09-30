import type { Bounds } from "./frame.ts";

/**
 * Rasterises polygons onto a plate-carrée grid (north-up, pixel edges on `bounds`): each pixel takes the label of the
 * polygon that contains its centre, by an even-odd scanline fill (holes and multipart polygons handled). Label 0 is
 * "no polygon"; labels are 1-based indices into `features`. Where polygons overlap, the later one wins (the
 * official boundaries do not overlap; shared edges go to one side by the half-open rule).
 *
 * The same rule as `gibs-nightlights/masks.ts` (level 6, states), generalised to any grid and to municipalities.
 */

type Ring = readonly (readonly number[])[];
export type MaskFeature = {
	readonly geometry:
		| { readonly type: "Polygon"; readonly coordinates: readonly Ring[] }
		| { readonly type: "MultiPolygon"; readonly coordinates: readonly (readonly Ring[])[] };
};

export type Grid = { readonly width: number; readonly height: number; readonly bounds: Bounds };

export function rasterise(features: readonly MaskFeature[], grid: Grid): Uint16Array {
	if (features.length > 65_535) throw new Error("too many features for a 16-bit mask");
	const { width, height, bounds } = grid;
	const dx = (bounds.east - bounds.west) / width;
	const dy = (bounds.north - bounds.south) / height;
	const labels = new Uint16Array(width * height);
	for (const [index, feature] of features.entries()) {
		const label = index + 1;
		const rings =
			feature.geometry.type === "Polygon"
				? feature.geometry.coordinates
				: feature.geometry.coordinates.flat();
		let north = Number.NEGATIVE_INFINITY;
		let south = Number.POSITIVE_INFINITY;
		for (const ring of rings)
			for (const [, lat = 0] of ring) {
				if (lat > north) north = lat;
				if (lat < south) south = lat;
			}
		// Only the rows the feature spans (a municipality is a few hundred of a raster's thousands).
		const row0 = Math.max(0, Math.floor((bounds.north - north) / dy) - 1);
		const row1 = Math.min(height - 1, Math.ceil((bounds.north - south) / dy) + 1);
		if (row1 < row0) continue;
		const crossings: number[][] = Array.from({ length: row1 - row0 + 1 }, () => []);
		for (const ring of rings) {
			for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
				const [lonA = 0, latA = 0] = ring[j] ?? [];
				const [lonB = 0, latB = 0] = ring[i] ?? [];
				const xa = (lonA - bounds.west) / dx;
				const ya = (bounds.north - latA) / dy;
				const xb = (lonB - bounds.west) / dx;
				const yb = (bounds.north - latB) / dy;
				if (ya === yb) continue;
				const top = Math.min(ya, yb);
				const bottom = Math.max(ya, yb);
				// Rows whose centre (r + 0.5) lies in [top, bottom).
				const first = Math.max(row0, Math.ceil(top - 0.5));
				const last = Math.min(row1, Math.ceil(bottom - 0.5) - 1);
				for (let r = first; r <= last; r++) {
					const yc = r + 0.5;
					crossings[r - row0]?.push(xa + ((yc - ya) / (yb - ya)) * (xb - xa));
				}
			}
		}
		for (let r = row0; r <= row1; r++) {
			const xs = crossings[r - row0];
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
	return labels;
}

const KM_PER_DEG = 111.32;

/** Area of one pixel of each row of a plate-carrée grid, km² (spherical Earth, R = 6378 km: within ~0.3 %). */
export function rowAreasKm2(grid: Grid): Float64Array {
	const dx = (grid.bounds.east - grid.bounds.west) / grid.width;
	const dy = (grid.bounds.north - grid.bounds.south) / grid.height;
	const out = new Float64Array(grid.height);
	for (let r = 0; r < grid.height; r++) {
		const lat = grid.bounds.north - (r + 0.5) * dy;
		out[r] = dx * KM_PER_DEG * Math.cos((lat * Math.PI) / 180) * dy * KM_PER_DEG;
	}
	return out;
}
