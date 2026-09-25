/**
 * The one geographic frame every Vigía image of Venezuela is delivered in: plate carrée (plain lon/lat),
 * north up, pixel edges on this box. It is aligned to NASA GIBS's EPSG:4326 tile grid (level 6 pixels of
 * 0.0087890625°, whose tiles start at 90° N / 180° W), so night-light tiles are cropped without resampling,
 * and it contains the UI map frame (lon −73.6…−59.5, lat 0.5…12.9). To overlay an image, stretch it to these
 * bounds (SVG `<image preserveAspectRatio="none">`); any x-scaling such as cos(7°) applies to it like to
 * every other layer.
 */
export const VENEZUELA_FRAME = {
	west: -74.00390625,
	east: -58.9921875,
	south: 0,
	north: 13.5,
} as const;

export type Bounds = { west: number; east: number; south: number; north: number };

/** Degrees per pixel of GIBS EPSG:4326 level `level` (512-px tiles, level 0 = 0.5625°/px). */
export function gibsDegPerPx(level: number): number {
	return 0.5625 / 2 ** level;
}

/** Pixel size of the frame at a GIBS level: level 6 → 1708 × 1536, level 5 → 854 × 768, level 4 → 427 × 384. */
export function frameSize(level: number): { width: number; height: number } {
	const deg = gibsDegPerPx(level);
	return {
		width: Math.round((VENEZUELA_FRAME.east - VENEZUELA_FRAME.west) / deg),
		height: Math.round((VENEZUELA_FRAME.north - VENEZUELA_FRAME.south) / deg),
	};
}

/** Centre of pixel (col, row) of a `width` × `height` raster of the frame. */
export function pixelCentre(
	col: number,
	row: number,
	width: number,
	height: number,
): { lon: number; lat: number } {
	const f = VENEZUELA_FRAME;
	return {
		lon: f.west + ((col + 0.5) / width) * (f.east - f.west),
		lat: f.north - ((row + 0.5) / height) * (f.north - f.south),
	};
}
