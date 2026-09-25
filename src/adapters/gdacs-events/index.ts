import { z } from "zod";
import type { Adapter, Licence, Observation } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { placeOf } from "../../geo/place.ts";

/**
 * GDACS (Global Disaster Alert and Coordination System, UN OCHA and the European Commission JRC): impact-weighted
 * alerts (Green / Orange / Red) for earthquakes, tropical cyclones, floods (GloFAS), volcanoes, droughts (GDO)
 * and wildfires (GWIS) that affect Venezuela.
 *
 * Quirks, measured 2026-09-24:
 * - Without `alertlevel=green;orange;red` the search returns only Orange and Red events (5 in a year instead of 95).
 * - `country=VEN` matches as a substring: it returned "Flood in Slovenia" (SloVENia) and a European drought, so
 *   events are kept only when `affectedcountries[].iso3` contains "VEN".
 * - The date window selects events that overlap it: the ongoing northern South America drought (from
 *   2026-02-21) comes back in a 30-day window.
 * - Datetimes have no timezone suffix and are UTC. `iscurrent` was false for everything, including the ongoing
 *   drought, so it is ignored; `todate` and `datemodified` are used.
 * - No events: HTTP 204 with an empty body.
 * - Terms: a disclaimer only (https://www.gdacs.org/About/termofuse.aspx), no explicit licence found.
 */

export const GDACS_LICENCE: Licence = {
	id: "gdacs-terms",
	name: "Términos de uso de GDACS (sin licencia explícita)",
	url: "https://www.gdacs.org/About/termofuse.aspx",
	attribution: "GDACS (ONU / Comisión Europea JRC)",
	commercial: "unclear",
};

const WINDOW_DAYS = 30;
export const EVENT_TYPES = ["EQ", "TC", "FL", "VO", "DR", "WF"] as const;
export type GdacsType = (typeof EVENT_TYPES)[number];

export const TYPE_ES: Readonly<Record<GdacsType, string>> = {
	EQ: "Sismo",
	TC: "Ciclón tropical",
	FL: "Inundación",
	VO: "Volcán",
	DR: "Sequía",
	WF: "Incendio forestal",
};

export function searchUrl(now: number): string {
	const day = (t: number) => new Date(t).toISOString().slice(0, 10);
	const p = new URLSearchParams({
		country: "VEN",
		fromdate: day(now - WINDOW_DAYS * 86_400_000),
		todate: day(now + 86_400_000),
		alertlevel: "green;orange;red",
		eventlist: EVENT_TYPES.join(";"),
	});
	// GDACS wants literal semicolons.
	return `https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?${p.toString().replaceAll("%3B", ";")}`;
}

/** GDACS datetimes are UTC without a suffix. */
export function gdacsTime(text: string): number | null {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(text)) return null;
	const t = Date.parse(`${text}Z`);
	return Number.isNaN(t) ? null : t;
}

const Feature = z.object({
	geometry: z.object({ type: z.literal("Point"), coordinates: z.tuple([z.number(), z.number()]) }).nullable(),
	properties: z.object({
		eventtype: z.enum(EVENT_TYPES),
		eventid: z.number().int(),
		episodeid: z.number().int(),
		name: z.string(),
		alertlevel: z.enum(["Green", "Orange", "Red"]),
		alertscore: z.number().nullable().optional(),
		fromdate: z.string(),
		todate: z.string(),
		datemodified: z.string(),
		source: z.string().nullable().optional(),
		severitydata: z
			.object({ severity: z.number().nullable(), severitytext: z.string(), severityunit: z.string() })
			.nullable()
			.optional(),
		affectedcountries: z.array(z.object({ iso3: z.string() })).nullable(),
		url: z.object({ report: z.string().url() }),
	}),
});

const Collection = z.object({ type: z.literal("FeatureCollection"), features: z.array(z.unknown()) });

