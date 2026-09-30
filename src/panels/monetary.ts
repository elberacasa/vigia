import type { BcvHistoryRate } from "../adapters/bcv-history/index.ts";
import { bcvHistory } from "../adapters/bcv-history/index.ts";
import type { Intervention } from "../adapters/bcv-intervention/index.ts";
import { bcvIntervention } from "../adapters/bcv-intervention/index.ts";
import type { LiquidityWeek } from "../adapters/bcv-liquidity/index.ts";
import { bcvLiquidity } from "../adapters/bcv-liquidity/index.ts";
import type { BcvRate } from "../adapters/bcv-official/index.ts";
import { bcvOfficial } from "../adapters/bcv-official/index.ts";
import type { ReservesDay } from "../adapters/bcv-reserves/index.ts";
import { bcvReserves } from "../adapters/bcv-reserves/index.ts";
import type { Store } from "../core/store.ts";
import type { Json } from "../core/types.ts";
import { caracasDateToMs, startOfCaracasDay } from "../formats/time.ts";
import type { Panel } from "../server/panels.ts";
import { type Change, change } from "./money.ts";

/**
 * "¿Cuánto dinero hay y cuántas reservas?" The BCV's weekly money supply, its daily international reserves and its
 * foreign-exchange interventions, each as the BCV publishes it, with every change computed here from the published
 * levels (week on week, four weeks, year on year, year to date; day, week, 30 days, year for the reserves). One
 * derived figure: the money supply in US dollars at the official rate of the same day, labelled as computed by
 * Vigía. The BCV publishes when it intervened and at what rate, never how much: the panel says so.
 */

const DAY = 86_400_000;

export const DERIVED_LABEL = "calculado por Vigía a partir de las cifras publicadas por el BCV";
export const USD_LABEL = "calculado por Vigía: liquidez ÷ tipo de cambio oficial (venta) vigente ese día";
export const INTERVENTION_NOTE =
	"El BCV publica la fecha, el número y el tipo de cambio de cada intervención cambiaria; no publica el monto.";

// ---------------------------------------------------------------------------------------------------------
// View model

export type LiquidityPoint = {
	weekEnding: string;
	m2Ves: number;
	weekPct: number | null;
	provisional: boolean;
};

export type LiquidityView = {
	latest: {
		weekEnding: string;
		m2Ves: number;
		m1Ves: number;
		currencyVes: number;
		demandDepositsVes: number;
		savingsDepositsVes: number;
		quasiMoneyVes: number;
		provisional: boolean;
		rectified: boolean;
		observedAt: number;
		fetchedAt: number;
	} | null;
	/** vs the week before; 4 weeks; the week 52 weeks earlier (±3 days); the last week of the previous year. */
	changeWeek: Change | null;
	change4w: Change | null;
	changeYear: Change | null;
	changeYtd: Change | null;
	/** M2 in US dollars at the official rate in force that Friday (derived, labelled). */
	usd: { m2Usd: number; vesPerUsd: number; rateValueDate: string; feed: string } | null;
	/** The last 104 weeks, oldest first, with the week-on-week % computed here. */
	series: LiquidityPoint[];
	stale: boolean;
	feed: string;
	sourceUrl: string;
	attribution: string;
};

export type ReservesPoint = { date: string; totalMusd: number; provisional: boolean };

export type ReservesView = {
	latest: {
		date: string;
		totalMusd: number;
		bcvMusd: number;
		femMusd: number;
		provisional: boolean;
		observedAt: number;
		fetchedAt: number;
	} | null;
	/** vs the business day before; the last day ≤ 7, 30 and 365 days earlier; the last day of the previous year. */
	changeDay: Change | null;
	change7d: Change | null;
	change30d: Change | null;
	changeYear: Change | null;
	changeYtd: Change | null;
	/** The last 365 days, oldest first. */
	series: ReservesPoint[];
	stale: boolean;
	feed: string;
	sourceUrl: string;
	attribution: string;
};

