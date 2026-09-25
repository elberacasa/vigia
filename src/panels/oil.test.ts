import { expect, test } from "bun:test";
import type { OilPrice } from "../adapters/fred-oil/index.ts";
import { Store } from "../core/store.ts";
import type { Observation } from "../core/types.ts";
import { oilView } from "./oil.ts";

const obs = (
	series: string,
	date: string,
	usdPerBarrel: number,
	fetchedAt = Date.UTC(2026, 8, 24),
): Observation<OilPrice> => ({
	source: "fred-oil",
	series,
	sourceUrl: "https://fred.stlouisfed.org/series/DCOILBRENTEU",
	fetchedAt,
	observedAt: Date.parse(`${date}T00:00:00Z`),
	licence: "eia-public-domain-via-fred",
	value: { usdPerBarrel, date },
	confidence: 1,
	basis: "official",
});

test("latest, day change against the previous trading day, and a 30-day series", () => {
	const store = new Store(":memory:");
	store.insert([
		obs("brent", "2026-08-10", 90), // outside 30 days, still usable as history
		obs("brent", "2026-09-18", 119.66),
		obs("brent", "2026-09-21", 116.15),
		obs("brent", "2026-09-22", 114.89),
		obs("wti", "2026-09-22", 96.41),
	]);
	const view = oilView(store, Date.UTC(2026, 8, 24, 12));
	const brent = view.benchmarks.find((b) => b.id === "brent");
	expect(brent?.latest?.usdPerBarrel).toBe(114.89);
	expect(brent?.previous).toEqual({ usdPerBarrel: 116.15, date: "2026-09-21" });
	expect(brent?.change?.usd).toBeCloseTo(-1.26, 10);
	expect(brent?.change?.pct).toBeCloseTo((114.89 / 116.15 - 1) * 100, 10);
	expect(brent?.series30d.map((p) => p.date)).toEqual(["2026-09-18", "2026-09-21", "2026-09-22"]);
	expect(brent?.stale).toBe(false);
	expect(oilView(store, Date.UTC(2026, 9, 5)).benchmarks[0]?.stale).toBe(true);
	const wti = view.benchmarks.find((b) => b.id === "wti");
	expect(wti?.change).toBeNull();
	expect(view.attribution).toContain("Energy Information Administration");
});

test("a revised value for the same day replaces the earlier one", () => {
	const store = new Store(":memory:");
	store.insert([
		obs("brent", "2026-09-21", 116),
		obs("brent", "2026-09-22", 114),
		obs("brent", "2026-09-22", 115, Date.UTC(2026, 8, 25)),
	]);
	const brent = oilView(store, Date.UTC(2026, 8, 25, 12)).benchmarks[0];
	expect(brent?.latest?.usdPerBarrel).toBe(115);
	expect(brent?.series30d.length).toBe(2);
});

test("empty store: no numbers, no crash", () => {
	const view = oilView(new Store(":memory:"), Date.UTC(2026, 8, 24));
	expect(
		view.benchmarks.every((b) => b.latest === null && b.change === null && b.series30d.length === 0),
	).toBe(true);
});
