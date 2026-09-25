import { expect, test } from "bun:test";
import type { BcvHistoryRate } from "../adapters/bcv-history/index.ts";
import type { InpcMonth } from "../adapters/bcv-inpc/index.ts";
import type { BcvCurrency, BcvRate } from "../adapters/bcv-official/index.ts";
import { type P2pAd, sample } from "../adapters/binance-p2p/median.ts";
import type { YadioRate } from "../adapters/yadio/index.ts";
import { Store } from "../core/store.ts";
import type { Basis, Json, Observation } from "../core/types.ts";
import { caracasMidnight } from "../formats/time.ts";
import { gapPct, moneyView, periodMinusMonths, yearOnYear } from "./money.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function o<V extends Json>(
	source: string,
	series: string,
	observedAt: number,
	value: V,
	fetchedAt = observedAt,
	basis: Basis = "official",
): Observation<V> {
	return {
		source,
		series,
		sourceUrl: "https://example.test/",
		fetchedAt,
		observedAt,
		licence: "x",
		value,
		confidence: 1,
		basis,
	};
}

const at = (iso: string) => Date.parse(iso);
const valueDateMs = (d: string) => at(`${d}T00:00:00-04:00`);

function bcv(valueDate: string, vesPerUnit: number, currency: BcvCurrency = "USD", fetchedAt?: number) {
	const obs = o<BcvRate>(
		"bcv-official",
		`${currency.toLowerCase()}-ves`,
		valueDateMs(valueDate),
		{ currency, vesPerUnit, valueDate },
		fetchedAt ?? valueDateMs(valueDate) - 8 * HOUR,
	);
	return obs;
}

function hist(valueDate: string, vesPerUsd: number): Observation<BcvHistoryRate> {
	return o<BcvHistoryRate>("bcv-history", "usd-ves", valueDateMs(valueDate), {
		vesPerUsd,
		bidVesPerUsd: vesPerUsd * 0.9975,
		publishedAsk: vesPerUsd,
		publishedBid: vesPerUsd * 0.9975,
		publishedUnit: "Bs.",
		divisor: 1,
		conversion: null,
		valueDate,
	});
}

const yad = (t: number, vesPerUsd: number) =>
	o<YadioRate>("yadio", "usd-ves", t, { vesPerUsd }, t + 20_000, "quote");

// Thursday 2026-09-24 19:10 Caracas: the BCV has already published Friday's rate.
const THURSDAY_EVENING = at("2026-09-24T23:10:00Z");

function seeded(): Store {
	const store = new Store(":memory:");
	store.insert([
		hist("2026-09-17", 846.0),
		hist("2026-09-22", 852.4168),
		hist("2026-09-23", 853.4993),
		bcv("2026-09-23", 853.4993),
		bcv("2026-09-24", 854.4637),
		bcv("2026-09-25", 855.6625, "USD", at("2026-09-24T20:05:00Z")),
		bcv("2026-09-24", 970.1, "EUR"),
		bcv("2026-09-25", 972.648677, "EUR"),
		yad(THURSDAY_EVENING - 2 * MIN, 957.049391),
		yad(THURSDAY_EVENING - DAY - 10 * MIN, 950.0),
		yad(THURSDAY_EVENING - 7 * DAY + 30 * MIN, 930.0),
	]);
	return store;
}

test("the rate in force now is the latest Fecha Valor ≤ now; a published future one is 'next'", () => {
	const v = moneyView(seeded(), THURSDAY_EVENING);
	expect(v.official.usd.current).toMatchObject({
		vesPerUnit: 854.4637,
		valueDate: "2026-09-24",
		feed: "bcv-official",
	});
	expect(v.official.usd.current?.validFrom).toBe(at("2026-09-24T04:00:00Z"));
	expect(v.official.usd.next).toMatchObject({ vesPerUnit: 855.6625, valueDate: "2026-09-25" });
	// When Vigía first saw Friday's rate (upper bound on publication).
	expect(v.official.usd.next?.fetchedAt).toBe(at("2026-09-24T20:05:00Z"));
	expect(v.official.eur.current?.vesPerUnit).toBe(970.1);
	expect(v.official.eur.next?.vesPerUnit).toBe(972.648677);

	// At 00:00 Caracas on Friday the next rate takes over; nothing is 'next' any more.
	const friday = moneyView(seeded(), at("2026-09-25T04:00:00Z"));
	expect(friday.official.usd.current?.valueDate).toBe("2026-09-25");
	expect(friday.official.usd.next).toBeNull();
	// One minute earlier it is still Thursday's.
	expect(moneyView(seeded(), at("2026-09-25T03:59:00Z")).official.usd.current?.valueDate).toBe("2026-09-24");
});

