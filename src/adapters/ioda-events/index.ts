import { z } from "zod";
import type { Adapter, Observation, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { stateByIso } from "../../geo/index.ts";
import { ISP_ASNS, ISPS } from "../ioda-asn/index.ts";
import { IODA_API, IODA_HOST_GAP_MS, IODA_LICENCE, IODA_SITE } from "../ioda-states/ioda.ts";
import { IODA_REGIONS, regionById } from "../ioda-states/regions.ts";

/**
 * IODA's own outage events for Venezuela, its states and the main ISPs, last 7 days: IODA's automatic detector
 * (method "median": a signal falling below a fraction of its recent median) merges consecutive alerts into events
 * with a start, a duration and a score. These are IODA's labels, shown as such, next to (not blended with) our
 * own same-hour comparison in the connectivity panel.
 *
 * Series: `event:<location>:<datasource>:<start>` (e.g. `event:region/4501:ping-slash24:1790255400`); an event
 * that is still growing is re-stored with its new duration (the store keeps revisions, the panel reads the latest).
 * IODA extends the window by up to 14 days (`extendWindow`), so events that began before it are included.
 */

export type IodaEvent = {
	readonly entityType: "country" | "region" | "asn";
	readonly entityCode: string;
	/** Spanish name: state name from src/geo, ISP name from our table, or "Venezuela". */
	readonly entityName: string;
	/** ISO 3166-2 for states, ISP id for ASNs, "VE" for the country. */
	readonly key: string;
	readonly datasource: string;
	readonly startS: number;
	readonly durationS: number;
	readonly score: number;
	readonly method: string;
};

const Event = z.object({
	location: z.string().regex(/^(country|region|asn)\/[\w-]+$/),
	start: z.number().int(),
	duration: z.number().int().nonnegative(),
	method: z.string(),
	datasource: z.string(),
	score: z.number(),
	location_name: z.string().optional(),
});

const Envelope = z.object({
	type: z.literal("outages.events"),
	error: z.string().nullable(),
	data: z.array(z.unknown()).nullable(),
});

export const EVENT_WINDOW_S = 7 * 86_400;

export function eventsUrl(
	entityType: "country" | "region" | "asn",
	codes: readonly string[],
	now: number,
): string {
	const until = Math.floor(now / 1_000);
	const p = new URLSearchParams({
		entityType,
		entityCode: codes.join(","),
		from: String(until - EVENT_WINDOW_S),
		until: String(until),
		format: "codf",
		limit: "500",
	});
	return `${IODA_API}/outages/events?${p}`;
}

const ASN_TO_ISP = new Map(ISPS.flatMap((isp) => isp.asns.map((asn) => [asn, isp] as const)));

function describe(entityType: string, code: string): Pick<IodaEvent, "entityName" | "key"> | null {
	if (entityType === "country") return code === "VE" ? { entityName: "Venezuela", key: "VE" } : null;
	if (entityType === "region") {
		const region = regionById(code);
		if (!region) return null;
		return { entityName: stateByIso(region.iso)?.name ?? region.iodaName, key: region.iso };
	}
	const isp = ASN_TO_ISP.get(code);
	return isp ? { entityName: `${isp.name} (AS${code})`, key: isp.id } : null;
}

export const iodaEvents: Adapter<IodaEvent> = {
	id: "ioda-events",
	layer: "internet",
	name: { es: "Eventos de caída (IODA)", en: "Outage events (IODA)" },
	provider: "IODA, Georgia Tech Internet Intelligence Lab",
	homepage: `${IODA_SITE}/country/VE`,
	licence: IODA_LICENCE,
	keys: [],
	intervalMs: 10 * 60_000,
	// Event feed: silence is normal, so only the fetch age makes it stale.
	freshness: { fetchMs: 40 * 60_000, dataMs: null },

	async fetch(ctx) {
		const now = ctx.now();
		const out: RawResponse[] = [];
		for (const [type, codes] of [
			["country", ["VE"]],
			["region", IODA_REGIONS.map((r) => r.id)],
			["asn", ISP_ASNS],
		] as const) {
			out.push(
				await ctx.http.request(eventsUrl(type, codes, now), {
					headers: { accept: "application/json" },
					hostGapMs: IODA_HOST_GAP_MS,
					timeoutMs: 30_000,
					maxBytes: 2 * 1024 * 1024,
					signal: ctx.signal,
				}),
			);
		}
		return out;
	},

	normalise(raws) {
		if (raws.length === 0) throw new SchemaError("IODA: sin respuestas");
		const out: Observation<IodaEvent>[] = [];
		for (const raw of raws) {
			let json: unknown;
			try {
				json = JSON.parse(raw.body);
			} catch {
				throw new SchemaError("IODA events: respuesta no es JSON");
			}
			const envelope = Envelope.safeParse(json);
			if (!envelope.success) throw new SchemaError(`IODA events: ${envelope.error.message}`);
			const { error, data } = envelope.data;
			if (error !== null) throw new SchemaError(`IODA events error: ${error}`);
			if (data === null) throw new SchemaError("IODA events: data null");
			for (const item of data) {
				const parsed = Event.safeParse(item);
				if (!parsed.success) continue;
				const e = parsed.data;
				const [type = "", code = ""] = e.location.split("/");
				const who = describe(type, code);
				if (!who) continue;
				const observedAt = e.start * 1_000;
				if (observedAt > raw.fetchedAt) continue;
				const state = type === "region" ? stateByIso(who.key) : undefined;
				out.push({
					source: "ioda-events",
					series: `event:${e.location}:${e.datasource}:${e.start}`,
					sourceUrl: `${IODA_SITE}/${e.location}?from=${e.start - 3_600}&until=${e.start + e.duration + 3_600}`,
					fetchedAt: raw.fetchedAt,
					observedAt,
					licence: IODA_LICENCE.id,
					value: {
						entityType: type as IodaEvent["entityType"],
						entityCode: code,
						entityName: who.entityName,
						key: who.key,
						datasource: e.datasource,
						startS: e.start,
						durationS: e.duration,
						score: e.score,
						method: e.method,
					},
					// IODA's own detector output: a named third party's label, not our measurement.
					confidence: 0.8,
					basis: "quote",
					...(state
						? {
								location: { lat: state.label.lat, lon: state.label.lon, state: state.iso, place: state.name },
							}
						: {}),
				});
			}
		}
		return out;
	},
};
