import type { Adapter, Observation } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { CONFIDENCE, FIRMS_LICENCE, firmsMapUrl, parseFirmsCsv } from "../firms-fires/index.ts";
import { facilityFor } from "./facilities.ts";

/**
 * Gas flaring and industrial heat at Venezuela's oil and gas facilities, from the same NASA FIRMS sensor as
 * `firms-fires` (VIIRS on NOAA-20, 375 m pixels), kept only near a fixed list of facilities (`facilities.json`).
 *
 * Why a second FIRMS feed: the flaring index compares weeks, so it needs every night, not only the ones since
 * Vigía started. This adapter reads the keyless 7-day South America file once a day (8.0 MB on 2026-09-24): the
 * first run fills a week of history, and a missed day heals itself on the next run. `firms-fires` (hourly, 24 h
 * file) supplies the newest night; the energy panel merges both and removes duplicates.
 *
 * VIIRS Nightfire (EOG, the flare-specific product) now sits behind an account login (verified 2026-09-24), so it is
 * not used. A FIRMS hot pixel at a flare stack is a detection, not a volume: clouds hide flares (a cloudy night reads
 * as zero), and the pixel's radiative power depends on scan angle. The panel says so.
 */

export const SEVEN_DAY_URL =
	"https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_South_America_7d.csv";

export type FlareDetection = {
	kind: "detection";
	facilityId: string;
	/** Distance to the facility's outline or nearest flare site, km (0 inside an outline). */
	facilityKm: number;
	satellite: string;
	confidenceClass: "low" | "nominal" | "high";
	frpMW: number;
	brightnessK: number;
	daynight: "day" | "night";
	/** UTC date of acquisition, YYYY-MM-DD: the "night" a night detection belongs to (passes are ~05–08 UTC). */
	acqDate: string;
};

/** One per fetch: the time span the file covers, which is what "a night with data" means. */
export type FlareFile = {
	kind: "file";
	product: string;
	rows: number;
	invalidRows: number;
	kept: number;
	oldestAcqAt: number;
	newestAcqAt: number;
};

export type FlareValue = FlareDetection | FlareFile;

export const firmsFlares: Adapter<FlareValue> = {
	id: "firms-flares",
	layer: "oil",
	name: {
		es: "Quema de gas en instalaciones petroleras (NASA FIRMS, 7 días)",
		en: "Gas flaring at oil facilities (NASA FIRMS, 7 days)",
	},
	provider: "NASA FIRMS",
	homepage: "https://firms.modaps.eosdis.nasa.gov/map/",
	licence: FIRMS_LICENCE,
	keys: [],
	// Once a day: the file is rewritten hourly, but one night's passes are all that changes per day.
	intervalMs: 24 * 3_600_000,
	// Stale after three missed days, or when the file's newest row is two days old.
	freshness: { fetchMs: 3 * 24 * 3_600_000, dataMs: 2 * 24 * 3_600_000 },

	async fetch(ctx) {
		const raw = await ctx.http.request(SEVEN_DAY_URL, {
			headers: { accept: "text/csv, text/plain" },
			hostGapMs: 5_000,
			timeoutMs: 120_000,
			maxBytes: 32 * 1024 * 1024,
			signal: ctx.signal,
		});
		return [raw];
	},

	normalise(raws) {
		const raw = raws[0];
		if (!raw) throw new SchemaError("no response");
		if (/^\s*</.test(raw.body)) throw new SchemaError(`FIRMS: not a CSV (${raw.body.slice(0, 80).trim()})`);
		const { rows, invalid } = parseFirmsCsv(raw.body);
		if (invalid > 0 && invalid * 2 > rows.length + invalid) {
			throw new SchemaError(`FIRMS: ${invalid} of ${rows.length + invalid} rows invalid`);
		}
		const out: Observation<FlareValue>[] = [];
		for (const r of rows) {
			// Venezuela's box (the facilities are all inside it): skips the exact test for most of the continent.
			if (r.lat < 6.5 || r.lat > 12.5 || r.lon < -73.5 || r.lon > -61.5) continue;
			if (r.acqAt > raw.fetchedAt + 10 * 60_000) continue;
			const hit = facilityFor(r.lat, r.lon);
			if (!hit) continue;
			const f = hit.facility;
			out.push({
				source: "firms-flares",
				// Same series id as firms-fires for the same pixel, so the two feeds' copies are recognisably one.
				series: `fire:${r.satellite}:${r.acqDate}T${r.acqTime}Z:${r.lat.toFixed(5)}:${r.lon.toFixed(5)}`,
				sourceUrl: firmsMapUrl(r.lat, r.lon),
				fetchedAt: raw.fetchedAt,
				observedAt: r.acqAt,
				licence: FIRMS_LICENCE.id,
				value: {
					kind: "detection",
					facilityId: f.id,
					facilityKm: Math.round(hit.km * 100) / 100,
					satellite: r.satellite,
					confidenceClass: r.confidence,
					frpMW: r.frpMW,
					brightnessK: r.brightnessK,
					daynight: r.daynight === "D" ? "day" : "night",
					acqDate: r.acqDate,
				},
				location: f.state
					? { lat: r.lat, lon: r.lon, state: f.state, place: f.nameEs }
					: { lat: r.lat, lon: r.lon, place: f.nameEs },
				confidence: CONFIDENCE[r.confidence],
				basis: "measurement",
			});
		}
		if (rows.length > 0) {
			// A loop, not Math.min(...): the 7-day file has ~100k rows, too many for spread arguments.
			let oldest = Number.POSITIVE_INFINITY;
			let newest = Number.NEGATIVE_INFINITY;
			for (const r of rows) {
				oldest = Math.min(oldest, r.acqAt);
				newest = Math.max(newest, r.acqAt);
			}
			out.push({
				source: "firms-flares",
				series: "flares:file",
				sourceUrl: "https://firms.modaps.eosdis.nasa.gov/active_fire/",
				fetchedAt: raw.fetchedAt,
				observedAt: Math.min(newest, raw.fetchedAt),
				licence: FIRMS_LICENCE.id,
				value: {
					kind: "file",
					product: "VIIRS NOAA-20 NRT, archivo Sudamérica «7d»",
					rows: rows.length,
					invalidRows: invalid,
					kept: out.length,
					oldestAcqAt: oldest,
					newestAcqAt: newest,
				},
				confidence: 1,
				basis: "measurement",
			});
		}
		return out;
	},
};
