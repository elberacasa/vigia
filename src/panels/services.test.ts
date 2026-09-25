import { expect, test } from "bun:test";
import type { GuriLevel } from "../adapters/dahiti-guri/index.ts";
import { Store } from "../core/store.ts";
import type { Observation } from "../core/types.ts";
import { guriView, servicesPanel, UNAVAILABLE } from "./services.ts";

const DAY = 86_400_000;

function pt(at: number, wseM: number, fetchedAt = at + 40 * DAY): Observation<GuriLevel> {
	return {
		source: "dahiti-guri",
		series: "guri:wse",
		sourceUrl: "https://dahiti.dgfi.tum.de/en/67/water-level-altimetry/",
		fetchedAt,
		observedAt: at,
		licence: "cc-by-4.0-dahiti",
		value: { wseM, uncertaintyM: 0.01, mission: "test" },
		confidence: 0.9,
		basis: "measurement",
	};
}

/** Ten-day passes over five years; each year is 1 m higher in mid-August, a dry-season dip in April. */
function series(): Observation<GuriLevel>[] {
	const out: Observation<GuriLevel>[] = [];
	const start = Date.UTC(2021, 0, 5, 18);
	for (let t = start; t <= Date.UTC(2026, 7, 16, 19); t += 10 * DAY) {
		const d = new Date(t);
		const yearBoost = d.getUTCFullYear() - 2021;
		const season = Math.cos(((d.getUTCMonth() + 1 - 8) / 12) * 2 * Math.PI); // peak in August
		out.push(pt(t, 262 + yearBoost * 0.5 + season * 4));
	}
	return out;
}

test("empty store: no figures, stale, and every unavailable service still listed", () => {
	const store = new Store(":memory:");
	const v = servicesPanel.compute(store, Date.UTC(2026, 8, 24));
	expect(v.guri.latest).toBeNull();
	expect(v.guri.stale).toBe(true);
	expect(v.guri.season).toBeNull();
	expect(v.unavailable.map((u) => u.id)).toEqual(["corpoelec", "rationing", "water", "gas", "fuel"]);
	for (const u of UNAVAILABLE) expect(u.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test("latest point, ~30-day and ~1-year changes against the nearest points, record extremes", () => {
	const store = new Store(":memory:");
	const pts = series();
	store.insert(pts);
	const now = Date.UTC(2026, 8, 24);
	const v = guriView(store, now);
	const last = pts.at(-1) as Observation<GuriLevel>;
	expect(v.latest?.observedAt).toBe(last.observedAt);
	expect(v.latest?.m).toBeCloseTo(last.value.wseM, 9);
	// Passes every 10 days: the point 30 days before exists exactly.
	const back30 = pts.find((p) => p.observedAt === last.observedAt - 30 * DAY) as Observation<GuriLevel>;
	expect(v.change30d?.fromObservedAt).toBe(back30.observedAt);
	expect(v.change30d?.m).toBeCloseTo(last.value.wseM - back30.value.wseM, 9);
	expect(v.change1y).not.toBeNull();
	expect(Math.abs((v.change1y?.fromObservedAt ?? 0) - (last.observedAt - 365 * DAY))).toBeLessThanOrEqual(
		12 * DAY,
	);
	expect(v.record?.since).toBe(pts[0]?.observedAt);
	expect(v.record?.max.m).toBeCloseTo(last.value.wseM, 1);
	expect(v.stale).toBe(false);
	// Two years of points for the sparkline, oldest first.
	expect(v.spark[0]?.t).toBeGreaterThanOrEqual(last.observedAt - 730 * DAY);
	expect(v.spark.at(-1)?.t).toBe(last.observedAt);
});

test("season: each earlier year's median in the same weeks; a rising series beats all five", () => {
	const store = new Store(":memory:");
	store.insert(series());
	const v = guriView(store, Date.UTC(2026, 8, 24));
	expect(v.season?.years).toBe(5);
	expect(v.season?.firstYear).toBe(2021);
	expect(v.season?.lastYear).toBe(2025);
	expect(v.season?.below).toBe(5);
	expect(v.season?.lowest.year).toBe(2021);
	expect(v.season?.highest.year).toBe(2025);
});

test("season: a low current level is below most years, and years without points in the window are left out", () => {
	const store = new Store(":memory:");
	const at = (y: number) => Date.UTC(y, 7, 10, 12);
	store.insert([
		pt(at(2019), 270),
		pt(at(2020), 268),
		// 2021: only a point two months away, outside ±15 days.
		pt(Date.UTC(2021, 5, 1), 250),
		pt(at(2022), 255),
		pt(at(2026), 260),
	]);
	const v = guriView(store, Date.UTC(2026, 8, 24));
	expect(v.season?.years).toBe(3);
	expect(v.season?.below).toBe(1);
	expect(v.change1y).toBeNull();
});

test("a window straddling New Year counts late-December points for the next year's early January", () => {
	const store = new Store(":memory:");
	store.insert([pt(Date.UTC(2024, 11, 28), 250), pt(Date.UTC(2026, 0, 5), 260)]);
	const v = guriView(store, Date.UTC(2026, 1, 1));
	expect(v.season).toMatchObject({ years: 1, firstYear: 2025, below: 1 });
});

test("a revised pass (same instant, later fetch) replaces the earlier value", () => {
	const store = new Store(":memory:");
	const t = Date.UTC(2026, 7, 16, 19);
	store.insert([pt(t, 262, t + 30 * DAY), pt(t, 263, t + 31 * DAY)]);
	expect(guriView(store, t + 32 * DAY).latest?.m).toBe(263);
});

test("the newest point older than 75 days makes the view stale", () => {
	const store = new Store(":memory:");
	const t = Date.UTC(2026, 5, 1);
	store.insert([pt(t, 262)]);
	expect(guriView(store, t + 74 * DAY).stale).toBe(false);
	expect(guriView(store, t + 76 * DAY).stale).toBe(true);
});
