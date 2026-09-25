import { expect, test } from "bun:test";
import { join } from "node:path";
import { bcbPtax } from "../adapters/bcb-ptax/index.ts";
import { faoFfpi } from "../adapters/fao-ffpi/index.ts";
import { fredMarkets } from "../adapters/fred-markets/index.ts";
import { fredOil } from "../adapters/fred-oil/index.ts";
import { imfPortwatch } from "../adapters/imf-portwatch/index.ts";
import { trmColombia } from "../adapters/trm-colombia/index.ts";
import { wbPinksheet } from "../adapters/wb-pinksheet/index.ts";
import { hasFixture, loadFixture } from "../core/fixtures.ts";
import { Store } from "../core/store.ts";
import type { Adapter } from "../core/types.ts";
import {
	dailyChanges,
	latestRevisions,
	marketsView,
	monthlyChanges,
	type Point,
	portWindow,
} from "./markets.ts";

const p = (date: string, value: number): Point => ({ date, value });

// Recorded responses carry third-party content, so they are absent from the public repository (see hasFixture).
const recorded = hasFixture(
	join(import.meta.dir, "..", "adapters", "imf-portwatch", "fixtures", "2026-09-24"),
);

test("daily changes: previous value, 7 to 13 days back, 365 to 372 days back", () => {
	const points = [
		p("2025-09-19", 80),
		p("2026-09-08", 95),
		p("2026-09-11", 100),
		p("2026-09-17", 104),
		p("2026-09-18", 110),
	];
	const c = dailyChanges(points);
	expect(c.d1).toEqual({ abs: 6, pct: (110 / 104 - 1) * 100, from: "2026-09-17" });
	// 7 days back from 18 Sep is 11 Sep.
	expect(c.w1?.from).toBe("2026-09-11");
	expect(c.w1?.pct).toBeCloseTo(10, 10);
	// 364 days back is not a year; 2025-09-19 is exactly 364 days before 2026-09-18.
	expect(c.y1).toBeNull();
	const withYear = dailyChanges([p("2025-09-15", 88), ...points]);
	expect(withYear.y1?.from).toBe("2025-09-15");
	expect(withYear.y1?.abs).toBe(22);
});

test("review 4 M11: the daily change is against the previous trading day, at most 4 calendar days back", () => {
	// Friday → Monday (3 days) and Friday → Tuesday after a holiday Monday (4 days) are a day's change.
	expect(dailyChanges([p("2026-09-18", 100), p("2026-09-21", 101)]).d1?.from).toBe("2026-09-18");
	expect(dailyChanges([p("2026-09-18", 100), p("2026-09-22", 102)]).d1?.abs).toBe(2);
	// Five days is a gap, not a day.
	expect(dailyChanges([p("2026-09-17", 100), p("2026-09-22", 102)]).d1).toBeNull();
	// The previous stored value is used even when older ones exist; a single point has no change.
	expect(dailyChanges([p("2026-09-01", 90), p("2026-09-21", 100), p("2026-09-22", 99)]).d1?.from).toBe(
		"2026-09-21",
	);
	expect(dailyChanges([p("2026-09-22", 99)]).d1).toBeNull();
});

test("daily changes: a base too far back is not used (a gap is not a week)", () => {
	const c = dailyChanges([p("2026-08-01", 50), p("2026-09-18", 60)]);
	// Review 4 M11: after a gap of weeks there is no "día" change (it was +10, a seven-week change).
	expect(c.d1).toBeNull();
	expect(c.w1).toBeNull();
	expect(dailyChanges([])).toEqual({ d1: null, w1: null, y1: null });
});

test("monthly changes use exact months only, across the year boundary", () => {
	const c = monthlyChanges([p("2025-01", 100), p("2025-12", 120), p("2026-01", 126)]);
	expect(c.m1?.from).toBe("2025-12");
	expect(c.m1?.pct).toBeCloseTo(5, 10);
	expect(c.y1?.from).toBe("2025-01");
	expect(c.y1?.pct).toBeCloseTo(26, 10);
	expect(monthlyChanges([p("2025-10", 1), p("2026-01", 2)]).m1).toBeNull();
});

test("the latest revision of a period wins", () => {
	const row = (id: number, month: string, fetchedAt: number, value: number) => ({
		id,
		source: "fao-ffpi",
		series: "ffpi",
		sourceUrl: "x",
		fetchedAt,
		observedAt: Date.parse(`${month}-01T00:00:00Z`),
		licence: "x",
		value: { index: value, month },
		confidence: 1,
		basis: "official" as const,
	});
	const out = latestRevisions(
		[row(1, "2026-07", 1, 130.8), row(2, "2026-08", 1, 133.3), row(3, "2026-07", 2, 130.6)],
		(o) => o.value.month,
	);
	expect(out.map((o) => o.value.index)).toEqual([130.6, 133.3]);
});

