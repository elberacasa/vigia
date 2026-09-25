import { blobKey } from "../../core/blobs.ts";
import type { Adapter, FetchContext, Licence, Observation, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { type Bounds, VENEZUELA_FRAME } from "../../imaging/frame.ts";
import { type ColorMap, checkPalette, parseColorMap, valueByIndex } from "./colormap.ts";
import { COLS, type IndexedRaster, LEVEL, mosaic, ROWS, type Tile } from "./grid.ts";
import { stateMask } from "./masks.ts";
import { DISPLAY, renderLights } from "./render.ts";
import { type LightStats, regionStats } from "./stats.ts";

/**
 * NASA GIBS night lights: VIIRS (NOAA-20) Black Marble, gap-filled and moonlight-corrected, one picture per
 * night from the ≈01:30 local overpass, published about a day and a half later. The second, independent
 * blackout signal: a state whose lights fall well below its own recent nights.
 *
 * For each new date the 12 level-6 tiles covering the Venezuela frame are fetched (≈0.4 MB), plus the 12
 * tiles of the same night's VIIRS cloud mask (clear-sky confidence), which says how much of each state was
 * actually seen that night: the product is gap-filled, so under cloud it repeats older nights. Pixel values
 * are read from palette indices through the layers' published colormaps (colormap.ts); per-state figures are
 * computed in code (stats.ts). The picture is stored as a ≈50 KB grey JPEG (render.ts). 14 nights are kept.
 *
 * Measured 2026-09-24: newest date 2026-09-23 at 23:15 UTC on the 24th; tile 0.3–0.5 s, 14–63 KB (lights),
 * ≈100 KB (cloud mask). GIBS publishes no rate limit; we pace 1 request per second and fetch at most 4
 * nights per run (the first hours fill the 14-night history).
 */

export const LIGHTS_LAYER = "VIIRS_NOAA20_GapFilled_BRDF_Corrected_DayNightBand_Radiance";
export const CLOUD_LAYER = "VIIRS_NOAA20_Clear_Sky_Confidence_Night";

/**
 * The same product from the other satellite. GIBS has had long holes in NOAA-20's series (none at all from
 * 2024-01-01 to 2026-05-31, domain listing read on 2026-09-24); Suomi NPP (VNP46A2, same algorithm, crossing
 * ≈50 min later) fills a night NOAA-20 lacks. Each night records which satellite it is from.
 */
export const SATELLITES = {
	NOAA20: { name: "NOAA-20", lights: LIGHTS_LAYER, cloud: CLOUD_LAYER },
	SNPP: {
		name: "Suomi NPP",
		lights: "VIIRS_SNPP_GapFilled_BRDF_Corrected_DayNightBand_Radiance",
		cloud: "VIIRS_SNPP_Clear_Sky_Confidence_Night",
	},
} as const;
export type Satellite = keyof typeof SATELLITES;
/** NOAA-20's newest night older than this counts as a hole to fill from Suomi NPP. */
const PRIMARY_LATE_MS = 3 * 86_400_000;

export function satelliteOfLayer(layer: string): Satellite {
	return layer === SATELLITES.SNPP.lights || layer === SATELLITES.SNPP.cloud ? "SNPP" : "NOAA20";
}
const LIGHTS_SET = "500m";
const CLOUD_SET = "1km";
const GIBS = "https://gibs.earthdata.nasa.gov";
export const LIGHTS_COLORMAP_URL = `${GIBS}/colormaps/v1.3/VIIRS_DayNightBand_At_Sensor_Radiance.xml`;
export const CLOUD_COLORMAP_URL = `${GIBS}/colormaps/v1.3/VIIRS_Clear_Sky_Confidence.xml`;
export const KEEP_NIGHTS = 14;
const MAX_NIGHTS_PER_RUN = 4;
const LOOKBACK_DAYS = 20;
/** Clear-sky confidence at or above this is "clear" (VIIRS cloud mask "probably clear" and better). */
export const CLEAR_CONFIDENCE = 0.95;
/**
 * NOAA-20 crosses at ≈01:30 local solar time; at 66.5° W (the frame's centre) that is ≈05:56 UTC, from ≈05:26
 * in the east to ≈06:26 in the west. Approximate; stated as such.
 */
const OVERPASS_UTC_MIN = 5 * 60 + 56;
export const PIPELINE_VERSION = "gibs-nightlights/1";
const REQUEST = { hostGapMs: 1_000, timeoutMs: 30_000 } as const;

export const NASA_GIBS: Licence = {
	id: "nasa-gibs",
	name: "Datos abiertos de NASA (GIBS/ESDIS)",
	url: "https://nasa-gibs.github.io/gibs-api-docs/",
	attribution:
		"We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS).",
	commercial: true,
};

export type NightMosaic = {
	readonly kind: "mosaic";
	/** GIBS date (UTC day of the overpass). */
	readonly date: string;
	/** Blob key of the picture: GET /api/blobs/gibs-nightlights/<key>. */
	readonly key: string;
	readonly width: number;
	readonly height: number;
	readonly bounds: Bounds;
	readonly layer: string;
	/** "NOAA-20" or "Suomi NPP" (a night NOAA-20 lacks); absent on nights stored before the fallback existed. */
	readonly satellite?: string;
	/** Null when the cloud mask for this night was not available. */
	readonly cloudLayer: string | null;
	readonly unit: string;
	/** Radiance ceiling of the colormap: brighter pixels count as this. */
	readonly ceiling: number;
	readonly pipeline: string;
};

export type RegionLight = LightStats & {
	readonly kind: "region";
	readonly date: string;
	/** ISO 3166-2 (VE-X), or "VE" for the whole country. */
	readonly iso: string;
	readonly name: string;
};

export type NightLights = NightMosaic | RegionLight;

export function domainUrl(layer: string, set: string, start: string, end: string): string {
	return `${GIBS}/wmts/epsg4326/best/1.0.0/${layer}/default/${set}/all/${start}--${end}.xml`;
}

export function tileUrl(layer: string, set: string, date: string, row: number, col: number): string {
	return `${GIBS}/wmts/epsg4326/best/${layer}/default/${date}/${set}/${LEVEL}/${row}/${col}.png`;
}

const TILE_RE =
	/\/wmts\/epsg4326\/best\/([\w-]+)\/default\/(\d{4}-\d{2}-\d{2})\/\w+\/(\d+)\/(\d+)\/(\d+)\.png$/;

/** A page a person can open to see the same night (NASA Worldview). */
export function worldviewUrl(date: string): string {
	return `https://worldview.earthdata.nasa.gov/?v=-74,0,-59,13.5&l=${LIGHTS_LAYER}&t=${date}-T00%3A00%3A00Z`;
}

const isoDay = (at: number) => new Date(at).toISOString().slice(0, 10);

/** Dates listed in a GIBS DescribeDomains response (`2026-09-01/2026-09-23/P1D,2026-09-25`). */
export function parseDomain(xml: string): string[] {
	const text = /<Domain>([^<]*)<\/Domain>/.exec(xml)?.[1];
	if (text === undefined) throw new SchemaError("GIBS domains: no <Domain>");
	const out = new Set<string>();
	for (const item of text.split(",").map((s) => s.trim())) {
		if (!item) continue;
		const [start, end = start, period = "P1D"] = item.split("/");
		if (!start || !/^\d{4}-\d{2}-\d{2}/.test(start) || period !== "P1D") continue;
		const from = Date.parse(`${start.slice(0, 10)}T00:00:00Z`);
		const to = Date.parse(`${(end ?? start).slice(0, 10)}T00:00:00Z`);
		if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 400 * 86_400_000) continue;
		for (let t = from; t <= to; t += 86_400_000) out.add(isoDay(t));
	}
	return [...out].sort();
}

