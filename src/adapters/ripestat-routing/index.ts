import { z } from "zod";
import type { Adapter, Licence, Observation } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";

/**
 * RIPEstat country-resource-stats for Venezuela: how many IPv4 and IPv6 prefixes and ASNs registered to Venezuela
 * the RIPE RIS collectors see routed, per hour. A second routing view, independent of IODA's BGP signal.
 *
 * TERMS: the RIPEstat Service T&C forbid re-packaging or re-distributing RIPEstat data; showing derived results
 * with attribution is fine. The licence id `ripestat-no-redistribution` marks these rows so the archive and any
 * public API must never expose them raw; the connectivity panel shows only derived changes (%).
 *
 * Quirks (2026-09-24): hours with no change are merged into one `timeline` range (start and end are both hour
 * starts, inclusive); values can be fractional (2545.5); -1 means not available; times are UTC without a zone;
 * the newest hour lags 1–2 h. Series `country:VE:routing`, one observation per hour. One request per 30 min.
 */

export const RIPESTAT_LICENCE: Licence = {
	id: "ripestat-no-redistribution",
	name: "Términos de RIPEstat: sin redistribución de los datos; solo resultados derivados con atribución",
	url: "https://www.ripe.net/about-us/legal/ripestat-service-terms-and-conditions",
	attribution: "Fuente: RIPEstat, RIPE NCC",
	commercial: false,
	raw: false,
};

export type Routing = {
	/** RIS-visible prefixes/ASNs registered to Venezuela; null where RIPEstat says -1. */
	readonly v4Prefixes: number | null;
	readonly v6Prefixes: number | null;
	readonly asns: number | null;
};

const HOUR = 3_600_000;
const WINDOW_MS = 8 * 24 * HOUR;

const Stat = z.object({
	timeline: z.array(z.object({ starttime: z.string(), endtime: z.string() })).min(1),
	v4_prefixes_ris: z.number(),
	v6_prefixes_ris: z.number(),
	asns_ris: z.number(),
});
const Envelope = z.object({
	status: z.literal("ok"),
	data: z.object({ resource: z.string(), stats: z.array(z.unknown()) }),
});

export function statsUrl(now: number): string {
	const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16);
	const p = new URLSearchParams({
		resource: "VE",
		starttime: iso(now - WINDOW_MS),
		endtime: iso(now),
		resolution: "1h",
		sourceapp: "vigia",
	});
	return `https://stat.ripe.net/data/country-resource-stats/data.json?${p}`;
}

/** RIPEstat times are UTC without a zone designator. */
export function parseUtc(s: string): number {
	return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : `${s}Z`);
}

const value = (n: number) => (n < 0 ? null : n);

export const ripestatRouting: Adapter<Routing> = {
	id: "ripestat-routing",
	layer: "internet",
	name: { es: "Rutas anunciadas de Venezuela (RIPEstat)", en: "Routed prefixes of Venezuela (RIPEstat)" },
	provider: "RIPE NCC (RIPEstat)",
	homepage: "https://stat.ripe.net/app/launchpad/VE",
	licence: RIPESTAT_LICENCE,
	keys: [],
	intervalMs: 30 * 60_000,
	freshness: { fetchMs: 2 * HOUR, dataMs: 4 * HOUR },

	async fetch(ctx) {
		return [
			await ctx.http.request(statsUrl(ctx.now()), {
				headers: { accept: "application/json" },
				hostGapMs: 2_000,
				timeoutMs: 30_000,
				signal: ctx.signal,
			}),
		];
	},

	normalise(raws) {
		const raw = raws[0];
		if (!raw) throw new SchemaError("RIPEstat: sin respuesta");
		let json: unknown;
		try {
			json = JSON.parse(raw.body);
		} catch {
			throw new SchemaError("RIPEstat: respuesta no es JSON");
		}
		const env = Envelope.safeParse(json);
		if (!env.success) throw new SchemaError(`RIPEstat: ${env.error.message}`);
		const hours = new Map<number, Routing>();
		for (const item of env.data.data.stats) {
			const s = Stat.safeParse(item);
			if (!s.success) continue;
			const v: Routing = {
				v4Prefixes: value(s.data.v4_prefixes_ris),
				v6Prefixes: value(s.data.v6_prefixes_ris),
				asns: value(s.data.asns_ris),
			};
			for (const range of s.data.timeline) {
				const start = parseUtc(range.starttime);
				const end = parseUtc(range.endtime);
				if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > WINDOW_MS)
					continue;
				for (let t = Math.floor(start / HOUR) * HOUR; t <= end; t += HOUR)
					if (t <= raw.fetchedAt) hours.set(t, v);
			}
		}
		const out: Observation<Routing>[] = [];
		for (const [t, v] of [...hours].sort(([a], [b]) => a - b)) {
			out.push({
				source: "ripestat-routing",
				series: "country:VE:routing",
				sourceUrl: "https://stat.ripe.net/app/launchpad/VE",
				fetchedAt: raw.fetchedAt,
				observedAt: t,
				licence: RIPESTAT_LICENCE.id,
				value: v,
				confidence: 1,
				basis: "measurement",
			});
		}
		return out;
	},
};
