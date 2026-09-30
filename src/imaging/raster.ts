import { inflateSync } from "node:zlib";
import { convertIndexedToRgb, decode as decodePngRaw, encode as encodePngRaw } from "fast-png";
import { decodeJpeg, encodeJpeg, jpegSize, type Rgba } from "./jpeg.ts";

/**
 * Small, pure raster tools for the stills Vigía serves from its own origin (TV frames, channel logos, public
 * camera stills): decode a PNG or JPEG from a third party, reduce it, and re-encode it with our own encoder, so
 * the bytes a browser receives are never the bytes a remote server sent (no polyglot files, no metadata, no EXIF
 * position, no oversized images). Plus the few measurements the camera layer needs: mean luminance of a region
 * and a difference hash to tell a frozen picture from a live one. No faces, no people, no content analysis.
 */

export type { Rgba };

/**
 * Images larger than this (either side, or in total) are refused before decoding. 4 MP is twice the largest picture
 * any source sends (Charallave's 1600 × 1200 cameras) and keeps a decode under ~16 MB of pixels.
 */
export const MAX_SIDE = 4_096;
export const MAX_PIXELS = 4_000_000;
/** A PNG's compressed image data may be at most this long (a logo or a still is far smaller). */
const MAX_PNG_IDAT = 8 * 1024 * 1024;

export type ImageFormat = "png" | "jpeg";

export function sniffImage(bytes: Uint8Array): ImageFormat | null {
	if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
		return "png";
	if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
	return null;
}

/** Width and height from a PNG's IHDR without decoding. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
	if (sniffImage(bytes) !== "png" || bytes.length < 24) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const width = view.getUint32(16);
	const height = view.getUint32(20);
	return width > 0 && height > 0 ? { width, height } : null;
}

function sizeOk(size: { width: number; height: number } | null): boolean {
	return (
		size !== null &&
		size.width <= MAX_SIDE &&
		size.height <= MAX_SIDE &&
		size.width * size.height <= MAX_PIXELS
	);
}

/** Decodes a PNG or JPEG to RGBA (8 bits), refusing oversized images before decoding. Throws on anything else. */
export function decodeImage(bytes: Uint8Array): Rgba {
	const format = sniffImage(bytes);
	if (format === "jpeg") {
		if (!sizeOk(jpegSize(bytes))) throw new Error("image too large or not a JPEG");
		return decodeJpeg(bytes, MAX_PIXELS / 1_000_000, 128);
	}
	if (format === "png") {
		if (!sizeOk(pngSize(bytes))) throw new Error("image too large");
		return pngToRgba(decodePngRaw(sanitizePng(bytes)));
	}
	throw new Error("not a PNG or JPEG");
}

const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function u32(b: Uint8Array, at: number): number {
	return (((b[at] ?? 0) << 24) >>> 0) + ((b[at + 1] ?? 0) << 16) + ((b[at + 2] ?? 0) << 8) + (b[at + 3] ?? 0);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	const typed = new Uint8Array(4 + data.length);
	for (let i = 0; i < 4; i++) typed[i] = type.charCodeAt(i);
	typed.set(data, 4);
	out.set(typed, 4);
	view.setUint32(8 + data.length, Bun.hash.crc32(typed));
	return out;
}

/**
 * Pure: a PNG reduced to what a picture needs (IHDR, PLTE, tRNS, the image data, IEND), with its image data inflated
 * here first under a hard cap: exactly what IHDR's size allows (plus Adam7's per-pass filter bytes). Everything else
 * (colour profiles, compressed text, animation) is dropped unread. A decompression bomb throws before fast-png sees
 * it (measured 2026-09-29 by the review: a 204 KB PNG declaring 1 × 1 pixels made fast-png allocate 776 MB).
 */
