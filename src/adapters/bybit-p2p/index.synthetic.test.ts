import { expect, test } from "bun:test";
import type { RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { BYBIT_ONLINE_URL, BYBIT_PAGE, bybitP2p } from "./index.ts";

/**
 * Synthetic payloads in the shape of Bybit's P2P "online items" response (invented prices and counts). The
 * recorded responses stay out of the public repository; these run everywhere.
 */

const FETCHED = Date.UTC(2026, 0, 15, 12, 0);

function item(side: 0 | 1, price: string, over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "0000000000000000000",
		accountId: "0000000",
		nickName: "Ejemplo Comprador",
		tokenId: "USDT",
		currencyId: "VES",
		side,
		price,
		lastQuantity: "3000.0000",
		minAmount: "1000.0000",
		maxAmount: "300000.0000",
		recentOrderNum: 80,
		recentExecuteRate: 97,
		remark: "texto libre del anunciante",
		...over,
	};
}
function raw(items: unknown[] | null, count = 30, fetchedAt = FETCHED): RawResponse {
	return {
		url: BYBIT_ONLINE_URL,
		status: 200,
		contentType: "application/json; charset=utf-8",
		body: JSON.stringify({ ret_code: 0, ret_msg: "SUCCESS", result: { count, items } }),
		fetchedAt,
	};
}
// Side 1: advertisers selling USDT (the taker buys), cheapest first. Side 0: advertisers buying, highest first.
const sellers = ["201", "202", "203", "204", "205"].map((p) => item(1, p));
const buyers = ["199", "198", "197", "196", "195"].map((p) => item(0, p));

test("synthetic sample: one quote with both medians from the robust rule", () => {
	const obs = bybitP2p.normalise([raw(sellers, 12), raw(buyers, 7, FETCHED + 4_000)]);
	expect(obs.length).toBe(1);
	expect(obs[0]).toMatchObject({
		source: "bybit-p2p",
		series: "usdt-ves",
		sourceUrl: BYBIT_PAGE,
		fetchedAt: FETCHED + 4_000,
		observedAt: FETCHED + 4_000,
		licence: "bybit-p2p-terms",
		basis: "quote",
		confidence: 0.8,
	});
	const v = obs[0]?.value;
	expect(v?.takerBuy).toMatchObject({ status: "ok", n: 5, considered: 5, medianVesPerUsdt: 203 });
	expect(v?.takerSell).toMatchObject({ status: "ok", n: 5, medianVesPerUsdt: 197 });
	expect(v?.midVesPerUsdt).toBe(200);
	expect(v?.spreadPct).toBeCloseTo(3, 10);
	expect(v?.totalAds).toEqual({ takerBuy: 12, takerSell: 7 });
});

test("completion is a percentage (89 is below the 90 % floor); a malformed item is skipped", () => {
	const low = sellers.map((s) => ({ ...s, recentExecuteRate: 89 }));
	expect(bybitP2p.normalise([raw(low), raw(buyers)])[0]?.value.takerBuy).toMatchObject({
		status: "insufficient",
		n: 0,
		medianVesPerUsdt: null,
	});
	const broken = [item(1, "x"), ...sellers];
	expect(bybitP2p.normalise([raw(broken), raw(buyers)])[0]?.value.takerBuy.considered).toBe(5);
});

test("no advertiser identity or free text reaches the observation", () => {
	const text = JSON.stringify(bybitP2p.normalise([raw(sellers), raw(buyers)]));
	for (const needle of ["nickName", "accountId", "remark", "Ejemplo Comprador", "texto libre"]) {
		expect(text).not.toContain(needle);
	}
});

test("an error code, swapped sides, non-JSON or a missing side fail the run with SchemaError", () => {
	const error: RawResponse = {
		...raw(null),
		body: '{"ret_code":10001,"ret_msg":"params error","result":null}',
	};
	expect(() => bybitP2p.normalise([error, raw(buyers)])).toThrow("10001");
	expect(() => bybitP2p.normalise([raw(buyers), raw(sellers)])).toThrow("se esperaban");
	expect(() => bybitP2p.normalise([{ ...raw(sellers), body: "<html>" }, raw(buyers)])).toThrow(SchemaError);
	expect(() => bybitP2p.normalise([raw(sellers)])).toThrow(SchemaError);
});
