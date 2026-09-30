/**
 * Venezuelan time: America/Caracas is UTC−4 all year (no DST since 2016). Every "day" in the money layer is a
 * Caracas calendar day, so a BCV "Fecha Valor" of 25 Sep means 2026-09-25T04:00Z.
 */

export const CARACAS_OFFSET_MS = -4 * 3_600_000;
const DAY = 86_400_000;

/** Epoch ms of 00:00 Caracas on the given calendar date (month 1-12). */
export function caracasMidnight(year: number, month: number, day: number): number {
	return Date.UTC(year, month - 1, day) - CARACAS_OFFSET_MS;
}

/** "2026-09-25" → epoch ms of 00:00 Caracas that day; null if the text is not a real date. */
export function caracasDateToMs(iso: string): number | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	if (!m) return null;
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	const ms = caracasMidnight(y, mo, d);
	return caracasDay(ms) === iso ? ms : null;
}

/** The Caracas calendar day of an instant, "YYYY-MM-DD". */
export function caracasDay(ms: number): string {
	return new Date(ms + CARACAS_OFFSET_MS).toISOString().slice(0, 10);
}

/** 00:00 Caracas of the day containing `ms`. */
export function startOfCaracasDay(ms: number): number {
	return Math.floor((ms + CARACAS_OFFSET_MS) / DAY) * DAY - CARACAS_OFFSET_MS;
}

/** A UTC calendar date "YYYY-MM-DD" as epoch ms at 00:00 UTC; null if invalid. */
export function utcDateToMs(iso: string): number | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	if (!m) return null;
	const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	return new Date(ms).toISOString().slice(0, 10) === iso ? ms : null;
}

/**
 * Parses a number written the Venezuelan way: dot thousands, decimal comma ("637.409.769.724.325,0",
 * "855,66250000"). Returns null for anything else.
 */
export function parseVeNumber(text: string): number | null {
	const t = text.trim();
	if (!/^-?\d{1,3}(\.\d{3})*(,\d+)?$|^-?\d+(,\d+)?$/.test(t)) return null;
	const n = Number(t.replace(/\./g, "").replace(",", "."));
	return Number.isFinite(n) ? n : null;
}

/** Day of month of the n-th Sunday (1-based) of a month, UTC calendar. */
function nthSunday(year: number, month: number, n: number): number {
	const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
	return 1 + ((7 - first) % 7) + (n - 1) * 7;
}

/**
 * Epoch ms of a wall-clock time in US Eastern time (America/New_York), for US federal sources (OFAC, the Federal
 * Register) that print local dates and times without an offset. Daylight time (UTC−4) runs from 02:00 on the second
 * Sunday of March to 02:00 on the first Sunday of November (Energy Policy Act of 2005); standard time is UTC−5. A
 * wall time in the skipped or repeated hour resolves to the standard-time reading.
 */
export function usEasternToMs(
	year: number,
	month: number,
	day: number,
	hour = 0,
	minute = 0,
	second = 0,
): number {
	const wall = Date.UTC(year, month - 1, day, hour, minute, second);
	const dstStart = Date.UTC(year, 2, nthSunday(year, 3, 2), 2);
	const dstEnd = Date.UTC(year, 10, nthSunday(year, 11, 1), 1);
	const dst = wall >= dstStart + 3_600_000 && wall < dstEnd;
	return wall + (dst ? 4 : 5) * 3_600_000;
}

/** "2026-09-23" or "2026-09-23T10:07:28.65" (US Eastern wall time, no offset) → epoch ms; null if malformed. */
export function usEasternIsoToMs(text: string): number | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(text.trim());
	if (!m) return null;
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	if (utcDateToMs(`${m[1]}-${m[2]}-${m[3]}`) === null) return null;
	return usEasternToMs(y, mo, d, Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
}
