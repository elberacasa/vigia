import { FRAME } from "./geometry.gen.ts";

/** Same projection as scripts/build-map.ts: lon/lat with x scaled by cos(7°), fixed frame. */
export function project(lon: number, lat: number): [number, number] {
	return [(lon - FRAME.minLon) * FRAME.cos * FRAME.k, (FRAME.maxLat - lat) * FRAME.k];
}

export function inFrame(lon: number, lat: number): boolean {
	return lon >= FRAME.minLon && lon <= FRAME.maxLon && lat >= FRAME.minLat && lat <= FRAME.maxLat;
}

/** Bounding box [x, y, w, h] of a generated path (absolute M, relative l, z: the only commands build-map writes). */
export function pathBox(d: string): [number, number, number, number] {
	let x = 0;
	let y = 0;
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const m of d.matchAll(/([MlLz])([^MlLz]*)/g)) {
		const nums = (m[2] ?? "")
			.trim()
			.split(/[\s,]+/)
			.filter(Boolean)
			.map(Number);
		for (let i = 0; i + 1 < nums.length; i += 2) {
			const a = nums[i] as number;
			const b = nums[i + 1] as number;
			if (m[1] === "l") {
				x += a;
				y += b;
			} else {
				x = a;
				y = b;
			}
			minX = Math.min(minX, x);
			minY = Math.min(minY, y);
			maxX = Math.max(maxX, x);
			maxY = Math.max(maxY, y);
		}
	}
	return [minX, minY, maxX - minX, maxY - minY];
}