test.skipIf(!recorded)("port windows sum 7 days and count the days present", () => {
	const row = (date: string, calls: number) => ({
		date,
		portCalls: calls,
		tankerCalls: 1,
		importT: 10,
		exportT: 5,
	});
	const by = new Map([
		["2026-09-12", row("2026-09-12", 2)],
		["2026-09-18", row("2026-09-18", 3)],
		["2026-09-11", row("2026-09-11", 100)],
	]);
	const w = portWindow(by, "2026-09-18");
	expect(w).toEqual({
		from: "2026-09-12",
		to: "2026-09-18",
		days: 2,
		calls: 5,
		tankerCalls: 2,
		importT: 20,
		exportT: 10,
	});
});

/** Every recorded fixture, stored as the scheduler would, and the view computed on 24 Sep 2026, 20:00 UTC. */
function fixtureView() {
	const store = new Store(":memory:");
	const adapters: Adapter[] = [
		fredOil,
		fredMarkets,
		trmColombia,
		bcbPtax,
		wbPinksheet,
		faoFfpi,
		imfPortwatch,
	] as Adapter[];
	for (const a of adapters) {
		store.insert(
			a.normalise(loadFixture(join(import.meta.dir, "..", "adapters", a.id, "fixtures", "2026-09-24"))),
		);
	}
	return marketsView(store, Date.UTC(2026, 8, 24, 20));
}

test.skipIf(!recorded)("replays the recorded fixtures into four groups and the ports block", () => {
	const v = fixtureView();
	const tile = (id: string) => v.groups.flatMap((g) => g.tiles).find((t) => t.id === id);
	expect(v.groups.map((g) => g.id)).toEqual(["energy", "fx", "exports", "food"]);

	const brent = tile("brent");
	expect(brent?.latest).toMatchObject({ value: 114.89, date: "2026-09-22" });
	expect(brent?.d1?.from).toBe("2026-09-21");
	expect(brent?.stale).toBe(false);

	const gas = tile("gasoline-usgc");
	expect(gas?.latest?.value).toBe(3.891);
	expect(gas?.d1?.abs).toBeCloseTo(3.891 - 3.946, 10);
	expect(gas?.w1?.from).toBe("2026-09-15");
	expect(gas?.y1).not.toBeNull();

	// The TRM for 25 Sep is published but not in force at 20:00 UTC on the 24th.
	const cop = tile("usd-cop");
	expect(cop?.latest).toMatchObject({ value: 3264.39, date: "2026-09-24" });
	expect(cop?.next).toEqual({ value: 3329.61, date: "2026-09-25" });
	expect(cop?.d1?.from).toBe("2026-09-23");

	const brl = tile("usd-brl");
	expect(brl?.latest).toMatchObject({ value: 5.1795, date: "2026-09-24" });

	const gold = tile("pink-gold");
	expect(gold?.cadence).toBe("monthly");
	expect(gold?.latest).toMatchObject({ value: 4411, date: "2026-08" });
	expect(gold?.m1?.from).toBe("2026-07");
	expect(gold?.m1?.abs).toBe(4411 - 4073);
	expect(gold?.spark).toHaveLength(24);
	expect(gold?.stale).toBe(false);

	const ffpi = tile("fao-ffpi");
	expect(ffpi?.latest?.value).toBe(133.3);
	expect(ffpi?.m1?.abs).toBeCloseTo(133.3 - 130.8, 10);

	const ports = v.ports;
	expect(ports.newestDate).toBe("2026-09-18");
	expect(ports.week?.days).toBe(7);
	expect(ports.week?.from).toBe("2026-09-12");
	expect(ports.prevWeek?.days).toBe(7);
	expect(ports.yearAgo?.days).toBe(7);
	expect(ports.portCount).toBe(18);
	// Per-port sums of the newest week equal the national sum for the same week.
	expect(ports.byPort.reduce((s, x) => s + x.calls, 0)).toBe(ports.week?.calls ?? -1);
	expect(ports.byPort[0]?.calls).toBeGreaterThanOrEqual(ports.byPort.at(-1)?.calls ?? 0);
	expect(ports.weekly.length).toBeGreaterThan(20);
	expect(ports.weekly.at(-1)?.to).toBe("2026-09-18");
	expect(ports.stale).toBe(false);
});

test("an empty store gives empty tiles, stale, never zeros", () => {
	const v = marketsView(new Store(":memory:"), Date.UTC(2026, 8, 24));
	for (const t of v.groups.flatMap((g) => g.tiles)) {
		expect(t.latest).toBeNull();
		expect(t.stale).toBe(true);
		expect(t.spark).toEqual([]);
	}
	expect(v.ports.week).toBeNull();
	expect(v.ports.byPort).toEqual([]);
});

test.skipIf(!recorded)("data older than a series' own budget is stale", () => {
	const v = fixtureView();
	const later = marketsView(
		(() => {
			const store = new Store(":memory:");
			store.insert(
				wbPinksheet.normalise(
					loadFixture(join(import.meta.dir, "..", "adapters", "wb-pinksheet", "fixtures", "2026-09-24")),
				),
			);
			return store;
		})(),
		Date.UTC(2026, 9, 20),
	);
	expect(v.groups[2]?.tiles[0]?.stale).toBe(false);
	// 1 Aug + 75 days = 15 Oct: stale by 20 Oct if September never arrived.
	expect(later.groups[2]?.tiles[0]?.stale).toBe(true);
});