export type GdacsEvent = {
	eventType: GdacsType;
	typeEs: string;
	eventId: number;
	episodeId: number;
	name: string;
	alertLevel: "green" | "orange" | "red";
	alertScore: number | null;
	fromAt: number;
	toAt: number;
	modifiedAt: number;
	/** GDACS's own severity text, e.g. "Magnitude 4.5M, Depth:10km" or "Minor impact for agricultural drought in 881237 km2". */
	severityText: string | null;
	severity: number | null;
	severityUnit: string | null;
	/** Upstream model or agency: NEIC (USGS), GLOFAS, GDO, GWIS, … */
	upstream: string | null;
	/** ISO 3166-1 alpha-3 codes of every affected country. */
	countries: string[];
	/** Whether the point GDACS maps the event at (epicentre, centroid) is inside Venezuela. */
	inVenezuela: boolean;
};

export const gdacsEvents: Adapter<GdacsEvent> = {
	id: "gdacs-events",
	layer: "earth",
	name: { es: "Alertas de desastre (GDACS)", en: "Disaster alerts (GDACS)" },
	provider: "GDACS (ONU / CE JRC)",
	homepage: "https://www.gdacs.org/",
	licence: GDACS_LICENCE,
	keys: [],
	// GDACS publishes an earthquake alert ~40–46 min after origin and floods/droughts daily; 30 min is enough.
	intervalMs: 30 * 60_000,
	freshness: { fetchMs: 2 * 3_600_000, dataMs: null },

	async fetch(ctx) {
		const raw = await ctx.http.request(searchUrl(ctx.now()), {
			headers: { accept: "application/json" },
			hostGapMs: 5_000,
			timeoutMs: 30_000,
			maxBytes: 4 * 1024 * 1024,
			signal: ctx.signal,
		});
		return [raw];
	},

	normalise(raws) {
		const raw = raws[0];
		if (!raw) throw new SchemaError("no response");
		if (raw.status === 204 || raw.body.trim() === "") return [];
		let json: unknown;
		try {
			json = JSON.parse(raw.body);
		} catch {
			throw new SchemaError("GDACS: the response is not JSON");
		}
		const collection = Collection.safeParse(json);
		if (!collection.success) throw new SchemaError(`GDACS collection: ${collection.error.message}`);
		const out: Observation<GdacsEvent>[] = [];
		for (const item of collection.data.features) {
			const parsed = Feature.safeParse(item);
			if (!parsed.success) continue;
			const p = parsed.data.properties;
			const countries = (p.affectedcountries ?? []).map((c) => c.iso3);
			if (!countries.includes("VEN")) continue;
			const fromAt = gdacsTime(p.fromdate);
			const toAt = gdacsTime(p.todate);
			const modifiedAt = gdacsTime(p.datemodified);
			if (fromAt === null || toAt === null || modifiedAt === null) continue;
			const coords = parsed.data.geometry?.coordinates;
			const where = coords ? placeOf(coords[1], coords[0]) : null;
			const sev = p.severitydata ?? null;
			out.push({
				source: "gdacs-events",
				series: `gdacs:${p.eventtype}:${p.eventid}`,
				sourceUrl: p.url.report,
				fetchedAt: raw.fetchedAt,
				// The alert as GDACS last modified it; each modification (new episode, new level) is kept as history.
				observedAt: Math.min(modifiedAt, raw.fetchedAt),
				licence: GDACS_LICENCE.id,
				value: {
					eventType: p.eventtype,
					typeEs: TYPE_ES[p.eventtype],
					eventId: p.eventid,
					episodeId: p.episodeid,
					name: p.name.replace(/\s+/g, " ").trim(),
					alertLevel: p.alertlevel.toLowerCase() as GdacsEvent["alertLevel"],
					alertScore: p.alertscore ?? null,
					fromAt,
					toAt,
					modifiedAt,
					severityText: sev?.severitytext.trim() || null,
					severity: sev?.severity ?? null,
					severityUnit: sev?.severityunit || null,
					upstream: p.source ?? null,
					countries,
					inVenezuela: where?.inVenezuela ?? false,
				},
				...(coords && where
					? {
							location: where.state
								? { lat: coords[1], lon: coords[0], state: where.state }
								: { lat: coords[1], lon: coords[0] },
						}
					: {}),
				// An impact model's alert from a named international system, not a measurement.
				confidence: 0.8,
				basis: "quote",
			});
		}
		return out;
	},
};
