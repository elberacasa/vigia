import { expect, test } from "bun:test";
import { Store } from "../core/store.ts";
import { PanelCache } from "./panels.ts";

test("a failing panel serves its last good value and never blanks the others", () => {
	const store = new Store(":memory:");
	let broken = false;
	let t = 0;
	const cache = new PanelCache(
		[
			{
				id: "a",
				sources: ["x"],
				compute: () => {
					if (broken) throw new Error("bad row");
					return 1;
				},
			},
			{ id: "b", sources: ["y"], compute: () => 2 },
		],
		store,
		() => t,
		0,
	);
	expect(cache.all()).toEqual({ a: 1, b: 2 });
	broken = true;
	t = 10;
	expect(cache.all()).toEqual({ a: 1, b: 2 });
});

test("a failing panel is marked, not recomputed on every request; excluded panels are never computed", () => {
	const store = new Store(":memory:");
	let calls = 0;
	let broken = false;
	let heavy = 0;
	let t = 0;
	const cache = new PanelCache(
		[
			{
				id: "a",
				sources: ["x"],
				compute: () => {
					calls++;
					if (broken) throw new Error("bad row");
					return { n: 1 };
				},
			},
			{
				id: "heavy",
				sources: ["y"],
				compute: () => {
					heavy++;
					return 2;
				},
			},
			{ id: "reader", sources: [], compute: (_s, _n, read) => ({ fromA: read?.("a") ?? null }) },
		],
		store,
		() => t,
		60_000,
	);
	expect(cache.all(undefined, new Set(["heavy"]))).toEqual({ a: { n: 1 }, reader: { fromA: { n: 1 } } });
	expect(heavy).toBe(0);
	expect(calls).toBe(1);
	broken = true;
	cache.invalidate("x");
	t = 1_000;
	expect(cache.get("a")).toEqual({ n: 1, panelFailedAt: 1_000 });
	t = 2_000;
	cache.get("a");
	cache.get("a");
	expect(calls).toBe(2);
});

test("an on-demand panel is never in the bulk list, only when asked for by id", () => {
	const store = new Store(":memory:");
	let computed = 0;
	const cache = new PanelCache(
		[
			{ id: "a", sources: [], compute: () => 1 },
			{
				id: "big",
				sources: [],
				onDemand: true,
				compute: () => {
					computed++;
					return 2;
				},
			},
		],
		store,
	);
	expect(cache.all()).toEqual({ a: 1 });
	expect(cache.all(undefined, new Set(["a"]))).toEqual({});
	expect(computed).toBe(0);
	expect(cache.all(new Set(["big"]))).toEqual({ big: 2 });
	expect(cache.get("big")).toBe(2);
});
