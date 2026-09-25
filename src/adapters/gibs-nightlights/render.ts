import { frameSize } from "../../imaging/frame.ts";
import { encodeJpeg } from "../../imaging/jpeg.ts";
import type { ColorMap } from "./colormap.ts";
import type { IndexedRaster } from "./grid.ts";

/**
 * The picture people see: the level-6 mosaic averaged 2×2 (box filter on the colormap's grey, which is how
 * GIBS draws the layer) to 854 × 768, the GIBS level-5 grid of the frame (≈2 km pixels). No data and the
 * darkest class (< 0.1 nW, "no detectable light") are pure black, so the picture can be laid over a dark map
 * with `mix-blend-mode: screen` without a grey veil. Measured 66 KB for 2026-09-23 at quality 85.
 */
export const DISPLAY = frameSize(5);
export const JPEG_QUALITY = 85;

export function renderLights(lights: IndexedRaster, map: ColorMap): Uint8Array {
	const grey = new Uint8Array(256);
	for (const c of map.classes) grey[c.ref] = c.lo === 0 ? 0 : (lights.palette[c.ref]?.[0] ?? 0);
	const { width, height } = DISPLAY;
	const out = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const a = 2 * y * lights.width + 2 * x;
			const b = a + lights.width;
			const v =
				((grey[lights.data[a] ?? 0] ?? 0) +
					(grey[lights.data[a + 1] ?? 0] ?? 0) +
					(grey[lights.data[b] ?? 0] ?? 0) +
					(grey[lights.data[b + 1] ?? 0] ?? 0) +
					2) >>
				2;
			const o = (y * width + x) * 4;
			out[o] = v;
			out[o + 1] = v;
			out[o + 2] = v;
			out[o + 3] = 255;
		}
	}
	return encodeJpeg({ width, height, data: out }, JPEG_QUALITY);
}