/** Approximate overpass time of a GIBS night date. */
export function overpassAt(date: string): number {
	return Date.parse(`${date}T00:00:00Z`) + OVERPASS_UTC_MIN * 60_000;
}

/** Blob key of a night's picture: the date plus a hash of its 12 light tiles and the pipeline version. */
export function nightKey(date: string, tileBodies: readonly string[]): string {
	return blobKey(date, ...tileBodies, PIPELINE_VERSION);
}

type ParsedTile = Tile & {
	readonly layer: string;
	readonly date: string;
	readonly body: string;
	readonly fetchedAt: number;
};

function parseTiles(raws: readonly RawResponse[]): ParsedTile[] {
	const out: ParsedTile[] = [];
	for (const raw of raws) {
		const m = TILE_RE.exec(raw.url);
		if (!m || raw.status !== 200 || Number(m[3]) !== LEVEL) continue;
		out.push({
			layer: m[1] ?? "",
			date: m[2] ?? "",
			row: Number(m[4]),
			col: Number(m[5]),
			body: raw.body,
			fetchedAt: raw.fetchedAt,
			png: new Uint8Array(Buffer.from(raw.body, "base64")),
		});
	}
	return out;
}

/** The 12 tiles of one layer and date in row/col order, or null if any is missing. */
function tilesOf(tiles: readonly ParsedTile[], layer: string, date: string): ParsedTile[] | null {
	const out: ParsedTile[] = [];
	for (const row of ROWS)
		for (const col of COLS) {
			const t = tiles.find((x) => x.layer === layer && x.date === date && x.row === row && x.col === col);
			if (!t) return null;
			out.push(t);
		}
	return out;
}

