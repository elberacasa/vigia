/**
 * The pocket converter's arithmetic: one amount, one named rate, one direction. The only numbers the browser
 * computes itself (everything else comes computed from the server), so they live here, pure and tested.
 */

export type Direction = "toForeign" | "toVes";

/** How an amount was read: its value, and whether the text could have meant another number. */
export interface Reading {
	value: number;
	/** "1,500" or "1.500": thousands or a decimal? Settled by the language's convention, and said under the input. */
	ambiguous: boolean;
}

/**
 * Reads an amount the way people type it in Venezuela and elsewhere: "1.500", "1.500,50", "1500,5", "1,500.50",
 * "2.50", "Bs 1.200", "US$ 10". With both separators, the last one is the decimal mark. With one kind only:
 * - several of them, each followed by exactly three digits, are thousands ("1.500.000", "1,500,000");
 * - one of them followed by exactly three digits after a first group of 1 to 3 digits not starting with 0 is
 *   AMBIGUOUS ("1.500", "1,500"): it is read by the language's convention (Spanish: "." thousands and "," decimal;
 *   English the other way round), flagged, and the converter shows what it read;
 * - otherwise it is a decimal mark ("2,5", "0,500" = 0,5: review 4, M3, it was read as 500).
 * Null for anything that is not a non-negative amount.
 */
export function readAmount(text: string, lang: "es" | "en" = "es"): Reading | null {
	const t = text.replace(/\s|us\$|usd|bs\.?|ves|eur|\$|€/gi, "");
	if (!t || !/^[\d.,]+$/.test(t) || !/\d/.test(t)) return null;
	const lastDot = t.lastIndexOf(".");
	const lastComma = t.lastIndexOf(",");
	let normal: string;
	let ambiguous = false;
	if (lastDot !== -1 && lastComma !== -1) {
		const dec = lastDot > lastComma ? "." : ",";
		const thou = dec === "." ? "," : ".";
		const [int, frac, ...rest] = t.split(dec);
		if (rest.length || frac === undefined || int === undefined || !/^\d+$/.test(frac)) return null;
		if (!new RegExp(`^[1-9]\\d{0,2}(\\${thou}\\d{3})+$`).test(int)) return null;
		normal = `${int.split(thou).join("")}.${frac}`;
	} else if (lastDot !== -1 || lastComma !== -1) {
		const sep = lastDot !== -1 ? "." : ",";
		const parts = t.split(sep);
		const grouped =
			parts.length > 1 &&
			/^[1-9]\d{0,2}$/.test(parts[0] ?? "") &&
			parts.slice(1).every((p) => /^\d{3}$/.test(p));
		if (grouped && parts.length > 2) normal = parts.join("");
		else if (grouped) {
			ambiguous = true;
			const thousands = sep === (lang === "es" ? "." : ",");
			normal = thousands ? parts.join("") : `${parts[0]}.${parts[1]}`;
		} else if (parts.length === 2 && /^\d*$/.test(parts[0] ?? "") && /^\d+$/.test(parts[1] ?? ""))
			normal = `${parts[0] || "0"}.${parts[1]}`;
		else return null;
	} else {
		normal = t;
	}
	const n = Number(normal);
	return Number.isFinite(n) && n >= 0 ? { value: n, ambiguous } : null;
}

/** The value of `readAmount`, or null. */
export function parseAmount(text: string, lang: "es" | "en" = "es"): number | null {
	return readAmount(text, lang)?.value ?? null;
}

/** Decimals needed to echo a read amount exactly (up to 8): "leído como 0,5", not "0,50" or "1". */
export function echoDigits(value: number): number {
	for (let d = 0; d <= 8; d++) if (Math.abs(Math.round(value * 10 ** d) - value * 10 ** d) < 1e-6) return d;
	return 8;
}

/** amount in Bs ÷ rate = amount in the foreign currency; amount in foreign currency × rate = Bs. */
export function convert(amount: number, vesPerUnit: number, direction: Direction): number | null {
	if (!Number.isFinite(amount) || amount < 0 || !Number.isFinite(vesPerUnit) || vesPerUnit <= 0) return null;
	return direction === "toForeign" ? amount / vesPerUnit : amount * vesPerUnit;
}

/** How many monthly minimum wages an amount in Bs is. */
export function inWages(ves: number, wageVesMonthly: number): number | null {
	return wageVesMonthly > 0 && Number.isFinite(ves) && ves >= 0 ? ves / wageVesMonthly : null;
}

/** Digits worth showing for a converted amount: cents for money, more for tiny amounts (Bs 130 = US$0.15). */
export function digitsFor(value: number): number {
	const a = Math.abs(value);
	return a === 0 || a >= 1 ? 2 : a >= 0.01 ? 2 : 4;
}
