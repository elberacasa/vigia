import type { Adapter, Licence, Observation, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { placeOf } from "../../geo/place.ts";

/**
 * NASA FIRMS active fire detections (thermal anomalies) from VIIRS on NOAA-20, 375 m pixels.
 *
 * Keyless path (default): the public South America "24h" CSV, clipped here. Sensor chosen by measurement on
 * 2026-09-24 (24h files, Venezuela box): NOAA-20 1,003 detections, S-NPP 944, NOAA-21 745, MODIS 109 (1 km
 * pixels). One sensor only, so counts are self-consistent: the same fire seen by two satellites is not two fires.
 * The file is 1.7 MB and the server ignores If-None-Match / If-Modified-Since and gzip (measured: 200 with the
 * full body every time), so hourly polling costs ~41 MB/day. With a free MAP_KEY (`nasa-firms-map-key`) the adapter
 * asks the area API for the box only instead.
 *
 * Quirks: "24h" means "from 00:00 UTC yesterday to now", so a file holds up to ~47 h (measured: 2026-09-23 03:42
 * to 2026-09-24 19:28 UTC); the panel filters by acquisition time. `acq_time` is HHMM UTC, sometimes without
 * leading zeros. `confidence` is a class (low / nominal / high, older files l / n / h) for VIIRS and 0–100 for MODIS.
 * A detection is a hot pixel, not a confirmed fire: gas flares and industry show up too (see the fires panel).
 */

export const FIRMS_LICENCE: Licence = {
	id: "nasa-firms-open",
	name: "Datos abiertos de la NASA (sin restricciones de uso)",
	url: "https://www.earthdata.nasa.gov/data/tools/firms/faq",
	attribution: "NASA FIRMS",
	commercial: true,
};

export const FIRMS_KEY_ID = "nasa-firms-map-key";
export const KEYLESS_URL =
	"https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_South_America_24h.csv";
/** West, south, east, north: Venezuela's box plus ~50 km, for the near-border detections. */
export const AREA = { west: -74, south: 0, east: -59, north: 13.5 } as const;
/** Detections outside Venezuela are kept only this close to it. */
export const NEAR_BORDER_KM = 50;

export function areaUrl(key: string): string {
	return `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/VIIRS_NOAA20_NRT/${AREA.west},${AREA.south},${AREA.east},${AREA.north}/2`;
}

/** A page a person can open: the FIRMS map centred on the point. */
export function firmsMapUrl(lat: number, lon: number): string {
	return `https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs;@${lon.toFixed(3)},${lat.toFixed(3)},11.0z`;
}

export type FirmsRow = {
	lat: number;
	lon: number;
	acqDate: string;
	acqTime: string;
	acqAt: number;
	satellite: string;
	confidence: "low" | "nominal" | "high";
	frpMW: number;
	brightnessK: number;
	scanKm: number;
	trackKm: number;
	daynight: "D" | "N";
};

const REQUIRED = [
	"latitude",
	"longitude",
	"acq_date",
	"acq_time",
	"satellite",
	"confidence",
	"frp",
	"daynight",
];

function confidenceClass(raw: string): FirmsRow["confidence"] | null {
	const s = raw.trim().toLowerCase();
	if (s === "low" || s === "l") return "low";
	if (s === "nominal" || s === "n") return "nominal";
	if (s === "high" || s === "h") return "high";
	// MODIS: 0–100, with FIRMS's own bands (0–29 low, 30–79 nominal, 80–100 high).
	if (/^\d{1,3}$/.test(s)) {
		const n = Number(s);
		if (n > 100) return null;
		return n < 30 ? "low" : n < 80 ? "nominal" : "high";
	}
	return null;
}

/** Parses a FIRMS CSV by header name (VIIRS and MODIS schemas; the area API adds columns). */
export function parseFirmsCsv(text: string): { rows: FirmsRow[]; invalid: number } {
	const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
	const header = (lines[0] ?? "").split(",").map((h) => h.trim());
	const col = new Map(header.map((h, i) => [h, i]));
	const missing = REQUIRED.filter((h) => !col.has(h));
	const brightCol = col.get("bright_ti4") ?? col.get("brightness");
	if (missing.length > 0 || brightCol === undefined) {
		throw new SchemaError(`FIRMS CSV: missing columns ${[...missing, "bright_ti4|brightness"].join(", ")}`);
	}
	const at = (cells: string[], name: string) => cells[col.get(name) ?? -1] ?? "";
	const rows: FirmsRow[] = [];
	let invalid = 0;
	for (const line of lines.slice(1)) {
		const c = line.split(",");
		const lat = Number(at(c, "latitude"));
		const lon = Number(at(c, "longitude"));
		const acqDate = at(c, "acq_date");
		const acqTime = at(c, "acq_time").trim().padStart(4, "0");
		const conf = confidenceClass(at(c, "confidence"));
		const frp = Number(at(c, "frp"));
		const bright = Number(c[brightCol] ?? "");
		const scan = Number(at(c, "scan"));
		const track = Number(at(c, "track"));
		const dn = at(c, "daynight");
		const acqAt = Date.parse(`${acqDate}T${acqTime.slice(0, 2)}:${acqTime.slice(2)}:00Z`);
		if (
			!Number.isFinite(lat) ||
			!Number.isFinite(lon) ||
			Math.abs(lat) > 90 ||
			Math.abs(lon) > 180 ||
			!/^\d{4}-\d{2}-\d{2}$/.test(acqDate) ||
			!/^\d{4}$/.test(acqTime) ||
			Number.isNaN(acqAt) ||
			conf === null ||
			!Number.isFinite(frp) ||
			!Number.isFinite(bright) ||
			(dn !== "D" && dn !== "N")
		) {
			invalid++;
			continue;
		}
		rows.push({
			lat,
			lon,
			acqDate,
			acqTime,
			acqAt,
			satellite: at(c, "satellite"),
			confidence: conf,
			frpMW: frp,
			brightnessK: bright,
			scanKm: Number.isFinite(scan) ? scan : 0,
			trackKm: Number.isFinite(track) ? track : 0,
			daynight: dn,
		});
	}
	return { rows, invalid };
}

/**
 * Our reading of FIRMS's classes as a 0..1 confidence (not a calibrated probability). FIRMS: "low" pixels are
 * often sun glint or weak anomalies, "nominal" a clear thermal anomaly, "high" a saturated (very hot) pixel.
 */
export const CONFIDENCE: Readonly<Record<FirmsRow["confidence"], number>> = {
	low: 0.4,
	nominal: 0.8,
	high: 0.95,
};

export type FireDetection = {
	kind: "detection";
	satellite: string;
	instrument: "VIIRS";
	confidenceClass: "low" | "nominal" | "high";
	/** Fire radiative power, megawatts. */
	frpMW: number;
	/** I-4 band brightness temperature, kelvin. */
	brightnessK: number;
	/** Pixel size along scan and track, km (grows toward the swath edge). */
	scanKm: number;
	trackKm: number;
	daynight: "day" | "night";
	inVenezuela: boolean;
	country: string | null;
	borderKm: number;
	placeEs: string;
};

/** One per fetch: what the file covered, so the panel can say "the 24 h file spans 40 h" and see staleness. */
export type FireFile = {
	kind: "file";
	product: string;
	/** Rows in the file (South America, or the box when the area API is used). */
	rows: number;
	invalidRows: number;
	/** Detections kept (Venezuela and within NEAR_BORDER_KM). */
	kept: number;
	oldestAcqAt: number;
	newestAcqAt: number;
};

export type FirmsValue = FireDetection | FireFile;

const isArea = (raw: RawResponse) => raw.url.includes("/api/area/");

export const firmsFires: Adapter<FirmsValue> = {
	id: "firms-fires",
	layer: "earth",
	name: { es: "Focos de calor (NASA FIRMS, VIIRS NOAA-20)", en: "Active fires (NASA FIRMS, VIIRS NOAA-20)" },
	provider: "NASA FIRMS",
	homepage: "https://firms.modaps.eosdis.nasa.gov/map/",
	licence: FIRMS_LICENCE,
	keys: [],
	// FIRMS rewrites the files every 60 min (FAQ; last-modified agrees).
	intervalMs: 60 * 60_000,
	// Stale if no fetch for 3 h, or if the file's newest detection (anywhere in South America) is 14 h old.
	// NOAA-20 is polar-orbiting: it crosses South America in a daytime batch (~15–19 UTC) and a night batch
	// (~03–07 UTC; hour histogram of the 2026-09-24 file), and files lag ~3 h (measured 3 h 44 min). Just before
	// the next batch lands the newest row is normally ~11–12 h old, so 8 h (a first guess) would call
	// a healthy feed stale every night.
	freshness: { fetchMs: 3 * 3_600_000, dataMs: 14 * 3_600_000 },

	async fetch(ctx) {
		const key = ctx.key(FIRMS_KEY_ID);
		const url = key ? areaUrl(key) : KEYLESS_URL;
		const raw = await ctx.http.request(url, {
			headers: { accept: "text/csv, text/plain" },
			hostGapMs: 5_000,
			timeoutMs: 60_000,
			maxBytes: 16 * 1024 * 1024,
			signal: ctx.signal,
		});
		// The key is in the path (the API has no header option): never let it reach logs or fixtures.
		return [key ? { ...raw, url: raw.url.split(encodeURIComponent(key)).join("MAP_KEY") } : raw];
	},

	normalise(raws) {
		const raw = raws[0];
		if (!raw) throw new SchemaError("no response");
		if (/^\s*</.test(raw.body) || /invalid map_key/i.test(raw.body.slice(0, 200))) {
			throw new SchemaError(`FIRMS: not a CSV (${raw.body.slice(0, 80).trim()})`);
		}
		const { rows, invalid } = parseFirmsCsv(raw.body);
		if (invalid * 2 > rows.length + invalid && invalid > 0) {
			throw new SchemaError(`FIRMS: ${invalid} of ${rows.length + invalid} rows invalid`);
		}
		const out: Observation<FirmsValue>[] = [];
		for (const r of rows) {
			if (r.lat < AREA.south || r.lat > AREA.north || r.lon < AREA.west || r.lon > AREA.east) continue;
			if (r.acqAt > raw.fetchedAt + 10 * 60_000) continue;
			const where = placeOf(r.lat, r.lon);
			if (!where.inVenezuela && where.borderKm > NEAR_BORDER_KM) continue;
			out.push({
				source: "firms-fires",
				series: `fire:${r.satellite}:${r.acqDate}T${r.acqTime}Z:${r.lat.toFixed(5)}:${r.lon.toFixed(5)}`,
				sourceUrl: firmsMapUrl(r.lat, r.lon),
				fetchedAt: raw.fetchedAt,
				observedAt: r.acqAt,
				licence: FIRMS_LICENCE.id,
				value: {
					kind: "detection",
					satellite: r.satellite,
					instrument: "VIIRS",
					confidenceClass: r.confidence,
					frpMW: r.frpMW,
					brightnessK: r.brightnessK,
					scanKm: r.scanKm,
					trackKm: r.trackKm,
					daynight: r.daynight === "D" ? "day" : "night",
					inVenezuela: where.inVenezuela,
					country: where.country,
					borderKm: where.borderKm,
					placeEs: where.placeEs,
				},
				location: where.state
					? { lat: r.lat, lon: r.lon, state: where.state, place: where.placeEs }
					: { lat: r.lat, lon: r.lon, place: where.placeEs },
				confidence: CONFIDENCE[r.confidence],
				basis: "measurement",
			});
		}
		if (rows.length > 0) {
			const times = rows.map((r) => r.acqAt);
			const newest = Math.max(...times);
			out.push({
				source: "firms-fires",
				series: "firms:file",
				sourceUrl: "https://firms.modaps.eosdis.nasa.gov/active_fire/",
				fetchedAt: raw.fetchedAt,
				observedAt: Math.min(newest, raw.fetchedAt),
				licence: FIRMS_LICENCE.id,
				value: {
					kind: "file",
					product: isArea(raw)
						? "VIIRS NOAA-20 NRT, API de área (clave MAP_KEY)"
						: "VIIRS NOAA-20 NRT, archivo Sudamérica «24h»",
					rows: rows.length,
					invalidRows: invalid,
					kept: out.length,
					oldestAcqAt: Math.min(...times),
					newestAcqAt: newest,
				},
				confidence: 1,
				basis: "measurement",
			});
		}
		return out;
	},
};
