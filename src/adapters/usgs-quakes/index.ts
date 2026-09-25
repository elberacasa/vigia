import { z } from "zod";
import type { Adapter, GeoPoint, Observation } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { placeOf } from "../../geo/place.ts";
import { PUBLIC_DOMAIN_USGS } from "../../sources/licences.ts";

/**
 * USGS FDSN event service (ComCat), Venezuela and its near shore.
 *
 * Completeness: USGS is complete from about M4 in this region. Measured 2026-09-24: of 9 events in 30 days, 8
 * were M4.3–4.9 and one was an M3.5 ml (Mérida, 2026-08-27); a year of M≥4 held 111 events. Over the same days
 * FUNVISIS listed dozens of M1.6–3.9 events that USGS does not have.
 * So "no USGS quake today" does not mean "no quake today"; the national catalogue is `funvisis-quakes`.
 *
 * The box (lat 0.5–13.0, lon −73.5 to −59.5) covers mainland Venezuela (0.65–12.2 °N, 73.38–59.8 °W), Margarita,
 * Los Roques, the ABC channel, the San Sebastián / El Pilar faults and Trinidad; it does not cover Isla de Aves.
 * It also takes in Colombian seismicity (the Bucaramanga nest), so every event is tagged by point-in-polygon
 * (`inVenezuela`, `country`, `borderKm`; Lake Maracaibo counts as Zulia, see src/geo/place.ts); USGS's English
 * place text is not used to decide where a quake is.
 */

export const VENEZUELA_BBOX = { minLat: 0.5, maxLat: 13.0, minLon: -73.5, maxLon: -59.5 } as const;
/** USGS's own statement of practice for this region, shown with the panel. Measured, see above. */
export const USGS_COMPLETENESS_MAG = 4;
const WINDOW_DAYS = 30;

const Feature = z.object({
	id: z.string().min(1),
	properties: z.object({
		mag: z.number().nullable(),
		magType: z.string().nullable(),
		place: z.string().nullable(),
		time: z.number(),
		updated: z.number(),
		url: z.string().url(),
		felt: z.number().nullable(),
		cdi: z.number().nullable(),
		mmi: z.number().nullable(),
		alert: z.string().nullable(),
		status: z.string(),
		tsunami: z.number(),
		sig: z.number().nullable(),
	}),
	geometry: z.object({
		coordinates: z.tuple([z.number(), z.number(), z.number()]).or(z.tuple([z.number(), z.number()])),
	}),
});

const Collection = z.object({
	type: z.literal("FeatureCollection"),
	metadata: z.object({ generated: z.number() }),
	features: z.array(z.unknown()),
});

export type Quake = {
	readonly mag: number;
	readonly magType: string | null;
	/** USGS's own place text (English), e.g. "12 km NNE of Morón, Venezuela". */
	readonly placeText: string | null;
	readonly depthKm: number | null;
	readonly status: "reviewed" | "automatic";
	/** Number of "Did You Feel It?" reports. */
	readonly felt: number | null;
	/** Highest DYFI community intensity. */
	readonly cdi: number | null;
	/** ShakeMap instrumental intensity. */
	readonly mmi: number | null;
	readonly alert: string | null;
	readonly tsunami: boolean;
	readonly updated: number;
	/** Epicentre inside Venezuela per the official boundaries (INE via OCHA COD-AB). */
	readonly inVenezuela: boolean;
	/** Neighbouring country (Spanish name) when outside Venezuela and on land; null in Venezuela or at sea. */
	readonly country: string | null;
	/** Kilometres from the epicentre to Venezuelan territory (0 inside). */
	readonly borderKm: number;
	/** Our Spanish description relative to the nearest town (GeoNames), e.g. "a 45 km al NNO de Duaca (Lara)". */
	readonly placeEs: string;
};

export function queryUrl(now: number): string {
	const start = new Date(now - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 19);
	const p = new URLSearchParams({
		format: "geojson",
		starttime: start,
		minlatitude: String(VENEZUELA_BBOX.minLat),
		maxlatitude: String(VENEZUELA_BBOX.maxLat),
		minlongitude: String(VENEZUELA_BBOX.minLon),
		maxlongitude: String(VENEZUELA_BBOX.maxLon),
		minmagnitude: "2.5",
		orderby: "time",
		limit: "500",
	});
	return `https://earthquake.usgs.gov/fdsnws/event/1/query?${p}`;
}

export const usgsQuakes: Adapter<Quake> = {
	id: "usgs-quakes",
	layer: "earth",
	name: { es: "Sismos (USGS)", en: "Earthquakes (USGS)" },
	provider: "USGS",
	homepage: "https://earthquake.usgs.gov/earthquakes/map/",
	licence: PUBLIC_DOMAIN_USGS,
	keys: [],
	intervalMs: 2 * 60_000,
	freshness: { fetchMs: 15 * 60_000, dataMs: null },

	async fetch(ctx) {
		const raw = await ctx.http.request(queryUrl(ctx.now()), {
			headers: { accept: "application/geo+json, application/json" },
			signal: ctx.signal,
		});
		return [raw];
	},

	normalise(raws) {
		const raw = raws[0];
		if (!raw) throw new SchemaError("no response");
		const collection = Collection.safeParse(JSON.parse(raw.body));
		if (!collection.success) throw new SchemaError(`USGS collection: ${collection.error.message}`);
		const out: Observation<Quake>[] = [];
		let skipped = 0;
		for (const item of collection.data.features) {
			const parsed = Feature.safeParse(item);
			// One malformed event must not hide the others; it is skipped and counted.
			if (!parsed.success) {
				skipped++;
				continue;
			}
			const f = parsed.data;
			const p = f.properties;
			if (p.mag === null) continue;
			// An event dated after the fetch (a clock or data error) would keep the feed looking fresh forever.
			if (p.time > raw.fetchedAt + 10 * 60_000) {
				skipped++;
				continue;
			}
			const [lon, lat, depth] = f.geometry.coordinates;
			const where = placeOf(lat, lon);
			const placeEs = where.placeEs;
			const location: GeoPoint = where.state
				? { lat, lon, state: where.state, place: placeEs }
				: { lat, lon, place: placeEs };
			out.push({
				source: "usgs-quakes",
				series: `quake:${f.id}`,
				sourceUrl: p.url,
				fetchedAt: raw.fetchedAt,
				observedAt: p.time,
				licence: PUBLIC_DOMAIN_USGS.id,
				value: {
					mag: p.mag,
					magType: p.magType,
					placeText: p.place,
					depthKm: depth ?? null,
					status: p.status === "reviewed" ? "reviewed" : "automatic",
					felt: p.felt,
					cdi: p.cdi,
					mmi: p.mmi,
					alert: p.alert,
					tsunami: p.tsunami === 1,
					updated: p.updated,
					inVenezuela: where.inVenezuela,
					country: where.country,
					borderKm: where.borderKm,
					placeEs,
				},
				location,
				confidence: p.status === "reviewed" ? 1 : 0.8,
				basis: "measurement",
			});
		}
		// Most events invalid means the schema changed: fail loudly (status page) instead of showing "no quakes".
		const total = collection.data.features.length;
		if (total > 0 && skipped > total / 2) {
			throw new SchemaError(`USGS: ${skipped} de ${total} eventos no cumplen el esquema`);
		}
		return out;
	},
};
