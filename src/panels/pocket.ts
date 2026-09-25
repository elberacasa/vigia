import { bcvApi } from "../adapters/bcv-api/index.ts";
import { bcvHistory } from "../adapters/bcv-history/index.ts";
import type { Store } from "../core/store.ts";
import type { Panel, PanelReader } from "../server/panels.ts";
import { type MoneyView, moneyView } from "./money.ts";
import { MINIMUM_WAGE, PENDING, type Pending, type PublishedFigure } from "./pocket-published.ts";

/**
 * "¿Cuánto es en dólares? ¿Cuánto vale mi sueldo?" The rates a Venezuelan converts with, each one named and dated,
 * never blended: the BCV's official USD and EUR, and, labelled apart, the third-party quotes the Dollar panel
 * already shows (Yadio, and P2P medians when those opt-in feeds run). The browser multiplies an amount the reader
 * types by one of these rates (web/src/lib/convert.ts, tested); every other number is computed here.
 */

export type PocketRate = {
	/** "bcv-usd", "bcv-eur", "yadio", "p2p:binance-p2p"… */
	id: string;
	kind: "official" | "quote";
	currency: "USD" | "EUR";
	labelEs: string;
	labelEn: string;
	/** Bolívares per unit (per USDT for P2P). */
	vesPerUnit: number;
	/** When the rate is true: the Fecha Valor's 00:00 for the BCV, the quote time otherwise. */
	asOf: number;
	/** When Vigía received it (for a BCV figure via bcv-api, bcv-api's own read of the BCV). */
	fetchedAt: number;
	feed: string;
	sourceUrl: string;
	stale: boolean;
	/** Short caveat shown with the rate. */
	noteEs: string | null;
	noteEn: string | null;
};

export type WageInCurrency = { rateId: string; amount: number; currency: "USD" | "EUR" };

export type PocketView = {
	rates: PocketRate[];
	wage: PublishedFigure & {
		/** Bs per working day: the decree's own rule (art. 1: the monthly wage "dividido entre treinta (30) días"). */
		vesDaily: number;
		/** The monthly wage at each rate above. */
		inCurrency: WageInCurrency[];
	};
	pending: Pending[];
	ruleEs: string;
	ruleEn: string;
};

export const POCKET_RULE_ES =
	"Cada conversión usa una sola tasa, con su nombre y su fecha: monto en Bs ÷ tasa = monto en divisa, y al revés. Las tasas no se promedian ni se mezclan. El salario mínimo en divisa es Bs 130 ÷ cada tasa.";
export const POCKET_RULE_EN =
	"Each conversion uses one rate, named and dated: amount in Bs ÷ rate = amount in foreign currency, and back. Rates are never averaged or mixed. The minimum wage in foreign currency is Bs 130 ÷ each rate.";

export function pocketRates(m: MoneyView): PocketRate[] {
	const out: PocketRate[] = [];
	for (const o of [m.official.usd, m.official.eur]) {
		const c = o.current;
		if (!c) continue;
		const via = c.route
			? { es: `vía ${c.route.label}`, en: `via ${c.route.label}` }
			: c.feed === bcvHistory.id
				? { es: "del archivo histórico del BCV", en: "from the BCV's history file" }
				: null;
		out.push({
			id: o.currency === "USD" ? "bcv-usd" : "bcv-eur",
			kind: "official",
			currency: o.currency,
			labelEs: `BCV oficial (${o.currency})`,
			labelEn: `BCV official (${o.currency})`,
			vesPerUnit: c.vesPerUnit,
			asOf: c.validFrom,
			fetchedAt: c.route?.readAt ?? c.fetchedAt,
			feed: c.route ? bcvApi.id : c.feed,
			sourceUrl: c.sourceUrl,
			stale: o.stale,
			noteEs: via ? `Tasa de referencia del BCV, ${via.es}.` : "Tasa de referencia del BCV (venta).",
			noteEn: via ? `The BCV's reference rate, ${via.en}.` : "The BCV's reference rate (sell).",
		});
	}
	const y = m.yadio;
	if (y.figure) {
		out.push({
			id: "yadio",
			kind: "quote",
			currency: "USD",
			labelEs: "Yadio",
			labelEn: "Yadio",
			vesPerUnit: y.figure.vesPerUsd,
			asOf: y.figure.observedAt,
			fetchedAt: y.figure.fetchedAt,
			feed: y.feed,
			sourceUrl: y.sourceUrl,
			stale: y.stale,
			noteEs: "Índice de Yadio a partir de anuncios P2P; su fórmula no es pública.",
			noteEn: "Yadio's index built from P2P ads; its formula is not public.",
		});
	}
	for (const p of m.p2p) {
		const buy = p.buy.medianVesPerUsdt;
		if (p.buy.status !== "ok" || buy === null) continue;
		out.push({
			id: `p2p:${p.feed}`,
			kind: "quote",
			currency: "USD",
			labelEs: `${p.label.split(",")[0] ?? p.label} (USDT)`,
			labelEn: `${p.label.split(",")[0] ?? p.label} (USDT)`,
			vesPerUnit: buy,
			asOf: p.observedAt,
			fetchedAt: p.fetchedAt,
			feed: p.feed,
			sourceUrl: p.sourceUrl,
			stale: p.stale,
			noteEs: `Mediana de ${p.buy.n} anuncios de venta de USDT (${p.label}): lo que cuesta comprar un USDT, no un dólar en efectivo.`,
			noteEn: `Median of ${p.buy.n} ads selling USDT: what one USDT costs to buy, not a cash dollar.`,
		});
	}
	return out.filter((r) => Number.isFinite(r.vesPerUnit) && r.vesPerUnit > 0);
}

export function pocketView(money: MoneyView): PocketView {
	const rates = pocketRates(money);
	return {
		rates,
		wage: {
			...MINIMUM_WAGE,
			vesDaily: MINIMUM_WAGE.vesMonthly / 30,
			inCurrency: rates.map((r) => ({
				rateId: r.id,
				amount: MINIMUM_WAGE.vesMonthly / r.vesPerUnit,
				currency: r.currency,
			})),
		},
		pending: [...PENDING],
		ruleEs: POCKET_RULE_ES,
		ruleEn: POCKET_RULE_EN,
	};
}

export const pocketPanel: Panel<PocketView> = {
	id: "pocket",
	sources: ["bcv-official", bcvApi.id, bcvHistory.id, "yadio", "binance-p2p", "bybit-p2p"],
	compute: (store: Store, now: number, read?: PanelReader) =>
		pocketView((read?.("money") as MoneyView | undefined) ?? moneyView(store, now)),
};
