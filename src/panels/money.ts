import type { BcvApiRate, BcvApiRead } from "../adapters/bcv-api/index.ts";
import { BCV_API_PROVIDER, bcvApi, READ_SERIES } from "../adapters/bcv-api/index.ts";
import type { BcvHistoryRate } from "../adapters/bcv-history/index.ts";
import { bcvHistory } from "../adapters/bcv-history/index.ts";
import type { InpcMonth } from "../adapters/bcv-inpc/index.ts";
import { bcvInpc } from "../adapters/bcv-inpc/index.ts";
import type { BcvRate } from "../adapters/bcv-official/index.ts";
import { bcvOfficial } from "../adapters/bcv-official/index.ts";
import { BINANCE_LABEL, binanceP2p } from "../adapters/binance-p2p/index.ts";
import type { P2pSample, P2pSide } from "../adapters/binance-p2p/median.ts";
import { BYBIT_LABEL, bybitP2p } from "../adapters/bybit-p2p/index.ts";
import type { YadioRate } from "../adapters/yadio/index.ts";
import { YADIO_LABEL, yadio } from "../adapters/yadio/index.ts";
import type { Store } from "../core/store.ts";
import { CARACAS_OFFSET_MS, caracasDay } from "../formats/time.ts";
import type { Panel } from "../server/panels.ts";

/**
 * "¿A cuánto está el dólar hoy?" Every figure is attributed to its source with its own time. The official
 * rate comes only from the BCV; each third-party quote is shown by name with its gap to the official rate,
 * computed here. Quotes are never averaged into one number and there is no "Vigía rate".
 *
 * The official rate has two routes to the same figure: Vigía's own read of bcv.org.ve (`bcv-official`, plus the
 * BCV's history file) and bcv-api (`bcv-api`), a service that reads the same page. Per Fecha Valor:
 * - both routes have it with the same value (to the BCV's 8 published decimals): shown once, "confirmado por 2 vías";
 * - only bcv-api has it (bcv.org.ve failing, or not polled since the publish): bcv-api's value, labelled with its
 *   route and aged by bcv-api's own read of the BCV (`scraped_at`), never by Vigía's later fetch;
 * - the routes disagree: the direct value, with a discrepancy carrying both values and both times. Never averaged.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const OFFICIAL_LABEL = "BCV, tipo de cambio de referencia (venta)";
export const INPC_DERIVED_LABEL = "calculado por Vigía a partir del INPC del BCV";
export const GAP_LABEL = "brecha calculada por Vigía: (cotización ÷ oficial − 1) × 100";

// ---------------------------------------------------------------------------------------------------------
// View model

export type Change = {
	/** Value now minus value then, in Bs. */
	abs: number;
	pct: number;
	/** The earlier figure compared against. */
	fromValue: number;
	fromObservedAt: number;
};

export type OfficialFigure = {
	vesPerUnit: number;
	/** Fecha Valor, "YYYY-MM-DD" (Caracas). */
	valueDate: string;
	/** 00:00 Caracas of the Fecha Valor: "vigente desde". */
	validFrom: number;
	/** When Vigía first saw this rate (an upper bound on its publication time). */
	fetchedAt: number;
	feed: string;
	sourceUrl: string;
	/** Present when the figure was converted from an older bolívar (history before 2021-10-01). */
	conversion: string | null;
	/** Feeds that returned this same value for this Fecha Valor: two entries mean "confirmado por 2 vías". */
	confirmedBy: string[];
	/**
	 * Only for a figure that reached Vigía through bcv-api: the route's label and its last read of the BCV that
	 * showed this Fecha Valor (`scraped_at`), which is what the figure's age is measured from.
	 */
	route: { label: string; readAt: number } | null;
};

/** The two routes returned different values for one Fecha Valor: the direct one is shown, both are listed. */
export type RouteDiscrepancy = {
	currency: "USD" | "EUR";
	valueDate: string;
	direct: { feed: string; vesPerUnit: number; fetchedAt: number; sourceUrl: string };
	mirror: { feed: string; vesPerUnit: number; fetchedAt: number; changedAt: number; sourceUrl: string };
};

