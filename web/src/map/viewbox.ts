import { FRAME } from "./geometry.gen.ts";

/** A viewBox: x, y, width, height in map units. */
export type Box = readonly [number, number, number, number];
export const FULL: Box = [0, 0, FRAME.width, FRAME.height];
/** Deepest zoom: an eighth of the country's width. */
export const MAX_ZOOM = 8;

/** A box around `b` with 15 % margin each side, grown to the frame's aspect ratio and kept inside the frame. */
export function fitBox(b: Box, minW = FRAME.width / MAX_ZOOM): Box {
	const aspect = FRAME.width / FRAME.height;
	let w = Math.max(minW, b[2] * 1.3);
	const h0 = Math.max(b[3] * 1.3, w / aspect);
	w = Math.max(w, h0 * aspect);
	if (w >= FRAME.width) return FULL;
	const h = w / aspect;
	const cx = b[0] + b[2] / 2;
	const cy = b[1] + b[3] / 2;
	return [
		Math.min(Math.max(0, cx - w / 2), FRAME.width - w),
		Math.min(Math.max(0, cy - h / 2), FRAME.height - h),
		w,
		h,
	];
}

/** Zooms `b` by `factor` (<1 zooms in) around its centre, clamped to the frame. */
export function zoomBox(b: Box, factor: number): Box {
	const c = b[0] + b[2] / 2;
	const m = b[1] + b[3] / 2;
	const w = Math.min(FRAME.width, Math.max(FRAME.width / MAX_ZOOM, b[2] * factor));
	if (w >= FRAME.width - 0.5) return FULL;
	const h = w / (FRAME.width / FRAME.height);
	return [
		Math.min(Math.max(0, c - w / 2), FRAME.width - w),
		Math.min(Math.max(0, m - h / 2), FRAME.height - h),
		w,
		h,
	];
}
