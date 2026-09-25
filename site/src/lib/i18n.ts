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

/** "25 sept 2026" for an ISO date (YYYY-MM-DD), read as a calendar day (no time zone shift). */
export function day(lang: Lang, iso: string): string {
	return new Intl.DateTimeFormat(lang === "es" ? "es-VE" : "en-GB", {
		timeZone: "UTC",
		day: "numeric",
		month: "short",
		year: "numeric",
	})
		.format(new Date(`${iso}T12:00:00Z`))
		.replace(/\./g, "");
}

export const REPO = "https://github.com/elberacasa/vigia";
/** The ideas box: GitHub Discussions' Ideas category, where people propose and vote (no backend of ours). */
export const IDEAS = `${REPO}/discussions/categories/ideas`;

/** The site's pages in each language. */
export type Page = "home" | "sources" | "changelog";
export const PATHS: Readonly<Record<Page | "feed", Readonly<Record<Lang, string>>>> = {
	home: { es: "/", en: "/en" },
	sources: { es: "/fuentes", en: "/en/sources" },
	changelog: { es: "/cambios", en: "/en/changelog" },
	feed: { es: "/cambios.xml", en: "/en/changelog.xml" },
};
export const blob = (path: string) => `${REPO}/blob/main/${path}`;
