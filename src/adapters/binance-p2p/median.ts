/**
 * The robust P2P median, shared by the Binance and Bybit adapters. Deterministic and tested; it is the only
 * place a P2P figure is computed.
 *
 * 1. Ask the venue for ads a retail buyer could actually take: a typical ticket (`TICKET_VES`), best price
 *    first, 20 per side.
 * 2. Keep an ad only if it is tradable, the ticket fits between its min and max, it has enough stock for the
 *    ticket, and its advertiser completed at least 20 orders in 30 days at ≥ 90 % (drops bait prices).
 * 3. Take the first 10 survivors in the venue's order. Fewer than 5: "sin datos suficientes", no number.
 * 4. Report the median of those prices per side, the mid of both medians and the spread between them.
 *
 * Advertiser names and ids never enter this module: adapters map raw ads to `P2pAd` first.
 */

/** 50,000 Bs ≈ US$52 at the 2026-09-24 rate: a typical retail ticket. Revisit as the rate moves. */
export const TICKET_VES = 50_000;
export const TOP_N = 10;
export const MIN_N = 5;
export const MIN_ORDERS_30D = 20;
export const MIN_COMPLETION = 0.9;

export type P2pAd = {
	readonly priceVes: number;
	readonly tradable: boolean;
	readonly minVes: number;
	readonly maxVes: number;
	/** Stock available, in the asset (USDT). */
	readonly availableAsset: number;
	/** Orders completed by the advertiser in the last 30 days. */
	readonly orders30d: number;
	/** Completion rate 0..1 over the last 30 days. */
	readonly completion: number;
};

export type P2pSide = {
	readonly status: "ok" | "insufficient";
	/** Median of the kept ads' prices, Bs per USDT; null when fewer than MIN_N ads survive. */
	readonly medianVesPerUsdt: number | null;
	/** Ads used for the median (≤ TOP_N). */
	readonly n: number;
	/** Ads the venue returned for this side before filtering. */
	readonly considered: number;
	/** Prices of the ads used, in the venue's order (best first). */
	readonly pricesVes: number[];
};

export type P2pSample = {
	readonly asset: "USDT";
	readonly ticketVes: number;
	/** Ads where the taker buys USDT (advertisers selling): what it costs to get dollars. */
	readonly takerBuy: P2pSide;
	/** Ads where the taker sells USDT (advertisers buying): what you get for your dollars. */
	readonly takerSell: P2pSide;
	/** (buy median + sell median) / 2, when both sides have enough data. */
	readonly midVesPerUsdt: number | null;
	/** (buy median − sell median) / mid × 100. */
	readonly spreadPct: number | null;
	/** The venue's total count of matching ads per side, when it reports one. */
	readonly totalAds: { readonly takerBuy: number | null; readonly takerSell: number | null };
};

export function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const hi = sorted[mid] as number;
	return sorted.length % 2 === 1 ? hi : ((sorted[mid - 1] as number) + hi) / 2;
}

export function keepAd(ad: P2pAd, ticketVes = TICKET_VES): boolean {
	return (
		ad.tradable &&
		Number.isFinite(ad.priceVes) &&
		ad.priceVes > 0 &&
		ad.minVes <= ticketVes &&
		ad.maxVes >= ticketVes &&
		ad.availableAsset * ad.priceVes >= ticketVes &&
		ad.orders30d >= MIN_ORDERS_30D &&
		ad.completion >= MIN_COMPLETION
	);
}

export function robustSide(ads: readonly P2pAd[], ticketVes = TICKET_VES): P2pSide {
	const kept = ads.filter((ad) => keepAd(ad, ticketVes)).slice(0, TOP_N);
	const pricesVes = kept.map((ad) => ad.priceVes);
	const ok = kept.length >= MIN_N;
	return {
		status: ok ? "ok" : "insufficient",
		medianVesPerUsdt: ok ? median(pricesVes) : null,
		n: kept.length,
		considered: ads.length,
		pricesVes,
	};
}

export function sample(
	takerBuyAds: readonly P2pAd[],
	takerSellAds: readonly P2pAd[],
	totalAds: P2pSample["totalAds"],
	ticketVes = TICKET_VES,
): P2pSample {
	const takerBuy = robustSide(takerBuyAds, ticketVes);
	const takerSell = robustSide(takerSellAds, ticketVes);
	const b = takerBuy.medianVesPerUsdt;
	const s = takerSell.medianVesPerUsdt;
	const mid = b !== null && s !== null ? (b + s) / 2 : null;
	return {
		asset: "USDT",
		ticketVes,
		takerBuy,
		takerSell,
		midVesPerUsdt: mid,
		spreadPct: mid !== null && b !== null && s !== null ? ((b - s) / mid) * 100 : null,
		totalAds,
	};
}

/** Replaces the values of identifying keys anywhere in a JSON document (for recorded fixtures). */
export function redactJson(text: string, keys: readonly string[]): string {
	const set = new Set(keys);
	const walk = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(walk);
		if (v && typeof v === "object") {
			const out: Record<string, unknown> = {};
			for (const [k, x] of Object.entries(v)) out[k] = set.has(k) && x !== null ? "redacted" : walk(x);
			return out;
		}
		return v;
	};
	return JSON.stringify(walk(JSON.parse(text)));
}
