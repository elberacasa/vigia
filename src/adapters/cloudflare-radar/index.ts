import { z } from "zod";
import type { Adapter, Licence, Observation, RawResponse } from "../../core/types.ts";
import { MissingKeyError, SchemaError } from "../../core/types.ts";

/**
 * Cloudflare Radar for Venezuela: Cloudflare's outage annotations (each one written by Cloudflare's analysts, with a
 * cause and a scope), its automatic traffic-anomaly detections (verified or not), and the country's hourly traffic
 * curve as Cloudflare sees it (NetFlows, normalised 0–1 over the window). A third, independent view of the
 * internet next to IODA and RIPE Atlas: a different vantage (one large network's traffic, not probes or BGP).
 *
 * Access: the Radar API needs a free Cloudflare API token (a free account, email only; a custom token with the
 * Radar read permission). Without it the feed is locked and the setup guide explains how to get it. Tested without
 * a token on 2026-09-29: `GET /client/v4/radar/annotations/outages?location=VE` answers 400 "Missing X-Auth-Key,
 * X-Auth-Email or Authorization headers". Response shapes are the ones in Cloudflare's published OpenAPI schema
 * (github.com/cloudflare/api-schemas, openapi.json, read 2026-09-29): `result.annotations[]` (id, startDate, endDate,
 * description, scope, outage.outageCause/outageType, asnsDetails, locations, linkedUrl), `result.trafficAnomalies[]`
 * (uuid, status VERIFIED/UNVERIFIED, type LOCATION/AS, startDate, endDate, asnDetails, locationDetails) and
 * `result.serie_0.{timestamps, values}` with `result.meta` (aggInterval, normalization, lastUpdated). The tests use
 * synthetic payloads built from that schema; a recorded fixture is added on the first run with a token.
 *
 * Rate: the Cloudflare API allows 1,200 requests per 5 minutes per user; Vigía makes 3 every 30 minutes.
 *
 * Licence: "Data available via Radar API endpoints is made available under the CC BY-NC 4.0 license"
 * (developers.cloudflare.com/radar); attribution "Cloudflare Radar". Non-commercial, which Vigía is.
 */

export const CLOUDFLARE_RADAR_LICENCE: Licence = {
	id: "cc-by-nc-4.0-cloudflare-radar",
	name: "CC BY-NC 4.0 (Cloudflare Radar)",
	url: "https://developers.cloudflare.com/radar/",
	attribution: "Datos: Cloudflare Radar (CC BY-NC 4.0)",
	commercial: false,
};

export const CLOUDFLARE_KEY_ID = "cloudflare-radar-token";
export const RADAR_HOME = "https://radar.cloudflare.com/ve";
const API = "https://api.cloudflare.com/client/v4/radar";
const DAY = 86_400_000;

export function outagesUrl(): string {
	return `${API}/annotations/outages?${new URLSearchParams({ location: "VE", dateRange: "30d", limit: "100", format: "json" })}`;
}
export function anomaliesUrl(): string {
	return `${API}/traffic_anomalies?${new URLSearchParams({ location: "VE", dateRange: "7d", limit: "100", format: "json" })}`;
}
export function trafficUrl(): string {
	return `${API}/netflows/timeseries?${new URLSearchParams({
		location: "VE",
		dateRange: "7d",
		aggInterval: "1h",
		normalization: "MIN0_MAX",
		format: "json",
	})}`;
}

export type RadarOutage = {
	kind: "outage";
	id: string;
	startDate: string;
	endDate: string | null;
	/** Cloudflare's own words (English), e.g. "Power outage in Zulia". */
	description: string | null;
	/** Where, in Cloudflare's words (e.g. "Zulia"), or null. */
	scope: string | null;
	/** e.g. POWER_OUTAGE, CABLE_CUT, GOVERNMENT_DIRECTED, TECHNICAL_PROBLEM. */
	cause: string | null;
	/** NATIONWIDE, REGIONAL, NETWORK, … */
	outageType: string | null;
	asns: { asn: number; name: string | null }[];
	locations: string[];
	linkedUrl: string | null;
};

export type RadarAnomaly = {
	kind: "anomaly";
	uuid: string;
	status: "VERIFIED" | "UNVERIFIED";
	/** LOCATION (the whole country) or AS (one network). */
	type: string;
	startDate: string;
	endDate: string | null;
	asn: number | null;
	asnName: string | null;
	location: string | null;
};