export function sanitizePng(bytes: Uint8Array): Uint8Array {
	if (sniffImage(bytes) !== "png") throw new Error("not a PNG");
	let at = 8;
	let ihdr: Uint8Array | null = null;
	const keep: { type: string; data: Uint8Array }[] = [];
	const idat: Uint8Array[] = [];
	let idatBytes = 0;
	while (at + 12 <= bytes.length) {
		const length = u32(bytes, at);
		const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
		const data = bytes.subarray(at + 8, at + 8 + length);
		if (data.length !== length) throw new Error("truncated PNG");
		at += 12 + length;
		if (type === "IHDR") ihdr = data;
		else if (type === "PLTE" || type === "tRNS") keep.push({ type, data });
		else if (type === "IDAT") {
			idatBytes += length;
			if (idatBytes > MAX_PNG_IDAT) throw new Error("PNG image data too large");
			idat.push(data);
		} else if (type === "IEND") break;
	}
	if (!ihdr || ihdr.length !== 13 || idat.length === 0) throw new Error("malformed PNG");
	const width = u32(ihdr, 0);
	const height = u32(ihdr, 4);
	const depth = ihdr[8] ?? 0;
	const channels = CHANNELS[ihdr[9] ?? -1];
	if (!channels || ![1, 2, 4, 8, 16].includes(depth) || !sizeOk({ width, height }))
		throw new Error("bad PNG header");
	const rowBytes = Math.ceil((width * channels * depth) / 8);
	// Interlaced images add up to 7 passes' filter bytes and partial rows: a small, bounded allowance.
	const limit =
		height * (1 + rowBytes) + (ihdr[12] === 1 ? 8 * (height + 16) * (1 + Math.ceil(channels * 2)) : 0) + 64;
	const joined = new Uint8Array(idatBytes);
	let o = 0;
	for (const d of idat) {
		joined.set(d, o);
		o += d.length;
	}
	// Throws RangeError past the limit: the bomb never expands.
	inflateSync(joined, { maxOutputLength: limit });
	const parts = [
		new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		...keep.map((k) => chunk(k.type, k.data)),
		chunk("IDAT", joined),
		chunk("IEND", new Uint8Array(0)),
	];
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let w = 0;
	for (const p of parts) {
		out.set(p, w);
		w += p.length;
	}
	return out;
}

function pngToRgba(png: ReturnType<typeof decodePngRaw>): Rgba {
	const { width, height } = png;
	const out = new Uint8Array(width * height * 4);
	if (png.palette) {
		const rgb = convertIndexedToRgb(png);
		const per = png.palette[0]?.length ?? 3;
		for (let i = 0; i < width * height; i++) {
			out[i * 4] = rgb[i * per] ?? 0;
			out[i * 4 + 1] = rgb[i * per + 1] ?? 0;
			out[i * 4 + 2] = rgb[i * per + 2] ?? 0;
			out[i * 4 + 3] = per === 4 ? (rgb[i * per + 3] ?? 255) : 255;
		}
		return { width, height, data: out };
	}
	const ch = png.channels;
	const shift = png.depth === 16 ? 8 : 0;
	const scale = png.depth < 8 ? 255 / (2 ** png.depth - 1) : 1;
	const src = png.data;
	const at = (i: number) => Math.round(((src[i] ?? 0) >> shift) * scale);
	for (let i = 0; i < width * height; i++) {
		const s = i * ch;
		if (ch === 1 || ch === 2) {
			const g = at(s);
			out[i * 4] = g;
			out[i * 4 + 1] = g;
			out[i * 4 + 2] = g;
			out[i * 4 + 3] = ch === 2 ? at(s + 1) : 255;
		} else {
			out[i * 4] = at(s);
			out[i * 4 + 1] = at(s + 1);
			out[i * 4 + 2] = at(s + 2);
			out[i * 4 + 3] = ch === 4 ? at(s + 3) : 255;
		}
	}
	return { width, height, data: out };
}

export function encodePng(image: Rgba): Uint8Array {
	return encodePngRaw({ width: image.width, height: image.height, data: image.data, depth: 8, channels: 4 });
}

export { encodeJpeg };

/** RGB (3 bytes per pixel) to RGBA, opaque. */
export function rgbToRgba(width: number, height: number, rgb: Uint8Array): Rgba {
	const data = new Uint8Array(width * height * 4);
	for (let i = 0, j = 0; i < width * height; i++, j += 3) {
		data[i * 4] = rgb[j] ?? 0;
		data[i * 4 + 1] = rgb[j + 1] ?? 0;
		data[i * 4 + 2] = rgb[j + 2] ?? 0;
		data[i * 4 + 3] = 255;
	}
	return { width, height, data };
}

