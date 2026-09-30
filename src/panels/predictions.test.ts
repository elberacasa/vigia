import { expect, test } from "bun:test";
import { join } from "node:path";
import { kalshi } from "../adapters/kalshi/index.ts";
import { type PredictionMarket, polymarket } from "../adapters/polymarket/index.ts";
import { hasFixture, loadFixture } from "../core/fixtures.ts";
import { Store } from "../core/store.ts";
import { change24h, eventsOf, predictionsView } from "./predictions.ts";

const H = 3_600_000;
const NOW = Date.UTC(2026, 0, 15, 12);
const value = (
	outcome: string,
	lastPrice: number | null,
	over: Partial<PredictionMarket> = {},
): PredictionMarket => ({
	venue: "polymarket",
	eventId: "1",
	eventTitle: "Invented question?",
	eventUrl: "https://polymarket.com/event/invented",
	marketId: outcome,
	outcome,
	question: `Will ${outcome}?`,
	lastPrice,
	bid: null,
	ask: null,
	lastTradeAt: NOW - H,
	volume: 100,
	volume24h: 10,
	volumeUnit: "USD",
	closesAt: NOW + 30 * 24 * H,
	optionsInEvent: 2,
	...over,
});
const row = (series: string, at: number, v: PredictionMarket) => ({
	series,
	observedAt: at,
	fetchedAt: at,
	sourceUrl: v.eventUrl,
	value: v,
});

test("24 h change against the reading nearest to a day before (±3 h), in points", () => {
	const history = [row("m", NOW - 25 * H, value("A", 0.4)), row("m", NOW - 20 * H, value("A", 0.45))];
	const latest = row("m", NOW, value("A", 0.52));
	expect(change24h([...history, latest], latest)).toBe(12);
	expect(change24h([latest], latest)).toBeNull();
	expect(change24h([row("m", NOW - 30 * H, value("A", 0.1)), latest], latest)).toBeNull();
});

test("events group their options, newest read only, quiet markets flagged, venues never blended", () => {
	const rows = [
		row("a", NOW - 24 * H, value("A", 0.3)),
		row("a", NOW, value("A", 0.35)),
		row("b", NOW, value("B", 0.6, { lastTradeAt: NOW - 8 * 24 * H })),
		row("old", NOW - 5 * H, value("Gone", 0.9)),
		row("k", NOW, value("K", 0.7, { venue: "kalshi", eventId: "KX-1", volumeUnit: "contracts" })),
	];
	const events = eventsOf(rows, NOW);
	expect(events.map((e) => `${e.venue}:${e.eventId}`)).toEqual(["polymarket:1", "kalshi:KX-1"]);
	const pm = events[0];
	expect(pm?.options.map((o) => o.outcome)).toEqual(["B", "A"]);
	expect(pm?.options[0]?.quiet).toBe(true);
	expect(pm?.options[1]).toMatchObject({ quiet: false, change24hPoints: 5 });
	expect(events[1]?.volumeUnit).toBe("contracts");
	// A past `closesAt` does not hide an option: Polymarket leaves stale end dates on options that still trade.
	expect(eventsOf([row("c", NOW, value("C", 0.5, { closesAt: NOW - 1 }))], NOW).length).toBe(1);
});

const recorded = [polymarket, kalshi].every((a) =>
	hasFixture(join(import.meta.dir, "..", "adapters", a.id, "fixtures", "2026-09-28")),
);

test.skipIf(!recorded)("end to end on the recordings", () => {
	const store = new Store(":memory:");
	for (const a of [polymarket, kalshi]) {
		store.insert(
			a.normalise(loadFixture(join(import.meta.dir, "..", "adapters", a.id, "fixtures", "2026-09-28"))),
		);
	}
	const v = predictionsView(store, Date.parse("2026-09-29T03:00:00Z"));
	expect(v.events.length).toBe(21);
	expect(v.events.filter((e) => e.venue === "kalshi").length).toBe(6);
	expect(v.priceLabel).toContain("no una encuesta");
	expect(v.venues.map((x) => x.id)).toEqual(["polymarket", "kalshi"]);
});
