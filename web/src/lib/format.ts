/** Formatting only. Numbers arrive computed from the server; the client never does data arithmetic. */

export type Lang = "es" | "en";
export const TZ = "America/Caracas";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "hace 3 min" / "3 min ago". Precise enough to judge freshness at a glance. */
export function ago(ms: number, lang: Lang = "es"): string {
	const d = Math.max(0, ms);
	let n: number;
	let unit: string;
	if (d < 45_000) return lang === "es" ? "ahora" : "now";
	if (d < HOUR) {
		n = Math.round(d / MIN);
		unit = "min";
	} else if (d < DAY) {
		n = Math.floor(d / HOUR);
		unit = "h";
	} else {
		n = Math.floor(d / DAY);
		unit = lang === "es" ? "d" : "d";
	}
	return lang === "es" ? `hace ${n} ${unit}` : `${n} ${unit} ago`;
}

const locale = (lang: Lang) => (lang === "es" ? "es-VE" : "en-US");

/** Caracas wall-clock time, e.g. "14:05". */
export function clock(t: number, lang: Lang = "es", seconds = false): string {
	return new Intl.DateTimeFormat(locale(lang), {
		timeZone: TZ,
		hour: "2-digit",
		minute: "2-digit",
		...(seconds ? { second: "2-digit" } : {}),
		hourCycle: "h23",
	}).format(t);
}

/** The Caracas calendar year of an instant. */
function year(t: number): number {
	return new Date(t - 4 * HOUR).getUTCFullYear();
}

/**
 * "24 sept, 14:05" in Caracas time; "1 ene 2020, 00:00" when `ref` (usually now) is given and falls in another year,
 * so an old date is never read as this year's.
 */
export function stamp(t: number, lang: Lang = "es", ref?: number): string {
	const withYear = ref !== undefined && year(ref) !== year(t);
	const date = new Intl.DateTimeFormat(locale(lang), {
		timeZone: TZ,
		day: "numeric",
		month: "short",
		...(withYear ? { year: "numeric" } : {}),
	}).format(t);
	return `${date.replace(".", "").replace(" de ", " ")}, ${clock(t, lang)}`;
}

/** Full timestamp with zone for tooltips and the source sheet. */
export function fullStamp(t: number, lang: Lang = "es"): string {
	const s = new Intl.DateTimeFormat(locale(lang), {
		timeZone: TZ,
		dateStyle: "long",
		timeStyle: "medium",
		hourCycle: "h23",
	}).format(t);
	return `${s} (hora de Caracas)`;
}

export function num(value: number, digits = 2, lang: Lang = "es"): string {
	return new Intl.NumberFormat(locale(lang), {
		minimumFractionDigits: digits,
		maximumFractionDigits: digits,
	}).format(value);
}

export function int(value: number, lang: Lang = "es"): string {
	return new Intl.NumberFormat(locale(lang), { maximumFractionDigits: 0 }).format(value);
}

/** Signed percentage with a real minus sign: "+12,4 %" / "−3,1 %". */
export function pct(value: number, digits = 1, lang: Lang = "es"): string {
	const abs = num(Math.abs(value), digits, lang);
	const sign = value > 0 ? "+" : value < 0 ? "−" : "";
	return lang === "es" ? `${sign}${abs} %` : `${sign}${abs}%`;
}
