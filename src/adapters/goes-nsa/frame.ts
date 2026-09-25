import { frameSize, pixelCentre } from "../../imaging/frame.ts";
import { decodeJpeg, encodeJpeg, type Rgba } from "../../imaging/jpeg.ts";
import { solarZenithDeg } from "../../imaging/sun.ts";
import { NSA_SECTOR, nsaPixel } from "./geos.ts";

/**
 * One GOES-19 GeoColor frame → a small Venezuela image in the shared lon/lat frame.
 *
 * Source size, measured 2026-09-24 over the last 144 frames (one day) of the nsa sector:
 *   900×540 mean 0.41 MB · 1800×1080 1.29 MB · 3600×2160 4.00 MB · 7200×4320 12.1 MB per frame.
 * Venezuela is 404 px wide in the 1800 image (≈4 km pixels) and 808 px in the 3600 image. 1800×1080 costs
 * 185 MB a day at one frame every 10 min; 3600×2160 would cost 576 MB a day (17 GB a month) for one panel,
 * too much for a self-hosted tool on a Venezuelan connection. So the default is 1800×1080, delivered at its
 * own resolution: 427×384 (the GIBS level-4 grid of the frame, 0.0352° ≈ 3.9 km per pixel). Switching
 * `SOURCE` to 3600×2160 gives 854×768 frames; nothing else changes.
 */
export const SOURCE = { width: NSA_SECTOR.width, height: NSA_SECTOR.height, level: 4 } as const;
export const OUTPUT = frameSize(SOURCE.level);
export const JPEG_QUALITY = 82;
/** Bump when the output for the same source bytes changes (it is part of every blob key). */
export const PIPELINE_VERSION = "goes-nsa/1";

export type Lighting = "day" | "night" | "mixed";

/** Source pixel coordinates (pixel centres at +0.5) for every output pixel, computed once. */
let lookup: Float32Array | null = null;
function sourceLookup(): Float32Array {
	if (lookup) return lookup;
	const { width, height } = OUTPUT;
	const table = new Float32Array(width * height * 2);
	for (let row = 0; row < height; row++) {
		for (let col = 0; col < width; col++) {
			const { lon, lat } = pixelCentre(col, row, width, height);
			const p = nsaPixel(lat, lon, SOURCE.width);
			if (!p) throw new Error("the Venezuela frame is always visible from GOES-East");
			table[(row * width + col) * 2] = p.u - 0.5;
			table[(row * width + col) * 2 + 1] = p.v - 0.5;
		}
	}
	lookup = table;
	return table;
}

/** Bilinear resampling of the sector image into the frame. Pure; exported for tests. */
export function reproject(source: Rgba): Rgba {
	if (source.width !== SOURCE.width || source.height !== SOURCE.height) {
		throw new Error(`expected ${SOURCE.width}×${SOURCE.height}, got ${source.width}×${source.height}`);
	}
	const table = sourceLookup();
	const { width, height } = OUTPUT;
	const out = new Uint8Array(width * height * 4);
	const src = source.data;
	const sw = source.width;
	const maxX = source.width - 1;
	const maxY = source.height - 1;
	for (let i = 0; i < width * height; i++) {
		const fx = table[i * 2] ?? 0;
		const fy = table[i * 2 + 1] ?? 0;
		const x0 = Math.min(maxX, Math.max(0, Math.floor(fx)));
		const y0 = Math.min(maxY, Math.max(0, Math.floor(fy)));
		const x1 = Math.min(maxX, x0 + 1);
		const y1 = Math.min(maxY, y0 + 1);
		const tx = fx - Math.floor(fx);
		const ty = fy - Math.floor(fy);
		const a = (y0 * sw + x0) * 4;
		const b = (y0 * sw + x1) * 4;
		const c = (y1 * sw + x0) * 4;
		const d = (y1 * sw + x1) * 4;
		for (let ch = 0; ch < 3; ch++) {
			const top = (src[a + ch] ?? 0) * (1 - tx) + (src[b + ch] ?? 0) * tx;
			const bottom = (src[c + ch] ?? 0) * (1 - tx) + (src[d + ch] ?? 0) * tx;
			out[i * 4 + ch] = Math.round(top * (1 - ty) + bottom * ty);
		}
		out[i * 4 + 3] = 255;
	}
	return { width, height, data: out };
}

/** Mean of R, G and B over the image, 0–255. */
export function meanLevel(image: Rgba): number {
	let sum = 0;
	for (let i = 0; i < image.data.length; i += 4) {
		sum += (image.data[i] ?? 0) + (image.data[i + 1] ?? 0) + (image.data[i + 2] ?? 0);
	}
	return sum / ((image.data.length / 4) * 3);
}

/** Decodes, reprojects and re-encodes one frame. Throws on a corrupt, wrong-size or blank (all-black) frame. */
export function renderFrame(jpegBytes: Uint8Array): Uint8Array {
	const frame = reproject(decodeJpeg(jpegBytes));
	if (meanLevel(frame) < 2) throw new Error("blank frame");
	return encodeJpeg(frame, JPEG_QUALITY);
}

/**
 * Day, night or mixed over the frame at scan time, from the solar zenith at its corners and centre. GeoColor
 * switches to its night rendering past a zenith of about 85°, and at night it shows a *static* city-lights
 * layer: night frames must never be read as evidence of power (see `staticCityLights`).
 */
export function lighting(at: number): Lighting {
	const points = [
		[13.5, -74],
		[13.5, -59],
		[0, -74],
		[0, -59],
		[6.75, -66.5],
	] as const;
	const zeniths = points.map(([lat, lon]) => solarZenithDeg(lat, lon, at));
	if (Math.max(...zeniths) <= 80) return "day";
	if (Math.min(...zeniths) >= 90) return "night";
	return "mixed";
}