export type InterventionView = {
	latest: { date: string; number: string; vesPerEur: number; observedAt: number; fetchedAt: number } | null;
	/** Days with an intervention in the last 7 and 30 Caracas calendar days (today included), and this year. */
	days7: number;
	days30: number;
	daysYear: number;
	/** Distinct intervention numbers in the last 365 days (the BCV numbers one per week). */
	numbers365: number;
	/** The 20 newest, newest first. */
	recent: { date: string; number: string; vesPerEur: number; conversion: string | null }[];
	note: string;
	stale: boolean;
	feed: string;
	sourceUrl: string;
	attribution: string;
};

export type MonetaryView = {
	now: number;
	derivedLabel: string;
	usdLabel: string;
	liquidity: LiquidityView;
	reserves: ReservesView;
	intervention: InterventionView;
};

// ---------------------------------------------------------------------------------------------------------
// Pure computations (exported for tests)

type Dated<V> = { observedAt: number; fetchedAt: number; value: V };

/** One row per observed time (the newest stored revision wins), oldest first. */
export function latestRevisions<V>(rows: readonly (Dated<V> & { id?: number })[]): Dated<V>[] {
	const by = new Map<number, Dated<V>>();
	for (const r of rows) by.set(r.observedAt, r);
	return [...by.values()].sort((a, b) => a.observedAt - b.observedAt);
}

/** The newest row observed at or before `at`, not older than `at − windowMs`. Rows are oldest first. */
export function atOrBefore<V>(rows: readonly Dated<V>[], at: number, windowMs: number): Dated<V> | null {
	for (let i = rows.length - 1; i >= 0; i--) {
		const r = rows[i];
		if (!r || r.observedAt > at) continue;
		return at - r.observedAt <= windowMs ? r : null;
	}
	return null;
}

/** The row nearest to `at` within ±`toleranceMs` (ties go to the earlier row). Rows are oldest first. */
export function nearest<V>(rows: readonly Dated<V>[], at: number, toleranceMs: number): Dated<V> | null {
	let best: Dated<V> | null = null;
	for (const r of rows) {
		const d = Math.abs(r.observedAt - at);
		if (d <= toleranceMs && (best === null || d < Math.abs(best.observedAt - at))) best = r;
	}
	return best;
}

function changeOf<V>(latest: Dated<V>, then: Dated<V> | null, pick: (v: V) => number): Change | null {
	return then ? change(pick(latest.value), pick(then.value), then.observedAt) : null;
}

/** 00:00 Caracas of 1 January of the Caracas year containing `ms`. */
export function startOfCaracasYear(ms: number): number {
	const year = new Date(ms - 4 * 3_600_000).getUTCFullYear();
	return caracasDateToMs(`${year}-01-01`) ?? ms;
}

