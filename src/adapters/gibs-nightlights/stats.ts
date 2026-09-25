import { gibsDegPerPx, VENEZUELA_FRAME } from "../../imaging/frame.ts";
import { CROP, type IndexedRaster, LEVEL } from "./grid.ts";

/**
 * Per-region night-light statistics, computed from palette indices (no colours, no model):
 * - `radiance`: mean over the region's pixels with data of each pixel's class value (class midpoint, the
 *   top class counted at its floor of 38.2), weighted by cos(latitude) for pixel area. Unit nW/(cm²·sr).
 *   It is an index: saturated city cores count as 38.2, and the grid samples one pixel in four.
 * - `clearFraction`: share of the region's pixels that the same night's VIIRS cloud mask calls clear
 *   (clear-sky confidence ≥ 0.95), among pixels that have a mask value. The night-lights product is
 *   gap-filled: under cloud it repeats the last clear night, so a low value means the figure is mostly old.
 */
export type LightStats = {
	radiance: number | null;
	pixels: number;
	validPixels: number;
	saturatedFraction: number | null;
	/** Share of pixels with a cloud-mask value (0 when the mask was not available). */
	cloudDataFraction: number;
	clearFraction: number | null;
};

export type StatsInput = {
	readonly labels: Uint8Array;
	readonly regions: number;
	readonly lights: IndexedRaster;
	/** Value per palette index; NaN = no data. */
	readonly lightValue: Float64Array;
	/** Palette index of the open top (saturated) class. */
	readonly saturatedIndex: number;
	readonly cloud: IndexedRaster | null;
	/** Per palette index: 1 clear, 0 not clear, 255 no data. */
	readonly cloudClass: Uint8Array | null;
};

/** Stats for regions 1..regions (index 0 of the result is unused) and for all of them together (national). */
export function regionStats(input: StatsInput): { regions: LightStats[]; national: LightStats } {
	const { labels, lights, lightValue, saturatedIndex, cloud, cloudClass } = input;
	const n = input.regions + 1;
	const pixels = new Float64Array(n);
	const valid = new Float64Array(n);
	const weight = new Float64Array(n);
	const sum = new Float64Array(n);
	const saturated = new Float64Array(n);
	const masked = new Float64Array(n);
	const clear = new Float64Array(n);
	const deg = gibsDegPerPx(LEVEL);
	for (let row = 0; row < CROP.height; row++) {
		const lat = VENEZUELA_FRAME.north - (row + 0.5) * deg;
		const w = Math.cos((lat * Math.PI) / 180);
		for (let col = 0; col < CROP.width; col++) {
			const i = row * CROP.width + col;
			const label = labels[i] ?? 0;
			if (label === 0) continue;
			pixels[label] = (pixels[label] ?? 0) + 1;
			const index = lights.data[i] ?? 0;
			const value = lightValue[index] ?? Number.NaN;
			if (!Number.isNaN(value)) {
				valid[label] = (valid[label] ?? 0) + 1;
				weight[label] = (weight[label] ?? 0) + w;
				sum[label] = (sum[label] ?? 0) + w * value;
				if (index === saturatedIndex) saturated[label] = (saturated[label] ?? 0) + 1;
			}
			if (cloud && cloudClass) {
				const c = cloudClass[cloud.data[i] ?? 0] ?? 255;
				if (c !== 255) {
					masked[label] = (masked[label] ?? 0) + 1;
					if (c === 1) clear[label] = (clear[label] ?? 0) + 1;
				}
			}
		}
	}
	const make = (
		p: number,
		v: number,
		wt: number,
		s: number,
		sat: number,
		m: number,
		c: number,
	): LightStats => ({
		radiance: wt > 0 ? s / wt : null,
		pixels: p,
		validPixels: v,
		saturatedFraction: v > 0 ? sat / v : null,
		cloudDataFraction: p > 0 ? m / p : 0,
		clearFraction: m > 0 ? c / m : null,
	});
	const regions: LightStats[] = [];
	const total = [0, 0, 0, 0, 0, 0, 0];
	for (let k = 0; k < n; k++) {
		const parts = [pixels[k], valid[k], weight[k], sum[k], saturated[k], masked[k], clear[k]].map(
			(x) => x ?? 0,
		);
		regions.push(make(...(parts as [number, number, number, number, number, number, number])));
		if (k > 0) for (let j = 0; j < 7; j++) total[j] = (total[j] ?? 0) + (parts[j] ?? 0);
	}
	return {
		regions,
		national: make(...(total as [number, number, number, number, number, number, number])),
	};
}
