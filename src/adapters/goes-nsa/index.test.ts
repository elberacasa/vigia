import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "../../core/blobs.ts";
import { loadFixture } from "../../core/fixtures.ts";
import type { FetchContext, HttpLike, RawResponse, RequestOptions } from "../../core/types.ts";
import contextJson from "../../geo/data/context.geo.json" with { type: "json" };
import { decodeJpeg, jpegSize } from "../../imaging/jpeg.ts";
import { lighting, meanLevel, OUTPUT, renderFrame } from "./frame.ts";
import { fixedGrid, nsaPixel } from "./geos.ts";
import {
	candidateSlots,
	frameKey,
	frameName,
	frameUrl,
	goesNsa,
	namesFromListing,
	parseFrameName,
} from "./index.ts";

const raws = loadFixture(join(import.meta.dir, "fixtures", "2026-09-24-night"));
const frame = raws[0] as RawResponse;
const frameBytes = new Uint8Array(Buffer.from(frame.body, "base64"));
const tmp = mkdtempSync(join(tmpdir(), "vigia-goes-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test("normalises the recorded night frame", () => {
	const obs = goesNsa.normalise(raws);
	expect(obs).toHaveLength(1);
	const o = obs[0];
	expect(o?.source).toBe("goes-nsa");
	expect(o?.series).toBe("geocolor");
	expect(o?.observedAt).toBe(Date.UTC(2026, 8, 24, 23, 30));
	expect(o?.observedAt).toBeLessThanOrEqual(o?.fetchedAt ?? 0);
	expect(o?.sourceUrl).toBe(frameUrl("20262672330"));
	expect(o?.value.key).toBe(frameKey("20262672330", frame.body));
	expect(o?.value.key).toMatch(/^20262672330-[0-9a-f]{16}$/);
	// 19:30 in Venezuela: night, so the lights are NOAA's fixed layer.
	expect(o?.value.lighting).toBe("night");
	expect(o?.value.staticCityLights).toBe(true);
	expect(o?.value).toMatchObject({ width: 427, height: 384, sourceSize: "1800x1080" });
	expect(o?.value.bounds).toEqual({ west: -74.00390625, east: -58.9921875, south: 0, north: 13.5 });
});

test("a corrupt frame is skipped, the listing ignored; only corrupt frames fail the run", () => {
	const bad = {
		...frame,
		url: frameUrl("20262672320"),
		body: Buffer.from("<html>oops</html>").toString("base64"),
	};
	const listing = {
		...frame,
		url: "https://cdn.star.nesdis.noaa.gov/x/",
		contentType: "text/html",
		body: "",
	};
	expect(goesNsa.normalise([bad, frame, listing])).toHaveLength(1);
	expect(() => goesNsa.normalise([bad])).toThrow("GOES");
	expect(goesNsa.normalise([])).toEqual([]);
});

test("calibration: NOAA's burned-in coast and border lines fall on our projected coastlines", () => {
	const image = decodeJpeg(frameBytes);
	const white = (u: number, v: number) => {
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++) {
				const i = ((Math.floor(v) + dy) * image.width + Math.floor(u) + dx) * 4;
				if ((image.data[i] ?? 0) >= 200 && (image.data[i + 1] ?? 0) >= 200 && (image.data[i + 2] ?? 0) >= 200)
					return true;
			}
		return false;
	};
	let points = 0;
	let hits = 0;
	type Ring = number[][];
	for (const f of (
		contextJson as unknown as { features: { geometry: { type: string; coordinates: unknown } }[] }
	).features) {
		const polys = (
			f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates
		) as Ring[][];
		for (const poly of polys)
			for (const ring of poly)
				for (let i = 1; i < ring.length; i += 3) {
					const [lon = 0, lat = 0] = ring[i] ?? [];
					// Skip the straight edges where the context layer was clipped to a box.
					if (lon <= -74.99 || lon >= -55.01 || lat <= -0.49 || lat >= 14.99) continue;
					const p = nsaPixel(lat, lon, image.width);
					if (!p) continue;
					points++;
					if (white(p.u, p.v)) hits++;
				}
	}
	expect(points).toBeGreaterThan(500);
	// Measured 0.93 when fitting; a pixel of drift drops it well below 0.8.
	expect(hits / points).toBeGreaterThan(0.85);
});

test("the fixed grid: sub-satellite point is (0, 0) and the far side is invisible", () => {
	const nadir = fixedGrid(0, -75.2);
	expect(Math.abs(nadir?.x ?? 1)).toBeLessThan(1e-12);
	expect(Math.abs(nadir?.y ?? 1)).toBeLessThan(1e-12);
	expect(fixedGrid(0, 104.8)).toBeNull();
	// East is positive x, north positive y.
	expect(fixedGrid(10, -66)?.x).toBeGreaterThan(0);
	expect(fixedGrid(10, -66)?.y).toBeGreaterThan(0);
});

test("renders a small, non-blank Venezuela frame", () => {
	const jpg = renderFrame(frameBytes);
	expect(jpegSize(jpg)).toEqual({ width: OUTPUT.width, height: OUTPUT.height });
	expect(jpg.byteLength).toBeLessThan(80_000);
	expect(meanLevel(decodeJpeg(jpg))).toBeGreaterThan(5);
	const black = { width: 1800, height: 1080, data: new Uint8Array(1800 * 1080 * 4) };
	expect(meanLevel(black)).toBe(0);
});

