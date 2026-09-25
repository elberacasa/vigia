import { describe, expect, test } from "bun:test";
import { Arrivals, FRESH_MS, NEW_MAX_AGE_MS, type SeenStorage } from "./seen.ts";

function memory(initial: Record<string, string[]> = {}): SeenStorage & { data: Record<string, string[]> } {
	const box = { data: structuredClone(initial) };
	return {
		get data() {
			return box.data;
		},
		load: () => structuredClone(box.data),
		save: (s) => {
			box.data = structuredClone(s);
		},
	};
}

describe("Arrivals", () => {
	test("a device's first look at a list announces nothing", () => {
		const a = new Arrivals(memory());
		expect(a.observe("news", ["a", "b"], 0).size).toBe(0);
	});

	test("an empty (not yet loaded) list is not the first look", () => {
		const a = new Arrivals(memory());
		a.observe("news", [], 0);
		expect(a.observe("news", ["a", "b"], 10).size).toBe(0);
	});

	test("ids that arrive later are fresh for FRESH_MS, then ordinary", () => {
		const a = new Arrivals(memory());
		a.observe("q", ["a"], 0);
		expect([...a.observe("q", ["b", "a"], 1_000)]).toEqual(["b"]);
		expect([...a.observe("q", ["b", "a"], 1_000 + FRESH_MS - 1)]).toEqual(["b"]);
		expect(a.observe("q", ["b", "a"], 1_000 + FRESH_MS).size).toBe(0);
		expect(a.nextExpiry(1_000)).toBe(1_000 + FRESH_MS);
		expect(a.nextExpiry(1_000 + FRESH_MS)).toBeNull();
	});

	test("a reload does not re-announce what this device already showed", () => {
		const storage = memory();
		const first = new Arrivals(storage);
		first.observe("q", ["a"], 0);
		first.observe("q", ["b", "a"], 5);
		const reload = new Arrivals(storage);
		expect(reload.observe("q", ["b", "a"], 10).size).toBe(0);
		// …but what arrived while the page was closed is new to this device.
		expect([...reload.observe("q", ["c", "b", "a"], 20)]).toEqual(["c"]);
	});

	test("scopes are independent", () => {
		const a = new Arrivals(memory({ q: ["a"] }));
		expect([...a.observe("q", ["a", "b"], 0)]).toEqual(["b"]);
		expect(a.observe("news", ["a", "b"], 0).size).toBe(0);
	});

	test("a returning reader never sees day-old rows marked new (review 3, L10)", () => {
		const a = new Arrivals(memory());
		const T = 10 * NEW_MAX_AGE_MS;
		a.observe("quakes", ["a"], T);
		const own: Record<string, number> = { old: T - 2 * NEW_MAX_AGE_MS, recent: T - 60_000 };
		const fresh = a.observe("quakes", ["a", "old", "recent"], T, (id) => own[id]);
		expect([...fresh]).toEqual(["recent"]);
	});
});