export type OfficialRate = {
	currency: "USD" | "EUR";
	label: string;
	/** The rate in force now: the latest Fecha Valor that is ≤ now. */
	current: OfficialFigure | null;
	/** Already published, in force from a later day ("próxima"). */
	next: OfficialFigure | null;
	/** Rate in force now vs the rate in force 24 h / 7 days ago. */
	change24h: Change | null;
	change7d: Change | null;
	/** The newest Fecha Valor is older than the feed's budget (the BCV has not published). */
	stale: boolean;
	/**
	 * True on a weekday (Caracas) when the rate in force is from an earlier day: today is a bank holiday, or
	 * Vigía never saw today's rate (e.g. it started after the BCV page had moved on to the next day's rate;
	 * the history file fills the gap within ~2 business days). The UI should say "puede haber una tasa más
	 * reciente" next to "vigente desde".
	 */
	possiblyMissed: boolean;
	/** Disagreements between the two routes for the figures shown (current and next). */
	discrepancies: RouteDiscrepancy[];
};

export type Gap = {
	/** (quote ÷ official in force now − 1) × 100. */
	pct: number;
	officialVesPerUsd: number;
	officialValueDate: string;
	/** quote time − start of the official rate's Fecha Valor: how far apart the two figures are in time. */
	skewMs: number;
};

export type QuoteFigure = {
	vesPerUsd: number;
	observedAt: number;
	fetchedAt: number;
	ageMs: number;
	gap: Gap | null;
	change24h: Change | null;
	change7d: Change | null;
};

export type YadioQuote = {
	id: "yadio";
	label: string;
	feed: string;
	sourceUrl: string;
	attribution: string;
	figure: QuoteFigure | null;
	stale: boolean;
};

export type P2pSideView = {
	status: "ok" | "insufficient";
	/** Median Bs per USDT (null when "sin datos suficientes"). */
	medianVesPerUsdt: number | null;
	n: number;
	considered: number;
	gap: Gap | null;
};

export type P2pQuote = {
	id: string;
	label: string;
	feed: string;
	sourceUrl: string;
	attribution: string;
	asset: "USDT";
	observedAt: number;
	fetchedAt: number;
	ageMs: number;
	ticketVes: number;
	/** What it costs to buy USDT (advertisers selling). */
	buy: P2pSideView;
	/** What you get for selling USDT (advertisers buying). */
	sell: P2pSideView;
	/** Distance between the two medians, % of their midpoint. */
	spreadPct: number | null;
	stale: boolean;
};

export type DayPoint = { date: string; vesPerUsd: number; observedAt: number; feed: string };

export type InflationPoint = {
	period: string;
	index: number;
	monthlyPct: number | null;
	/** Computed by Vigía from index levels; null without the month a year earlier. */
	yearOnYearPct: number | null;
	provisional: boolean;
};

export type Inflation = {
	/** The month the latest figure refers to, "YYYY-MM". */
	latest: {
		period: string;
		index: number;
		/** As published by the BCV. */
		monthlyPct: number | null;
		provisional: boolean;
		observedAt: number;
		fetchedAt: number;
	} | null;
	/** 12-month change, computed from the index levels. */
	yearOnYearPct: number | null;
	/** Change since the previous December, computed from the index levels (the BCV's "Var Acumulada"). */
	yearToDatePct: number | null;
	derivedLabel: string;
	/** Last 24 months, oldest first. */
	series24m: InflationPoint[];
	feed: string;
	sourceUrl: string;
	attribution: string;
	stale: boolean;
};

export type MoneyView = {
	now: number;
	official: { usd: OfficialRate; eur: OfficialRate; attribution: string; licenceUrl: string };
	yadio: YadioQuote;
	/** Only venues with a sample in the last 24 h (they are opt-in). */
	p2p: P2pQuote[];
	gapLabel: string;
	series90d: { official: DayPoint[]; yadio: DayPoint[] };
	inflation: Inflation;
};

// ---------------------------------------------------------------------------------------------------------
// Store access

type Row<V> = {
	id: number;
	observedAt: number;
	fetchedAt: number;
	sourceUrl: string;
	value: V;
	source: string;
};

