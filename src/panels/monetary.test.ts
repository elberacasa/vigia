import { expect, test } from "bun:test";
import { join } from "node:path";
import { bcvHistory } from "../adapters/bcv-history/index.ts";
import { bcvIntervention, type Intervention } from "../adapters/bcv-intervention/index.ts";
import { bcvLiquidity, type LiquidityWeek } from "../adapters/bcv-liquidity/index.ts";
import { bcvOfficial } from "../adapters/bcv-official/index.ts";
import { bcvReserves, type ReservesDay } from "../adapters/bcv-reserves/index.ts";
import { loadFixture } from "../core/fixtures.ts";
import { Store } from "../core/store.ts";
import type { Adapter } from "../core/types.ts";
import { caracasDateToMs } from "../formats/time.ts";
import {
	atOrBefore,
	interventionView,
	liquidityView,
	monetaryView,
	nearest,
	reservesView,
	startOfCaracasYear,
} from "./monetary.ts";

const DAY = 86_400_000;
const at = (date: string) => caracasDateToMs(date) ?? Number.NaN;

const recorded: readonly [Adapter, string][] = [
	[bcvLiquidity, "2026-09-28"],
	[bcvReserves, "2026-09-28"],
	[bcvIntervention, "2026-09-28"],
	[bcvHistory, "2026-09-24"],
	[bcvOfficial, "2026-09-24"],
];

test("end to end on the files recorded on 2026-09-28", () => {
	const store = new Store(":memory:");
	for (const [a, name] of recorded) {
		store.insert(a.normalise(loadFixture(join(import.meta.dir, "..", "adapters", a.id, "fixtures", name))));
	}
	const started = performance.now();
	const v = monetaryView(store, Date.parse("2026-09-29T02:00:00Z"));
	expect(performance.now() - started).toBeLessThan(200);

	// Money supply: week to Fri 18 Sep 2026, provisional.
	expect(v.liquidity.latest).toMatchObject({
		weekEnding: "2026-09-18",
		m2Ves: 2_839_145_987_504.81,
		provisional: true,
	});
	expect(v.liquidity.changeWeek?.pct).toBeCloseTo(3.3496, 4);
	expect(v.liquidity.changeWeek?.fromValue).toBe(2_747_128_521_348.17);
	expect(v.liquidity.change4w?.pct).toBeCloseTo(9.7209, 4);
	// Year on year against Fri 19 Sep 2025; year to date against Fri 26 Dec 2025.
	expect(v.liquidity.changeYear?.fromObservedAt).toBe(at("2025-09-19"));
	expect(v.liquidity.changeYear?.pct).toBeCloseTo(506.878, 3);
	expect(v.liquidity.changeYtd?.fromObservedAt).toBe(at("2025-12-26"));
	expect(v.liquidity.changeYtd?.pct).toBeCloseTo(215.772, 3);
	// In dollars at the official rate of Fecha Valor 18 Sep (848,5458 in the history file).
	expect(v.liquidity.usd).toMatchObject({
		vesPerUsd: 848.5458,
		rateValueDate: "2026-09-18",
		feed: "bcv-history",
	});
	expect(v.liquidity.usd?.m2Usd).toBeCloseTo(2_839_145_987_504.81 / 848.5458, 3);
	expect(v.liquidity.series.length).toBe(104);
	expect(v.liquidity.stale).toBe(false);

	// Reserves: 25 Sep 2026, 12,727 MM US$.
	expect(v.reserves.latest).toMatchObject({
		date: "2026-09-25",
		totalMusd: 12727,
		bcvMusd: 12724,
		femMusd: 3,
	});
	expect(v.reserves.changeDay).toMatchObject({ abs: -38, fromValue: 12765 });
	expect(v.reserves.change7d).toMatchObject({
		abs: -611,
		fromValue: 13338,
		fromObservedAt: at("2026-09-18"),
	});
	expect(v.reserves.changeYear?.fromObservedAt).toBe(at("2025-09-25"));
	expect(v.reserves.changeYtd).toMatchObject({ fromValue: 13309, fromObservedAt: at("2025-12-30") });
	expect(v.reserves.series.at(-1)?.date).toBe("2026-09-25");

	// Intervention: Mon 28 Sep, N° 030-26; five days in the last week, as every week of September.
	expect(v.intervention.latest).toMatchObject({ date: "2026-09-28", number: "030-26", vesPerEur: 976.9 });
	expect(v.intervention.days7).toBe(5);
	expect(v.intervention.daysYear).toBe(103);
	expect(v.intervention.recent.length).toBe(20);
	expect(v.intervention.note).toContain("no publica el monto");
	expect(v.intervention.stale).toBe(false);
});