test("weekend: Friday's publication with a Monday Fecha Valor stays 'next' until Monday", () => {
	const store = seeded();
	store.insert([bcv("2026-09-28", 858.0, "USD", at("2026-09-25T20:00:00Z"))]);
	const saturday = moneyView(store, at("2026-09-26T15:00:00Z"));
	expect(saturday.official.usd.current?.valueDate).toBe("2026-09-25");
	expect(saturday.official.usd.next?.valueDate).toBe("2026-09-28");
	expect(saturday.official.usd.stale).toBe(false);
});

test("gaps are computed per named quote against the rate in force now, with the time skew", () => {
	const v = moneyView(seeded(), THURSDAY_EVENING);
	const gap = v.yadio.figure?.gap;
	expect(gap?.pct).toBeCloseTo((957.049391 / 854.4637 - 1) * 100, 10);
	expect(gap?.pct).toBeCloseTo(12.006, 3);
	expect(gap?.officialValueDate).toBe("2026-09-24");
	expect(gap?.skewMs).toBe(THURSDAY_EVENING - 2 * MIN - at("2026-09-24T04:00:00Z"));
	expect(v.yadio.figure?.ageMs).toBe(2 * MIN);
	expect(v.yadio.label).toContain("fórmula no publicada");
	expect(v.yadio.stale).toBe(false);
	expect(gapPct(110, 100)).toBeCloseTo(10, 12);
});

test("24 h and 7 d changes: official by rate in force, Yadio by the nearest earlier sample", () => {
	const v = moneyView(seeded(), THURSDAY_EVENING);
	// In force 24 h ago (Wed 19:10 Caracas): Fecha Valor 23 Sep.
	expect(v.official.usd.change24h?.fromValue).toBe(853.4993);
	expect(v.official.usd.change24h?.abs).toBeCloseTo(854.4637 - 853.4993, 10);
	// In force 7 days ago (Thu 17 Sep): from the history file.
	expect(v.official.usd.change7d?.fromValue).toBe(846.0);
	expect(v.official.usd.change7d?.pct).toBeCloseTo((854.4637 / 846 - 1) * 100, 10);
	expect(v.yadio.figure?.change24h?.fromValue).toBe(950.0);
	expect(v.yadio.figure?.change7d).toBeNull(); // nearest sample is 30 min *after* the 7-day mark
});

test("no Yadio sample near 24 h ago: no change rather than a wrong one", () => {
	const store = new Store(":memory:");
	store.insert([yad(THURSDAY_EVENING - MIN, 957), yad(THURSDAY_EVENING - 30 * HOUR, 940)]);
	expect(moneyView(store, THURSDAY_EVENING).yadio.figure?.change24h).toBeNull();
});

test("90-day series: official per Fecha Valor (home page wins over the file), Yadio's last value per Caracas day", () => {
	const store = seeded();
	store.insert([
		yad(at("2026-09-23T12:00:00Z"), 950.5),
		// 23:59 Caracas on the 23rd = 03:59Z on the 24th: still the 23rd.
		yad(at("2026-09-24T03:59:00Z"), 951.25),
		yad(at("2026-09-24T04:01:00Z"), 952.0),
	]);
	const v = moneyView(store, THURSDAY_EVENING);
	expect(v.series90d.official.map((p) => [p.date, p.feed])).toEqual([
		["2026-09-17", "bcv-history"],
		["2026-09-22", "bcv-history"],
		["2026-09-23", "bcv-official"],
		["2026-09-24", "bcv-official"],
	]);
	const yadioDays = new Map(v.series90d.yadio.map((p) => [p.date, p.vesPerUsd]));
	expect(yadioDays.get("2026-09-23")).toBe(951.25);
	expect(yadioDays.get("2026-09-24")).toBe(957.049391);
	expect(v.series90d.yadio.every((p, i, a) => i === 0 || (a[i - 1]?.observedAt ?? 0) < p.observedAt)).toBe(
		true,
	);
});

const ad = (priceVes: number): P2pAd => ({
	priceVes,
	tradable: true,
	minVes: 1_000,
	maxVes: 1_000_000,
	availableAsset: 1_000,
	orders30d: 100,
	completion: 0.99,
});

test("P2P venues appear only with a recent sample; each side has its own gap; thin sides have none", () => {
	const store = seeded();
	const buy = [968, 968.5, 969, 969.5, 970].map(ad);
	const sell = [965, 964].map(ad);
	store.insert([
		o(
			"binance-p2p",
			"usdt-ves",
			THURSDAY_EVENING - 5 * MIN,
			sample(buy, sell, { takerBuy: 100, takerSell: 90 }),
			THURSDAY_EVENING - 5 * MIN,
			"quote",
		),
	]);
	const v = moneyView(store, THURSDAY_EVENING);
	expect(v.p2p.map((q) => q.id)).toEqual(["binance-p2p"]);
	const q = v.p2p[0];
	expect(q?.buy.medianVesPerUsdt).toBe(969);
	expect(q?.buy.gap?.pct).toBeCloseTo((969 / 854.4637 - 1) * 100, 10);
	expect(q?.sell.status).toBe("insufficient");
	expect(q?.sell.gap).toBeNull();
	expect(q?.spreadPct).toBeNull();
	expect(q?.label).toContain("Binance P2P");
	expect(moneyView(store, THURSDAY_EVENING + 2 * DAY).p2p).toEqual([]);
});

