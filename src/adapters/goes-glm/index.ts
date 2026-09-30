import type { Adapter, FetchContext, Licence, Observation, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { Hdf5Error, Hdf5File, NeedBytes, SparseFile } from "../../formats/hdf5.ts";
import { locate } from "../../geo/index.ts";
import { inLakeMaracaibo, LAKE_MARACAIBO } from "../../geo/place.ts";

/**
 * Lightning over Venezuela from GOES-19's Geostationary Lightning Mapper (GLM): NOAA's Level-2 "Lightning Cluster
 * Filter Algorithm" files (`GLM-L2-LCFA`), one NetCDF-4 (HDF5) file per 20 seconds for the whole disk, public on
 * AWS (NOAA Open Data Dissemination, bucket `noaa-goes19`).
 *
 * Measured 2026-09-28/29: 179–180 files an hour, ~630 KB each (112 MB/hour for the full files), uploaded ~30 s after
 * their 20 s end. Vigía needs three variables of each file (`flash_lat`, `flash_lon`, `flash_quality_flag`, about
 * 800 flashes for the disk, ~8 KB compressed), so it reads them with HTTP Range requests through the in-repo HDF5
 * reader (formats/hdf5.ts): 17 requests and ~24 KB per file, 1.8 s (≈4.3 MB and 3,060 requests an hour, ≈100 MB a
 * day, about what the GeoColor loop costs). No Python, no HDF5 library, nothing to install.
 *
 * Every run turns each complete 15-minute window (UTC :00/:15/:30/:45, 45 files) into one observation: good-quality
 * flashes (`flash_quality_flag` = 0) in Venezuela per state (official boundaries; Lake Maracaibo counted in Zulia),
 * in the Catatumbo area (a 1° box on the lightning hotspot of the Lake Maracaibo basin), and on a 0.25° grid over the
 * region for the map. A window is read 5 minutes after it ends; one with files missing is stored as incomplete, with
 * how many were read. GLM detects most but not all lightning (a satellite measurement): the panel says "rayos
 * detectados por GLM", never "todos los rayos".
 */

export const GLM_BUCKET = "https://noaa-goes19.s3.amazonaws.com/";
export const GLM_PRODUCT = "GLM-L2-LCFA";
export const GLM_PAGE = "https://registry.opendata.aws/noaa-goes/";

export const GLM_LICENCE: Licence = {
	id: "noaa-open-data-glm",
	name: "Dominio público (NOAA Open Data Dissemination)",
	url: "https://www.noaa.gov/information-technology/open-data-dissemination",
	attribution: "Datos: NOAA, GOES-19 GLM (Geostationary Lightning Mapper)",
	commercial: true,
};

export const WINDOW_MS = 15 * 60_000;
export const FILES_PER_WINDOW = 45;
/** Files land ~30 s after their end; a window is read 5 minutes after it closes. */
const READ_AFTER_MS = 5 * 60_000;
/** Windows missed while Vigía was off are caught up for 2 hours, at most 2 per run (~90 s each). */
const BACKFILL_MS = 2 * 3_600_000;
export const MAX_WINDOWS_PER_RUN = 2;
/** A file whose structure needs more reads than this is given up (a layout change, not a slow network). */
const MAX_READS_PER_FILE = 60;
const MIN_READ = 1_024;
const FIRST_READ = 4_096;
const DATASETS = ["flash_lat", "flash_lon", "flash_quality_flag"] as const;

/** Venezuela and its surroundings: the grid of the map layer. */
export const REGION = { minLat: 0.5, maxLat: 12.5, minLon: -73.5, maxLon: -59.5 } as const;
/**
 * The Catatumbo area: 1° box centred on 9.75 °N, 71.65 °W, the Lake Maracaibo basin hotspot of the LIS lightning
 * climatology (Albrecht et al., 2016, BAMS, "Where Are the Lightning Hotspots on Earth?").
 */
export const CATATUMBO = { minLat: 9.25, maxLat: 10.25, minLon: -72.15, maxLon: -71.15 } as const;
export const CELL_DEG = 0.25;

export type LightningWindow = {
	/** Window start, ISO UTC. */
	readonly windowStart: string;
	readonly windowMinutes: number;
	readonly filesListed: number;
	readonly filesRead: number;
	/** All 45 files of the window were read. */
	readonly complete: boolean;
	/** Good-quality flashes: in Venezuela (Lake Maracaibo included), in the Catatumbo box, on the lake. */
	readonly venezuela: number;
	readonly catatumbo: number;
	readonly lake: number;
	/** Flashes per state, ISO 3166-2 ("VE-V": 12); states with none are absent. */
	readonly byState: Record<string, number>;
	/** [lat, lon, n] of the 0.25° cells over REGION (land and sea) with at least one flash; lat/lon = cell centre. */
	readonly cells: [number, number, number][];
	/** Flashes in REGION that GLM flagged as not good quality (not counted anywhere above). */
	readonly flagged: number;
	readonly satellite: string;
};

// ---------------------------------------------------------------------------------------------------------
// Names and windows

/** "OR_GLM-L2-LCFA_G19_s20262720115200_e…" → start time (epoch ms); null otherwise. */
export function fileStart(key: string): number | null {
	const m = /_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})(\d)_e\d{14}_c\d{14}\.nc$/.exec(key);
	if (!m) return null;
	const [year, day, h, min, s, tenth] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as number[];
	return Date.UTC(year ?? 0, 0, day ?? 0, h ?? 0, min ?? 0, s ?? 0, (tenth ?? 0) * 100);
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** The hour prefix and the start-after key that list one window's files. */
export function listingUrl(windowStart: number): string {
	const d = new Date(windowStart);
	const day = Math.floor((windowStart - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000) + 1;
	const prefix = `${GLM_PRODUCT}/${d.getUTCFullYear()}/${pad(day, 3)}/${pad(d.getUTCHours())}/`;
	const minute = `${d.getUTCFullYear()}${pad(day, 3)}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
	const after = `${prefix}OR_${GLM_PRODUCT}_G19_s${minute}`;
	return `${GLM_BUCKET}?list-type=2&prefix=${encodeURIComponent(prefix)}&start-after=${encodeURIComponent(after)}&max-keys=${FILES_PER_WINDOW + 5}`;
}

/** The window a listing URL was asked for (from its start-after key). */
export function listingWindow(url: string): number | null {
	const after = new URL(url).searchParams.get("start-after") ?? "";
	const m = /_s(\d{4})(\d{3})(\d{2})(\d{2})$/.exec(after);
	if (!m) return null;
	return Date.UTC(Number(m[1]), 0, Number(m[2]), Number(m[3]), Number(m[4]));
}

export function listedFiles(xml: string): { key: string; size: number }[] {
	const out: { key: string; size: number }[] = [];
	for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
		const key = /<Key>([^<]+)<\/Key>/.exec(m[1] ?? "")?.[1];
		const size = Number(/<Size>(\d+)<\/Size>/.exec(m[1] ?? "")?.[1]);
		if (key && Number.isFinite(size)) out.push({ key, size });
	}
	return out;
}

/** Complete windows to read at `now`, newest first. */
export function dueWindows(now: number): number[] {
	const newest = Math.floor((now - READ_AFTER_MS) / WINDOW_MS) * WINDOW_MS - WINDOW_MS;
	const out: number[] = [];
	for (let w = newest; w > now - BACKFILL_MS; w -= WINDOW_MS) out.push(w);
	return out;
}

// ---------------------------------------------------------------------------------------------------------
// Reading one file

/** The byte ranges read from a file, as stored in a RawResponse body. */
type RangeBundle = { size: number; ranges: [number, string][] };

export function flashesOf(bundle: RangeBundle): { lat: number[]; lon: number[]; quality: number[] } {
	const sparse = new SparseFile(bundle.size);
	for (const [offset, b64] of bundle.ranges) sparse.add(offset, new Uint8Array(Buffer.from(b64, "base64")));
	const file = new Hdf5File(sparse);
	const links = file.rootLinks([...DATASETS]);
	const [lat, lon, quality] = DATASETS.map((name) => file.read1d(name, links.get(name)));
	if (!lat || !lon || !quality || lat.length !== lon.length || lat.length !== quality.length) {
		throw new Hdf5Error("flash_lat, flash_lon and flash_quality_flag differ in length");
	}
	return { lat, lon, quality };
}

async function readFile(ctx: FetchContext, key: string, size: number): Promise<RawResponse> {
	const url = `${GLM_BUCKET}${key}`;
	const sparse = new SparseFile(size);
	const ranges: [number, string][] = [];
	let fetchedAt = 0;
	const get = async (offset: number, length: number) => {
		const end = Math.min(size, offset + Math.max(length, MIN_READ)) - 1;
		const r = await ctx.http.request(url, {
			headers: { range: `bytes=${offset}-${end}` },
			binary: true,
			hostGapMs: 0,
			timeoutMs: 20_000,
			maxBytes: 2 * 1024 * 1024,
			signal: ctx.signal,
		});
		if (r.status !== 206) throw new SchemaError(`GLM: ${key} no respondió al Range (HTTP ${r.status})`);
		sparse.add(offset, new Uint8Array(Buffer.from(r.body, "base64")));
		ranges.push([offset, r.body]);
		fetchedAt = r.fetchedAt;
	};
	await get(0, FIRST_READ);
	for (let reads = 1; ; reads++) {
		try {
			const file = new Hdf5File(sparse);
			const links = file.rootLinks([...DATASETS]);
			for (const name of DATASETS) file.read1d(name, links.get(name));
			break;
		} catch (error) {
			if (!(error instanceof NeedBytes) || reads >= MAX_READS_PER_FILE) throw error;
			await get(error.offset, error.length);
		}
	}
	const bundle: RangeBundle = { size, ranges };
	return {
		url,
		status: 206,
		contentType: "application/vnd.vigia.ranges+json",
		body: JSON.stringify(bundle),
		fetchedAt,
	};
}

// ---------------------------------------------------------------------------------------------------------
// Aggregation

const inBox = (
	b: { minLat: number; maxLat: number; minLon: number; maxLon: number },
	lat: number,
	lon: number,
) => lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon;

export type Tally = Omit<
	LightningWindow,
	"windowStart" | "windowMinutes" | "filesListed" | "filesRead" | "complete" | "satellite"
>;

export function tallyFlashes(files: readonly { lat: number[]; lon: number[]; quality: number[] }[]): Tally {
	let venezuela = 0;
	let catatumbo = 0;
	let lake = 0;
	let flagged = 0;
	const byState: Record<string, number> = {};
	const cells = new Map<string, [number, number, number]>();
	for (const f of files) {
		for (let i = 0; i < f.lat.length; i++) {
			const lat = f.lat[i] ?? Number.NaN;
			const lon = f.lon[i] ?? Number.NaN;
			if (!inBox(REGION, lat, lon)) continue;
			if (f.quality[i] !== 0) {
				flagged++;
				continue;
			}
			const cLat = (Math.floor(lat / CELL_DEG) + 0.5) * CELL_DEG;
			const cLon = (Math.floor(lon / CELL_DEG) + 0.5) * CELL_DEG;
			const k = `${cLat},${cLon}`;
			const cell = cells.get(k) ?? [cLat, cLon, 0];
			cell[2]++;
			cells.set(k, cell);
			if (inBox(CATATUMBO, lat, lon)) catatumbo++;
			const where = locate(lat, lon);
			const onLake = !where.inVenezuela && inLakeMaracaibo(lat, lon);
			const state = where.state?.iso ?? (onLake ? LAKE_MARACAIBO.state : null);
			if (onLake) lake++;
			if (state) {
				venezuela++;
				byState[state] = (byState[state] ?? 0) + 1;
			}
		}
	}
	const sorted = [...cells.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	return { venezuela, catatumbo, lake, byState, cells: sorted, flagged };
}

// ---------------------------------------------------------------------------------------------------------

export const goesGlm: Adapter<LightningWindow> = {
	id: "goes-glm",
	layer: "earth",
	name: { es: "Rayos: GOES-19 GLM (NOAA)", en: "Lightning: GOES-19 GLM (NOAA)" },
	provider: "NOAA/NESDIS (GOES-19, AWS Open Data)",
	homepage: GLM_PAGE,
	licence: GLM_LICENCE,
	keys: [],
	// One 15-minute window per run, read 5 minutes after it closes.
	intervalMs: WINDOW_MS,
	// Three missed windows (45 min) make the layer stale; the data budget allows for the 20-minute read lag.
	freshness: { fetchMs: 45 * 60_000, dataMs: 60 * 60_000 },

	async fetch(ctx) {
		const due = dueWindows(ctx.now());
		// Without a store (recording a fixture) only the newest window is read.
		const pending = (ctx.seen ? due.filter((w) => !ctx.seen?.("window", w)) : due.slice(0, 1)).slice(
			0,
			MAX_WINDOWS_PER_RUN,
		);
		const raws: RawResponse[] = [];
		for (const w of pending) {
			const listing = await ctx.http.request(listingUrl(w), {
				headers: { accept: "application/xml" },
				hostGapMs: 0,
				signal: ctx.signal,
			});
			raws.push(listing);
			for (const f of listedFiles(listing.body)) {
				const start = fileStart(f.key);
				if (start === null || start < w || start >= w + WINDOW_MS) continue;
				try {
					raws.push(await readFile(ctx, f.key, f.size));
				} catch (error) {
					if (ctx.signal.aborted) throw error;
					// One unreadable file makes the window incomplete, not the run failed.
				}
			}
		}
		return raws;
	},

	normalise(raws) {
		const out: Observation<LightningWindow>[] = [];
		const files = raws.filter((r) => r.url.endsWith(".nc"));
		for (const listing of raws.filter((r) => r.url.includes("list-type=2"))) {
			const w = listingWindow(listing.url);
			if (w === null) throw new SchemaError("GLM: listado sin ventana");
			if (!listing.body.includes("<ListBucketResult")) throw new SchemaError("GLM: el listado no es de S3");
			const listed = listedFiles(listing.body).filter((f) => {
				const s = fileStart(f.key);
				return s !== null && s >= w && s < w + WINDOW_MS;
			});
			const keys = new Set(listed.map((f) => `${GLM_BUCKET}${f.key}`));
			const read: { lat: number[]; lon: number[]; quality: number[] }[] = [];
			let fetchedAt = listing.fetchedAt;
			for (const f of files.filter((x) => keys.has(x.url))) {
				try {
					read.push(flashesOf(JSON.parse(f.body) as RangeBundle));
					fetchedAt = Math.max(fetchedAt, f.fetchedAt);
				} catch {
					// Counted as not read: `filesRead` says so.
				}
			}
			const tally = tallyFlashes(read);
			out.push({
				source: "goes-glm",
				series: "window",
				sourceUrl: GLM_PAGE,
				fetchedAt,
				observedAt: w,
				licence: GLM_LICENCE.id,
				value: {
					windowStart: new Date(w).toISOString(),
					windowMinutes: WINDOW_MS / 60_000,
					filesListed: listed.length,
					filesRead: read.length,
					complete: read.length === FILES_PER_WINDOW,
					...tally,
					satellite: "GOES-19",
				},
				confidence: Math.min(1, read.length / FILES_PER_WINDOW),
				basis: "measurement",
			});
		}
		return out;
	},
};
