import { z } from "zod";
import type { Adapter, GeoPoint, Licence, Observation } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { placeOf } from "../../geo/place.ts";

/**
 * FUNVISIS, Venezuela's national seismological network: the official catalogue, and the only public source for
 * the M1.6–3.9 quakes people actually feel (USGS is complete only from about M4 here).
 *
 * Source: the undocumented GeoJSON the homepage map loads (`/assets/mapa-leaflet/js/map.js` fetches
 * `./maravilla.json`): the last 20 events, about 1.5 days. Quirks, all measured 2026-09-24:
 * - Field names come from an address template: `phone` is the magnitude, `postalCode` the date (DD-MM-YYYY),
 *   `city` the time (HH:MM, **HLV = UTC−4**; the site's own popup labels it "Hora (HLV)"), `state` the depth
 *   ("5.0 km"), `address` "24 km al noroeste de Biscucuy". `country` is always "Venezuela", even for Colombia.
 *   `geometry.marcador` is "marker" or "marker1" (marker1 was seen on Colombian epicentres; undocumented, so
 *   unused: we locate every epicentre ourselves).
 * - Time basis cross-checked on the 2026-06-24 M7.2: FUNVISIS reported it at 6:04 p.m. local time, USGS at
 *   22:04:31 UTC, which is 18:04 HLV. The last-20 file and two Wayback snapshots (2024-09-18, 2026-08-04) had no
 *   event in common with USGS, so no second check was possible; the panel's match rule would expose an offset.
 * - Times have minute precision only.
 * - HTTPS is broken (TLS EOF), so this is plain HTTP and could be altered in transit: lower confidence.
 * - The server clock was ~54 min slow and the file is rewritten with no new event (the address "24 km" became
 *   "24. km", padding spaces vary), so its Date/Last-Modified/ETag are ignored and the series id is built from
 *   time, epicentre and magnitude, never from the address text.
 * - A strict validator guards against a template change silently shifting fields: coordinates must agree with
 *   the lat/long strings, and if fewer than half the items validate, the run fails loudly.
 */

export const FUNVISIS_URL = "http://www.funvisis.gob.ve/maravilla.json";
export const FUNVISIS_HOME = "http://www.funvisis.gob.ve/";
/** Felt-report form, for the UI ("¿Sentiste un sismo?"). Link only; we never submit to it. */
export const FUNVISIS_FELT_FORM = "https://encuesta.funvisis.gob.ve";

export const FUNVISIS_LICENCE: Licence = {
	id: "funvisis-attribution",
	name: "Sin licencia publicada (datos factuales, con atribución)",
	url: FUNVISIS_HOME,
	attribution: "Fuente: FUNVISIS (red sismológica nacional)",
	commercial: "unclear",
};

/** HLV (hora legal de Venezuela) is UTC−4 with no daylight saving since 2016. */
const HLV_OFFSET_MS = 4 * 3_600_000;
/** An event stamped more than this after our fetch is a data error, not a clock detail. */
const FUTURE_TOLERANCE_MS = 10 * 60_000;

const num = (pattern: RegExp) =>
	z
		.string()
		.transform((s) => s.trim())
		.refine((s) => pattern.test(s))
		.transform(Number);

const Feature = z.object({
	type: z.literal("Feature"),
	geometry: z.object({
		type: z.literal("Point"),
		coordinates: z.tuple([z.number(), z.number()]),
		marcador: z.string().optional(),
	}),
	properties: z.object({
		phone: num(/^\d{1,2}(\.\d+)?$/).pipe(z.number().min(0).max(10)),
		postalCode: z
			.string()
			.transform((s) => s.trim())
			.pipe(z.string().regex(/^\d{2}-\d{2}-\d{4}$/)),
		city: z
			.string()
			.transform((s) => s.trim())
			.pipe(z.string().regex(/^\d{2}:\d{2}$/)),
		state: z
			.string()
			.transform((s) => s.trim())
			.pipe(z.string().regex(/^\d+(\.\d+)?\s*km$/))
			.transform((s) => Number.parseFloat(s)),
		address: z.string(),
		lat: num(/^-?\d+(\.\d+)?$/).pipe(z.number().min(-10).max(25)),
		long: num(/^-?\d+(\.\d+)?$/).pipe(z.number().min(-90).max(-50)),
	}),
});

const Collection = z.object({
	type: z.literal("FeatureCollection"),
	features: z.array(z.unknown()),
});

export type FunvisisQuake = {
	readonly mag: number;
	readonly depthKm: number;
	/** FUNVISIS's own location text, whitespace and "24. km" cleaned: "24 km al noroeste de Biscucuy". */
	readonly addressEs: string;
	/** The time exactly as FUNVISIS gave it, for display next to our UTC: "24-09-2026 13:31 HLV". */
	readonly localTime: string;
	/** FUNVISIS times are to the minute. */
	readonly timePrecisionS: 60;
	readonly inVenezuela: boolean;
	readonly country: string | null;
	readonly borderKm: number;
	/** Our description from the gazetteer, same wording as the USGS rows. */
	readonly placeEs: string;
};

