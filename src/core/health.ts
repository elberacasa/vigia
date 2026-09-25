import type { FeedRuntime } from "./scheduler.ts";
import type { RunRecord } from "./store.ts";
import type { Adapter } from "./types.ts";

export type FeedState =
	/** Fresh and succeeding. */
	| "ok"
	/** Last good data is older than the budget; shown with its age. */
	| "stale"
	/** Recent attempts failing but data still within budget. */
	| "degraded"
	/** Failing and out of budget, or never succeeded. */
	| "failing"
	/** Needs a key the user has not added. */
	| "locked"
	/** Turned off by the user (or opt-in and not turned on). */
	| "off"
	/** Not tried yet. */
	| "pending";

export interface FeedHealth {
	readonly id: string;
	readonly state: FeedState;
	readonly lastSuccessAt: number | null;
	readonly lastAttemptAt: number | null;
	readonly newestObservedAt: number | null;
	readonly fetchAgeMs: number | null;
	readonly dataAgeMs: number | null;
	readonly lastError: string | null;
	readonly consecutiveFailures: number;
	readonly nextRunAt: number | null;
	/** Share of successful runs among the last ones recorded (up to 50). */
	readonly successRate: number | null;
	/** Median duration of recent successful runs. */
	readonly medianLatencyMs: number | null;
}

export interface HealthInput {
	readonly adapter: Adapter;
	readonly locked: boolean;
	readonly enabled?: boolean;
	readonly runtime: FeedRuntime | null;
	readonly runs: readonly RunRecord[];
	readonly lastSuccessAt: number | null;
	readonly newestObservedAt: number | null;
	readonly now: number;
}

/** Pure: the state shown on the status page and as a badge on every panel. */
export function computeHealth(input: HealthInput): FeedHealth {
	const { adapter, runtime, runs, lastSuccessAt, newestObservedAt, now } = input;
	const fetchAgeMs = lastSuccessAt === null ? null : now - lastSuccessAt;
	const dataAgeMs = newestObservedAt === null ? null : Math.max(0, now - newestObservedAt);
	const lastRun = runs[0];
	const failures = runtime?.consecutiveFailures ?? 0;

	const fetchStale = fetchAgeMs !== null && fetchAgeMs > adapter.freshness.fetchMs;
	const dataStale =
		adapter.freshness.dataMs !== null && dataAgeMs !== null && dataAgeMs > adapter.freshness.dataMs;

	let state: FeedState;
	if (input.enabled === false) state = "off";
	else if (input.locked) state = "locked";
	else if (lastSuccessAt === null) state = lastRun ? "failing" : "pending";
	else if (fetchStale || dataStale) state = failures > 0 && fetchStale ? "failing" : "stale";
	else if (failures > 0) state = "degraded";
	else state = "ok";

	const successes = runs.filter((r) => r.ok);
	const durations = successes.map((r) => r.finishedAt - r.startedAt).sort((a, b) => a - b);
	return {
		id: adapter.id,
		state,
		lastSuccessAt,
		lastAttemptAt: runtime?.lastAttemptAt ?? lastRun?.startedAt ?? null,
		newestObservedAt,
		fetchAgeMs,
		dataAgeMs,
		lastError: runtime?.lastError ?? (lastRun && !lastRun.ok ? lastRun.error : null),
		consecutiveFailures: failures,
		nextRunAt: input.locked || input.enabled === false ? null : (runtime?.nextRunAt ?? null),
		successRate: runs.length ? successes.length / runs.length : null,
		medianLatencyMs: durations.length ? (durations[Math.floor(durations.length / 2)] ?? null) : null,
	};
}
