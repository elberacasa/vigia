export type Lang = "es" | "en";

/** A picker for one language: `const t = tr(lang); t("Hola", "Hello")`. Both strings are always written. */
export function tr(lang: Lang) {
	return (es: string, en: string): string => (lang === "es" ? es : en);
}

const CARACAS = "America/Caracas";

/** Numbers as a Venezuelan reader writes them (855,66) in Spanish, and 855.66 in English. */
export function num(lang: Lang, value: number, digits = 0): string {
	return new Intl.NumberFormat(lang === "es" ? "es-VE" : "en-US", {
		minimumFractionDigits: digits,
		maximumFractionDigits: digits,
	}).format(value);
}

/** "25 sept 2026, 07:00" in Caracas time. */
export function when(lang: Lang, ms: number, withYear = true): string {
	const d = new Date(ms);
	const day = new Intl.DateTimeFormat(lang === "es" ? "es-VE" : "en-GB", {
		timeZone: CARACAS,
		day: "numeric",
		month: "short",
		...(withYear ? { year: "numeric" } : {}),
	}).format(d);
	const time = new Intl.DateTimeFormat("en-GB", {
		timeZone: CARACAS,
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).format(d);
	return `${day.replace(/\./g, "")}, ${time}`;
}

export const REPO = "https://github.com/elberacasa/vigia";
export const blob = (path: string) => `${REPO}/blob/main/${path}`;
