import { expect, test } from "bun:test";
import type { RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { kalshi, openEvents, venezuelaSeries } from "./index.ts";

/** Synthetic answers in the shapes of Kalshi's public trade API; tickers, prices and times are invented. */
const AT = Date.UTC(2026, 0, 15, 12);
const API = "https://api.elections.kalshi.com/trade-api/v2";
const raw = (url: string, body: unknown): RawResponse => ({
	url,
	status: 200,
	contentType: "application/json",
	body: JSON.stringify(body),
	fetchedAt: AT,
});
const mkt = (t: string, price: string, extra: Record<string, unknown> = {}) => ({
	ticker: t,
	title: "Who will be invented?",
	yes_sub_title: `Option ${t}`,
	status: "active",
	last_price_dollars: price,
	yes_bid_dollars: "0.1000",
	yes_ask_dollars: "0.1200",
	volume_fp: "1500.00",
	volume_24h_fp: "12.00",
	close_time: "2026-12-31T15:00:00Z",
	...extra,
});
const events = raw(`${API}/events?series_ticker=KXINVENTEDVE&status=open&with_nested_markets=true`, {
	events: [
		{
			event_ticker: "KXINVENTEDVE-26",
			series_ticker: "KXINVENTEDVE",
			title: "Invented Venezuela event",
			sub_title: "2026",
			markets: [
				mkt("A", "0.7000"),
				mkt("B", "0.2000"),
				mkt("C", "0.0100", { status: "settled" }),
				{ nope: 1 },
			],
		},
	],
});
const trades = raw(`${API}/markets/trades?ticker=A&limit=1`, {
	trades: [
		{ ticker: "A", created_time: "2026-01-15T11:00:00Z", yes_price_dollars: "0.7000", count_fp: "3.00" },
	],
});

test("markets of open events, leading first, with the last trade's time; prices in dollars, volumes in contracts", () => {
	const obs = kalshi.normalise([events, trades]);
	expect(obs.map((o) => o.value.outcome)).toEqual(["Option A", "Option B"]);
	expect(obs[0]?.value).toEqual({
		venue: "kalshi",
		eventId: "KXINVENTEDVE-26",
		eventTitle: "Invented Venezuela event (2026)",
		eventUrl: "https://kalshi.com/markets/kxinventedve",
		marketId: "A",
		outcome: "Option A",
		question: "Who will be invented?",
		lastPrice: 0.7,
		bid: 0.1,
		ask: 0.12,
		lastTradeAt: Date.parse("2026-01-15T11:00:00Z"),
		volume: 1500,
		volume24h: 12,
		volumeUnit: "contracts",
		closesAt: Date.parse("2026-12-31T15:00:00Z"),
		optionsInEvent: 2,
	});
	expect(obs[1]?.value.lastTradeAt).toBeNull();
});

test("series discovery keeps Venezuela titles and drops sports", () => {
	const body = JSON.stringify({
		series: [
			{
				ticker: "KXA",
				title: "Will Venezuela invent a thing?",
				category: "Politics",
				tags: ["International"],
			},
			{ ticker: "KXB", title: "Venezuela invented league", category: "Sports", tags: ["Soccer"] },
			{ ticker: "KXC", title: "Unrelated question", category: "Politics" },
			{ bad: true },
		],
	});
	expect(venezuelaSeries([body])).toEqual(["KXA"]);
	expect(() => venezuelaSeries(["<html>"])).toThrow(SchemaError);
	expect(openEvents(JSON.stringify({ events: [] }))).toEqual([]);
	expect(() => openEvents("{}")).toThrow("events");
});
