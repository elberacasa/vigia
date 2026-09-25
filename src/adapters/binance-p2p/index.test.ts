import { expect, test } from "bun:test";
import { join } from "node:path";
import { hasFixture, loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { BINANCE_IDENTIFYING_KEYS, binanceP2p, searchBody } from "./index.ts";

// Recorded exchange responses are not redistributed (the terms forbid automated access), so they are absent from
// the public repository; index.synthetic.test.ts covers the adapter there.
const FIXTURE = join(import.meta.dir, "fixtures", "2026-09-24");
const NO_TICKET = join(import.meta.dir, "fixtures", "2026-09-24-no-ticket");
const recorded = hasFixture(FIXTURE) && hasFixture(NO_TICKET);
const raws = recorded ? loadFixture(FIXTURE) : [];
const noTicket = recorded ? loadFixture(NO_TICKET) : [];

test.skipIf(!recorded)(
	"normalises a recorded sample (request filtered to a 50,000 Bs ticket) into one observation",
	() => {
		const obs = binanceP2p.normalise(raws);
		expect(obs.length).toBe(1);
		const o = obs[0];
		expect(o?.series).toBe("usdt-ves");
		expect(o?.basis).toBe("quote");
		expect(o?.source).toBe("binance-p2p");
		expect(o?.observedAt).toBe(o?.fetchedAt ?? -1);
		const v = o?.value;
		expect(v?.takerBuy.status).toBe("ok");
		expect(v?.takerBuy.n).toBe(10);
		expect(v?.takerBuy.medianVesPerUsdt).toBe(968.793);
		expect(v?.takerSell.medianVesPerUsdt).toBe(964.25);
		expect(v?.midVesPerUsdt).toBeCloseTo(966.5215, 6);
		expect(v?.spreadPct).toBeCloseTo(((968.793 - 964.25) / 966.5215) * 100, 8);
		// Sellers' asks are sorted up, buyers' bids down.
		const buy = v?.takerBuy.pricesVes ?? [];
		expect([...buy].sort((a, b) => a - b)).toEqual(buy);
	},
);

test.skipIf(!recorded)(
	"without the ticket filter in the request, the code filter leaves 4 buy ads: 'sin datos suficientes'",
	() => {
		const v = binanceP2p.normalise(noTicket)[0]?.value;
		expect(v?.takerBuy.considered).toBe(20);
		expect(v?.takerBuy.n).toBe(4);
		expect(v?.takerBuy.status).toBe("insufficient");
		expect(v?.takerBuy.medianVesPerUsdt).toBeNull();
		expect(v?.takerBuy.pricesVes).toEqual([967, 968, 968.375, 968.4]);
		expect(v?.midVesPerUsdt).toBeNull();
		expect(v?.totalAds).toEqual({ takerBuy: 1055, takerSell: 2237 });
	},
);

test.skipIf(!recorded)("no advertiser identity reaches an observation or the recorded fixtures", () => {
	const text = JSON.stringify([...binanceP2p.normalise(raws), ...binanceP2p.normalise(noTicket)]);
	for (const key of BINANCE_IDENTIFYING_KEYS) expect(text).not.toContain(key);
	for (const raw of [...raws, ...noTicket]) {
		expect(raw.body).not.toMatch(/"(nickName|userNo|advNo)":"(?!redacted)/);
	}
});

test.skipIf(!recorded)("a malformed ad is skipped; an error envelope or swapped sides fail the run", () => {
	const buy = JSON.parse(raws[0]?.body ?? "{}");
	buy.data[0].adv.price = "n/a";
	const obs = binanceP2p.normalise([
		{ ...(raws[0] as RawResponse), body: JSON.stringify(buy) },
		raws[1] as RawResponse,
	]);
	expect(obs[0]?.value.takerBuy.considered).toBe(19);
	const illegal = '{"code":"000002","message":"illegal parameter","data":null,"success":false}';
	expect(() =>
		binanceP2p.normalise([{ ...(raws[0] as RawResponse), body: illegal }, raws[1] as RawResponse]),
	).toThrow("000002");
	expect(() => binanceP2p.normalise([raws[1] as RawResponse, raws[0] as RawResponse])).toThrow(
		"se esperaban",
	);
	expect(() =>
		binanceP2p.normalise([{ ...(raws[0] as RawResponse), body: "<html>" }, raws[1] as RawResponse]),
	).toThrow("JSON");
	expect(() => binanceP2p.normalise([raws[0] as RawResponse])).toThrow("2");
});

test("request body: 20 rows, taker side, retail ticket; opt-in with reasons in both languages", () => {
	const body = JSON.parse(searchBody("SELL"));
	expect(body).toMatchObject({
		fiat: "VES",
		asset: "USDT",
		tradeType: "SELL",
		rows: 20,
		transAmount: "50000",
	});
	expect(binanceP2p.optIn?.es).toContain("prohíben el acceso automatizado");
	expect(binanceP2p.optIn?.en).toContain("forbid automated access");
	expect(binanceP2p.intervalMs).toBeGreaterThanOrEqual(10 * 60_000);
});
