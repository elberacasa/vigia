import { expect, test } from "bun:test";
import type { RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { isAboutVenezuela, LEADING, POLYMARKET_EVENTS, polymarket, venezuelaEvents } from "./index.ts";

/** Synthetic answers in the shapes of Polymarket's Gamma and data APIs; markets, prices and wallets are invented. */
const AT = Date.UTC(2026, 0, 15, 12);
const market = (i: number, price: number, extra: Record<string, unknown> = {}) => ({
	id: String(100 + i),
	question: `Will option ${i} happen?`,
	groupItemTitle: `Option ${i}`,
	conditionId: `0xcond${i}`,
	outcomes: '["Yes", "No"]',
	outcomePrices: `["${price}", "${1 - price}"]`,
	lastTradePrice: price,
	bestBid: price - 0.01,
	bestAsk: price + 0.01,
	volumeNum: 1000 * i,
	volume24hr: "25.5",
	endDate: "2026-12-31T12:00:00Z",
	active: true,
	closed: false,
	...extra,
});
const events = [
	{
		id: 1,
		slug: "invented-venezuela-question",
		title: "Invented Venezuela question?",
		tags: [{ slug: "politics" }, { slug: "venezuela" }],
		markets: [
			...[0.5, 0.2, 0.1, 0.08, 0.05, 0.04, 0.01].map((p, i) => market(i + 1, p)),
			market(9, 0.9, { closed: true }),
			{ broken: true },
		],
	},
	{
		id: 2,
		slug: "cuba-thing",
		title: "Invented Cuba question?",
		tags: [{ slug: "venezuela" }],
		markets: [market(20, 0.3)],
	},
	{
		id: 3,
		slug: "futbol",
		title: "Venezuela vs Invented FC",
		tags: [{ slug: "sports" }],
		markets: [market(30, 0.5)],
	},
];
const raw = (url: string, body: unknown): RawResponse => ({
	url,
	status: 200,
	contentType: "application/json",
	body: JSON.stringify(body),
	fetchedAt: AT,
});
const trade = (cond: string, ts: number) =>
	raw(`https://data-api.polymarket.com/trades?market=${cond}&limit=1`, [
		{
			proxyWallet: "0xinvented",
			name: "someone",
			pseudonym: "Invented-Name",
			timestamp: ts / 1000,
			price: 0.5,
		},
	]);

test("keeps Venezuela events, the leading options of each, and only the time of the last trade", () => {
	const obs = polymarket.normalise([raw(POLYMARKET_EVENTS, events), trade("0xcond1", AT - 3_600_000)]);
	expect(obs.length).toBe(LEADING);
	expect(obs.map((o) => o.value.outcome)).toEqual([
		"Option 1",
		"Option 2",
		"Option 3",
		"Option 4",
		"Option 5",
	]);
	expect(obs[0]?.value).toEqual({
		venue: "polymarket",
		eventId: "1",
		eventTitle: "Invented Venezuela question?",
		eventUrl: "https://polymarket.com/event/invented-venezuela-question",
		marketId: "101",
		outcome: "Option 1",
		question: "Will option 1 happen?",
		lastPrice: 0.5,
		bid: 0.49,
		ask: 0.51,
		lastTradeAt: AT - 3_600_000,
		volume: 1000,
		volume24h: 25.5,
		volumeUnit: "USD",
		closesAt: Date.parse("2026-12-31T12:00:00Z"),
		optionsInEvent: 7,
	});
	expect(obs[1]?.value.lastTradeAt).toBeNull();
	for (const o of obs) {
		expect(o.basis).toBe("quote");
		expect(o.series).toStartWith("market:0xcond");
	}
	const text = JSON.stringify(obs);
	for (const leak of ["0xinvented", "someone", "Invented-Name"]) expect(text).not.toContain(leak);
});

test("topic rule", () => {
	expect(isAboutVenezuela("Maduro prison time?", [])).toBe(true);
	expect(isAboutVenezuela("Will the U.S. invade Cuba?", ["venezuela"])).toBe(false);
	expect(isAboutVenezuela("Venezuela vs Brazil", ["sports", "soccer"])).toBe(false);
	expect(venezuelaEvents(JSON.stringify(events)).map((e) => e.id)).toEqual(["1"]);
});

test("envelopes", () => {
	expect(() => polymarket.normalise([])).toThrow(SchemaError);
	expect(() => polymarket.normalise([{ ...raw(POLYMARKET_EVENTS, {}), body: "<html>" }])).toThrow("JSON");
	expect(() => polymarket.normalise([raw(POLYMARKET_EVENTS, { events: [] })])).toThrow("lista");
});
