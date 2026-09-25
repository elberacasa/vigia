import { expect, test } from "bun:test";
import { join } from "node:path";
import { hasFixture, loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { BYBIT_IDENTIFYING_KEYS, bybitP2p, onlineBody } from "./index.ts";

// Recorded exchange responses are not redistributed (the terms forbid automated access), so they are absent from
// the public repository; index.synthetic.test.ts covers the adapter there.
const FIXTURE = join(import.meta.dir, "fixtures", "2026-09-24");
const recorded = hasFixture(FIXTURE);
const raws = recorded ? loadFixture(FIXTURE) : [];
const [buyRaw, sellRaw] = raws as [RawResponse, RawResponse];

test.skipIf(!recorded)("normalises a recorded sample into one observation with both medians", () => {
	const obs = bybitP2p.normalise(raws);
	expect(obs.length).toBe(1);
	const o = obs[0];
	expect(o?.source).toBe("bybit-p2p");
	expect(o?.series).toBe("usdt-ves");
	expect(o?.basis).toBe("quote");
	expect(o?.observedAt).toBe(o?.fetchedAt ?? -1);
	const v = o?.value;
	expect(v?.takerBuy).toMatchObject({ status: "ok", n: 10, considered: 20, medianVesPerUsdt: 968.845 });
	expect(v?.takerSell).toMatchObject({ status: "ok", n: 10, considered: 20, medianVesPerUsdt: 964.005 });
	expect(v?.totalAds).toEqual({ takerBuy: 57, takerSell: 101 });
	expect(v?.spreadPct).toBeGreaterThan(0);
});

test.skipIf(!recorded)("completion is read as a percentage (recentExecuteRate 95 → 0.95)", () => {
	const body = JSON.parse(buyRaw.body);
	for (const item of body.result.items) item.recentExecuteRate = 89;
	const v = bybitP2p.normalise([{ ...buyRaw, body: JSON.stringify(body) }, sellRaw])[0]?.value;
	expect(v?.takerBuy.status).toBe("insufficient");
	expect(v?.takerBuy.n).toBe(0);
});

test.skipIf(!recorded)("no advertiser identity in observations or fixtures", () => {
	const text = JSON.stringify(bybitP2p.normalise(raws));
	for (const key of BYBIT_IDENTIFYING_KEYS) expect(text).not.toContain(`"${key}"`);
	for (const raw of raws) expect(raw.body).not.toMatch(/"(nickName|userId|accountId|remark)":"(?!redacted)/);
});

test.skipIf(!recorded)("a malformed item is skipped; an error envelope or swapped sides fail", () => {
	const body = JSON.parse(buyRaw.body);
	body.result.items[0].price = "x";
	const v = bybitP2p.normalise([{ ...buyRaw, body: JSON.stringify(body) }, sellRaw])[0]?.value;
	expect(v?.takerBuy.considered).toBe(19);
	expect(() =>
		bybitP2p.normalise([
			{ ...buyRaw, body: '{"ret_code":10001,"ret_msg":"params error","result":null}' },
			sellRaw,
		]),
	).toThrow("10001");
	expect(() => bybitP2p.normalise([sellRaw, buyRaw])).toThrow("se esperaban");
});

test("request: 20 ads filtered to the ticket; opt-in with reasons", () => {
	expect(JSON.parse(onlineBody("1"))).toMatchObject({
		side: "1",
		size: "20",
		amount: "50000",
		currencyId: "VES",
	});
	expect(bybitP2p.optIn?.es).toContain("no documentada");
	expect(bybitP2p.optIn?.en).toContain("undocumented");
});