interface RawRow {
	id: number;
	source: string;
	observed_at: number;
	fetched_at: number;
	source_url: string;
	value: string;
}

function toRow<V>(r: RawRow): Row<V> {
	return {
		id: r.id,
		source: r.source,
		observedAt: r.observed_at,
		fetchedAt: r.fetched_at,
		sourceUrl: r.source_url,
		value: JSON.parse(r.value) as V,
	};
}

/**
 * The latest revision of each distinct observed time of a series in [from, to], oldest first. For daily
 * sources the first fetch of a value is kept as `fetchedAt` (the store ignores identical re-fetches).
 */
function perObservedAt<V>(store: Store, source: string, series: string, from: number, to: number): Row<V>[] {
	return store.db
		.query<RawRow, [string, string, number, number]>(
			`SELECT id, source, observed_at, fetched_at, source_url, value FROM (
				SELECT *, ROW_NUMBER() OVER (PARTITION BY observed_at ORDER BY id DESC) AS rn
				FROM obs WHERE source = ? AND series = ? AND observed_at BETWEEN ? AND ?
			) WHERE rn = 1 ORDER BY observed_at ASC`,
		)
		.all(source, series, from, to)
		.map((r) => toRow<V>(r));
}

/** The last observation of each Caracas calendar day in [from, to], oldest first. */
function lastPerCaracasDay<V>(
	store: Store,
	source: string,
	series: string,
	from: number,
	to: number,
): Row<V>[] {
	return store.db
		.query<RawRow, [number, number, string, string, number, number]>(
			`SELECT id, source, observed_at, fetched_at, source_url, value FROM (
				SELECT *, ROW_NUMBER() OVER (
					PARTITION BY CAST((observed_at + ?) / ? AS INTEGER) ORDER BY observed_at DESC, id DESC
				) AS rn
				FROM obs WHERE source = ? AND series = ? AND observed_at BETWEEN ? AND ?
			) WHERE rn = 1 ORDER BY observed_at ASC`,
		)
		.all(CARACAS_OFFSET_MS, DAY, source, series, from, to)
		.map((r) => toRow<V>(r));
}

/** Newest observation at or before `at`, looking back at most `windowMs`. */
function latestAtOrBefore<V>(
	store: Store,
	source: string,
	series: string,
	at: number,
	windowMs: number,
): Row<V> | null {
	const row = store.db
		.query<RawRow, [string, string, number, number]>(
			`SELECT id, source, observed_at, fetched_at, source_url, value FROM obs
			 WHERE source = ? AND series = ? AND observed_at BETWEEN ? AND ?
			 ORDER BY observed_at DESC, id DESC LIMIT 1`,
		)
		.get(source, series, at - windowMs, at);
	return row ? toRow<V>(row) : null;
}

// ---------------------------------------------------------------------------------------------------------
// Pure computations (exported for tests)

export function change(now: number, then: number, thenAt: number): Change {
	return { abs: now - then, pct: (now / then - 1) * 100, fromValue: then, fromObservedAt: thenAt };
}

export function gapPct(quote: number, official: number): number {
	return (quote / official - 1) * 100;
}

export function yearOnYear(index: number, indexYearBefore: number): number {
	return (index / indexYearBefore - 1) * 100;
}

