import { expect, test } from "bun:test";
import {
	barHeight,
	cellIntensities,
	coverage,
	type SeriesPoint,
	slots,
	WINDOW_MS,
} from "./lightning-view.ts";

const T0 = Date.UTC(2026, 8, 28, 12, 0);
const p = (i: number, venezuela: number, complete = true): SeriesPoint => ({
	windowStart: T0 + i * WINDOW_MS,
	venezuela,
	catatumbo: 0,
	complete,
});

test("96 slots end at the newest window; an unread window is a gap (null), never a zero", () => {
	const s = slots([p(0, 5), p(2, 0)], T0 + 3 * WINDOW_MS + 60_000);
	expect(s).toHaveLength(96);
	expect(s.at(-1)?.start).toBe(T0 + 2 * WINDOW_MS);
	expect(s.at(-1)?.point?.venezuela).toBe(0);
	expect(s.at(-2)?.point).toBeNull();
	expect(s.at(-3)?.point?.venezuela).toBe(5);
	// Nothing read: the slots end at the current window, all empty.
	const none = slots([], T0 + 7 * 60_000);
	expect(none.at(-1)?.start).toBe(T0);
	expect(none.every((x) => x.point === null)).toBe(true);
});

test("bars and cells scale by square root of the busiest; zero and empty draw nothing", () => {
	expect(barHeight(0, 100)).toBe(0);
	expect(barHeight(25, 100)).toBe(0.5);
	expect(barHeight(3, 0)).toBe(0);
	expect(cellIntensities([])).toEqual([]);
	const c = cellIntensities([
		[9.125, -71.625, 16],
		[10.375, -66.875, 4],
		[8.0, -63.0, 0],
	]);
	expect(c.map((x) => x.n)).toEqual([4, 16]);
	expect(c[0]?.w).toBe(0.5);
	expect(c[1]?.w).toBe(1);
});

test("coverage says complete only when every window was read whole", () => {
	const base = { venezuela: 0, catatumbo: 0, windowsExpected: 96 };
	expect(coverage({ ...base, windowsRead: 96, incomplete: 0 })).toBe("complete");
	expect(coverage({ ...base, windowsRead: 96, incomplete: 1 })).toBe("partial");
	expect(coverage({ ...base, windowsRead: 2, incomplete: 0 })).toBe("partial");
	expect(coverage({ ...base, windowsRead: 0, incomplete: 0 })).toBe("none");
});