export type RadarTraffic = {
	kind: "traffic";
	/** Hourly points of the last 7 days, whole hours only, oldest first: [epoch ms, 0..1 of the window's maximum]. */
	points: [number, number][];
	normalization: string;
	aggInterval: string;
	/** Cloudflare's own "last updated" for the dataset (ISO), when given. */
	lastUpdated: string | null;
};

export type CloudflareRadar = RadarOutage | RadarAnomaly | RadarTraffic;

const Iso = z.string().datetime({ offset: true });
const Annotation = z.object({
	id: z.string().min(1).max(40),
	startDate: Iso,
	endDate: Iso.nullable(),
	description: z.string().max(2000).nullable(),
	scope: z.string().max(500).nullable(),
	outage: z.object({ outageCause: z.string().max(60), outageType: z.string().max(60) }).nullable(),
	asnsDetails: z
		.array(z.object({ asn: z.string().regex(/^\d{1,10}$/), name: z.string().max(200).nullable() }))
		.default([]),
	locations: z.array(z.string().max(4)).default([]),
	linkedUrl: z.string().url().max(1000).nullable(),
});
const Anomaly = z.object({
	uuid: z.string().min(1).max(60),
	status: z.enum(["VERIFIED", "UNVERIFIED"]),
	type: z.string().max(20),
	startDate: Iso,
	endDate: Iso.nullable(),
	asnDetails: z
		.object({ asn: z.string().regex(/^\d{1,10}$/), name: z.string().max(200).nullable() })
		.nullable(),
	locationDetails: z.object({ code: z.string().max(4), name: z.string().max(100) }).nullable(),
});
const Envelope = z.object({ success: z.literal(true), result: z.record(z.string(), z.unknown()) });
/** Bucket length of each aggregation interval Radar names. */
const AGG_MS: Readonly<Record<string, number>> = {
	FIFTEEN_MINUTES: 15 * 60_000,
	ONE_HOUR: 3_600_000,
	ONE_DAY: 86_400_000,
	ONE_WEEK: 7 * 86_400_000,
};
const Serie = z.object({
	timestamps: z.array(Iso),
	values: z.array(z.string().regex(/^-?\d+(\.\d+)?(e-?\d+)?$/i)),
});
const Meta = z.object({
	aggInterval: z.string(),
	normalization: z.string(),
	lastUpdated: Iso.optional(),
});

function envelope(raw: RawResponse): Record<string, unknown> {
	let body: unknown;
	try {
		body = JSON.parse(raw.body);
	} catch {
		throw new SchemaError("Cloudflare Radar: la respuesta no es JSON");
	}
	const env = Envelope.safeParse(body);
	if (!env.success) throw new SchemaError("Cloudflare Radar: respuesta sin «success» o «result»");
	return env.data.result;
}

