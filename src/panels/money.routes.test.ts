import { expect, test } from "bun:test";
import type { BcvApiRate, BcvApiRead } from "../adapters/bcv-api/index.ts";
import type { BcvCurrency, BcvRate } from "../adapters/bcv-official/index.ts";
import { Store } from "../core/store.ts";
import type { Json, Observation } from "../core/types.ts";
import { moneyView, samePublished } from "./money.ts";

/** The official rate's two routes: bcv.org.ve read directly (`bcv-official`) and bcv-api (`bcv-api`). */

const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (iso: string) => Date.parse(iso);
const valueDateMs = (d: string) => at(`${d}T00:00:00-04:00`);

function o<V extends Json>(source: string, series: string, observedAt: number, value: V, fetchedAt: number) {
	const obs: Observation<V> = {
		source,
		series,
		sourceUrl: "https://example.test/",
		fetchedAt,
		observedAt,
		licence: "x",
		value,
		confidence: 1,
		basis: "official",
	};
	return obs;
}

const series = (c: BcvCurrency) => `${c.toLowerCase()}-ves`;

function direct(valueDate: string, vesPerUnit: number, fetchedAt: number, currency: BcvCurrency = "USD") {
	return o<BcvRate>(
		"bcv-official",
		series(currency),
		valueDateMs(valueDate),
		{ currency, vesPerUnit, valueDate },
		fetchedAt,
	);
}

function mirror(
	valueDate: string,
	vesPerUnit: number,
	fetchedAt: number,
	changedAt: number,
	currency: BcvCurrency = "USD",
) {
	return o<BcvApiRate>(
		"bcv-api",
		series(currency),
		valueDateMs(valueDate),
		{ currency, vesPerUnit, valueDate, changedAt },
		fetchedAt,
	);
}

function read(valueDate: string, scrapedAt: number, fetchedAt: number, changedAt: number) {
	return o<BcvApiRead>("bcv-api", "read", scrapedAt, { valueDate, changedAt }, fetchedAt);
}

// Thursday 2026-09-24 19:10 Caracas: the BCV published Friday's rate at ~15:36.
const THURSDAY_EVENING = at("2026-09-24T23:10:00Z");
const PUBLISHED = at("2026-09-24T19:36:45Z");

test("published precision: 8 decimals, as the BCV prints them", () => {
	expect(samePublished(855.6625, 855.6625)).toBe(true);
	// Arithmetic noise below the 8th decimal is not a difference.
	expect(samePublished(972.648677, 972.648677 + 1e-11)).toBe(true);
	expect(samePublished(855.6625, 855.66250001)).toBe(false);
});

test("both routes agree: the BCV is shown once, from the direct route, confirmed by 2 routes", () => {
	const store = new Store(":memory:");
	store.insert([
		direct("2026-09-24", 854.4637, at("2026-09-23T20:00:00Z")),
		mirror("2026-09-24", 854.4637, at("2026-09-23T19:50:00Z"), at("2026-09-23T19:40:00Z")),
		direct("2026-09-25", 855.6625, at("2026-09-24T20:05:00Z")),
		mirror("2026-09-25", 855.6625, at("2026-09-24T19:40:00Z"), PUBLISHED),
		direct("2026-09-25", 972.648677, at("2026-09-24T20:05:00Z"), "EUR"),
		mirror("2026-09-25", 972.648677, at("2026-09-24T19:40:00Z"), PUBLISHED, "EUR"),
	]);
	const usd = moneyView(store, THURSDAY_EVENING).official.usd;
	expect(usd.current).toMatchObject({ vesPerUnit: 854.4637, feed: "bcv-official", route: null });
	expect(usd.current?.confirmedBy).toEqual(["bcv-official", "bcv-api"]);
	expect(usd.next).toMatchObject({ vesPerUnit: 855.6625, valueDate: "2026-09-25", feed: "bcv-official" });
	expect(usd.next?.confirmedBy).toEqual(["bcv-official", "bcv-api"]);
	expect(usd.discrepancies).toEqual([]);
	expect(moneyView(store, THURSDAY_EVENING).official.eur.next?.confirmedBy).toEqual([
		"bcv-official",
		"bcv-api",
	]);
});