export function liquidityView(
	weeks: readonly Dated<LiquidityWeek>[],
	officialUsd: readonly Dated<{ vesPerUnit: number; valueDate: string; feed: string }>[],
	now: number,
): Omit<LiquidityView, "feed" | "sourceUrl" | "attribution"> {
	const rows = weeks.filter((w) => w.observedAt <= now);
	const latest = rows.at(-1) ?? null;
	const budget = bcvLiquidity.freshness.dataMs ?? 21 * DAY;
	const first = Math.max(0, rows.length - 104);
	const series: LiquidityPoint[] = rows.slice(first).map((w, k) => {
		const prev = rows[first + k - 1];
		// Only a week exactly 7 days before counts as "the week before" (a gap in the file is not a weekly change).
		const weekPct =
			prev && w.observedAt - prev.observedAt === 7 * DAY
				? (w.value.m2Ves / prev.value.m2Ves - 1) * 100
				: null;
		return {
			weekEnding: w.value.weekEnding,
			m2Ves: w.value.m2Ves,
			weekPct,
			provisional: w.value.provisional,
		};
	});
	if (!latest) {
		return {
			latest: null,
			changeWeek: null,
			change4w: null,
			changeYear: null,
			changeYtd: null,
			usd: null,
			series,
			stale: true,
		};
	}
	const m2 = (v: LiquidityWeek) => v.m2Ves;
	const exact = (ms: number) => rows.find((r) => r.observedAt === ms) ?? null;
	const lastOfPreviousYear = atOrBefore(rows, startOfCaracasYear(latest.observedAt) - 1, 10 * DAY);
	const rate = atOrBefore(officialUsd, latest.observedAt, 7 * DAY);
	return {
		latest: {
			weekEnding: latest.value.weekEnding,
			m2Ves: latest.value.m2Ves,
			m1Ves: latest.value.m1Ves,
			currencyVes: latest.value.currencyVes,
			demandDepositsVes: latest.value.demandDepositsVes,
			savingsDepositsVes: latest.value.savingsDepositsVes,
			quasiMoneyVes: latest.value.quasiMoneyVes,
			provisional: latest.value.provisional,
			rectified: latest.value.rectified,
			observedAt: latest.observedAt,
			fetchedAt: latest.fetchedAt,
		},
		changeWeek: changeOf(latest, exact(latest.observedAt - 7 * DAY), m2),
		change4w: changeOf(latest, exact(latest.observedAt - 28 * DAY), m2),
		changeYear: changeOf(latest, nearest(rows, latest.observedAt - 364 * DAY, 3 * DAY), m2),
		changeYtd: changeOf(latest, lastOfPreviousYear, m2),
		usd: rate
			? {
					m2Usd: latest.value.m2Ves / rate.value.vesPerUnit,
					vesPerUsd: rate.value.vesPerUnit,
					rateValueDate: rate.value.valueDate,
					feed: rate.value.feed,
				}
			: null,
		series,
		stale: now - latest.observedAt > budget,
	};
}

export function reservesView(
	days: readonly Dated<ReservesDay>[],
	now: number,
): Omit<ReservesView, "feed" | "sourceUrl" | "attribution"> {
	const rows = days.filter((d) => d.observedAt <= now);
	const latest = rows.at(-1) ?? null;
	const budget = bcvReserves.freshness.dataMs ?? 8 * DAY;
	const series = rows
		.filter((d) => latest && d.observedAt > latest.observedAt - 365 * DAY)
		.map((d) => ({ date: d.value.date, totalMusd: d.value.totalMusd, provisional: d.value.provisional }));
	if (!latest) {
		return {
			latest: null,
			changeDay: null,
			change7d: null,
			change30d: null,
			changeYear: null,
			changeYtd: null,
			series,
			stale: true,
		};
	}
	const total = (v: ReservesDay) => v.totalMusd;
	const back = (days: number, window: number) =>
		atOrBefore(rows, latest.observedAt - days * DAY, window * DAY);
	return {
		latest: {
			date: latest.value.date,
			totalMusd: latest.value.totalMusd,
			bcvMusd: latest.value.bcvMusd,
			femMusd: latest.value.femMusd,
			provisional: latest.value.provisional,
			observedAt: latest.observedAt,
			fetchedAt: latest.fetchedAt,
		},
		// The business day before: at most 7 calendar days back (a holiday week).
		changeDay: changeOf(latest, back(1, 6), total),
		change7d: changeOf(latest, back(7, 7), total),
		change30d: changeOf(latest, back(30, 7), total),
		changeYear: changeOf(latest, back(365, 7), total),
		changeYtd: changeOf(latest, atOrBefore(rows, startOfCaracasYear(latest.observedAt) - 1, 10 * DAY), total),
		series,
		stale: now - latest.observedAt > budget,
	};
}

