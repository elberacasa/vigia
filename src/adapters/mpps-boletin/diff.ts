import type { WeekFigures } from "./transcribe.ts";

/**
 * What a new transcription changes against the committed weeks.gen.ts, for the person who reviews it before
 * committing (scripts/health/mpps-transcribe.ts): weeks added or gone, and every figure that changed in a week that
 * was already there (a re-uploaded bulletin, or a pattern fixed in transcribe.ts).
 */

export type Week = WeekFigures & { readonly year: number; readonly week: number; readonly pdfUrl: string };

export type WeekDiff = {
	readonly added: readonly Week[];
	readonly removed: readonly Week[];
	readonly changed: readonly {
		readonly key: string;
		readonly field: string;
		readonly from: number | string | null;
		readonly to: number | string | null;
	}[];
};

export const weekKey = (w: { year: number; week: number }) =>
	`${w.year}-SE${String(w.week).padStart(2, "0")}`;

export function diffWeeks(before: readonly Week[], after: readonly Week[]): WeekDiff {
	const old = new Map(before.map((w) => [weekKey(w), w]));
	const next = new Map(after.map((w) => [weekKey(w), w]));
	const changed: { key: string; field: string; from: number | string | null; to: number | string | null }[] =
		[];
	for (const [key, w] of next) {
		const o = old.get(key);
		if (!o) continue;
		for (const field of Object.keys(w).sort() as (keyof Week)[]) {
			if (field === "year" || field === "week") continue;
			if (o[field] !== w[field]) changed.push({ key, field, from: o[field] ?? null, to: w[field] ?? null });
		}
	}
	const order = (a: Week, b: Week) => a.year - b.year || a.week - b.week;
	return {
		added: [...next]
			.filter(([k]) => !old.has(k))
			.map(([, w]) => w)
			.sort(order),
		removed: [...old]
			.filter(([k]) => !next.has(k))
			.map(([, w]) => w)
			.sort(order),
		changed,
	};
}

/** The figures a week is missing (null: the pattern did not find the sentence), for a warning. */
export function missingFigures(w: Week): string[] {
	return (Object.keys(w) as (keyof Week)[]).filter((k) => w[k] === null);
}