/** Pure: a binary PPM (P6, maxval 255) as written by `ffmpeg -c:v ppm`. Null if malformed or over the limits. */
export function parsePpm(bytes: Uint8Array, maxWidth: number, maxHeight: number): Rgba | null {
	const header: string[] = [];
	let i = 0;
	while (header.length < 4 && i < Math.min(bytes.length, 64)) {
		while (i < bytes.length && /\s/.test(String.fromCharCode(bytes[i] ?? 0))) i++;
		if (bytes[i] === 0x23) return null; // comments are never written by ffmpeg
		let token = "";
		while (i < bytes.length && !/\s/.test(String.fromCharCode(bytes[i] ?? 0)))
			token += String.fromCharCode(bytes[i++] ?? 0);
		header.push(token);
	}
	i++; // the single whitespace after maxval
	const [magic, w, h, max] = header;
	const width = Number(w);
	const height = Number(h);
	if (magic !== "P6" || max !== "255" || !Number.isInteger(width) || !Number.isInteger(height)) return null;
	if (width < 1 || height < 1 || width > maxWidth || height > maxHeight) return null;
	if (bytes.length < i + width * height * 3) return null;
	return rgbToRgba(width, height, bytes.subarray(i, i + width * height * 3));
}

/** Pure: an area-average reduction to `width` × `height` (never enlarges detail; used only to shrink). */
export function downscale(image: Rgba, width: number, height: number): Rgba {
	const w = Math.max(1, Math.round(width));
	const h = Math.max(1, Math.round(height));
	if (w === image.width && h === image.height) return image;
	const out = new Uint8Array(w * h * 4);
	const sx = image.width / w;
	const sy = image.height / h;
	for (let y = 0; y < h; y++) {
		const y0 = Math.floor(y * sy);
		const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
		for (let x = 0; x < w; x++) {
			const x0 = Math.floor(x * sx);
			const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			let n = 0;
			for (let yy = y0; yy < y1 && yy < image.height; yy++) {
				for (let xx = x0; xx < x1 && xx < image.width; xx++) {
					const s = (yy * image.width + xx) * 4;
					const alpha = image.data[s + 3] ?? 255;
					// Premultiplied, so a transparent pixel's colour does not bleed into its neighbours.
					r += (image.data[s] ?? 0) * alpha;
					g += (image.data[s + 1] ?? 0) * alpha;
					b += (image.data[s + 2] ?? 0) * alpha;
					a += alpha;
					n++;
				}
			}
			const d = (y * w + x) * 4;
			out[d] = a ? Math.round(r / a) : 0;
			out[d + 1] = a ? Math.round(g / a) : 0;
			out[d + 2] = a ? Math.round(b / a) : 0;
			out[d + 3] = n ? Math.round(a / n) : 0;
		}
	}
	return { width: w, height: h, data: out };
}

