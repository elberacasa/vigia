import { expect, test } from "bun:test";
import type { RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { BINANCE_IDENTIFYING_KEYS, BINANCE_PAGE, BINANCE_SEARCH_URL, binanceP2p } from "./index.ts";

/**
 * Synthetic payloads in the shape of Binance's P2P search response (invented prices and counts). The recorded
 * responses stay out of the public repository; these run everywhere.
 */

const FETCHED = Date.UTC(2026, 0, 15, 12, 0);

type AdOver = { price?: string | number; tradeType?: string; orders?: number; finish?: number; max?: string };
function ad(over: AdOver = {}): Record<string, unknown> {
	return {
		adv: {
			tradeType: over.tradeType ?? "SELL",
			asset: "USDT",
			fiatUnit: "VES",
			price: over.price ?? "100.00",
			tradableQuantity: "5000.00",
			minSingleTransAmount: "1000.00",
			maxSingleTransAmount: over.max ?? "200000.00",
			dynamicMaxSingleTransAmount: null,
			isTradable: true,
		},
		advertiser: {
			monthOrderCount: over.orders ?? 150,
			monthFinishRate: over.finish ?? 0.98,
			// Identity fields exist in the real response; the adapter must never read them.
			nickName: "Ejemplo Vendedor",
			userNo: "s00000000000000000000000000000000",
		},
	};
}
function raw(data: unknown[] | null, over: Record<string, unknown> = {}, fetchedAt = FETCHED): RawResponse {
	return {
		url: BINANCE_SEARCH_URL,
		status: 200,
		contentType: "application/json",
		body: JSON.stringify({ code: "000000", message: null, success: true, data, total: 42, ...over }),
		fetchedAt,
	};
}
// Taker buys USDT: advertisers selling, cheapest first. Taker sells: advertisers buying, highest first.
const sells = [101, 102, 103, 104, 105, 106].map((p) => ad({ price: String(p) }));
const buys = [99, 98, 97, 96, 95, 94].map((p) => ad({ price: p, tradeType: "BUY" }));

test("synthetic sample: one quote with both medians, mid and spread, from the later fetch", () => {
	const obs = binanceP2p.normalise([raw(sells), raw(buys, {}, FETCHED + 3_000)]);
	expect(obs.length).toBe(1);
	const o = obs[0];
	expect(o).toMatchObject({
		source: "binance-p2p",
		series: "usdt-ves",
		sourceUrl: BINANCE_PAGE,
		fetchedAt: FETCHED + 3_000,
		observedAt: FETCHED + 3_000,
		licence: "binance-p2p-terms",
		basis: "quote",
		confidence: 0.8,
	});
	expect(o?.value.takerBuy).toEqual({
		status: "ok",
		medianVesPerUsdt: 103.5,
		n: 6,
		considered: 6,
		pricesVes: [101, 102, 103, 104, 105, 106],
	});
	expect(o?.value.takerSell.medianVesPerUsdt).toBe(96.5);
	expect(o?.value.midVesPerUsdt).toBe(100);
	expect(o?.value.spreadPct).toBeCloseTo(7, 10);
	expect(o?.value.totalAds).toEqual({ takerBuy: 42, takerSell: 42 });
});

test("bait ads (few orders, low completion, ticket above the max) are dropped; under 5 left is 'insufficient'", () => {
	const thin = [
		ad({ price: "50" }),
		ad({ price: "90", orders: 3 }),
		ad({ price: "91", finish: 0.5 }),
		ad({ price: "92", max: "20000" }),
		ad({ price: "not a price" }),
	];
	const v = binanceP2p.normalise([raw(thin), raw(buys)])[0]?.value;
	expect(v?.takerBuy.considered).toBe(4);
	expect(v?.takerBuy.status).toBe("insufficient");
	expect(v?.takerBuy.medianVesPerUsdt).toBeNull();
	expect(v?.takerBuy.pricesVes).toEqual([50]);
	expect(v?.midVesPerUsdt).toBeNull();
	expect(v?.spreadPct).toBeNull();
});

test("no advertiser identity reaches the observation", () => {
	const text = JSON.stringify(binanceP2p.normalise([raw(sells), raw(buys)]));
	for (const key of BINANCE_IDENTIFYING_KEYS) expect(text).not.toContain(key);
	expect(text).not.toContain("Ejemplo Vendedor");
});

test("an error envelope, swapped sides, non-JSON or a missing side fail the run with SchemaError", () => {
	const error = raw(null, { code: "000002", message: "illegal parameter", success: false });
	expect(() => binanceP2p.normalise([error, raw(buys)])).toThrow("000002");
	expect(() => binanceP2p.normalise([raw(buys), raw(sells)])).toThrow("se esperaban");
	expect(() => binanceP2p.normalise([{ ...raw(sells), body: "<html>" }, raw(buys)])).toThrow(SchemaError);
	expect(() => binanceP2p.normalise([raw(sells)])).toThrow(SchemaError);
	expect(() => binanceP2p.normalise([{ ...raw(sells), body: '{"data":[]}' }, raw(buys)])).toThrow(
		SchemaError,
	);
});