/** "24.  km al sur      de X" → "24 km al sur de X". */
export function cleanAddress(text: string): string {
	return text
		.replace(/\s+/g, " ")
		.replace(/(\d)\.\s*km/g, "$1 km")
		.trim();
}

/** UTC epoch ms of a FUNVISIS date (DD-MM-YYYY) and HLV time (HH:MM). Null if not a real calendar time. */
export function hlvToUtc(date: string, time: string): number | null {
	const [d, m, y] = date.split("-").map(Number);
	const [hh, mm] = time.split(":").map(Number);
	if (d === undefined || m === undefined || y === undefined || hh === undefined || mm === undefined)
		return null;
	if (m < 1 || m > 12 || d < 1 || d > 31 || hh > 23 || mm > 59) return null;
	const local = Date.UTC(y, m - 1, d, hh, mm);
	// Reject 31-02 style dates that Date.UTC would roll over.
	if (new Date(local).getUTCDate() !== d) return null;
	return local + HLV_OFFSET_MS;
}

/**
 * Stable id with no address text: UTC minute, epicentre to 0.01° (the feed's precision) and magnitude to 0.1.
 * A FUNVISIS revision of magnitude or epicentre therefore makes a new series; the panel folds those (same minute,
 * within 10 km) into one event, keeping the newest fetch.
 */
export function seriesId(observedAt: number, lat: number, lon: number, mag: number): string {
	const t = new Date(observedAt).toISOString().slice(0, 16).replace(/[-:]/g, "");
	return `funvisis:${t}Z:${lat.toFixed(2)}:${lon.toFixed(2)}:M${mag.toFixed(1)}`;
}

export const funvisisQuakes: Adapter<FunvisisQuake> = {
	id: "funvisis-quakes",
	layer: "earth",
	name: { es: "Sismos (FUNVISIS)", en: "Earthquakes (FUNVISIS)" },
	provider: "FUNVISIS",
	homepage: FUNVISIS_HOME,
	licence: FUNVISIS_LICENCE,
	keys: [],
	// The file holds ~1.5 days of events, so 10 min loses nothing and is gentle on a fragile government server.
	intervalMs: 10 * 60_000,
	freshness: { fetchMs: 40 * 60_000, dataMs: null },

	async fetch(ctx) {
		const raw = await ctx.http.request(FUNVISIS_URL, {
			headers: { accept: "application/json, text/plain" },
			hostGapMs: 5_000,
			timeoutMs: 20_000,
			maxBytes: 512 * 1024,
			signal: ctx.signal,
		});
		return [raw];
	},

	normalise(raws) {
		const raw = raws[0];
		if (!raw) throw new SchemaError("no response");
		let json: unknown;
		try {
			json = JSON.parse(raw.body);
		} catch {
			throw new SchemaError("FUNVISIS: the response is not JSON");
		}
		const collection = Collection.safeParse(json);
		if (!collection.success) throw new SchemaError(`FUNVISIS collection: ${collection.error.message}`);
		const out: Observation<FunvisisQuake>[] = [];
		let invalid = 0;
		for (const item of collection.data.features) {
			const parsed = Feature.safeParse(item);
			if (!parsed.success) {
				invalid++;
				continue;
			}
			const { properties: p, geometry } = parsed.data;
			const [gLon, gLat] = geometry.coordinates;
			// Field-shift guard: the geometry and the lat/long strings must describe the same point.
			if (Math.abs(gLat - p.lat) > 0.011 || Math.abs(gLon - p.long) > 0.011) {
				invalid++;
				continue;
			}
			const observedAt = hlvToUtc(p.postalCode, p.city);
			if (observedAt === null || observedAt > raw.fetchedAt + FUTURE_TOLERANCE_MS) {
				invalid++;
				continue;
			}
			const lat = p.lat;
			const lon = p.long;
			const where = placeOf(lat, lon);
			const placeEs = where.placeEs;
			const location: GeoPoint = where.state
				? { lat, lon, state: where.state, place: placeEs }
				: { lat, lon, place: placeEs };
			out.push({
				source: "funvisis-quakes",
				series: seriesId(observedAt, lat, lon, p.phone),
				sourceUrl: FUNVISIS_HOME,
				fetchedAt: raw.fetchedAt,
				observedAt,
				licence: FUNVISIS_LICENCE.id,
				value: {
					mag: p.phone,
					depthKm: p.state,
					addressEs: cleanAddress(p.address),
					localTime: `${p.postalCode} ${p.city} HLV`,
					timePrecisionS: 60,
					inVenezuela: where.inVenezuela,
					country: where.country,
					borderKm: where.borderKm,
					placeEs,
				},
				location,
				// Official national network, but automatic-looking locations, minute precision, an undocumented
				// file and plain HTTP transport: below the 1.0 we give instrument feeds over authenticated channels.
				confidence: 0.85,
				basis: "official",
			});
		}
		const total = collection.data.features.length;
		if (total > 0 && invalid * 2 > total) {
			throw new SchemaError(
				`FUNVISIS: ${invalid} of ${total} events failed validation; the file's template may have changed`,
			);
		}
		return out;
	},
};