test("direct route failing: bcv-api's figure is shown with its route, aged by its own read of the BCV", () => {
	const store = new Store(":memory:");
	const scrapedAt = at("2026-09-24T22:58:00Z");
	const fetchedAt = at("2026-09-24T23:05:00Z");
	store.insert([
		// bcv.org.ve answered on Wednesday, then stopped: it never saw Thursday's publication.
		direct("2026-09-24", 854.4637, at("2026-09-23T20:00:00Z")),
		mirror("2026-09-25", 855.6625, at("2026-09-24T19:40:00Z"), PUBLISHED),
		read("2026-09-25", at("2026-09-24T19:38:00Z"), at("2026-09-24T19:40:00Z"), PUBLISHED),
		read("2026-09-25", scrapedAt, fetchedAt, PUBLISHED),
	]);
	const usd = moneyView(store, THURSDAY_EVENING).official.usd;
	expect(usd.current).toMatchObject({
		vesPerUnit: 854.4637,
		feed: "bcv-official",
		confirmedBy: ["bcv-official"],
	});
	expect(usd.next).toMatchObject({ vesPerUnit: 855.6625, feed: "bcv-api", confirmedBy: ["bcv-api"] });
	expect(usd.next?.route).toEqual({ label: "BCV (vía bcv-api)", readAt: scrapedAt });
	// Never fresher than bcv-api's own read, although Vigía fetched it later.
	expect(usd.next?.route?.readAt ?? Number.POSITIVE_INFINITY).toBeLessThan(fetchedAt);
	// A read in the future (after `now`) is not used.
	store.insert([read("2026-09-25", THURSDAY_EVENING + 5 * MIN, THURSDAY_EVENING + 6 * MIN, PUBLISHED)]);
	expect(moneyView(store, THURSDAY_EVENING).official.usd.next?.route?.readAt).toBe(scrapedAt);
});

test("with no stored read yet, the route's age starts at bcv-api's changed_at, never at Vigía's fetch", () => {
	const store = new Store(":memory:");
	store.insert([mirror("2026-09-24", 854.4637, at("2026-09-23T20:00:00Z"), at("2026-09-23T19:36:00Z"))]);
	const usd = moneyView(store, THURSDAY_EVENING).official.usd;
	expect(usd.current?.feed).toBe("bcv-api");
	expect(usd.current?.route?.readAt).toBe(at("2026-09-23T19:36:00Z"));
});

test("the routes disagree for one Fecha Valor: the direct value is shown and both are listed, never averaged", () => {
	const store = new Store(":memory:");
	const directAt = at("2026-09-24T20:05:00Z");
	const mirrorAt = at("2026-09-24T20:10:00Z");
	store.insert([
		direct("2026-09-24", 854.4637, at("2026-09-23T20:00:00Z")),
		direct("2026-09-25", 855.6625, directAt),
		mirror("2026-09-25", 855.7, mirrorAt, PUBLISHED),
		// An old disagreement on a day no longer shown is not listed.
		direct("2026-09-10", 840.0, at("2026-09-09T20:00:00Z")),
		mirror("2026-09-10", 841.0, at("2026-09-09T20:00:00Z"), at("2026-09-09T19:30:00Z")),
	]);
	const usd = moneyView(store, THURSDAY_EVENING).official.usd;
	expect(usd.next).toMatchObject({
		vesPerUnit: 855.6625,
		feed: "bcv-official",
		confirmedBy: ["bcv-official"],
	});
	expect(usd.discrepancies).toEqual([
		{
			currency: "USD",
			valueDate: "2026-09-25",
			direct: {
				feed: "bcv-official",
				vesPerUnit: 855.6625,
				fetchedAt: directAt,
				sourceUrl: "https://example.test/",
			},
			mirror: {
				feed: "bcv-api",
				vesPerUnit: 855.7,
				fetchedAt: mirrorAt,
				changedAt: PUBLISHED,
				sourceUrl: "https://example.test/",
			},
		},
	]);
	// Once in force, the same discrepancy is still listed (it is the current figure then).
	const friday = moneyView(store, at("2026-09-25T15:00:00Z")).official.usd;
	expect(friday.current?.vesPerUnit).toBe(855.6625);
	expect(friday.discrepancies.map((d) => d.valueDate)).toEqual(["2026-09-25"]);
});