export function interventionView(
	rows: readonly Dated<Intervention>[],
	now: number,
): Omit<InterventionView, "feed" | "sourceUrl" | "attribution" | "note"> {
	const past = rows.filter((r) => r.observedAt <= now);
	const latest = past.at(-1) ?? null;
	const budget = bcvIntervention.freshness.dataMs ?? 14 * DAY;
	// Calendar days in Caracas: "the last 7 days" are today and the 6 before it.
	const today = startOfCaracasDay(now);
	const since = (days: number) => past.filter((r) => r.observedAt >= today - (days - 1) * DAY).length;
	const yearStart = startOfCaracasYear(now);
	return {
		latest: latest
			? {
					date: latest.value.date,
					number: latest.value.number,
					vesPerEur: latest.value.vesPerEur,
					observedAt: latest.observedAt,
					fetchedAt: latest.fetchedAt,
				}
			: null,
		days7: since(7),
		days30: since(30),
		daysYear: past.filter((r) => r.observedAt >= yearStart).length,
		numbers365: new Set(past.filter((r) => r.observedAt > now - 365 * DAY).map((r) => r.value.number)).size,
		recent: past
			.slice(-20)
			.reverse()
			.map((r) => ({
				date: r.value.date,
				number: r.value.number,
				vesPerEur: r.value.vesPerEur,
				conversion: r.value.conversion,
			})),
		stale: !latest || now - latest.observedAt > budget,
	};
}

// ---------------------------------------------------------------------------------------------------------
// Store access

function stored<V extends Json>(
	store: Store,
	source: string,
	series: string,
	from: number,
	to: number,
): Dated<V>[] {
	return latestRevisions(store.history<V>(source, series, from, to, 20_000));
}

/** The official USD rate per Fecha Valor: the home page's reading where there is one, else the history file's. */
function officialUsd(
	store: Store,
	from: number,
	to: number,
): Dated<{ vesPerUnit: number; valueDate: string; feed: string }>[] {
	const by = new Map<number, Dated<{ vesPerUnit: number; valueDate: string; feed: string }>>();
	for (const r of stored<BcvHistoryRate>(store, bcvHistory.id, "usd-ves", from, to)) {
		by.set(r.observedAt, {
			...r,
			value: { vesPerUnit: r.value.vesPerUsd, valueDate: r.value.valueDate, feed: bcvHistory.id },
		});
	}
	for (const r of stored<BcvRate>(store, bcvOfficial.id, "usd-ves", from, to)) {
		by.set(r.observedAt, {
			...r,
			value: { vesPerUnit: r.value.vesPerUnit, valueDate: r.value.valueDate, feed: bcvOfficial.id },
		});
	}
	return [...by.values()].sort((a, b) => a.observedAt - b.observedAt);
}

export function monetaryView(store: Store, now: number): MonetaryView {
	const weeks = stored<LiquidityWeek>(store, bcvLiquidity.id, "m2", now - 3 * 365 * DAY, now);
	const days = stored<ReservesDay>(store, bcvReserves.id, "reserves", now - 2 * 366 * DAY, now);
	const interventions = stored<Intervention>(store, bcvIntervention.id, "intervention", now - 400 * DAY, now);
	const latestWeek = weeks.at(-1)?.observedAt ?? now;
	return {
		now,
		derivedLabel: DERIVED_LABEL,
		usdLabel: USD_LABEL,
		liquidity: {
			...liquidityView(weeks, officialUsd(store, latestWeek - 10 * DAY, latestWeek), now),
			feed: bcvLiquidity.id,
			sourceUrl: bcvLiquidity.homepage,
			attribution: bcvLiquidity.licence.attribution,
		},
		reserves: {
			...reservesView(days, now),
			feed: bcvReserves.id,
			sourceUrl: bcvReserves.homepage,
			attribution: bcvReserves.licence.attribution,
		},
		intervention: {
			...interventionView(interventions, now),
			note: INTERVENTION_NOTE,
			feed: bcvIntervention.id,
			sourceUrl: bcvIntervention.homepage,
			attribution: bcvIntervention.licence.attribution,
		},
	};
}

export const monetaryPanel: Panel<MonetaryView> = {
	id: "monetary",
	onDemand: true,
	sources: [bcvLiquidity.id, bcvReserves.id, bcvIntervention.id, bcvOfficial.id, bcvHistory.id],
	compute: (store: Store, now: number) => monetaryView(store, now),
};