/** The largest size inside `maxWidth` × `maxHeight` with the image's aspect, never larger than the image. */
export function fitWithin(
	width: number,
	height: number,
	maxWidth: number,
	maxHeight: number,
): { width: number; height: number } {
	const scale = Math.min(1, maxWidth / width, maxHeight / height);
	return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Pure: a rectangle of the image (clamped to it). */
export function crop(image: Rgba, x: number, y: number, width: number, height: number): Rgba {
	const x0 = Math.max(0, Math.min(image.width - 1, Math.round(x)));
	const y0 = Math.max(0, Math.min(image.height - 1, Math.round(y)));
	const w = Math.max(1, Math.min(image.width - x0, Math.round(width)));
	const h = Math.max(1, Math.min(image.height - y0, Math.round(height)));
	const out = new Uint8Array(w * h * 4);
	for (let row = 0; row < h; row++) {
		const s = ((y0 + row) * image.width + x0) * 4;
		out.set(image.data.subarray(s, s + w * 4), row * w * 4);
	}
	return { width: w, height: h, data: out };
}

/** A region as fractions of the image (0..1), so it survives a change of resolution. */
export type Region = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
export const WHOLE: Region = { x: 0, y: 0, w: 1, h: 1 };

/** Rec. 709 luma of gamma-encoded RGB, 0..255 (what "brightness" means for a picture, not physical light). */
function luma(d: Uint8Array, s: number): number {
	return 0.2126 * (d[s] ?? 0) + 0.7152 * (d[s + 1] ?? 0) + 0.0722 * (d[s + 2] ?? 0);
}

export type LumaStats = {
	/** Mean luma, 0..255. */
	readonly mean: number;
	/** Standard deviation of luma: near 0 for a flat picture (black, a single colour). */
	readonly sd: number;
	/** Share of pixels brighter than 128 (city lights at night are few, small and bright). */
	readonly bright: number;
	readonly pixels: number;
};

/** Pure: luma statistics of a region; `brightAbove` is the luma a pixel must exceed to count as lit. */
export function lumaStats(image: Rgba, region: Region = WHOLE, brightAbove = 128): LumaStats {
	const x0 = Math.max(0, Math.floor(region.x * image.width));
	const y0 = Math.max(0, Math.floor(region.y * image.height));
	const x1 = Math.min(image.width, Math.ceil((region.x + region.w) * image.width));
	const y1 = Math.min(image.height, Math.ceil((region.y + region.h) * image.height));
	let sum = 0;
	let sq = 0;
	let bright = 0;
	let n = 0;
	for (let y = y0; y < y1; y++) {
		for (let x = x0; x < x1; x++) {
			const v = luma(image.data, (y * image.width + x) * 4);
			sum += v;
			sq += v * v;
			if (v > brightAbove) bright++;
			n++;
		}
	}
	if (n === 0) return { mean: 0, sd: 0, bright: 0, pixels: 0 };
	const mean = sum / n;
	return {
		mean: round2(mean),
		sd: round2(Math.sqrt(Math.max(0, sq / n - mean * mean))),
		bright: round4(bright / n),
		pixels: n,
	};
}

/**
 * Pure: a 64-bit difference hash (9×8 grey thumbnail, each bit = left brighter than right), as 16 hex digits.
 * Two stills of a live view differ in several bits over minutes (clouds, light, traffic, sensor noise); a frozen
 * server resends the same picture, hash for hash.
 */
export function dhash(image: Rgba): string {
	const small = downscale(image, 9, 8);
	let hex = "";
	for (let y = 0; y < 8; y++) {
		let byte = 0;
		for (let x = 0; x < 8; x++) {
			const a = luma(small.data, (y * 9 + x) * 4);
			const b = luma(small.data, (y * 9 + x + 1) * 4);
			byte = (byte << 1) | (a > b ? 1 : 0);
		}
		hex += byte.toString(16).padStart(2, "0");
	}
	return hex;
}

/** Bits that differ between two hashes of the same length. */
export function hamming(a: string, b: string): number {
	if (a.length !== b.length) return Math.max(a.length, b.length) * 4;
	let bits = 0;
	for (let i = 0; i < a.length; i += 2) {
		let x = Number.parseInt(a.slice(i, i + 2), 16) ^ Number.parseInt(b.slice(i, i + 2), 16);
		while (x) {
			bits += x & 1;
			x >>= 1;
		}
	}
	return bits;
}

/** Composite an image with transparency over a solid colour (for JPEG, which has none). */
export function flatten(image: Rgba, rgb: readonly [number, number, number]): Rgba {
	const out = new Uint8Array(image.data.length);
	for (let s = 0; s < image.data.length; s += 4) {
		const a = (image.data[s + 3] ?? 255) / 255;
		out[s] = Math.round((image.data[s] ?? 0) * a + rgb[0] * (1 - a));
		out[s + 1] = Math.round((image.data[s + 1] ?? 0) * a + rgb[1] * (1 - a));
		out[s + 2] = Math.round((image.data[s + 2] ?? 0) * a + rgb[2] * (1 - a));
		out[s + 3] = 255;
	}
	return { width: image.width, height: image.height, data: out };
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}
function round4(n: number): number {
	return Math.round(n * 10_000) / 10_000;
}
