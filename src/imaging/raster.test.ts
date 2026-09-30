import { expect, test } from "bun:test";
import { encode as encodePngRaw } from "fast-png";
import { encodeJpeg } from "./jpeg.ts";
import {
	crop,
	decodeImage,
	dhash,
	downscale,
	encodePng,
	fitWithin,
	flatten,
	hamming,
	lumaStats,
	parsePpm,
	type Rgba,
	sniffImage,
} from "./raster.ts";

function solid(width: number, height: number, rgba: [number, number, number, number]): Rgba {
	const data = new Uint8Array(width * height * 4);
	for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
	return { width, height, data };
}

/** Left half black, right half white. */
function halves(width: number, height: number): Rgba {
	const img = solid(width, height, [0, 0, 0, 255]);
	for (let y = 0; y < height; y++)
		for (let x = Math.floor(width / 2); x < width; x++)
			img.data.set([255, 255, 255, 255], (y * width + x) * 4);
	return img;
}

test("decode: PNG (RGBA, grey, palette) and JPEG round-trip through our own encoders", () => {
	const png = encodePng(halves(16, 8));
	expect(sniffImage(png)).toBe("png");
	const back = decodeImage(png);
	expect([back.width, back.height]).toEqual([16, 8]);
	expect([...back.data.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
	expect([...back.data.subarray(15 * 4, 16 * 4)]).toEqual([255, 255, 255, 255]);

	const grey = encodePngRaw({ width: 2, height: 1, data: new Uint8Array([10, 200]), depth: 8, channels: 1 });
	expect([...decodeImage(grey).data]).toEqual([10, 10, 10, 255, 200, 200, 200, 255]);

	const palette = encodePngRaw({
		width: 2,
		height: 1,
		data: new Uint8Array([0, 1]),
		depth: 8,
		channels: 1,
		palette: [
			[255, 0, 0],
			[0, 0, 255],
		],
	});
	expect([...decodeImage(palette).data]).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);

	const jpeg = encodeJpeg(solid(8, 8, [128, 128, 128, 255]), 90);
	expect(sniffImage(jpeg)).toBe("jpeg");
	const j = decodeImage(jpeg);
	expect(Math.abs((j.data[0] ?? 0) - 128)).toBeLessThanOrEqual(2);
});

test("decode: anything else, and decompression bombs, are refused before decoding", () => {
	expect(() => decodeImage(new TextEncoder().encode("<svg onload=alert(1)>"))).toThrow();
	expect(() => decodeImage(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toThrow();
	// A PNG header that claims 30000 × 30000 pixels.
	const bomb = new Uint8Array(64);
	bomb.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
	new DataView(bomb.buffer).setUint32(16, 30_000);
	new DataView(bomb.buffer).setUint32(20, 30_000);
	expect(() => decodeImage(bomb)).toThrow(/too large/);
});

test("PPM: ffmpeg's output is parsed within limits; anything malformed is null", () => {
	const header = new TextEncoder().encode("P6\n2 1\n255\n");
	const ppm = new Uint8Array([...header, 255, 0, 0, 0, 255, 0]);
	expect(parsePpm(ppm, 480, 480)).toEqual({
		width: 2,
		height: 1,
		data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]),
	});
	expect(parsePpm(ppm, 1, 480)).toBeNull();
	expect(parsePpm(ppm.subarray(0, ppm.length - 1), 480, 480)).toBeNull();
	expect(parsePpm(new TextEncoder().encode("P3\n2 1\n255\n1 2 3 4 5 6"), 480, 480)).toBeNull();
	expect(parsePpm(new TextEncoder().encode("P6\n2 1\n65535\n"), 480, 480)).toBeNull();
});

test("downscale averages areas (premultiplied), crop and fit keep geometry", () => {
	const small = downscale(halves(4, 2), 2, 1);
	expect([...small.data]).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
	// A transparent red pixel does not tint its opaque white neighbour.
	const mixed: Rgba = { width: 2, height: 1, data: new Uint8Array([255, 0, 0, 0, 255, 255, 255, 255]) };
	expect([...downscale(mixed, 1, 1).data]).toEqual([255, 255, 255, 128]);
	expect(crop(halves(4, 2), 2, 0, 2, 2).data.every((v) => v === 255)).toBe(true);
	expect(fitWithin(1000, 500, 256, 144)).toEqual({ width: 256, height: 128 });
	expect(fitWithin(100, 50, 256, 144)).toEqual({ width: 100, height: 50 });
	expect([...flatten(mixed, [10, 20, 30]).data.subarray(0, 4)]).toEqual([10, 20, 30, 255]);
});

test("luma statistics of a region; dhash tells pictures apart and survives re-encoding", () => {
	const img = halves(64, 32);
	expect(lumaStats(img)).toMatchObject({ mean: 127.5, bright: 0.5 });
	expect(lumaStats(img, { x: 0, y: 0, w: 0.5, h: 1 })).toMatchObject({ mean: 0, sd: 0, bright: 0 });
	expect(lumaStats(img, { x: 0.5, y: 0, w: 0.5, h: 1 }).mean).toBe(255);
	expect(lumaStats(solid(4, 4, [50, 50, 50, 255])).sd).toBe(0);

	const a = dhash(img);
	expect(a).toMatch(/^[0-9a-f]{16}$/);
	expect(hamming(a, a)).toBe(0);
	// The same picture after a lossy re-encode: (almost) the same hash.
	const again = decodeImage(encodeJpeg(img, 60));
	expect(hamming(a, dhash(again))).toBeLessThanOrEqual(2);
	// A different picture (a checkerboard of 7-px squares): many bits apart.
	const other = solid(63, 56, [0, 0, 0, 255]);
	for (let y = 0; y < 56; y++)
		for (let x = 0; x < 63; x++)
			if ((Math.floor(x / 7) + Math.floor(y / 7)) % 2) other.data.set([255, 255, 255, 255], (y * 63 + x) * 4);
	expect(hamming(a, dhash(other))).toBeGreaterThan(4);
	expect(hamming("00", "0000")).toBe(16);
});

test("PNG bombs: image data that inflates past what the header allows is refused before decoding", async () => {
	const { deflateSync } = await import("node:zlib");
	// A 1 × 1 RGBA header with 50 MB of zeros behind it (≈ 50 KB compressed), and a huge iCCP profile.
	const ihdr = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
	const crcChunk = (type: string, data: Uint8Array) => {
		const typed = new Uint8Array([...new TextEncoder().encode(type), ...data]);
		const out = new Uint8Array(12 + data.length);
		new DataView(out.buffer).setUint32(0, data.length);
		out.set(typed, 4);
		new DataView(out.buffer).setUint32(8 + data.length, Bun.hash.crc32(typed));
		return out;
	};
	const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	const bomb = new Uint8Array([
		...sig,
		...crcChunk("IHDR", ihdr),
		...crcChunk("IDAT", new Uint8Array(deflateSync(new Uint8Array(50_000_000)))),
		...crcChunk("IEND", new Uint8Array(0)),
	]);
	const before = process.memoryUsage().rss;
	expect(() => decodeImage(bomb)).toThrow();
	expect(process.memoryUsage().rss - before).toBeLessThan(64 * 1024 * 1024);
	// A profile bomb is dropped unread: the picture still decodes.
	const good = encodePng({ width: 2, height: 1, data: new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]) });
	const iccp = crcChunk("iCCP", new Uint8Array([0x70, 0, 0, ...deflateSync(new Uint8Array(30_000_000))]));
	const withIccp = new Uint8Array([...good.subarray(0, 33), ...iccp, ...good.subarray(33)]);
	expect([...decodeImage(withIccp).data]).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
});