type Maps = { readonly lights: ColorMap; readonly cloud: ColorMap | null };

/** The light colormap is required; a missing or broken cloud colormap only costs the quality label. */
function colormaps(raws: readonly RawResponse[]): Maps {
	const lightsRaw = raws.find((r) => r.url === LIGHTS_COLORMAP_URL);
	if (!lightsRaw) throw new SchemaError("GIBS: night-lights colormap missing");
	const cloudRaw = raws.find((r) => r.url === CLOUD_COLORMAP_URL);
	let cloud: ColorMap | null = null;
	try {
		cloud = cloudRaw ? parseColorMap(cloudRaw.body, "Clear Sky Confidence") : null;
	} catch {
		cloud = null;
	}
	return { lights: parseColorMap(lightsRaw.body, "Radiance"), cloud };
}

/**
 * Whether to ask Suomi NPP too: NOAA-20 lists no night in the window, has a hole before its newest night, or its
 * newest night is older than PRIMARY_LATE_MS.
 */
export function needsFallback(primary: readonly string[], start: string, now: number): boolean {
	const newest = primary.at(-1);
	if (!newest) return true;
	if (now - overpassAt(newest) > PRIMARY_LATE_MS) return true;
	const have = new Set(primary);
	for (let t = Date.parse(`${start}T00:00:00Z`); t < Date.parse(`${newest}T00:00:00Z`); t += 86_400_000)
		if (!have.has(isoDay(t))) return true;
	return false;
}

/** Share of Venezuela's pixels a night must have data for; below it the night is not used at all. */
export const MIN_COVERAGE = 0.95;

type Night = {
	readonly sat: Satellite;
	readonly lightTiles: readonly ParsedTile[];
	readonly lights: IndexedRaster;
	readonly cloud: IndexedRaster | null;
	readonly stats: ReturnType<typeof regionStats>;
};

/**
 * One night from its tiles: light mosaic (required, palette checked), cloud mosaic (optional: any problem
 * with it means "quality unknown", not a failed night), statistics. Pure; used by fetch (to decide whether
 * to store the picture) and normalise, so both agree. Throws with the reason when the night is unusable.
 */
export function analyseNight(tiles: readonly ParsedTile[], maps: Maps, date: string): Night {
	// The night's satellite: NOAA-20 when its tiles are there, else Suomi NPP.
	const sat: Satellite = tilesOf(tiles, LIGHTS_LAYER, date) ? "NOAA20" : "SNPP";
	const lightTiles = tilesOf(tiles, SATELLITES[sat].lights, date);
	// A night with a missing tile is unusable: partial states would read as darkness.
	if (!lightTiles) throw new SchemaError(`GIBS ${date}: missing light tile`);
	const lights = mosaic(lightTiles, `GIBS lights ${date}`, (p, what) => checkPalette(maps.lights, p, what));
	let cloud: IndexedRaster | null = null;
	const cloudTiles = tilesOf(tiles, SATELLITES[sat].cloud, date);
	const cloudMap = maps.cloud;
	if (cloudTiles && cloudMap) {
		try {
			cloud = mosaic(cloudTiles, `GIBS cloud ${date}`, (p, what) => checkPalette(cloudMap, p, what));
		} catch {
			cloud = null;
		}
	}
	const { labels, states } = stateMask();
	const top = maps.lights.classes.reduce((a, b) => (b.lo > a.lo ? b : a));
	const stats = regionStats({
		labels,
		regions: states.length,
		lights,
		lightValue: lightValues(maps.lights),
		saturatedIndex: top.ref,
		cloud,
		cloudClass: cloud && cloudMap ? clearByIndex(cloudMap) : null,
	});
	const coverage = stats.national.pixels > 0 ? stats.national.validPixels / stats.national.pixels : 0;
	// A listed night whose tiles are mostly empty would hide the last good night and read as a blackout.
	if (coverage < MIN_COVERAGE) {
		throw new SchemaError(`GIBS ${date}: only ${(coverage * 100).toFixed(0)} % of Venezuela has data`);
	}
	return { lightTiles, lights, cloud, stats, sat };
}

/** Confidence of a regional figure: an index (≤ 0.8), lower the more of it repeats older nights. */
export function regionConfidence(clearFraction: number | null): number {
	return clearFraction === null ? 0.4 : Math.round((0.4 + 0.4 * clearFraction) * 100) / 100;
}

