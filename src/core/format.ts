/**
 * Numbers and counts in the text the server returns: Spanish decimals and grouping ("6,82 MW", "1.234"), English
 * for the English strings, and nouns that agree with their number ("1 gaceta", "6 gacetas"). One place, tested
 * (format.test.ts), so no string the API sends says "6.82 MW" or "1 gacetas".
 */

export type Lang = "es" | "en";

const formats = new Map<string, Intl.NumberFormat>();
function formatter(lang: Lang, min: number, max: number): Intl.NumberFormat {
	const key = `${lang}:${min}:${max}`;
	let f = formats.get(key);
	if (!f) {
		f = new Intl.NumberFormat(lang === "es" ? "es-VE" : "en-US", {
			minimumFractionDigits: min,
			maximumFractionDigits: max,
		});
		formats.set(key, f);
	}
	return f;
}

/**
 * A number as a reader of that language writes it: `num(6.82)` → "6,82", `num(1234.5, "en")` → "1,234.5",
 * `num(43401)` → "43.401". At most `digits` decimals (2 by default), at least `min` (0). Never "-0".
 */
export function num(x: number, lang: Lang = "es", digits = 2, min = 0): string {
	if (!Number.isFinite(x)) return "—";
	const s = formatter(lang, Math.min(min, digits), digits).format(x);
	return /^-0(?:[.,]0+)?$/.test(s) ? s.slice(1) : s;
}

/** A signed percentage: `pct(8.04)` → "+8 %", `pct(-0.5, "es", 1)` → "−0,5 %" (a true minus sign). */
export function pct(x: number, lang: Lang = "es", digits = 1): string {
	const body = num(Math.abs(x), lang, digits);
	const zero = body.replace(/[0.,]/g, "") === "";
	return `${zero ? "" : x > 0 ? "+" : "−"}${body} %`;
}

/** Spanish and English agree the same way: 1 is singular, every other number (0, 2, 1,5) plural. */
export const isSingular = (n: number): boolean => n === 1;

/**
 * The number and a noun that agrees with it: `count(1, "gaceta", "gacetas")` → "1 gaceta",
 * `count(1250, "titular", "titulares")` → "1.250 titulares". Whole numbers unless `digits` is given.
 */
export function count(n: number, singular: string, plural: string, lang: Lang = "es", digits = 0): string {
	return `${num(n, lang, digits)} ${isSingular(n) ? singular : plural}`;
}

/** Both languages at once, for the bilingual strings the API returns: `bi(n, ["gaceta", "gacetas"], ["gazette", "gazettes"])`. */
export function bi(
	n: number,
	es: readonly [string, string],
	en: readonly [string, string],
	digits = 0,
): { es: string; en: string } {
	return { es: count(n, es[0], es[1], "es", digits), en: count(n, en[0], en[1], "en", digits) };
}