test("frame names are NOAA's YYYYDDDHHMM and slots are on the 10-minute cadence", () => {
	expect(frameName(Date.UTC(2026, 8, 24, 23, 30))).toBe("20262672330");
	expect(parseFrameName("20262672330")).toBe(Date.UTC(2026, 8, 24, 23, 30));
	expect(parseFrameName("20263672330")).toBeNull();
	expect(parseFrameName("2026267233")).toBeNull();
	const slots = candidateSlots(Date.UTC(2026, 8, 24, 23, 47, 6));
	expect(slots[0]).toBe(Date.UTC(2026, 8, 24, 23, 30));
	expect(slots[1]).toBe(Date.UTC(2026, 8, 24, 23, 20));
	expect(slots).toHaveLength(26);
});

test("names from a real directory listing, newest first, only our size", () => {
	const html = [
		'<a href="1800x1080.jpg">1800x1080.jpg</a>                                      24-Sep-2026 23:10              988512',
		'<a href="20262572300_GOES19-ABI-nsa-GEOCOLOR-1800x1080.jpg">20262572300_GOES19-ABI-nsa-GEOCOLOR-1800x1080.jpg</a>  14-Sep-2026 23:16             1034719',
		'<a href="20262572310_GOES19-ABI-nsa-GEOCOLOR-1800x1080.jpg">20262572310_GOES19-ABI-nsa-GEOCOLOR-1800x1080.jpg</a>  14-Sep-2026 23:25             1034872',
		'<a href="20262572310_GOES19-ABI-nsa-GEOCOLOR-3600x2160.jpg">20262572310_GOES19-ABI-nsa-GEOCOLOR-3600x2160.jpg</a>  14-Sep-2026 23:25             2916017',
	].join("\n");
	expect(namesFromListing(html)).toEqual(["20262572310", "20262572300"]);
});

test("lighting: day, night and the terminator", () => {
	expect(lighting(Date.UTC(2026, 8, 24, 16, 0))).toBe("day");
	expect(lighting(Date.UTC(2026, 8, 24, 4, 0))).toBe("night");
	expect(lighting(Date.UTC(2026, 8, 24, 10, 20))).toBe("mixed");
});

test("fetch stores each new frame once, skips slots it has, and forgets nothing it needs", async () => {
	const now = Date.UTC(2026, 8, 24, 23, 47, 6);
	const asked: string[] = [];
	const http: HttpLike = {
		request: async (url: string, options?: RequestOptions) => {
			asked.push(url);
			const found = url === frameUrl("20262672330");
			expect(options?.binary).toBe(true);
			return { ...frame, url, status: found ? 200 : 404, body: found ? frame.body : "", fetchedAt: now };
		},
	};
	const blobs = new BlobStore(tmp, () => now).scope(
		"goes-nsa",
		goesNsa.blobs ?? { maxEntries: 1, maxBytes: 1, maxAgeMs: null },
	);
	const ctx: FetchContext = {
		http,
		key: () => undefined,
		now: () => now,
		signal: new AbortController().signal,
		blobs,
	};
	const first = await goesNsa.fetch(ctx);
	expect(first).toHaveLength(1);
	expect(asked).toHaveLength(26);
	const key = frameKey("20262672330", frame.body);
	expect(blobs.has(key)).toBe(true);
	expect(goesNsa.normalise(first)[0]?.value.key).toBe(key);

	asked.length = 0;
	const second = await goesNsa.fetch(ctx);
	expect(second).toHaveLength(0);
	// Stored frame not asked again; slots over an hour old that 404'd are known gaps; recent ones are retried.
	expect(asked).not.toContain(frameUrl("20262672330"));
	expect(asked).toEqual([
		frameUrl("20262672320"),
		frameUrl("20262672310"),
		frameUrl("20262672300"),
		frameUrl("20262672250"),
	]);
});

test("a frame whose image is stored but whose observation is not gets fetched again; one failed download spares the rest", async () => {
	const now = Date.UTC(2026, 8, 24, 23, 47, 6);
	const dir = mkdtempSync(join(tmpdir(), "vigia-goes-seen-"));
	try {
		const asked: string[] = [];
		const http: HttpLike = {
			request: async (url: string) => {
				asked.push(url);
				if (url === frameUrl("20262672320")) throw new Error("network: reset");
				const found = url === frameUrl("20262672330");
				return { ...frame, url, status: found ? 200 : 404, body: found ? frame.body : "", fetchedAt: now };
			},
		};
		const blobs = new BlobStore(dir, () => now).scope(
			"goes-nsa",
			goesNsa.blobs ?? { maxEntries: 1, maxBytes: 1, maxAgeMs: null },
		);
		const base = { http, key: () => undefined, now: () => now, signal: new AbortController().signal, blobs };
		// The 23:20 download fails, the 23:30 frame is still returned.
		expect(await goesNsa.fetch({ ...base, seen: () => false })).toHaveLength(1);
		asked.length = 0;
		// Stored image, no stored observation (the run died before the insert): asked again and returned.
		const again = await goesNsa.fetch({ ...base, seen: () => false });
		expect(asked).toContain(frameUrl("20262672330"));
		expect(again).toHaveLength(1);
		asked.length = 0;
		// Nothing new and a download failed: the run reports the failure (status page), but asks nothing twice.
		await expect(goesNsa.fetch({ ...base, seen: () => true })).rejects.toThrow("network: reset");
		expect(asked).not.toContain(frameUrl("20262672330"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
