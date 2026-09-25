import { z } from "zod";
import type { Adapter, Licence, Observation, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { ISPS } from "../ioda-asn/index.ts";
import { domainKey } from "../ooni-ve/categories.ts";
import { OONI_LICENCE } from "../ooni-ve/index.ts";

/**
 * HOW each Venezuelan ISP blocks a site, per day, from OONI's analysis pipeline. For every web_connectivity
 * measurement OONI estimates how likely the DNS, TCP and TLS steps were interfered with ("loni" = likelihood of
 * network interference, 0..1); its aggregation endpoint averages that per domain × network per day. ooni-ve gives
 * the 7-day "is it blocked" reading; this adapter adds the method and a day-by-day history for first/last seen.
 *
 * The panel's rule (src/panels/netwatch.ts), measured 2026-09-24 against VE sin Filtro's hand-checked matrix (768
 * domain × ISP cells, 7 days): ≥ 10 measurements, a mean likelihood ≥ 0.5 on some step, and a blocking signature
 * (false/empty DNS answer or TLS reset) as the most frequent outcome: precision 0.87, recall 0.92; OONI's step
 * matches VE sin Filtro's method in 382 of 391 cells both call blocked (DNS ↔ DNS, TLS ↔ HTTP/HTTPS).
 *
 * One observation per domain per UTC day (series `domain:<key>`, observed at the day's start), only for domains
 * with a likely block (≥ 0.5) on at least one main ISP that day, carrying every main ISP's cell for that domain
 * (so "not blocked here" is recorded too); plus `day` rows (what was measured) and a `day-final` marker once the
 * day is two days old. Runs daily; fetches the last day and any of the last 14 without a final marker (at most 4
 * requests of ~9.6 MB JSON, ~0.5 MB gzip on the wire).
 */

/** api.ooni.io gzips this endpoint (~20× smaller on the wire); api.ooni.org does not (verified 2026-09-24). */
const API = "https://api.ooni.io/api/v1/aggregation/analysis";
const EXPLORER = "https://explorer.ooni.org";
const DAY = 86_400_000;
export const BACKFILL_DAYS = 14;
export const MAX_REQUESTS = 4;
/** A cell is a likely block when its mean likelihood on some layer reaches this. */
export const LIKELY = 0.5;

export type Layer = "dns" | "tcp" | "tls";

export type MethodCell = {
	readonly isp: string;
	/** Measurements (OONI's count; Digitel's two ASNs added). */
	readonly n: number;
	/** Mean likelihood of interference at each step, 0..1, 3 decimals. */
	readonly dns: number;
	readonly tcp: number;
	readonly tls: number;
	/** OONI's most likely blocking outcome, e.g. "dns.nxdomain" (weighted by measurements), null if none ≥ 0.5. */
	readonly outcome: string | null;
};

export type DomainDay = {
	readonly kind: "domain-day";
	readonly domain: string;
	/** UTC day, YYYY-MM-DD. */
	readonly day: string;
	readonly cells: MethodCell[];
};

export type DaySummary = {
	readonly kind: "day";
	readonly day: string;
	/** Domains OONI had measurements for on the main ISPs that day. */
	readonly domainsMeasured: number;
	/** Of those, domains with a likely block on ≥ 1 main ISP. */
	readonly domainsLikely: number;
	/** Measurements on the main ISPs. */
	readonly measurements: number;
	/** Fetched two or more days after the day ended (late uploads mostly in). */
	readonly final: boolean;
	/**
	 * The domains this fetch stored a domain-day row for (sorted). A later fetch of the same day replaces the list, so
	 * a domain that an earlier, partial fetch flagged and the fuller one did not is no longer read as flagged
	 * (review 3 M6). Absent on summaries stored before 2026-09-24.
	 */
	readonly likely?: string[];
};

export type MethodValue = DomainDay | DaySummary;

const Loni = z.object({
	dns_blocked: z.number(),
	tcp_blocked: z.number(),
	tls_blocked: z.number(),
	blocked_max: z.number(),
	blocked_max_outcome: z.string(),
});
const Row = z.object({
	count: z.number().nonnegative(),
	domain: z.string(),
	probe_asn: z.number().int(),
	loni: Loni,
});
const Envelope = z.object({ results: z.array(z.unknown()) });

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const startOf = (day: string) => Date.parse(`${day}T00:00:00Z`);

export function dayUrl(day: string): string {
	const p = new URLSearchParams({
		probe_cc: "VE",
		since: day,
		until: dayOf(startOf(day) + DAY),
		axis_x: "domain",
		axis_y: "probe_asn",
		test_name: "web_connectivity",
	});
	return `${API}?${p}`;
}

/** Days to fetch now, newest first: yesterday always, older ones until marked final. */
export function daysToFetch(now: number, isFinal: (dayStart: number) => boolean): string[] {
	const today = startOf(dayOf(now));
	const out: string[] = [];
	for (let k = 1; k <= BACKFILL_DAYS && out.length < MAX_REQUESTS; k++) {
		const start = today - k * DAY;
		if (k === 1 || !isFinal(start)) out.push(dayOf(start));
	}
	return out;
}

const ASN_TO_ISP = new Map(ISPS.flatMap((isp) => isp.asns.map((asn) => [Number(asn), isp.id] as const)));
const round3 = (x: number) => Math.round(x * 1_000) / 1_000;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * Adds OONI analysis rows (domain × ASN) into one cell per main ISP per domain: counts summed, likelihoods
 * weighted by count, the most frequent likely outcome (ties: alphabetical). Foreign ASNs, empty domains and
 * malformed rows are skipped. Domains sorted, cells in ISP order. Shared with the on-demand domain lookup.
 */
export function aggregateRows(items: readonly unknown[]): {
	perDomain: Map<string, MethodCell[]>;
	measurements: number;
} {
	type Acc = { n: number; dns: number; tcp: number; tls: number; outcomes: Map<string, number> };
	const acc = new Map<string, Map<string, Acc>>();
	let measurements = 0;
	for (const item of items) {
		const r = Row.safeParse(item);
		if (!r.success || r.data.count <= 0 || r.data.domain === "") continue;
		const isp = ASN_TO_ISP.get(r.data.probe_asn);
		if (!isp) continue;
		const key = domainKey(r.data.domain);
		const cells = acc.get(key) ?? new Map<string, Acc>();
		const a = cells.get(isp) ?? { n: 0, dns: 0, tcp: 0, tls: 0, outcomes: new Map<string, number>() };
		const n = r.data.count;
		const l = r.data.loni;
		a.n += n;
		a.dns += n * clamp01(l.dns_blocked);
		a.tcp += n * clamp01(l.tcp_blocked);
		a.tls += n * clamp01(l.tls_blocked);
		if (l.blocked_max >= LIKELY && l.blocked_max_outcome !== "none")
			a.outcomes.set(l.blocked_max_outcome, (a.outcomes.get(l.blocked_max_outcome) ?? 0) + n);
		cells.set(isp, a);
		acc.set(key, cells);
		measurements += n;
	}
	const order = new Map(ISPS.map((i, n) => [i.id, n]));
	const perDomain = new Map<string, MethodCell[]>();
	for (const [domain, cells] of [...acc].sort(([a], [b]) => a.localeCompare(b))) {
		perDomain.set(
			domain,
			[...cells]
				.sort(([a], [b]) => (order.get(a) ?? 99) - (order.get(b) ?? 99))
				.map(([isp, a]) => {
					let outcome: string | null = null;
					let best = 0;
					for (const [o, n] of [...a.outcomes].sort(([x], [y]) => x.localeCompare(y)))
						if (n > best) {
							best = n;
							outcome = o;
						}
					return {
						isp,
						n: a.n,
						dns: round3(a.dns / a.n),
						tcp: round3(a.tcp / a.n),
						tls: round3(a.tls / a.n),
						outcome,
					};
				}),
		);
	}
	return { perDomain, measurements };
}

function normaliseDay(raw: RawResponse): Observation<MethodValue>[] {
	const since = new URL(raw.url).searchParams.get("since") ?? "";
	if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new SchemaError("OONI análisis: URL sin día");
	let json: unknown;
	try {
		json = JSON.parse(raw.body);
	} catch {
		throw new SchemaError("OONI análisis: respuesta no es JSON");
	}
	const env = Envelope.safeParse(json);
	if (!env.success) throw new SchemaError(`OONI análisis: ${env.error.message}`);

	const { perDomain, measurements } = aggregateRows(env.data.results);

	const observedAt = startOf(since);
	const base = {
		source: "ooni-methods",
		fetchedAt: raw.fetchedAt,
		observedAt,
		licence: OONI_LICENCE.id,
		confidence: 0.85,
		basis: "measurement" as const,
	};
	const out: Observation<MethodValue>[] = [];
	for (const [domain, list] of perDomain) {
		if (!list.some((c) => Math.max(c.dns, c.tcp, c.tls) >= LIKELY)) continue;
		out.push({
			...base,
			series: `domain:${domain}`,
			sourceUrl: `${EXPLORER}/domain/${encodeURIComponent(domain)}?probe_cc=VE&since=${since}&until=${dayOf(observedAt + DAY)}`,
			value: { kind: "domain-day", domain, day: since, cells: list },
		});
	}
	const summary: DaySummary = {
		kind: "day",
		day: since,
		domainsMeasured: perDomain.size,
		domainsLikely: out.length,
		measurements: Math.round(measurements),
		final: raw.fetchedAt >= observedAt + 3 * DAY,
		likely: out.map((o) => (o.value as DomainDay).domain).sort(),
	};
	const dayPage = `${EXPLORER}/search?probe_cc=VE&test_name=web_connectivity&since=${since}&until=${dayOf(observedAt + DAY)}`;
	out.push({ ...base, series: "day", sourceUrl: dayPage, value: summary });
	if (summary.final) out.push({ ...base, series: "day-final", sourceUrl: dayPage, value: summary });
	return out;
}

export const ooniMethods: Adapter<MethodValue> = {
	id: "ooni-methods",
	layer: "internet",
	name: { es: "Método de bloqueo por proveedor (OONI)", en: "Blocking method per ISP (OONI)" },
	provider: "OONI",
	homepage: `${EXPLORER}/country/VE`,
	licence: OONI_LICENCE satisfies Licence,
	keys: [],
	intervalMs: 24 * 3_600_000,
	// Yesterday's day is read each run: stale when no fetch for 3 days or the newest day is 3 days old.
	freshness: { fetchMs: 3 * DAY, dataMs: 3 * DAY },

	async fetch(ctx) {
		const days = daysToFetch(ctx.now(), (start) => ctx.seen?.("day-final", start) ?? false);
		const out: RawResponse[] = [];
		for (const day of days) {
			out.push(
				await ctx.http.request(dayUrl(day), {
					headers: { accept: "application/json" },
					hostGapMs: 5_000,
					timeoutMs: 90_000,
					maxBytes: 24 * 1024 * 1024,
					signal: ctx.signal,
				}),
			);
		}
		return out;
	},

	normalise(raws) {
		if (raws.length === 0) throw new SchemaError("OONI análisis: sin respuestas");
		return raws.flatMap(normaliseDay);
	},
};
