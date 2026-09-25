import { expect, test } from "bun:test";
import { computeHealth, type HealthInput } from "./health.ts";
import type { Adapter } from "./types.ts";

const adapter = { id: "a", freshness: { fetchMs: 1_000, dataMs: 10_000 } } as unknown as Adapter;
const run = (ok: boolean, at: number) => ({
	source: "a",
	startedAt: at,
	finishedAt: at + 10,
	ok,
	error: ok ? null : "boom",
	bytes: 1,
	received: 1,
	inserted: 0,
});
const input = (over: Partial<HealthInput>): HealthInput => ({
	adapter,
	locked: false,
	runtime: null,
	runs: [],
	lastSuccessAt: null,
	newestObservedAt: null,
	now: 100_000,
	...over,
});
const rt = (failures: number) => ({
	nextRunAt: 0,
	running: false,
	lastError: failures ? "boom" : null,
	lastAttemptAt: 0,
	consecutiveFailures: failures,
	breaker: "closed" as const,
});

test("states", () => {
	expect(computeHealth(input({})).state).toBe("pending");
	expect(computeHealth(input({ locked: true })).state).toBe("locked");
	expect(computeHealth(input({ runs: [run(false, 1)] })).state).toBe("failing");
	expect(
		computeHealth(input({ lastSuccessAt: 99_500, newestObservedAt: 99_000, runtime: rt(0) })).state,
	).toBe("ok");
	expect(
		computeHealth(input({ lastSuccessAt: 99_500, newestObservedAt: 99_000, runtime: rt(1) })).state,
	).toBe("degraded");
	// Source keeps answering but its data is old: stale, not failing.
	expect(computeHealth(input({ lastSuccessAt: 99_500, newestObservedAt: 1_000, runtime: rt(0) })).state).toBe(
		"stale",
	);
	// We cannot reach it and our copy is old: failing (last-good still served with its age).
	expect(
		computeHealth(input({ lastSuccessAt: 50_000, newestObservedAt: 50_000, runtime: rt(3) })).state,
	).toBe("failing");
});

test("event feeds never go stale on silence", () => {
	const events = { id: "e", freshness: { fetchMs: 1_000, dataMs: null } } as unknown as Adapter;
	expect(computeHealth(input({ adapter: events, lastSuccessAt: 99_900, newestObservedAt: 1 })).state).toBe(
		"ok",
	);
});

test("success rate and median latency", () => {
	const h = computeHealth(
		input({
			runs: [run(true, 1), run(false, 2), run(true, 3), run(true, 4)],
			lastSuccessAt: 99_999,
			newestObservedAt: 99_999,
		}),
	);
	expect(h.successRate).toBe(0.75);
	expect(h.medianLatencyMs).toBe(10);
});