/** "2026-08" → "2025-08". */
export function periodMinusMonths(period: string, months: number): string {
	const [y, m] = period.split("-").map(Number) as [number, number];
	const total = y * 12 + (m - 1) - months;
	return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------------------------------------
// Official rate

type OfficialRow = Row<{ vesPerUnit: number; valueDate: string; conversion: string | null }>;

type MergedOfficial = OfficialRow & { confirmedBy: string[]; route: OfficialFigure["route"] };

/** Same figure to the BCV's published precision (8 decimals): the routes carry the same number, or they do not. */
export function samePublished(a: number, b: number): boolean {
	return Math.round(a * 1e8) === Math.round(b * 1e8);
}

/** Per Fecha Valor, bcv-api's last read of the BCV (its `scraped_at`) that showed it, at or before `now`. */
function mirrorReads(store: Store, now: number): Map<string, number> {
	const last = new Map<string, number>();
	for (const r of perObservedAt<BcvApiRead>(store, bcvApi.id, READ_SERIES, now - 10 * DAY, now)) {
		last.set(r.value.valueDate, r.observedAt);
	}
	return last;
}

/**
 * Official observations of every route, one per Fecha Valor. The direct route wins: the home page over the
 * history file over bcv-api. bcv-api fills a Fecha Valor the direct route does not have, and is compared with
 * the home page where both have one.
 */
function officialRows(
	store: Store,
	currency: "USD" | "EUR",
	from: number,
	to: number,
	now: number,
): { rows: MergedOfficial[]; discrepancies: RouteDiscrepancy[] } {
	const series = currency === "USD" ? "usd-ves" : "eur-ves";
	const byDate = new Map<string, MergedOfficial>();
	const mirror = new Map<string, Row<BcvApiRate>>();
	const reads = mirrorReads(store, now);
	for (const r of perObservedAt<BcvApiRate>(store, bcvApi.id, series, from, to))
		mirror.set(r.value.valueDate, r);
	for (const [date, r] of mirror) {
		byDate.set(date, {
			...r,
			value: { vesPerUnit: r.value.vesPerUnit, valueDate: date, conversion: null },
			confirmedBy: [r.source],
			// Aged by bcv-api's own read of the BCV; before any read is stored, by when it saw the value change.
			route: { label: BCV_API_PROVIDER, readAt: reads.get(date) ?? r.value.changedAt },
		});
	}
	if (currency === "USD") {
		for (const r of perObservedAt<BcvHistoryRate>(store, "bcv-history", series, from, to)) {
			byDate.set(r.value.valueDate, {
				...r,
				value: {
					vesPerUnit: r.value.vesPerUsd,
					valueDate: r.value.valueDate,
					conversion: r.value.conversion,
				},
				confirmedBy: [r.source],
				route: null,
			});
		}
	}
	const discrepancies: RouteDiscrepancy[] = [];
	for (const r of perObservedAt<BcvRate>(store, "bcv-official", series, from, to)) {
		const date = r.value.valueDate;
		const twin = mirror.get(date);
		const agrees = twin !== undefined && samePublished(twin.value.vesPerUnit, r.value.vesPerUnit);
		if (twin && !agrees) {
			discrepancies.push({
				currency,
				valueDate: date,
				direct: {
					feed: r.source,
					vesPerUnit: r.value.vesPerUnit,
					fetchedAt: r.fetchedAt,
					sourceUrl: r.sourceUrl,
				},
				mirror: {
					feed: twin.source,
					vesPerUnit: twin.value.vesPerUnit,
					fetchedAt: twin.fetchedAt,
					changedAt: twin.value.changedAt,
					sourceUrl: twin.sourceUrl,
				},
			});
		}
		byDate.set(date, {
			...r,
			value: { vesPerUnit: r.value.vesPerUnit, valueDate: date, conversion: null },
			confirmedBy: agrees ? [r.source, twin.source] : [r.source],
			route: null,
		});
	}
	return { rows: [...byDate.values()].sort((a, b) => a.observedAt - b.observedAt), discrepancies };
}

function officialFigure(r: MergedOfficial): OfficialFigure {
	return {
		vesPerUnit: r.value.vesPerUnit,
		valueDate: r.value.valueDate,
		validFrom: r.observedAt,
		fetchedAt: r.fetchedAt,
		feed: r.source,
		sourceUrl: r.sourceUrl,
		conversion: r.value.conversion,
		confirmedBy: r.confirmedBy,
		route: r.route,
	};
}

function inForceAt<R extends OfficialRow>(rows: readonly R[], at: number): R | null {
	let found: R | null = null;
	for (const r of rows) if (r.observedAt <= at) found = r;
	return found;
}

export function officialRate(store: Store, currency: "USD" | "EUR", now: number): OfficialRate {
	// 30 days back covers the 7-day comparison even across a long BCV silence; 10 days ahead covers
	// any published future Fecha Valor.
	const { rows, discrepancies } = officialRows(store, currency, now - 30 * DAY, now + 10 * DAY, now);
	const current = inForceAt(rows, now);
	const next = rows.find((r) => r.observedAt > now) ?? null;
	const compare = (ago: number): Change | null => {
		const then = inForceAt(rows, now - ago);
		return current && then ? change(current.value.vesPerUnit, then.value.vesPerUnit, then.observedAt) : null;
	};
	const newest = rows.at(-1);
	const budget = bcvOfficial.freshness.dataMs ?? 4 * DAY;
	const shown = new Set([current?.value.valueDate, next?.value.valueDate]);
	return {
		currency,
		label: OFFICIAL_LABEL,
		current: current ? officialFigure(current) : null,
		next: next ? officialFigure(next) : null,
		change24h: compare(DAY),
		change7d: compare(7 * DAY),
		stale: !newest || now - newest.observedAt > budget,
		possiblyMissed: current !== null && current.value.valueDate < caracasDay(now) && isCaracasWeekday(now),
		discrepancies: discrepancies.filter((d) => shown.has(d.valueDate)),
	};
}

export function isCaracasWeekday(ms: number): boolean {
	const day = new Date(ms + CARACAS_OFFSET_MS).getUTCDay();
	return day >= 1 && day <= 5;
}

function gapTo(official: OfficialRate, quote: number, quoteAt: number): Gap | null {
	const o = official.current;
	if (!o) return null;
	return {
		pct: gapPct(quote, o.vesPerUnit),
		officialVesPerUsd: o.vesPerUnit,
		officialValueDate: o.valueDate,
		skewMs: quoteAt - o.validFrom,
	};
}

// ---------------------------------------------------------------------------------------------------------
// Quotes

/** Compares with the newest figure at least `ago` older, if one exists within 3 h of that point. */
function quoteChange(store: Store, source: string, series: string, latest: Row<YadioRate>, ago: number) {
	const then = latestAtOrBefore<YadioRate>(store, source, series, latest.observedAt - ago, 3 * HOUR);
	return then ? change(latest.value.vesPerUsd, then.value.vesPerUsd, then.observedAt) : null;
}

function yadioQuote(store: Store, official: OfficialRate, now: number): YadioQuote {
	const latest = latestAtOrBefore<YadioRate>(store, "yadio", "usd-ves", now, 30 * DAY);
	const budget = yadio.freshness.dataMs ?? 30 * 60_000;
	return {
		id: "yadio",
		label: YADIO_LABEL,
		feed: "yadio",
		sourceUrl: yadio.homepage,
		attribution: yadio.licence.attribution,
		figure: latest
			? {
					vesPerUsd: latest.value.vesPerUsd,
					observedAt: latest.observedAt,
					fetchedAt: latest.fetchedAt,
					ageMs: now - latest.observedAt,
					gap: gapTo(official, latest.value.vesPerUsd, latest.observedAt),
					change24h: quoteChange(store, "yadio", "usd-ves", latest, DAY),
					change7d: quoteChange(store, "yadio", "usd-ves", latest, 7 * DAY),
				}
			: null,
		stale: !latest || now - latest.observedAt > budget,
	};
}

function sideView(side: P2pSide, official: OfficialRate, at: number): P2pSideView {
	return {
		status: side.status,
		medianVesPerUsdt: side.medianVesPerUsdt,
		n: side.n,
		considered: side.considered,
		gap: side.medianVesPerUsdt === null ? null : gapTo(official, side.medianVesPerUsdt, at),
	};
}

function p2pQuotes(store: Store, official: OfficialRate, now: number): P2pQuote[] {
	const venues = [
		{ adapter: binanceP2p, label: BINANCE_LABEL },
		{ adapter: bybitP2p, label: BYBIT_LABEL },
	];
	const out: P2pQuote[] = [];
	for (const { adapter, label } of venues) {
		const latest = latestAtOrBefore<P2pSample>(store, adapter.id, "usdt-ves", now, DAY);
		if (!latest) continue;
		const v = latest.value;
		out.push({
			id: adapter.id,
			label,
			feed: adapter.id,
			sourceUrl: adapter.homepage,
			attribution: adapter.licence.attribution,
			asset: "USDT",
			observedAt: latest.observedAt,
			fetchedAt: latest.fetchedAt,
			ageMs: now - latest.observedAt,
			ticketVes: v.ticketVes,
			buy: sideView(v.takerBuy, official, latest.observedAt),
			sell: sideView(v.takerSell, official, latest.observedAt),
			spreadPct: v.spreadPct,
			stale: now - latest.observedAt > (adapter.freshness.dataMs ?? 40 * 60_000),
		});
	}
	return out;
}

// ---------------------------------------------------------------------------------------------------------
// Series and inflation

function officialSeries(store: Store, now: number): DayPoint[] {
	return officialRows(store, "USD", now - 90 * DAY, now, now).rows.map((r) => ({
		date: r.value.valueDate,
		vesPerUsd: r.value.vesPerUnit,
		observedAt: r.observedAt,
		feed: r.source,
	}));
}

function yadioSeries(store: Store, now: number): DayPoint[] {
	return lastPerCaracasDay<YadioRate>(store, "yadio", "usd-ves", now - 90 * DAY, now).map((r) => ({
		date: caracasDay(r.observedAt),
		vesPerUsd: r.value.vesPerUsd,
		observedAt: r.observedAt,
		feed: "yadio",
	}));
}

export function inflation(store: Store, now: number): Inflation {
	// 40 months: 24 to show plus 12 before them for year-on-year, plus slack for gaps.
	const rows = perObservedAt<InpcMonth>(store, "bcv-inpc", "inpc", now - 40 * 31 * DAY, now);
	const byPeriod = new Map(rows.map((r) => [r.value.period, r]));
	const yoy = (period: string, index: number): number | null => {
		const before = byPeriod.get(periodMinusMonths(period, 12));
		return before ? yearOnYear(index, before.value.index) : null;
	};
	const latest = rows.at(-1) ?? null;
	const december = latest ? byPeriod.get(`${Number(latest.value.period.slice(0, 4)) - 1}-12`) : undefined;
	const budget = bcvInpc.freshness.dataMs ?? 70 * DAY;
	return {
		latest: latest
			? {
					period: latest.value.period,
					index: latest.value.index,
					monthlyPct: latest.value.monthlyPct,
					provisional: latest.value.provisional,
					observedAt: latest.observedAt,
					fetchedAt: latest.fetchedAt,
				}
			: null,
		yearOnYearPct: latest ? yoy(latest.value.period, latest.value.index) : null,
		yearToDatePct: latest && december ? yearOnYear(latest.value.index, december.value.index) : null,
		derivedLabel: INPC_DERIVED_LABEL,
		series24m: rows.slice(-24).map((r) => ({
			period: r.value.period,
			index: r.value.index,
			monthlyPct: r.value.monthlyPct,
			yearOnYearPct: yoy(r.value.period, r.value.index),
			provisional: r.value.provisional,
		})),
		feed: "bcv-inpc",
		sourceUrl: bcvInpc.homepage,
		attribution: bcvInpc.licence.attribution,
		stale: !latest || now - latest.observedAt > budget,
	};
}

// ---------------------------------------------------------------------------------------------------------

export function moneyView(store: Store, now: number): MoneyView {
	const usd = officialRate(store, "USD", now);
	const eur = officialRate(store, "EUR", now);
	return {
		now,
		official: { usd, eur, attribution: bcvOfficial.licence.attribution, licenceUrl: bcvOfficial.licence.url },
		yadio: yadioQuote(store, usd, now),
		p2p: p2pQuotes(store, usd, now),
		gapLabel: GAP_LABEL,
		series90d: { official: officialSeries(store, now), yadio: yadioSeries(store, now) },
		inflation: inflation(store, now),
	};
}

export const moneyPanel: Panel<MoneyView> = {
	id: "money",
	sources: ["bcv-official", bcvApi.id, bcvHistory.id, "yadio", "binance-p2p", "bybit-p2p", "bcv-inpc"],
	compute: (store: Store, now: number) => moneyView(store, now),
};