test("Friday → Monday through bcv-api: Monday's rate is 'next' all weekend, Friday's stays in force", () => {
	const store = new Store(":memory:");
	const fridayPublish = at("2026-09-25T20:21:00Z");
	store.insert([
		direct("2026-09-25", 855.6625, at("2026-09-24T20:05:00Z")),
		mirror("2026-09-25", 855.6625, at("2026-09-24T19:40:00Z"), PUBLISHED),
		// bcv.org.ve went down on Friday afternoon; bcv-api read Monday's rate.
		mirror("2026-09-28", 858.0, at("2026-09-25T20:30:00Z"), fridayPublish),
		read("2026-09-28", at("2026-09-26T14:40:00Z"), at("2026-09-26T14:50:00Z"), fridayPublish),
	]);
	const saturday = moneyView(store, at("2026-09-26T15:00:00Z")).official.usd;
	expect(saturday.current).toMatchObject({ valueDate: "2026-09-25", feed: "bcv-official" });
	expect(saturday.current?.confirmedBy).toEqual(["bcv-official", "bcv-api"]);
	expect(saturday.next).toMatchObject({ valueDate: "2026-09-28", vesPerUnit: 858.0, feed: "bcv-api" });
	expect(saturday.next?.validFrom).toBe(at("2026-09-28T04:00:00Z"));
	expect(saturday.possiblyMissed).toBe(false);
	// Monday 00:00 Caracas: it takes over, still labelled with its route.
	const monday = moneyView(store, at("2026-09-28T04:00:00Z")).official.usd;
	expect(monday.current).toMatchObject({ valueDate: "2026-09-28", feed: "bcv-api" });
	expect(monday.next).toBeNull();
	// The 90-day series carries the day too, with its feed.
	expect(moneyView(store, at("2026-09-28T12:00:00Z")).series90d.official.at(-1)).toMatchObject({
		date: "2026-09-28",
		feed: "bcv-api",
	});
});

test("EUR follows the same rules, from whichever route has it", () => {
	const store = new Store(":memory:");
	store.insert([
		direct("2026-09-24", 970.1, at("2026-09-23T20:00:00Z"), "EUR"),
		mirror("2026-09-25", 972.648677, at("2026-09-24T19:40:00Z"), PUBLISHED, "EUR"),
	]);
	const eur = moneyView(store, THURSDAY_EVENING).official.eur;
	expect(eur.current).toMatchObject({ vesPerUnit: 970.1, feed: "bcv-official" });
	expect(eur.next).toMatchObject({ vesPerUnit: 972.648677, feed: "bcv-api" });
	expect(eur.next?.route?.label).toBe("BCV (vía bcv-api)");
});

test("the history file counts as the direct route: it wins over bcv-api for its day", () => {
	const store = new Store(":memory:");
	store.insert([
		o(
			"bcv-history",
			"usd-ves",
			valueDateMs("2026-09-23"),
			{
				vesPerUsd: 853.4993,
				bidVesPerUsd: 851.0,
				publishedAsk: 853.4993,
				publishedBid: 851.0,
				publishedUnit: "Bs.",
				divisor: 1,
				conversion: null,
				valueDate: "2026-09-23",
			},
			at("2026-09-25T12:00:00Z"),
		),
		mirror("2026-09-23", 853.4993, at("2026-09-22T20:00:00Z"), at("2026-09-22T19:30:00Z")),
	]);
	const usd = moneyView(store, THURSDAY_EVENING - 20 * HOUR).official.usd;
	expect(usd.current).toMatchObject({ feed: "bcv-history", route: null });
});