export const cloudflareRadar: Adapter<CloudflareRadar> = {
	id: "cloudflare-radar",
	layer: "internet",
	name: {
		es: "Cloudflare Radar: cortes, anomalías y tráfico de Venezuela",
		en: "Cloudflare Radar: outages, anomalies and traffic in Venezuela",
	},
	provider: "Cloudflare Radar",
	homepage: RADAR_HOME,
	licence: CLOUDFLARE_RADAR_LICENCE,
	keys: [CLOUDFLARE_KEY_ID],
	// Anomalies are detected within the hour; every 30 min is prompt and three requests.
	intervalMs: 30 * 60_000,
	// The traffic curve is hourly: stale when the newest point is 3 h old or the last good fetch 2 h.
	freshness: { fetchMs: 2 * 3_600_000, dataMs: 3 * 3_600_000 },

	async fetch(ctx) {
		const token = ctx.key(CLOUDFLARE_KEY_ID);
		if (!token) throw new MissingKeyError(CLOUDFLARE_KEY_ID);
		const opts = {
			headers: { accept: "application/json", authorization: `Bearer ${token}` },
			hostGapMs: 1_000,
			timeoutMs: 30_000,
			maxBytes: 4 * 1024 * 1024,
			signal: ctx.signal,
		};
		return [
			await ctx.http.request(outagesUrl(), opts),
			await ctx.http.request(anomaliesUrl(), opts),
			await ctx.http.request(trafficUrl(), opts),
		];
	},

	normalise(raws) {
		if (raws.length === 0) throw new SchemaError("no response");
		const out: Observation<CloudflareRadar>[] = [];
		for (const raw of raws) {
			const result = envelope(raw);
			const base = {
				source: "cloudflare-radar",
				fetchedAt: raw.fetchedAt,
				licence: CLOUDFLARE_RADAR_LICENCE.id,
			};
			if (raw.url.includes("/annotations/outages")) {
				if (!Array.isArray(result.annotations))
					throw new SchemaError("Cloudflare Radar: faltan «annotations»");
				for (const item of result.annotations) {
					const a = Annotation.safeParse(item);
					if (!a.success) continue;
					const v = a.data;
					const at = Date.parse(v.startDate);
					if (at > raw.fetchedAt + 15 * 60_000) continue;
					out.push({
						...base,
						series: `outage:${v.id}`,
						sourceUrl: RADAR_HOME,
						observedAt: Math.min(at, raw.fetchedAt),
						value: {
							kind: "outage",
							id: v.id,
							startDate: new Date(at).toISOString(),
							endDate: v.endDate ? new Date(Date.parse(v.endDate)).toISOString() : null,
							description: v.description,
							scope: v.scope,
							cause: v.outage?.outageCause ?? null,
							outageType: v.outage?.outageType ?? null,
							asns: v.asnsDetails.map((d) => ({ asn: Number(d.asn), name: d.name })),
							locations: v.locations,
							linkedUrl: v.linkedUrl,
						},
						// Cloudflare's analysts' attributed account of an outage (their traffic, their words).
						confidence: 0.9,
						basis: "report",
					});
				}
			} else if (raw.url.includes("/traffic_anomalies")) {
				if (!Array.isArray(result.trafficAnomalies))
					throw new SchemaError("Cloudflare Radar: faltan «trafficAnomalies»");
				for (const item of result.trafficAnomalies) {
					const a = Anomaly.safeParse(item);
					if (!a.success) continue;
					const v = a.data;
					const at = Date.parse(v.startDate);
					if (at > raw.fetchedAt + 15 * 60_000) continue;
					out.push({
						...base,
						series: `anomaly:${v.uuid}`,
						sourceUrl: RADAR_HOME,
						observedAt: Math.min(at, raw.fetchedAt),
						value: {
							kind: "anomaly",
							uuid: v.uuid,
							status: v.status,
							type: v.type,
							startDate: new Date(at).toISOString(),
							endDate: v.endDate ? new Date(Date.parse(v.endDate)).toISOString() : null,
							asn: v.asnDetails ? Number(v.asnDetails.asn) : null,
							asnName: v.asnDetails?.name ?? null,
							location: v.locationDetails?.code ?? null,
						},
						// An automatic detector; Cloudflare marks the ones its analysts confirmed.
						confidence: v.status === "VERIFIED" ? 0.9 : 0.6,
						basis: "measurement",
					});
				}
			} else if (raw.url.includes("/netflows/timeseries")) {
				const serie = Serie.safeParse(result.serie_0);
				const meta = Meta.safeParse(result.meta);
				if (!serie.success || !meta.success)
					throw new SchemaError("Cloudflare Radar: serie de tráfico inválida");
				const { timestamps, values } = serie.data;
				if (timestamps.length !== values.length)
					throw new SchemaError("Cloudflare Radar: marcas de tiempo y valores no coinciden");
				const points: [number, number][] = [];
				// Only whole buckets: the newest one is still filling while its hour runs, and would read as a dip.
				const bucket = AGG_MS[meta.data.aggInterval] ?? 3_600_000;
				for (let i = 0; i < timestamps.length; i++) {
					const t = Date.parse(timestamps[i] ?? "");
					const v = Number(values[i]);
					if (!Number.isFinite(t) || !Number.isFinite(v) || t + bucket > raw.fetchedAt) continue;
					points.push([t, Math.round(v * 10_000) / 10_000]);
				}
				points.sort((a, b) => a[0] - b[0]);
				const newest = points.at(-1);
				if (!newest) continue;
				out.push({
					...base,
					series: "traffic:VE",
					sourceUrl: RADAR_HOME,
					observedAt: newest[0],
					value: {
						kind: "traffic",
						points,
						normalization: meta.data.normalization,
						aggInterval: meta.data.aggInterval,
						lastUpdated: meta.data.lastUpdated ?? null,
					},
					confidence: 0.9,
					basis: "measurement",
				});
			}
		}
		return out;
	},
};

/** Window the anomaly and outage lists cover (for the panel's "in the last N days"). */
export const WINDOWS = { outagesMs: 30 * DAY, anomaliesMs: 7 * DAY } as const;
