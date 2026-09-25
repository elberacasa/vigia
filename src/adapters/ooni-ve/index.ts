import { z } from "zod";
import type { Adapter, Licence, Observation, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { ISPS } from "../ioda-asn/index.ts";
import { domainKey } from "./categories.ts";

/**
 * OONI web-connectivity measurements from Venezuela over the last 7 days, aggregated by OONI per domain and per
 * network (ASN). Volunteers run OONI Probe; each measurement says whether a site loaded as expected from a
 * control vantage point. Venezuela blocks mostly by DNS tampering, which OONI's fingerprints rarely "confirm"
 * (1 confirmed in 30 days), so we use the anomaly share and call it "posible bloqueo", never "confirmado".
 *
 * Rule (measured against VE sin Filtro's hand-checked matrix on 2026-09-24, 768 domain×ISP cells with both
 * sources): a domain is a possible block on an ISP when that ISP has ≥ 10 measurements of it in the window and
 * ≥ 50 % are anomalies. Precision 0.91, recall 0.85 against VE sin Filtro's labels.
 *
 * Series: `domain:<domain>` (only domains flagged on at least one main ISP), `isp:<id>` (totals per ISP),
 * `country:VE:summary`. Observed at fetch time (the aggregates are true as of then). Every 3 hours; three
 * requests (domain × category, domain × ASN, newest measurement) of ~40 KB, ~195 KB and ~1 KB gzip.
 */

export const OONI_LICENCE: Licence = {
	id: "cc-by-nc-sa-4.0-ooni",
	name: "CC BY-NC-SA 4.0 (OONI)",
	url: "https://github.com/ooni/license/tree/master/data",
	attribution: "Datos: OONI (Open Observatory of Network Interference)",
	commercial: false,
};

const API = "https://api.ooni.io/api/v1";
const EXPLORER = "https://explorer.ooni.org";
/** OONI sends `x-ratelimit-remaining` (~4000) without a documented window; three calls every 3 h is far below. */
const HOST_GAP_MS = 2_000;
export const WINDOW_DAYS = 7;
export const MIN_MEASUREMENTS = 10;
export const FLAG_RATE = 0.5;

export type IspCell = {
	readonly isp: string;
	readonly measurements: number;
	readonly anomalies: number;
	/** anomalies / measurements, 3 decimals. */
	readonly anomalyRate: number;
	/** ≥ MIN_MEASUREMENTS and anomalyRate ≥ FLAG_RATE. */
	readonly flagged: boolean;
};

export type OoniDomain = {
	readonly kind: "domain";
	readonly domain: string;
	/** Citizen Lab category code; "" when the domain is not in the test lists (tested by users' own input). */
	readonly category: string;
	readonly measurements: number;
	readonly anomalies: number;
	readonly confirmed: number;
	readonly anomalyRate: number;
	/** One cell per main ISP with at least one measurement. */
	readonly isps: IspCell[];
	readonly since: string;
	readonly until: string;
};

export type OoniIsp = {
	readonly kind: "isp";
	readonly isp: string;
	readonly measurements: number;
	readonly anomalies: number;
	readonly anomalyRate: number;
	/** Domains with ≥ MIN_MEASUREMENTS on this ISP. */
	readonly domainsTested: number;
	readonly domainsFlagged: number;
	readonly since: string;
	readonly until: string;
};

export type OoniSummary = {
	readonly kind: "summary";
	readonly measurements: number;
	/**
	 * Measurements in the domain × ASN aggregation (the one flags come from). Absent on rows stored before
	 * 2026-09-24; the timeline uses it to tell a complete run from a thin one (src/panels/ooni-runs.ts).
	 */
	readonly asnMeasurements?: number;
	readonly anomalies: number;
	readonly confirmed: number;
	readonly domainsTested: number;
	readonly domainsFlagged: number;
	/** Start time of the newest VE measurement OONI had (UTC ms); null if that call failed. */
	readonly newestMeasurementAt: number | null;
	/** Fetch time of the run that produced this summary (one row per run). */
	readonly runAt: number;
	readonly since: string;
	readonly until: string;
};

export type OoniValue = OoniDomain | OoniIsp | OoniSummary;

const Row = z.object({
	anomaly_count: z.number().int().nonnegative(),
	confirmed_count: z.number().int().nonnegative(),
	failure_count: z.number().int().nonnegative(),
	ok_count: z.number().int().nonnegative(),
	measurement_count: z.number().int().nonnegative(),
	domain: z.string().min(1),
	category_code: z.string().optional(),
	probe_asn: z.number().int().optional(),
});
const Aggregation = z.object({ result: z.array(z.unknown()) });
const Latest = z.object({
	results: z.array(z.object({ measurement_start_time: z.string() }).loose()),
});

function day(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

export function windowOf(now: number): { since: string; until: string } {
	return { since: day(now - WINDOW_DAYS * 86_400_000), until: day(now + 86_400_000) };
}

export function aggregationUrl(now: number, axisY: "category_code" | "probe_asn"): string {
	const { since, until } = windowOf(now);
	const p = new URLSearchParams({
		probe_cc: "VE",
		since,
		until,
		test_name: "web_connectivity",
		axis_x: "domain",
		axis_y: axisY,
	});
	return `${API}/aggregation?${p}`;
}

export function latestUrl(): string {
	return `${API}/measurements?probe_cc=VE&limit=1&order_by=measurement_start_time&order=desc`;
}

const ASN_TO_ISP = new Map(ISPS.flatMap((isp) => isp.asns.map((asn) => [Number(asn), isp.id] as const)));

function parseAggregation(raw: RawResponse | undefined, what: string): z.infer<typeof Row>[] {
	if (!raw) throw new SchemaError(`OONI: falta ${what}`);
	let json: unknown;
	try {
		json = JSON.parse(raw.body);
	} catch {
		throw new SchemaError(`OONI ${what}: respuesta no es JSON`);
	}
	const agg = Aggregation.safeParse(json);
	if (!agg.success) throw new SchemaError(`OONI ${what}: ${agg.error.message}`);
	const rows: z.infer<typeof Row>[] = [];
	for (const item of agg.data.result) {
		const r = Row.safeParse(item);
		if (r.success && r.data.anomaly_count <= r.data.measurement_count) rows.push(r.data);
	}
	return rows;
}

const rate = (a: number, m: number) => (m > 0 ? Math.round((a / m) * 1_000) / 1_000 : 0);

export const ooniVe: Adapter<OoniValue> = {
	id: "ooni-ve",
	layer: "internet",
	name: { es: "Bloqueos web (OONI)", en: "Web blocking (OONI)" },
	provider: "OONI",
	homepage: `${EXPLORER}/country/VE`,
	licence: OONI_LICENCE,
	keys: [],
	intervalMs: 3 * 3_600_000,
	// Measurements arrive within seconds; stale when no fetch for 9 h or the newest measurement is 12 h old.
	freshness: { fetchMs: 9 * 3_600_000, dataMs: 12 * 3_600_000 },

	async fetch(ctx) {
		const now = ctx.now();
		const options = {
			headers: { accept: "application/json" },
			hostGapMs: HOST_GAP_MS,
			timeoutMs: 60_000,
			maxBytes: 12 * 1024 * 1024,
			signal: ctx.signal,
		};
		const byCategory = await ctx.http.request(aggregationUrl(now, "category_code"), options);
		const byAsn = await ctx.http.request(aggregationUrl(now, "probe_asn"), options);
		const latest = await ctx.http.request(latestUrl(), { ...options, retries: 0 }).catch(() => null);
		return latest ? [byCategory, byAsn, latest] : [byCategory, byAsn];
	},

	normalise(raws) {
		const [catRaw, asnRaw, latestRaw] = raws;
		const catRows = parseAggregation(catRaw, "dominio×categoría");
		const asnRows = parseAggregation(asnRaw, "dominio×ASN");
		// Seven days of Venezuelan measurements are never empty: an empty answer is an OONI failure, and storing it
		// would read as every flagged domain being unblocked. Fail the run so the last good one is kept.
		if (catRows.length === 0 || asnRows.length === 0) {
			throw new SchemaError("OONI devolvió 0 mediciones para 7 días de Venezuela; se descarta esta corrida");
		}
		const fetchedAt = Math.max(catRaw?.fetchedAt ?? 0, asnRaw?.fetchedAt ?? 0);
		const { since, until } = windowOf(asnRaw?.fetchedAt ?? fetchedAt);

		// Domain totals and category: a domain listed under two categories keeps the one with most measurements.
		type Total = { domain: string; category: string; best: number; m: number; a: number; c: number };
		const totals = new Map<string, Total>();
		for (const r of catRows) {
			const key = domainKey(r.domain);
			const t = totals.get(key) ?? { domain: key, category: "MISC", best: -1, m: 0, a: 0, c: 0 };
			t.m += r.measurement_count;
			t.a += r.anomaly_count;
			t.c += r.confirmed_count;
			if (r.measurement_count > t.best) {
				t.best = r.measurement_count;
				t.category = r.category_code ?? "MISC";
			}
			totals.set(key, t);
		}

		let asnMeasurements = 0;
		for (const r of asnRows) asnMeasurements += r.measurement_count;

		// Domain × ISP cells for the main ISPs (Digitel's two ASNs added together).
		const cells = new Map<string, Map<string, { m: number; a: number }>>();
		const ispTotals = new Map<string, { m: number; a: number }>();
		// Domains outside Citizen Lab's lists are absent from the category aggregation; their totals come from here.
		const anyAsn = new Map<string, { m: number; a: number; c: number }>();
		for (const r of asnRows) {
			const all = anyAsn.get(domainKey(r.domain)) ?? { m: 0, a: 0, c: 0 };
			all.m += r.measurement_count;
			all.a += r.anomaly_count;
			all.c += r.confirmed_count;
			anyAsn.set(domainKey(r.domain), all);
			const isp = r.probe_asn === undefined ? undefined : ASN_TO_ISP.get(r.probe_asn);
			if (!isp) continue;
			const key = domainKey(r.domain);
			const perDomain = cells.get(key) ?? new Map<string, { m: number; a: number }>();
			const cell = perDomain.get(isp) ?? { m: 0, a: 0 };
			cell.m += r.measurement_count;
			cell.a += r.anomaly_count;
			perDomain.set(isp, cell);
			cells.set(key, perDomain);
			const it = ispTotals.get(isp) ?? { m: 0, a: 0 };
			it.m += r.measurement_count;
			it.a += r.anomaly_count;
			ispTotals.set(isp, it);
		}

		const base = {
			source: "ooni-ve",
			fetchedAt,
			observedAt: fetchedAt,
			licence: OONI_LICENCE.id,
			confidence: 0.9,
			basis: "measurement" as const,
		};
		const out: Observation<OoniValue>[] = [];
		const tested = new Map<string, number>();
		const flaggedPerIsp = new Map<string, number>();
		let domainsFlagged = 0;
		for (const [key, perDomain] of [...cells].sort(([a], [b]) => a.localeCompare(b))) {
			const ispCells: IspCell[] = [];
			for (const isp of ISPS) {
				const c = perDomain.get(isp.id);
				if (!c || c.m === 0) continue;
				const flagged = c.m >= MIN_MEASUREMENTS && c.a / c.m >= FLAG_RATE;
				if (c.m >= MIN_MEASUREMENTS) tested.set(isp.id, (tested.get(isp.id) ?? 0) + 1);
				if (flagged) flaggedPerIsp.set(isp.id, (flaggedPerIsp.get(isp.id) ?? 0) + 1);
				ispCells.push({
					isp: isp.id,
					measurements: c.m,
					anomalies: c.a,
					anomalyRate: rate(c.a, c.m),
					flagged,
				});
			}
			if (!ispCells.some((c) => c.flagged)) continue;
			domainsFlagged++;
			const listed = totals.get(key);
			const fallback = anyAsn.get(key) ?? { m: 0, a: 0, c: 0 };
			const t = listed ?? { category: "", m: fallback.m, a: fallback.a, c: fallback.c };
			out.push({
				...base,
				series: `domain:${key}`,
				sourceUrl: `${EXPLORER}/domain/${encodeURIComponent(key)}?probe_cc=VE`,
				value: {
					kind: "domain",
					domain: key,
					category: t.category,
					measurements: t.m,
					anomalies: t.a,
					confirmed: t.c,
					anomalyRate: rate(t.a, t.m),
					isps: ispCells,
					since,
					until,
				},
			});
		}
		for (const isp of ISPS) {
			const t = ispTotals.get(isp.id);
			if (!t) continue;
			out.push({
				...base,
				series: `isp:${isp.id}`,
				sourceUrl: `${EXPLORER}/as/AS${isp.asns[0]}`,
				value: {
					kind: "isp",
					isp: isp.id,
					measurements: t.m,
					anomalies: t.a,
					anomalyRate: rate(t.a, t.m),
					domainsTested: tested.get(isp.id) ?? 0,
					domainsFlagged: flaggedPerIsp.get(isp.id) ?? 0,
					since,
					until,
				},
			});
		}

		let newest: number | null = null;
		if (latestRaw) {
			// Optional endpoint: an HTML error page or bad JSON only loses this figure, never the run.
			let json: unknown = null;
			try {
				json = JSON.parse(latestRaw.body);
			} catch {
				json = null;
			}
			const latest = Latest.safeParse(json);
			const t = latest.success
				? Date.parse(latest.data.results[0]?.measurement_start_time ?? "")
				: Number.NaN;
			if (Number.isFinite(t)) newest = t;
		}
		let m = 0;
		let a = 0;
		let c = 0;
		for (const t of totals.values()) {
			m += t.m;
			a += t.a;
			c += t.c;
		}
		out.push({
			...base,
			series: "country:VE:summary",
			// Observed when the newest measurement was taken, when known (never after the fetch).
			observedAt: newest !== null ? Math.min(newest, fetchedAt) : fetchedAt,
			sourceUrl: `${EXPLORER}/country/VE`,
			value: {
				kind: "summary",
				measurements: m,
				asnMeasurements,
				anomalies: a,
				confirmed: c,
				domainsTested: [...totals.values()].filter((t) => t.m >= MIN_MEASUREMENTS).length,
				domainsFlagged,
				newestMeasurementAt: newest,
				// Makes every run's summary a distinct row, so runs can be told apart even when OONI has nothing newer.
				runAt: fetchedAt,
				since,
				until,
			},
		});
		return out;
	},
};