const week = (date: string, m2Ves: number, provisional = false) => ({
	observedAt: at(date),
	fetchedAt: at("2026-09-28"),
	value: {
		weekEnding: date,
		currencyVes: 0,
		demandDepositsVes: 0,
		savingsDepositsVes: 0,
		m1Ves: m2Ves,
		quasiMoneyVes: 0,
		m2Ves,
		publishedChangePct: null,
		provisional,
		rectified: false,
	} satisfies LiquidityWeek,
});

test("a missing week gives no weekly change rather than a two-week change", () => {
	const v = liquidityView([week("2026-09-04", 100), week("2026-09-18", 110)], [], at("2026-09-28"));
	expect(v.changeWeek).toBeNull();
	expect(v.series.map((p) => p.weekPct)).toEqual([null, null]);
	expect(v.usd).toBeNull();
	const w = liquidityView([week("2026-09-11", 100), week("2026-09-18", 110)], [], at("2026-09-28"));
	expect(w.changeWeek).toMatchObject({ abs: 10, fromValue: 100 });
	expect(w.changeWeek?.pct).toBeCloseTo(10, 10);
	expect(w.series.at(-1)?.weekPct).toBeCloseTo(10, 10);
});

test("liquidity goes stale 21 days after the newest week; empty is stale", () => {
	expect(liquidityView([week("2026-09-18", 1)], [], at("2026-10-09")).stale).toBe(false);
	expect(liquidityView([week("2026-09-18", 1)], [], at("2026-10-10")).stale).toBe(true);
	expect(liquidityView([], [], at("2026-10-10"))).toMatchObject({ latest: null, stale: true });
});

const day = (date: string, totalMusd: number) => ({
	observedAt: at(date),
	fetchedAt: at("2026-09-28"),
	value: { date, bcvMusd: totalMusd, femMusd: 0, totalMusd, provisional: false } satisfies ReservesDay,
});

test("reserves: a change needs a day inside its window", () => {
	const v = reservesView(
		[day("2026-08-01", 100), day("2026-09-24", 110), day("2026-09-25", 121)],
		at("2026-09-28"),
	);
	expect(v.changeDay).toMatchObject({ abs: 11, fromValue: 110 });
	// 7 days back from 25 Sep is 18 Sep; the nearest earlier day (1 Aug) is outside the 7-day window.
	expect(v.change7d).toBeNull();
	expect(v.change30d).toBeNull();
	expect(v.changeYear).toBeNull();
	expect(v.changeYtd).toBeNull();
});

test("interventions: counts by window and year, newest first", () => {
	const rows = ["2025-12-30", "2026-01-05", "2026-09-22", "2026-09-25", "2026-09-28"].map((date, i) => ({
		observedAt: at(date),
		fetchedAt: at("2026-09-28"),
		value: {
			date,
			number: `${String(i).padStart(3, "0")}-${date.slice(2, 4)}`,
			vesPerEur: 900 + i,
			publishedRate: 900 + i,
			publishedUnit: "Bs.",
			divisor: 1,
			conversion: null,
		} satisfies Intervention,
	}));
	const v = interventionView(rows, Date.parse("2026-09-28T20:00:00Z"));
	// Today (28th) and the 6 days before: 22, 25, 28.
	expect(v.days7).toBe(3);
	expect(interventionView(rows, Date.parse("2026-09-29T20:00:00Z")).days7).toBe(2);
	expect(v.daysYear).toBe(4);
	expect(v.numbers365).toBe(5);
	expect(v.recent.map((r) => r.date)).toEqual([
		"2026-09-28",
		"2026-09-25",
		"2026-09-22",
		"2026-01-05",
		"2025-12-30",
	]);
	expect(interventionView(rows, at("2026-10-13")).stale).toBe(true);
	expect(interventionView([], at("2026-10-13"))).toMatchObject({ latest: null, stale: true, days7: 0 });
});

test("lookups", () => {
	const rows = [1, 5, 9].map((d) => ({ observedAt: d * DAY, fetchedAt: 0, value: d }));
	expect(atOrBefore(rows, 6 * DAY, 2 * DAY)?.value).toBe(5);
	expect(atOrBefore(rows, 8 * DAY, 2 * DAY)).toBeNull();
	expect(atOrBefore(rows, 0, DAY)).toBeNull();
	expect(nearest(rows, 7 * DAY, 2 * DAY)?.value).toBe(5);
	expect(nearest(rows, 7 * DAY, DAY)).toBeNull();
	expect(startOfCaracasYear(Date.parse("2026-01-01T03:59:00Z"))).toBe(at("2025-01-01"));
	expect(startOfCaracasYear(Date.parse("2026-01-01T04:00:00Z"))).toBe(at("2026-01-01"));
});
