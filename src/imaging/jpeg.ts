import jpeg from "jpeg-js";

/**
 * JPEG in pure JavaScript (jpeg-js, BSD-3): no native module, so it works the same on Linux, macOS and
 * Windows and inside `bun build --compile` (sharp, measured 2026-09-24, cannot load its native binding from
 * a compiled binary). Cost measured on this machine: decoding a 1800×1080 frame ≈ 120 ms, encoding a
 * 427×384 frame ≈ 15 ms.
 */

export interface Rgba {
	readonly width: number;
	readonly height: number;
	/** RGBA, 4 bytes per pixel, row-major. */
	readonly data: Uint8Array;
}

/** Dimensions from the frame header (SOF marker) without decoding; null if this is not a JPEG. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
	if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
	let i = 2;
	while (i + 9 < bytes.length) {
		if (bytes[i] !== 0xff) return null;
		const marker = bytes[i + 1] ?? 0;
		if (marker === 0xff) {
			i++;
			continue;
		}
		const length = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
		// SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			const height = ((bytes[i + 5] ?? 0) << 8) | (bytes[i + 6] ?? 0);
			const width = ((bytes[i + 7] ?? 0) << 8) | (bytes[i + 8] ?? 0);
			return width > 0 && height > 0 ? { width, height } : null;
		}
		if (length < 2) return null;
		i += 2 + length;
	}
	return null;
}

/** Decodes a JPEG to RGBA; throws on corrupt data or anything over `maxMegapixels`. */
export function decodeJpeg(bytes: Uint8Array, maxMegapixels = 20): Rgba {
	const img = jpeg.decode(bytes, {
		useTArray: true,
		formatAsRGBA: true,
		maxResolutionInMP: maxMegapixels,
		maxMemoryUsageInMB: 512,
	});
	return { width: img.width, height: img.height, data: img.data };
}

export function encodeJpeg(image: Rgba, quality: number): Uint8Array {
	return new Uint8Array(
		jpeg.encode({ width: image.width, height: image.height, data: image.data }, quality).data,
	);
}
