import { int, type Lang, num, pct } from "./format.ts";

/*
 * Formatting for the "Liquidez, reservas e intervención" and "Mercados de predicción" panels (panels/Monetary.tsx,
 * panels/Predictions.tsx). Every figure is computed on the server (src/panels/monetary.ts, predictions.ts); these
 * only choose units and words. Tested in monetary-view.test.ts.
 */

/** "2,84 billones" (Spanish billón = 10¹²) / "2.84 trillion"; smaller amounts in millardos / millions. */
export function bigBs(ves: number, lang: Lang): string {
	const es = lang === "es";
	const a = Math.abs(ves);
	if (a >= 1e12) return `${num(ves / 1e12, 2, lang)} ${es ? "billones" : "trillion"}`;
	if (a >= 1e9) return `${num(ves / 1e9, 2, lang)} ${es ? "millardos" : "billion"}`;
	if (a >= 1e6) return `${num(ves / 1e6, 1, lang)} ${es ? "millones" : "million"}`;
	return int(ves, lang);
}

/** Millions of US dollars, as the BCV publishes reserves: "12.727 MM US$" / "US$ 12,727 M". */
export function musd(millions: number, lang: Lang): string {
	return lang === "es" ? `${int(millions, lang)} MM US$` : `US$ ${int(millions, lang)} M`;
}

/** A dollar amount in words: "US$ 3,35 millardos" / "US$ 346 million". */
export function usdWords(usd: number, lang: Lang): string {
	const es = lang === "es";
	if (Math.abs(usd) >= 1e9) return `US$ ${num(usd / 1e9, 2, lang)} ${es ? "millardos" : "billion"}`;
	if (Math.abs(usd) >= 1e6) return `US$ ${int(usd / 1e6, lang)} ${es ? "millones" : "million"}`;
	return `US$ ${int(usd, lang)}`;
}

/** "18/09/2026" (Spanish) or "Sep 18, 2026" (English) from a Caracas calendar date. */
export function calDate(iso: string, lang: Lang): string {
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
	if (!m) return iso;
	const [, y, mo, d] = m;
	if (lang === "es") return `${d}/${mo}/${y}`;
	const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
		Number(mo) - 1
	];
	return `${month} ${Number(d)}, ${y}`;
}

/** A change as a signed percentage with a direction glyph that does not need colour: "▲ +3,3 %". */
export function changeText(p: number, lang: Lang, digits = 1): { glyph: "▲" | "▼" | "="; text: string } {
	const rounded = Number(p.toFixed(digits));
	return { glyph: rounded > 0 ? "▲" : rounded < 0 ? "▼" : "=", text: pct(rounded, digits, lang) };
}

/**
 * A contract price (0–1) as the percentage traders pay: "63,5 %". Under 1 % keeps one decimal, so 0.001 reads
 * "0,1 %", never "0 %"; null (no trade) is "—".
 */
export function priceText(price: number | null, lang: Lang): string {
	if (price === null) return "—";
	const p = price * 100;
	const digits = Number.isInteger(Number(p.toFixed(1))) ? 0 : 1;
	return lang === "es" ? `${num(p, digits, lang)} %` : `${num(p, digits, lang)}%`;
}

/** A 24 h change in price points: "+2,5 pp" / "−0,3 pp"; zero is "sin cambio". */
export function pointsText(points: number, lang: Lang): string {
	if (points === 0) return lang === "es" ? "sin cambio" : "no change";
	const sign = points > 0 ? "+" : "−";
	return `${sign}${num(Math.abs(points), 1, lang)} ${lang === "es" ? "pp" : "pts"}`;
}

/** Volume in its venue's unit: "US$ 3,3 M" or "967.309 contratos". */
export function volumeText(v: number, unit: "USD" | "contracts", lang: Lang): string {
	if (unit === "contracts") return `${int(v, lang)} ${lang === "es" ? "contratos" : "contracts"}`;
	if (v >= 1e6) return `US$ ${num(v / 1e6, 1, lang)} M`;
	if (v >= 1e3) return `US$ ${num(v / 1e3, 1, lang)} k`;
	return `US$ ${int(v, lang)}`;
}
