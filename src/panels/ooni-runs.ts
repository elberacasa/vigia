/**
 * Which OONI runs can be trusted to say a domain is NOT flagged.
 *
 * The ooni-ve adapter stores only flagged domains, so "absent from a run" is read as "not flagged". That is only
 * true when the run actually carried OONI's usual volume: an empty or thin answer (an OONI outage, a partial
 * aggregation) would otherwise read as hundreds of domains being unblocked at once. So:
 *
 * - a run is **complete** when its measurement count is > 0 and at least half the median of the previous
 *   `MEDIAN_RUNS` runs with data (the first run with data is complete by definition);
 * - only complete runs are compared; incomplete ones are skipped as if they had not happened;
 * - a flag ends only after the domain is absent (not flagged on that ISP) in `END_AFTER` consecutive complete
 *   runs, so a domain hovering near the threshold does not flicker.
 */
import type { OoniValue } from "../adapters/ooni-ve/index.ts";
import type { Store } from "../core/store.ts";

export const COMPLETE_SHARE = 0.5;
/** Eight runs at the 3-hour cadence: the last day. */
export const MEDIAN_RUNS = 8;
export const END_AFTER = 2;

export interface OoniRun {
	/** Fetch time shared by every row of the run. */
	readonly at: number;
	/** Measurements the run is based on (the smaller of its two aggregations when both are known). */
	readonly volume: number;
	readonly complete: boolean;
}

export function runVolume(value: OoniValue | null | undefined): number {
	if (value?.kind !== "summary") return 0;
	const m = Number.isFinite(value.measurements) ? value.measurements : 0;
	return typeof value.asnMeasurements === "number" ? Math.min(m, value.asnMeasurements) : m;
}

function median(xs: readonly number[]): number {
	const sorted = [...xs].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Completeness of each run, oldest first, judged against the runs before it. */
export function completeness(volumes: readonly number[]): boolean[] {
	return volumes.map((v, i) => {
		if (!(v > 0)) return false;
		const recent = volumes.slice(Math.max(0, i - MEDIAN_RUNS), i).filter((x) => x > 0);
		return recent.length === 0 || v >= COMPLETE_SHARE * median(recent);
	});
}

/**
 * The runs whose fetch time is in [from, to], oldest first, with completeness judged against up to MEDIAN_RUNS
 * earlier runs (read from before `from` too).
 */
export function ooniRuns(store: Store, from: number, to: number): OoniRun[] {
	const earlier = store.db
		.query<{ fetched_at: number; value: string }, [number]>(
			`SELECT fetched_at, value FROM obs WHERE source = 'ooni-ve' AND series = 'country:VE:summary'
			 AND fetched_at < ? ORDER BY fetched_at DESC LIMIT ${MEDIAN_RUNS}`,
		)
		.all(from)
		.reverse();
	const inside = store.db
		.query<{ fetched_at: number; value: string }, [number, number]>(
			`SELECT fetched_at, value FROM obs WHERE source = 'ooni-ve' AND series = 'country:VE:summary'
			 AND fetched_at BETWEEN ? AND ? ORDER BY fetched_at`,
		)
		.all(from, to);
	const rows = [...earlier, ...inside];
	const volumes = rows.map((r) => {
		try {
			return runVolume(JSON.parse(r.value) as OoniValue);
		} catch {
			return 0;
		}
	});
	const complete = completeness(volumes);
	return rows
		.map((r, i) => ({ at: r.fetched_at, volume: volumes[i] ?? 0, complete: complete[i] ?? false }))
		.slice(earlier.length);
}

/** Fetch time of the newest complete run in [from, to], or null. */
export function newestCompleteRun(store: Store, from: number, to: number): number | null {
	const runs = ooniRuns(store, from, to);
	for (let i = runs.length - 1; i >= 0; i--) if (runs[i]?.complete) return runs[i]?.at ?? null;
	return null;
}
