import { expect, test } from "bun:test";
import { canonicalJson, Store } from "./store.ts";
import type { Observation } from "./types.ts";

const base: Observation<{ usd: number }> = {
	source: "s",
	series: "usd",
	sourceUrl: "https://example.org",
	fetchedAt: 1_000,
	observedAt: 1_000,
	licence: "x",
	value: { usd: 1 },
	confidence: 1,
	basis: "official",
};

test("identical re-fetch is ignored; revisions and new times are kept", () => {
	const store = new Store(":memory:");
	expect(store.insert([base])).toBe(1);
	expect(store.insert([{ ...base, fetchedAt: 2_000 }])).toBe(0);
	expect(store.insert([{ ...base, value: { usd: 2 }, fetchedAt: 3_000 }])).toBe(1);
	expect(store.insert([{ ...base, observedAt: 5_000, value: { usd: 3 } }])).toBe(1);
	expect(store.latest("s", "usd")?.value).toEqual({ usd: 3 });
	expect(store.history("s", "usd", 0, 10_000).map((o) => o.value)).toEqual([
		{ usd: 1 },
		{ usd: 2 },
		{ usd: 3 },
	]);
});

test("latest per series picks the newest observation, and revision ties go to the newest row", () => {
	const store = new Store(":memory:");
	store.insert([
		{ ...base, series: "a", observedAt: 10 },
		{ ...base, series: "a", observedAt: 10, value: { usd: 9 }, fetchedAt: 20 },
		{ ...base, series: "b", observedAt: 5 },
	]);
	const latest = store.latestPerSeries("s");
	expect(latest.map((o) => [o.series, o.value])).toEqual([
		["a", { usd: 9 }],
		["b", { usd: 1 }],
	]);
});

test("locations round-trip", () => {
	const store = new Store(":memory:");
	store.insert([{ ...base, location: { lat: 10.5, lon: -66.9, state: "VE-A", place: "Caracas" } }]);
	expect(store.latest("s", "usd")?.location).toEqual({
		lat: 10.5,
		lon: -66.9,
		state: "VE-A",
		place: "Caracas",
	});
});

test("runs give the last success", () => {
	const store = new Store(":memory:");
	store.recordRun({
		source: "s",
		startedAt: 1,
		finishedAt: 2,
		ok: true,
		error: null,
		bytes: 1,
		received: 1,
		inserted: 1,
	});
	store.recordRun({
		source: "s",
		startedAt: 3,
		finishedAt: 4,
		ok: false,
		error: "x",
		bytes: 0,
		received: 0,
		inserted: 0,
	});
	expect(store.lastSuccessAt("s")).toBe(2);
	expect(store.recentRuns("s")[0]?.ok).toBe(false);
});

test("canonical JSON ignores key order", () => {
	expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
});

test("keepFirst: an undated item keeps the time it was first seen", () => {
	const store = new Store(":memory:");
	expect(
		store.insert([{ ...base, series: "item:x", observedAt: 1_000, fetchedAt: 1_000, keepFirst: true }]),
	).toBe(1);
	expect(
		store.insert([{ ...base, series: "item:x", observedAt: 9_000, fetchedAt: 9_000, keepFirst: true }]),
	).toBe(0);
	expect(store.latest("s", "item:x")?.observedAt).toBe(1_000);
});

test("retention keeps the newest row of every series, however old (review 2, M7)", () => {
	const store = new Store(":memory:");
	const row = (series: string, at: number, v: number) => ({
		source: "s",
		series,
		sourceUrl: "u",
		fetchedAt: at,
		observedAt: at,
		licence: "l",
		value: { v },
		confidence: 1,
		basis: "measurement" as const,
	});
	store.insert([
		row("monthly", 10, 1),
		row("monthly", 20, 2),
		row("fast", 10, 1),
		row("fast", 20, 2),
		row("fast", 200, 3),
	]);
	store.pruneObservations(100);
	expect(store.history("s", "monthly", 0, 1_000).map((o) => o.value)).toEqual([{ v: 2 }]);
	expect(store.history("s", "fast", 0, 1_000).map((o) => o.value)).toEqual([{ v: 3 }]);
});