/** Nights found unusable, not asked for again for 12 hours. Process-local. */
const rejected = new Map<string, number>();

export const gibsNightlights: Adapter<NightLights> = {
	id: "gibs-nightlights",
	layer: "internet",
	name: { es: "Luces nocturnas (NASA VIIRS)", en: "Night lights (NASA VIIRS)" },
	provider: "NASA GIBS / Black Marble",
	homepage: "https://worldview.earthdata.nasa.gov/",
	licence: NASA_GIBS,
	keys: [],
	intervalMs: 60 * 60_000,
	// A night lands ≈1.5 days after its overpass; 3.5 days without a newer one is a real delay.
	freshness: { fetchMs: 4 * 3_600_000, dataMs: 84 * 3_600_000 },
	blobs: { maxEntries: KEEP_NIGHTS + 4, maxBytes: 24 * 1024 * 1024, maxAgeMs: 21 * 86_400_000 },

	async fetch(ctx) {
		const now = ctx.now();
		const start = isoDay(now - LOOKBACK_DAYS * 86_400_000);
		const end = isoDay(now + 86_400_000);
		const request = (url: string, binary = false) =>
			ctx.http.request(url, { ...REQUEST, signal: ctx.signal, ...(binary ? { binary: true } : {}) });
		const lightsDomain = await request(domainUrl(LIGHTS_LAYER, LIGHTS_SET, start, end));
		const cloudDomain = await request(domainUrl(CLOUD_LAYER, CLOUD_SET, start, end));
		const primary = parseDomain(lightsDomain.body);
		const cloudDates = new Set(parseDomain(cloudDomain.body));
		const satOf = new Map<string, Satellite>(primary.map((d) => [d, "NOAA20"]));
		const domains: RawResponse[] = [lightsDomain, cloudDomain];
		if (needsFallback(primary, start, now)) {
			const alt = await request(domainUrl(SATELLITES.SNPP.lights, LIGHTS_SET, start, end));
			const altCloud = await request(domainUrl(SATELLITES.SNPP.cloud, CLOUD_SET, start, end));
			domains.push(alt, altCloud);
			const altCloudDates = new Set(parseDomain(altCloud.body));
			for (const d of parseDomain(alt.body)) {
				if (satOf.has(d)) continue;
				satOf.set(d, "SNPP");
				if (altCloudDates.has(d)) cloudDates.add(d);
				else cloudDates.delete(d);
			}
		}
		const dates = [...satOf.keys()].sort();
		const newest = dates.at(-1);
		if (!newest) throw new SchemaError("GIBS: no night-lights date in the last 20 days");
		const oldestKept = isoDay(Date.parse(`${newest}T00:00:00Z`) - (KEEP_NIGHTS - 1) * 86_400_000);
		for (const [d, at] of rejected) if (now - at > 12 * 3_600_000) rejected.delete(d);
		// Done = picture stored AND observation stored (a run that died in between is redone).
		const stored = new Set(ctx.blobs?.list().map((m) => m.name));
		const done = (d: string) => stored.has(d) && (ctx.seen?.("mosaic", overpassAt(d)) ?? true);
		const todo = dates
			.filter((d) => d >= oldestKept && overpassAt(d) <= now && !done(d) && !rejected.has(d))
			.reverse()
			.slice(0, ctx.blobs ? MAX_NIGHTS_PER_RUN : 1);
		const out: RawResponse[] = [...domains];
		if (todo.length === 0) return out;

		const mapRaws = [await request(LIGHTS_COLORMAP_URL), await request(CLOUD_COLORMAP_URL)];
		const maps = colormaps(mapRaws);
		out.push(...mapRaws);
		const errors: string[] = [];
		for (const date of todo) {
			try {
				out.push(...(await fetchNight(ctx, date, cloudDates.has(date), maps, satOf.get(date) ?? "NOAA20")));
			} catch (error) {
				if (ctx.signal.aborted) throw error;
				if (error instanceof SchemaError) rejected.set(date, now);
				errors.push(`${date}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (errors.length === todo.length) throw new Error(`GIBS night lights: ${errors[0]}`);
		return out;
	},

	normalise(raws) {
		const tiles = parseTiles(raws);
		if (tiles.length === 0) return [];
		const maps = colormaps(raws);
		const { states } = stateMask();
		const top = maps.lights.classes.reduce((a, b) => (b.lo > a.lo ? b : a));
		const out: Observation<NightLights>[] = [];
		const problems: string[] = [];
		const lightLayers: string[] = [SATELLITES.NOAA20.lights, SATELLITES.SNPP.lights];
		const dates = [...new Set(tiles.filter((t) => lightLayers.includes(t.layer)).map((t) => t.date))].sort();
		for (const date of dates) {
			let night: Night;
			try {
				night = analyseNight(tiles, maps, date);
			} catch (error) {
				// One unusable night is skipped; the others stand.
				problems.push(error instanceof Error ? error.message : String(error));
				continue;
			}
			const { lightTiles, cloud, stats, sat } = night;
			const base = {
				source: "gibs-nightlights",
				sourceUrl: worldviewUrl(date),
				fetchedAt: Math.max(...lightTiles.map((t) => t.fetchedAt)),
				observedAt: overpassAt(date),
				licence: NASA_GIBS.id,
				basis: "measurement" as const,
			};
			out.push({
				...base,
				series: "mosaic",
				value: {
					kind: "mosaic",
					date,
					key: nightKey(
						date,
						lightTiles.map((t) => t.body),
					),
					width: DISPLAY.width,
					height: DISPLAY.height,
					bounds: { ...VENEZUELA_FRAME },
					layer: SATELLITES[sat].lights,
					cloudLayer: cloud ? SATELLITES[sat].cloud : null,
					satellite: SATELLITES[sat].name,
					unit: maps.lights.units ?? "nW/(cm² sr)",
					ceiling: top.lo,
					pipeline: PIPELINE_VERSION,
				},
				confidence: 1,
			});
			// Regional figures are an index from classed pixels, gap-filled under cloud: not calibrated totals.
			out.push({
				...base,
				series: "country:VE",
				value: { kind: "region", date, iso: "VE", name: "Venezuela", ...stats.national },
				confidence: regionConfidence(stats.national.clearFraction),
			});
			states.forEach((state, i) => {
				const r = stats.regions[i + 1];
				if (!r) return;
				out.push({
					...base,
					series: `state:${state.iso}`,
					value: { kind: "region", date, iso: state.iso, name: state.name, ...r },
					location: { lat: state.label.lat, lon: state.label.lon, state: state.iso },
					confidence: regionConfidence(r.clearFraction),
				});
			});
		}
		if (out.length === 0 && problems.length > 0) throw new SchemaError(problems[0]);
		return out;
	},
};

/**
 * Radiance per palette index: class midpoints, the open top class at its floor (38.2), and the darkest class
 * [0, 0.1) as 0: it is below what the Day/Night Band can tell from darkness, and counting it as 0.05 would add
 * a constant floor that dilutes every change in sparsely lit states (Amazonas would read 0.056 instead of
 * ≈0.006, a blackout in its towns hidden under the floor).
 */
export function lightValues(map: ColorMap): Float64Array {
	const out = valueByIndex(map);
	for (const c of map.classes) if (c.lo === 0 && c.hi <= 0.1) out[c.ref] = 0;
	return out;
}

/** 1 = clear (confidence ≥ 0.95), 0 = not clear, 255 = no data, per palette index. */
export function clearByIndex(map: ColorMap): Uint8Array {
	const out = new Uint8Array(256).fill(255);
	for (const c of map.classes) out[c.ref] = c.lo >= CLEAR_CONFIDENCE ? 1 : 0;
	return out;
}

async function fetchNight(
	ctx: FetchContext,
	date: string,
	withCloud: boolean,
	maps: Maps,
	sat: Satellite = "NOAA20",
): Promise<RawResponse[]> {
	const out: RawResponse[] = [];
	const layers: [string, string][] = [[SATELLITES[sat].lights, LIGHTS_SET]];
	if (withCloud) layers.push([SATELLITES[sat].cloud, CLOUD_SET]);
	for (const [layer, set] of layers) {
		for (const row of ROWS) {
			for (const col of COLS) {
				const raw = await ctx.http.request(tileUrl(layer, set, date, row, col), {
					...REQUEST,
					binary: true,
					maxBytes: 2 * 1024 * 1024,
					headers: { accept: "image/png" },
					signal: ctx.signal,
				});
				if (!raw.contentType.startsWith("image/png"))
					throw new Error(`tile ${row}/${col} is ${raw.contentType}`);
				out.push(raw);
			}
		}
	}
	// Same analysis as normalise: a night normalise would skip is neither stored nor returned.
	const night = analyseNight(parseTiles(out), maps, date);
	if (ctx.blobs) {
		ctx.blobs.put(
			nightKey(
				date,
				night.lightTiles.map((t) => t.body),
			),
			renderLights(night.lights, maps.lights),
			{
				name: date,
				contentType: "image/jpeg",
				observedAt: overpassAt(date),
				width: DISPLAY.width,
				height: DISPLAY.height,
			},
		);
	}
	return out;
}
