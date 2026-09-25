import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "../../core/blobs.ts";
import { loadFixture } from "../../core/fixtures.ts";
import type { FetchContext, HttpLike, RawResponse } from "../../core/types.ts";
import { states as geoStates } from "../../geo/index.ts";
import { decodeJpeg, jpegSize } from "../../imaging/jpeg.ts";
import { parseColorMap, parseInterval } from "./colormap.ts";
import { CROP } from "./grid.ts";
import {
	CLOUD_COLORMAP_URL,
	CLOUD_LAYER,
	gibsNightlights,
	LIGHTS_LAYER,
	lightValues,
	type NightMosaic,
	needsFallback,
	nightKey,
	overpassAt,
	parseDomain,
	type RegionLight,
	SATELLITES,
	worldviewUrl,
} from "./index.ts";
import { stateMask } from "./masks.ts";

const raws = loadFixture(join(import.meta.dir, "fixtures", "2026-09-23"));
const tmp = mkdtempSync(join(tmpdir(), "vigia-gibs-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const lightTiles = raws.filter((r) => r.url.includes(`/${LIGHTS_LAYER}/default/2026-09-23/`));
const regions = (obs: ReturnType<typeof gibsNightlights.normalise>) =>
	new Map(
		obs
			.filter((o) => o.value.kind === "region")
			.map((o) => [(o.value as RegionLight).iso, o.value as RegionLight]),
	);

test("normalises the recorded night of 2026-09-23: picture, country and 25 states", () => {
	const obs = gibsNightlights.normalise(raws);
	expect(obs).toHaveLength(27);
	for (const o of obs) {
		expect(o.source).toBe("gibs-nightlights");
		expect(o.observedAt).toBe(Date.UTC(2026, 8, 23, 5, 56));
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(o.sourceUrl).toBe(worldviewUrl("2026-09-23"));
	}
	const mosaic = obs.find((o) => o.series === "mosaic")?.value as NightMosaic;
	expect(mosaic.key).toBe(
		nightKey(
			"2026-09-23",
			lightTiles.map((t) => t.body),
		),
	);
	expect(mosaic).toMatchObject({ width: 854, height: 768, ceiling: 38.2, cloudLayer: CLOUD_LAYER });
	expect(mosaic.bounds).toEqual({ west: -74.00390625, east: -58.9921875, south: 0, north: 13.5 });

	const r = regions(obs);
	expect(r.size).toBe(26);
	const ve = r.get("VE");
	expect(ve?.pixels).toBe(969_156);
	expect(ve?.validPixels).toBe(969_156);
	expect(ve?.radiance).toBeCloseTo(0.354, 3);
	expect(ve?.clearFraction).toBeCloseTo(0.458, 3);
	const dc = r.get("VE-A");
	expect(dc?.name).toBe("Distrito Capital");
	expect(dc?.pixels).toBe(397);
	expect(dc?.radiance).toBeCloseTo(16.118, 2);
	expect(dc?.saturatedFraction).toBeCloseTo(0.302, 3);
	// Amazonas is dark and was cloudy that night.
	expect(r.get("VE-Z")?.radiance).toBeLessThan(0.01);
	expect(r.get("VE-Z")?.clearFraction).toBeLessThan(0.05);
	const zulia = obs.find((o) => o.series === "state:VE-V");
	expect(zulia?.location?.state).toBe("VE-V");
	expect(zulia?.confidence).toBeLessThan(1);
});

test("state masks cover every state with about its official area", () => {
	const { labels, states } = stateMask();
	expect(states).toHaveLength(25);
	const counts = new Array<number>(states.length + 1).fill(0);
	for (const l of labels) counts[l] = (counts[l] ?? 0) + 1;
	const pxKm2 = 0.9785 * 0.9713; // 0.0087890625° at ≈7° N
	for (const [i, s] of states.entries()) {
		const area = geoStates().find((g) => g.iso === s.iso)?.areaKm2 ?? 0;
		const got = (counts[i + 1] ?? 0) * pxKm2;
		expect(got).toBeGreaterThan(0);
		// Large states within 5 %; islands and the smallest states are coarse at 1 km.
		if (area > 5_000) expect(Math.abs(got / area - 1)).toBeLessThan(0.05);
	}
	expect(labels.length).toBe(CROP.width * CROP.height);
});

test("a tile whose palette does not match the colormap fails the run", () => {
	const map = raws.find((r) => r.url.endsWith("VIIRS_DayNightBand_At_Sensor_Radiance.xml")) as RawResponse;
	const tampered = { ...map, body: map.body.replace('rgb="13,13,13"', 'rgb="14,14,14"') };
	expect(() => gibsNightlights.normalise(raws.map((r) => (r === map ? tampered : r)))).toThrow(
		"palette index 2",
	);
});

test("a night with a missing light tile is skipped whole; without the cloud mask quality is unknown", () => {
	const missing = raws.filter((r) => r !== lightTiles[5]);
	expect(() => gibsNightlights.normalise(missing)).toThrow("missing light tile");
	const noCloud = raws.filter((r) => !r.url.includes(CLOUD_LAYER) && r.url !== CLOUD_COLORMAP_URL);
	const obs = gibsNightlights.normalise(noCloud);
	expect(obs).toHaveLength(27);
	expect((obs.find((o) => o.series === "mosaic")?.value as NightMosaic | undefined)?.cloudLayer).toBeNull();
	expect(regions(obs).get("VE")?.clearFraction).toBeNull();
	expect(regions(obs).get("VE")?.radiance).toBeCloseTo(0.354, 3);
	// Domains only (nothing new to fetch): no observations, no error.
	expect(gibsNightlights.normalise(raws.slice(0, 2))).toEqual([]);
});

test("colormap intervals and radiance per class", () => {
	expect(parseInterval("[0,0.1)")).toEqual({ lo: 0, hi: 0.1 });
	expect(parseInterval("[38.2,999999.0)")).toEqual({ lo: 38.2, hi: Number.POSITIVE_INFINITY });
	expect(parseInterval("[1.0]")).toEqual({ lo: 1, hi: 1 });
	expect(parseInterval("[-999.900024,-999.900024]")).toEqual({ lo: -999.900024, hi: -999.900024 });
	expect(parseInterval("nope")).toBeNull();
	const map = parseColorMap(raws[2]?.body ?? "", "Radiance");
	expect(map.classes).toHaveLength(180);
	expect(map.nodata).toEqual([0]);
	const v = lightValues(map);
	expect(v[0]).toBeNaN();
	expect(v[1]).toBe(0);
	expect(v[2]).toBeCloseTo(0.15, 10);
	expect(v[180]).toBe(38.2);
	expect(() => parseColorMap("<ColorMaps/>", "Radiance")).toThrow("GIBS colormap");
});

test("GIBS domains: ranges, single dates, other periods ignored", () => {
	expect(parseDomain(raws[0]?.body ?? "")).toHaveLength(20);
	expect(parseDomain("<Domain>2026-09-01/2026-09-03/P1D,2026-09-05</Domain>")).toEqual([
		"2026-09-01",
		"2026-09-02",
		"2026-09-03",
		"2026-09-05",
	]);
	expect(parseDomain("<Domain>2026-09-01T00:00:00Z/2026-09-01T01:00:00Z/PT10M</Domain>")).toEqual([]);
	expect(() => parseDomain("<Domains/>")).toThrow("GIBS");
	expect(overpassAt("2026-09-23")).toBe(Date.UTC(2026, 8, 23, 5, 56));
});

test("fetch: four nights per run, newest first, each stored once as a small picture", async () => {
	const now = raws[0]?.fetchedAt ?? 0;
	const byUrl = new Map(raws.map((r) => [r.url, r]));
	const asked: string[] = [];
	const http: HttpLike = {
		request: async (url) => {
			asked.push(url);
			const hit = byUrl.get(url);
			if (hit) return hit;
			// Older nights are not in the fixture: answer like GIBS does for a tile, with a real (dark) tile.
			const tile = /\/(\d{4}-\d{2}-\d{2})\/(\w+)\/6\/(\d+)\/(\d+)\.png$/.exec(url);
			const same = tile
				? raws.find((r) => r.url.endsWith(`/${tile[2]}/6/${tile[3]}/${tile[4]}.png`))
				: undefined;
			if (same) return { ...same, url };
			throw new Error(`unexpected ${url}`);
		},
	};
	const blobs = new BlobStore(tmp, () => now).scope(
		"gibs-nightlights",
		gibsNightlights.blobs ?? { maxEntries: 1, maxBytes: 1, maxAgeMs: null },
	);
	const ctx: FetchContext = {
		http,
		key: () => undefined,
		now: () => now,
		signal: new AbortController().signal,
		blobs,
	};
	const first = await gibsNightlights.fetch(ctx);
	// 2 domains + 2 colormaps + 4 nights × 24 tiles.
	expect(first).toHaveLength(4 + 4 * 24);
	const stored = blobs.list();
	expect(stored.map((m) => m.name)).toEqual(["2026-09-23", "2026-09-22", "2026-09-21", "2026-09-20"]);
	const key = nightKey(
		"2026-09-23",
		lightTiles.map((t) => t.body),
	);
	expect(stored[0]?.key).toBe(key);
	const picture = new BlobStore(tmp).read("gibs-nightlights", key);
	const bytes = new Uint8Array(await Bun.file(picture?.path ?? "").arrayBuffer());
	expect(jpegSize(bytes)).toEqual({ width: 854, height: 768 });
	expect(bytes.byteLength).toBeLessThan(120_000);
	// Caracas is bright, the Amazonas forest dark.
	const img = decodeJpeg(bytes);
	const at = (lat: number, lon: number) =>
		img.data[
			(Math.floor(((13.5 - lat) / 13.5) * 768) * 854 +
				Math.floor(((lon + 74.00390625) / 15.01171875) * 854)) *
				4
		] ?? 0;
	expect(at(10.49, -66.9)).toBeGreaterThan(150);
	expect(at(3, -65.5)).toBeLessThan(10);

	asked.length = 0;
	const second = await gibsNightlights.fetch({ ...ctx, now: () => now });
	// The history fills 4 nights per run: 4 more are due, the stored ones are not asked again.
	expect(asked.filter((u) => u.includes("/2026-09-23/"))).toEqual([]);
	expect(second.length).toBe(4 + 4 * 24);
});

test("a listed night that is mostly empty is not used; nights in the future are not asked for", async () => {
	const { decode, encode } = await import("fast-png");
	const emptied = raws.map((r) => {
		if (!r.url.includes(`/${LIGHTS_LAYER}/`) || !r.url.endsWith(".png")) return r;
		const png = decode(new Uint8Array(Buffer.from(r.body, "base64")));
		const blank = encode({ ...png, data: new Uint8Array(png.data.length) });
		return { ...r, body: Buffer.from(blank).toString("base64") };
	});
	expect(() => gibsNightlights.normalise(emptied)).toThrow("% of Venezuela has data");

	const asked: string[] = [];
	const byUrl = new Map(raws.map((r) => [r.url, r]));
	const http: HttpLike = {
		request: async (url) => {
			asked.push(url);
			const tile = /\/(\w+)\/6\/(\d+)\/(\d+)\.png$/.exec(url);
			const same = tile
				? raws.find((r) => r.url.endsWith(`/${tile[1]}/6/${tile[2]}/${tile[3]}.png`))
				: undefined;
			const hit = byUrl.get(url) ?? (same ? { ...same, url } : undefined);
			if (hit) return hit;
			// Domain requests carry the run's own window; answer with the recorded domain.
			return { ...(raws[url.includes(CLOUD_LAYER) ? 1 : 0] as RawResponse), url };
		},
	};
	// 2026-09-23 04:00 UTC: the night of the 23rd has not been flown yet.
	const now = Date.UTC(2026, 8, 23, 4);
	await gibsNightlights.fetch({
		http,
		key: () => undefined,
		now: () => now,
		signal: new AbortController().signal,
	});
	expect(asked.some((u) => u.includes("/2026-09-23/"))).toBe(false);
	expect(asked.some((u) => u.includes("/2026-09-22/"))).toBe(true);
});

test("Suomi NPP fills what NOAA-20 lacks: asked only for a hole, a late newest night or none", () => {
	const now = Date.UTC(2026, 8, 24, 23);
	const run = (from: string, to: string) => {
		const out: string[] = [];
		for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000)
			out.push(new Date(t).toISOString().slice(0, 10));
		return out;
	};
	expect(needsFallback(run("2026-09-04", "2026-09-23"), "2026-09-04", now)).toBe(false);
	expect(needsFallback([], "2026-09-04", now)).toBe(true);
	expect(needsFallback(run("2026-09-04", "2026-09-19"), "2026-09-04", now)).toBe(true);
	const hole = run("2026-09-04", "2026-09-23").filter((d) => d !== "2026-09-10");
	expect(needsFallback(hole, "2026-09-04", now)).toBe(true);
});

test("a Suomi NPP night is read the same way and says which satellite it is from", () => {
	const snpp = raws.map((r) => ({
		...r,
		url: r.url
			.replace(`/${LIGHTS_LAYER}/`, `/${SATELLITES.SNPP.lights}/`)
			.replace(`/${CLOUD_LAYER}/`, `/${SATELLITES.SNPP.cloud}/`),
	}));
	const obs = gibsNightlights.normalise(snpp);
	const mosaic = obs.find((o) => o.series === "mosaic")?.value as NightMosaic;
	expect(mosaic).toMatchObject({
		satellite: "Suomi NPP",
		layer: SATELLITES.SNPP.lights,
		cloudLayer: SATELLITES.SNPP.cloud,
	});
	// Same tiles, same figures.
	const same = regions(gibsNightlights.normalise(raws));
	for (const [iso, r] of regions(obs)) expect(r.radiance).toBe(same.get(iso)?.radiance ?? Number.NaN);
	const noaa = gibsNightlights.normalise(raws).find((o) => o.series === "mosaic")?.value as NightMosaic;
	expect(noaa.satellite).toBe("NOAA-20");
});

test("fetch: when NOAA-20 lists no night, Suomi NPP's nights are fetched", async () => {
	const now = raws[0]?.fetchedAt ?? 0;
	const asked: string[] = [];
	const http: HttpLike = {
		request: async (url) => {
			asked.push(url);
			if (url.endsWith(".xml") && url.includes("/1.0.0/")) {
				const body = url.includes("VIIRS_NOAA20")
					? "<Domain></Domain>"
					: (raws[url.includes("Clear_Sky") ? 1 : 0] as RawResponse).body;
				return { ...(raws[0] as RawResponse), url, body };
			}
			const direct = raws.find((r) => r.url === url);
			if (direct) return direct;
			const tile = /\/(\d{4}-\d{2}-\d{2})\/(\w+)\/6\/(\d+)\/(\d+)\.png$/.exec(url);
			const kind = url.includes("Clear_Sky") ? CLOUD_LAYER : LIGHTS_LAYER;
			const same = tile
				? raws.find(
						(r) => r.url.includes(`/${kind}/`) && r.url.endsWith(`/${tile[2]}/6/${tile[3]}/${tile[4]}.png`),
					)
				: undefined;
			if (same) return { ...same, url };
			throw new Error(`unexpected ${url}`);
		},
	};
	const out = await gibsNightlights.fetch({
		http,
		key: () => undefined,
		now: () => now,
		signal: new AbortController().signal,
	});
	expect(asked.some((u) => u.includes(`/${SATELLITES.SNPP.lights}/default/2026-09-23/`))).toBe(true);
	expect(asked.some((u) => u.includes(`/${LIGHTS_LAYER}/default/2026`))).toBe(false);
	const mosaic = gibsNightlights.normalise(out).find((o) => o.series === "mosaic")?.value as NightMosaic;
	expect(mosaic.satellite).toBe("Suomi NPP");
});
