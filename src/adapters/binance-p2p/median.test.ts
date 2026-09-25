import { expect, test } from "bun:test";
import { keepAd, median, type P2pAd, redactJson, robustSide, sample } from "./median.ts";

const ad = (priceVes: number, over: Partial<P2pAd> = {}): P2pAd => ({
	priceVes,
	tradable: true,
	minVes: 1_000,
	maxVes: 1_000_000,
	availableAsset: 100_000,
	orders30d: 100,
	completion: 0.99,
	...over,
});

test("median of odd and even lists", () => {
	expect(median([3, 1, 2])).toBe(2);
	expect(median([4, 1, 3, 2])).toBe(2.5);
	expect(median([])).toBeNull();
});

test("filters: ticket within limits, enough stock, 20 orders, 90 % completion, tradable", () => {
	expect(keepAd(ad(960))).toBe(true);
	expect(keepAd(ad(960, { minVes: 60_000 }))).toBe(false);
	expect(keepAd(ad(960, { maxVes: 40_000 }))).toBe(false);
	expect(keepAd(ad(960, { availableAsset: 52 }))).toBe(false); // 52 × 960 = 49,920 < 50,000
	expect(keepAd(ad(960, { orders30d: 19 }))).toBe(false);
	expect(keepAd(ad(960, { completion: 0.89 }))).toBe(false);
	expect(keepAd(ad(960, { tradable: false }))).toBe(false);
});

test("takes the first 10 survivors in venue order, not the 10 cheapest", () => {
	const ads = [ad(1, { orders30d: 0 }), ...[10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 5].map((p) => ad(p))];
	const side = robustSide(ads);
	expect(side.n).toBe(10);
	expect(side.pricesVes).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
	expect(side.medianVesPerUsdt).toBe(14.5);
	expect(side.considered).toBe(13);
});

test("fewer than 5 usable ads: no number, 'insufficient'", () => {
	const side = robustSide([ad(10), ad(11), ad(12), ad(13), ad(14, { completion: 0.5 })]);
	expect(side).toEqual({
		status: "insufficient",
		medianVesPerUsdt: null,
		n: 4,
		considered: 5,
		pricesVes: [10, 11, 12, 13],
	});
});

test("mid and spread from both medians; null when a side is insufficient", () => {
	const buy = [970, 971, 972, 973, 974].map((p) => ad(p));
	const sell = [966, 965, 964, 963, 962].map((p) => ad(p));
	const s = sample(buy, sell, { takerBuy: 100, takerSell: 200 });
	expect(s.midVesPerUsdt).toBe(968);
	expect(s.spreadPct).toBeCloseTo((8 / 968) * 100, 10);
	const thin = sample(buy, sell.slice(0, 2), { takerBuy: null, takerSell: null });
	expect(thin.midVesPerUsdt).toBeNull();
	expect(thin.spreadPct).toBeNull();
	expect(thin.takerBuy.medianVesPerUsdt).toBe(972);
});

test("redaction replaces identifying keys at any depth and keeps the rest", () => {
	const text = JSON.stringify({
		data: [{ advertiser: { nickName: "someone", monthOrderCount: 3 }, adv: { advNo: "123" } }],
	});
	expect(JSON.parse(redactJson(text, ["nickName", "advNo"]))).toEqual({
		data: [{ advertiser: { nickName: "redacted", monthOrderCount: 3 }, adv: { advNo: "redacted" } }],
	});
});
