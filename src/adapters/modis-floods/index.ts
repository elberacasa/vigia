import { decode } from "fast-png";
import type { Adapter, FetchContext, Observation, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { frameSize, gibsDegPerPx, VENEZUELA_FRAME } from "../../imaging/frame.ts";
import { NASA_GIBS, parseDomain } from "../gibs-nightlights/index.ts";
import { floodMasks } from "./masks.ts";

/**
 * Observed floods in Venezuela from NASA's MODIS Near Real-Time Global Flood Product (LANCE MCDWD, Terra + Aqua),
 * 2-day composite, read through NASA GIBS: for each day, the area classed as flood, as recurring flood, as normal
 * surface water, and as "insufficient data" (cloud and cloud shadow: the product's own uncertainty class), per state,
 * per municipality and for the country, plus 0.1° cells with flood for the map.
 *
 * The product (colormap https://gibs.earthdata.nasa.gov/colormaps/v1.3/MODIS_Flood.xml, checked 2026-09-29): each
 * 250 m pixel is 0 "no water", 1 "surface water" (water where the reference water mask expects it), 2 "recurring
 * flood" (water seen in most years at this season), 3 "flood" (water outside both) or 255 "insufficient data". The
 * 2-day composite needs water on both days' passes, which NASA uses to cut the false floods cloud shadows cause in
 * single passes; it can still misread terrain and cloud shadow, so a "flood" here is the product's classification,
 * not a verified flood. Venezuela in the rainy season is mostly "insufficient data" (73 % of the frame on
 * 2026-09-27): the share is shown next to every figure, and an area is "flood seen", never "flooded area".
 *
 * How it is read (measured 2026-09-29): GIBS serves the layer as 512 px palette PNGs whose palette index is the
 * colormap's `ref` (0 nodata, 1..5 the classes above). Level 7 of the 250 m tile set (0.00439°, ≈490 m pixels) is
 * an exact nearest-neighbour subsample of the native level 8: every pixel of a level-7 tile over Apure equalled the
 * top-left pixel of its 2×2 level-8 block (262,144 of 262,144; the same held for level 6 against 4×4 blocks). So
 * every counted pixel is
 * a real 250 m pixel, one in four; an area is (sampled pixels) × (the level-7 pixel's area at that latitude):
 * calculado por Vigía, an estimate of about ±(1/√n) for n pixels. The frame (imaging/frame.ts) is 42 tiles, tile rows
 * 34–39 × cols 47–53, ≈0.5–1 MB a day. States and municipalities are the official boundaries (INE via OCHA COD-AB),
 * rasterised once by pixel centre (masks.ts); Lake Maracaibo is not in any municipality and counts for Zulia only
 * through the state polygon where that includes it.
 *
 * Timing: GIBS lists a date as soon as its first granules arrive; a day is read once it is 36 h past its start
 * (UTC), when both days' Terra and Aqua passes are in, and stored only when the product covers the whole country
 * (at most MAX_NODATA_SHARE of it without any class): a day still missing swaths is not stored, is not tried again
 * for RETRY_MS, and the run after takes the next older day. One day per run, newest first, up to 10 days back.
 *
 * Licence: NASA open data (GIBS/ESDIS, LANCE); acknowledgement shown.
 */

export const LAYER = "MODIS_Combined_Flood_2-Day";
const SET = "250m";
export const LEVEL = 7;
const GIBS = "https://gibs.earthdata.nasa.gov";
const TILE_PX = 512;
const DEG = gibsDegPerPx(LEVEL);
const TILE_DEG = DEG * TILE_PX;
export const ROWS = [34, 35, 36, 37, 38, 39] as const;
export const COLS = [47, 48, 49, 50, 51, 52, 53] as const;
export const FRAME = frameSize(LEVEL);
export const CROP = {
	x: Math.round((VENEZUELA_FRAME.west - (-180 + COLS[0] * TILE_DEG)) / DEG),
	y: Math.round((90 - ROWS[0] * TILE_DEG - VENEZUELA_FRAME.north) / DEG),
} as const;
const DAY = 86_400_000;
export const SETTLE_MS = 36 * 3_600_000;
export const LOOKBACK_DAYS = 10;
export const CELL_DEG = 0.1;
/** A day is stored only when at most this share of Venezuela has no product at all (2026-09-27: 0). */
export const MAX_NODATA_SHARE = 0.02;
/** A day tried and found incomplete is not downloaded again before this (per process). */
export const RETRY_MS = 12 * 3_600_000;
/** Dates tried and found incomplete, and when (this process only; a restart tries them again). */
const incomplete = new Map<string, number>();

/** Palette index → class. Index 0 is "no data" (outside the swaths or not yet produced). */
export const CLASSES = ["nodata", "dry", "water", "recurring", "flood", "insufficient"] as const;
/** RGB each palette index must carry (the published colormap), checked on every tile. */
export const PALETTE: readonly (readonly [number, number, number])[] = [
	[0, 0, 0],
	[0, 0, 1],
	[50, 210, 245],
	[255, 255, 0],
	[250, 30, 36],
	[175, 175, 175],
];

export type FloodStats = {
	/** Classed "flood" (water outside the reference and recurring masks), km². */
	floodKm2: number;
	/** Classed "recurring flood", km². */
	recurringKm2: number;
	/** Classed normal surface water, km². */
	waterKm2: number;
	/** "Insufficient data" (cloud, shadow, too few passes), km². */
	insufficientKm2: number;
	/** No product at all (outside every swath), km². */
	nodataKm2: number;
	/** The region's area on the raster, km². */
	areaKm2: number;
	/** Sampled pixels in the region (one per ≈0.24 km²). */
	pixels: number;
};

export type FloodDay = {
	/** UTC day the 2-day composite ends. */
	date: string;
	layer: string;
	level: number;
	venezuela: FloodStats;
	/** By ISO 3166-2 code. */
	states: Record<string, FloodStats>;
	/** By municipality P-code, only those with any flood or recurring flood. */
	municipalities: Record<string, FloodStats>;
	/** [lat, lon, floodKm2, recurringKm2] of 0.1° cells (south-west corner) with flood, inside Venezuela. */
	cells: [number, number, number, number][];
};

export function tileUrl(date: string, row: number, col: number): string {
	return `${GIBS}/wmts/epsg4326/best/${LAYER}/default/${date}/${SET}/${LEVEL}/${row}/${col}.png`;
}
export function domainUrl(start: string, end: string): string {
	return `${GIBS}/wmts/epsg4326/best/1.0.0/${LAYER}/default/${SET}/all/${start}--${end}.xml`;
}
/** A page a person can open to see the same day (NASA Worldview, flood layer). */
export function worldviewUrl(date: string): string {
	return `https://worldview.earthdata.nasa.gov/?v=-74,0,-59,13.5&l=${LAYER}&t=${date}-T00%3A00%3A00Z`;
}

const TILE_RE = /\/best\/([\w-]+)\/default\/(\d{4}-\d{2}-\d{2})\/250m\/(\d+)\/(\d+)\/(\d+)\.png$/;
const isoDay = (at: number) => new Date(at).toISOString().slice(0, 10);
const dayStart = (date: string) => Date.parse(`${date}T00:00:00Z`);

/** Dates to read now: listed, settled, within the lookback, not stored yet; newest first. */
export function datesToRead(
	listed: readonly string[],
	now: number,
	done: (date: string) => boolean,
): string[] {
	const oldest = isoDay(now - LOOKBACK_DAYS * DAY);
	return listed.filter((d) => d >= oldest && dayStart(d) + SETTLE_MS <= now && !done(d)).reverse();
}

async function fetchDay(ctx: FetchContext, date: string): Promise<RawResponse[]> {
	const out: RawResponse[] = [];
	for (const row of ROWS)
		for (const col of COLS)
			out.push(
				await ctx.http.request(tileUrl(date, row, col), {
					binary: true,
					hostGapMs: 500,
					timeoutMs: 30_000,
					maxBytes: 2 * 1024 * 1024,
					headers: { accept: "image/png" },
					signal: ctx.signal,
				}),
			);
	return out;
}

/** Decodes the 42 tiles of one day into the frame's palette indices; checks every tile's palette. */
export function mosaicDay(tiles: readonly RawResponse[], date: string): Uint8Array {
	const data = new Uint8Array(FRAME.width * FRAME.height);
	const got = new Set<string>();
	for (const raw of tiles) {
		const m = TILE_RE.exec(raw.url);
		if (!m || m[2] !== date) continue;
		const row = Number(m[4]);
		const col = Number(m[5]);
		let png: ReturnType<typeof decode>;
		try {
			png = decode(Buffer.from(raw.body, "base64"));
		} catch {
			throw new SchemaError(`GIBS flood ${date}: tile ${row}/${col} is not a PNG`);
		}
		if (
			png.width !== TILE_PX ||
			png.height !== TILE_PX ||
			png.channels !== 1 ||
			png.depth !== 8 ||
			!png.palette
		)
			throw new SchemaError(`GIBS flood ${date}: tile ${row}/${col} is not a 512×512 8-bit palette PNG`);
		for (const [i, rgb] of PALETTE.entries()) {
			const p = png.palette[i];
			if (!p || p[0] !== rgb[0] || p[1] !== rgb[1] || p[2] !== rgb[2])
				throw new SchemaError(`GIBS flood ${date}: tile ${row}/${col} palette differs from the colormap`);
		}
		got.add(`${row}/${col}`);
		const x0 = (col - COLS[0]) * TILE_PX - CROP.x;
		const y0 = (row - ROWS[0]) * TILE_PX - CROP.y;
		for (let y = 0; y < TILE_PX; y++) {
			const oy = y0 + y;
			if (oy < 0 || oy >= FRAME.height) continue;
			const xStart = Math.max(0, -x0);
			const xEnd = Math.min(TILE_PX, FRAME.width - x0);
			if (xEnd <= xStart) continue;
			const src = png.data.subarray(y * TILE_PX + xStart, y * TILE_PX + xEnd);
			for (let k = 0; k < src.length; k++)
				if ((src[k] ?? 0) > 5) throw new SchemaError("GIBS flood: bad index");
			data.set(src, oy * FRAME.width + x0 + xStart);
		}
	}
	for (const row of ROWS)
		for (const col of COLS)
			if (!got.has(`${row}/${col}`)) throw new SchemaError(`GIBS flood ${date}: missing tile ${row}/${col}`);
	return data;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

function emptyAcc(): number[] {
	// area by index 0..5, then pixels
	return [0, 0, 0, 0, 0, 0, 0];
}

function toStats(a: readonly number[]): FloodStats {
	const [nodata = 0, dry = 0, water = 0, recurring = 0, flood = 0, insufficient = 0, pixels = 0] = a;
	return {
		floodKm2: r1(flood),
		recurringKm2: r1(recurring),
		waterKm2: r1(water),
		insufficientKm2: r1(insufficient),
		nodataKm2: r1(nodata),
		areaKm2: r1(nodata + dry + water + recurring + flood + insufficient),
		pixels,
	};
}

/** Whether the product covers the country: at most MAX_NODATA_SHARE of it without any class. */
export function isComplete(day: FloodDay): boolean {
	const v = day.venezuela;
	return v.areaKm2 > 0 && v.nodataKm2 / v.areaKm2 <= MAX_NODATA_SHARE;
}

/** Per-region statistics of one day's classified raster (pure; exported for tests). */
export function floodStats(date: string, data: Uint8Array): FloodDay {
	const masks = floodMasks();
	const national = emptyAcc();
	const states = new Map<number, number[]>();
	const munis = new Map<number, number[]>();
	const cells = new Map<string, [number, number, number, number]>();
	const { width, height } = FRAME;
	for (let r = 0; r < height; r++) {
		const area = masks.rowArea[r] ?? 0;
		const lat = VENEZUELA_FRAME.north - (r + 0.5) * DEG;
		for (let c = 0; c < width; c++) {
			const i = r * width + c;
			const s = masks.states[i] ?? 0;
			if (s === 0) continue;
			const v = data[i] ?? 0;
			national[v] = (national[v] ?? 0) + area;
			national[6] = (national[6] ?? 0) + 1;
			const sa = states.get(s) ?? emptyAcc();
			sa[v] = (sa[v] ?? 0) + area;
			sa[6] = (sa[6] ?? 0) + 1;
			states.set(s, sa);
			const m = masks.municipalities[i] ?? 0;
			if (m !== 0) {
				const ma = munis.get(m) ?? emptyAcc();
				ma[v] = (ma[v] ?? 0) + area;
				ma[6] = (ma[6] ?? 0) + 1;
				munis.set(m, ma);
			}
			if (v === 3 || v === 4) {
				const lon = VENEZUELA_FRAME.west + (c + 0.5) * DEG;
				const cy = Math.floor(lat / CELL_DEG);
				const cx = Math.floor(lon / CELL_DEG);
				const k = `${cy}:${cx}`;
				const cell = cells.get(k) ?? [r1(cy * CELL_DEG), r1(cx * CELL_DEG), 0, 0];
				if (v === 4) cell[2] += area;
				else cell[3] += area;
				cells.set(k, cell);
			}
		}
	}
	const byState: Record<string, FloodStats> = {};
	for (const [label, acc] of [...states].sort((a, b) => a[0] - b[0])) {
		const iso = masks.stateIso[label - 1];
		if (iso) byState[iso] = toStats(acc);
	}
	const byMuni: Record<string, FloodStats> = {};
	for (const [label, acc] of [...munis].sort((a, b) => a[0] - b[0])) {
		const code = masks.municipalityCode[label - 1];
		if (!code || ((acc[3] ?? 0) === 0 && (acc[4] ?? 0) === 0)) continue;
		byMuni[code] = toStats(acc);
	}
	return {
		date,
		layer: LAYER,
		level: LEVEL,
		venezuela: toStats(national),
		states: byState,
		municipalities: byMuni,
		cells: [...cells.values()]
			.map(([la, lo, f, rc]) => [la, lo, r1(f), r1(rc)] as [number, number, number, number])
			.filter(([, , f, rc]) => f > 0 || rc > 0)
			.sort((a, b) => a[0] - b[0] || a[1] - b[1]),
	};
}

export const modisFloods: Adapter<FloodDay> = {
	id: "modis-floods",
	layer: "earth",
	name: {
		es: "Inundaciones vistas por satélite (NASA MODIS, compuesto de 2 días)",
		en: "Floods seen from space (NASA MODIS, 2-day composite)",
	},
	provider: "NASA LANCE / GIBS",
	homepage:
		"https://www.earthdata.nasa.gov/data/instruments/modis/near-real-time-data/nrt-global-flood-products",
	licence: NASA_GIBS,
	keys: [],
	// One day a run, ≈0.5–1 MB; a day settles 36 h after it starts, so every 3 h is prompt enough.
	intervalMs: 3 * 3_600_000,
	// A day lands about 1.5 days after it starts; four days without a newer one is a real delay.
	freshness: { fetchMs: 12 * 3_600_000, dataMs: 4 * DAY },

	async fetch(ctx) {
		const now = ctx.now();
		const domain = await ctx.http.request(domainUrl(isoDay(now - LOOKBACK_DAYS * DAY), isoDay(now + DAY)), {
			hostGapMs: 500,
			timeoutMs: 30_000,
			signal: ctx.signal,
		});
		for (const [d, at] of incomplete) if (now - at > RETRY_MS) incomplete.delete(d);
		const todo = datesToRead(
			parseDomain(domain.body),
			now,
			(d) => incomplete.has(d) || (ctx.seen?.("day", dayStart(d)) ?? false),
		);
		const date = todo[0];
		if (!date) return [domain];
		const tiles = await fetchDay(ctx, date);
		// Decided here too (normalise stays pure and decides the same): an incomplete day waits RETRY_MS.
		try {
			if (!isComplete(floodStats(date, mosaicDay(tiles, date)))) incomplete.set(date, now);
		} catch {
			// normalise reports the bad tiles
		}
		return [domain, ...tiles];
	},

	normalise(raws) {
		const domain = raws.find((r) => r.url.endsWith(".xml"));
		if (!domain) throw new SchemaError("GIBS flood: no domain response");
		parseDomain(domain.body);
		const tiles = raws.filter((r) => r.url.endsWith(".png"));
		const dates = [...new Set(tiles.map((r) => TILE_RE.exec(r.url)?.[2]).filter((d) => d !== undefined))];
		const out: Observation<FloodDay>[] = [];
		for (const date of dates) {
			const day = tiles.filter((r) => r.url.includes(`/${date}/`));
			const stats = floodStats(date, mosaicDay(day, date));
			// A day GIBS lists but has not fully produced over Venezuela yet: not stored, read again later.
			if (!isComplete(stats)) continue;
			const fetchedAt = Math.max(...day.map((r) => r.fetchedAt));
			out.push({
				source: "modis-floods",
				series: "day",
				sourceUrl: worldviewUrl(date),
				fetchedAt,
				observedAt: dayStart(date),
				licence: NASA_GIBS.id,
				value: stats,
				// NASA's per-pixel classes, counted by Vigía on a one-in-four sample.
				confidence: 0.8,
				basis: "derived",
			});
		}
		return out;
	},
};