test("inflation: latest month as published, 12-month and year-to-date computed from the index", () => {
	const store = new Store(":memory:");
	const months: Observation<InpcMonth>[] = [];
	let index = 100;
	for (let i = 0; i < 30; i++) {
		// 2024-03 … 2026-08, +10 % a month.
		const total = 2024 * 12 + 2 + i;
		const period = `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
		const [y, m] = period.split("-").map(Number) as [number, number];
		months.push(
			o<InpcMonth>("bcv-inpc", "inpc", caracasMidnight(y, m, 1), {
				period,
				index,
				monthlyPct: i === 0 ? null : 10,
				provisional: y >= 2025,
			}),
		);
		index *= 1.1;
	}
	store.insert(months);
	const inf = moneyView(store, at("2026-09-24T12:00:00Z")).inflation;
	expect(inf.latest?.period).toBe("2026-08");
	expect(inf.latest?.monthlyPct).toBe(10);
	expect(inf.yearOnYearPct).toBeCloseTo((1.1 ** 12 - 1) * 100, 8);
	expect(inf.yearToDatePct).toBeCloseTo((1.1 ** 8 - 1) * 100, 8);
	expect(inf.derivedLabel).toBe("calculado por Vigía a partir del INPC del BCV");
	expect(inf.series24m.length).toBe(24);
	expect(inf.series24m[0]?.period).toBe("2024-09");
	// 2024-09 has no month 12 earlier in the store (data starts 2024-03).
	expect(inf.series24m[0]?.yearOnYearPct).toBeNull();
	expect(inf.series24m.at(-1)?.yearOnYearPct).toBeCloseTo((1.1 ** 12 - 1) * 100, 8);
	expect(inf.stale).toBe(false);
	expect(moneyView(store, at("2026-11-15T12:00:00Z")).inflation.stale).toBe(true);
});

test("the real BCV figures: Aug 2026 YoY 534.2 % and YTD 200.1 % (the BCV's 'Var Acumulada')", () => {
	expect(yearOnYear(637409769724325.1, 100503985890335.98)).toBeCloseTo(534.2134, 3);
	expect(yearOnYear(637409769724325.1, 212393273459827.03)).toBeCloseTo(200.1, 1);
	expect(periodMinusMonths("2026-08", 12)).toBe("2025-08");
	expect(periodMinusMonths("2026-01", 1)).toBe("2025-12");
});

test("stale flags: an old BCV Fecha Valor and an old Yadio sample are marked", () => {
	const v = moneyView(seeded(), THURSDAY_EVENING + 6 * DAY);
	expect(v.official.usd.stale).toBe(true);
	expect(v.yadio.stale).toBe(true);
	expect(v.official.usd.current?.valueDate).toBe("2026-09-25");
});

test("empty store: every figure null, nothing invented", () => {
	const v = moneyView(new Store(":memory:"), THURSDAY_EVENING);
	expect(v.official.usd.current).toBeNull();
	expect(v.official.usd.change24h).toBeNull();
	expect(v.yadio.figure).toBeNull();
	expect(v.p2p).toEqual([]);
	expect(v.series90d).toEqual({ official: [], yadio: [] });
	expect(v.inflation.latest).toBeNull();
	expect(v.inflation.yearOnYearPct).toBeNull();
	expect(JSON.parse(JSON.stringify(v))).toEqual(v);
});

test("possiblyMissed: on a weekday, a rate in force from an earlier day is flagged; weekends are not", () => {
	const store = new Store(":memory:");
	// Fresh install on Thursday evening: the page already shows Friday's rate; Thursday's was never seen.
	store.insert([hist("2026-09-23", 853.4993), bcv("2026-09-25", 855.6625)]);
	const thu = moneyView(store, THURSDAY_EVENING).official.usd;
	expect(thu.current?.valueDate).toBe("2026-09-23");
	expect(thu.next?.valueDate).toBe("2026-09-25");
	expect(thu.possiblyMissed).toBe(true);
	expect(moneyView(seeded(), THURSDAY_EVENING).official.usd.possiblyMissed).toBe(false);
	// Saturday: Friday's rate is in force and nothing was missed.
	expect(moneyView(store, at("2026-09-26T15:00:00Z")).official.usd.possiblyMissed).toBe(false);
});
