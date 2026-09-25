import { expect, test } from "bun:test";
import { ago, clock, int, num, pct, stamp } from "./format.ts";

test("ages", () => {
	expect(ago(10_000)).toBe("ahora");
	expect(ago(3 * 60_000)).toBe("hace 3 min");
	expect(ago(59 * 60_000)).toBe("hace 59 min");
	expect(ago(2.5 * 3_600_000)).toBe("hace 2 h");
	expect(ago(3 * 86_400_000)).toBe("hace 3 d");
	expect(ago(3 * 60_000, "en")).toBe("3 min ago");
	expect(ago(-5)).toBe("ahora");
});

test("Caracas time is UTC−4 all year", () => {
	expect(clock(Date.UTC(2026, 8, 24, 18, 5))).toBe("14:05");
	expect(clock(Date.UTC(2026, 0, 10, 3, 0))).toBe("23:00");
	expect(stamp(Date.UTC(2026, 8, 24, 18, 5))).toBe("24 sept, 14:05");
	// With a reference time in another (Caracas) year, the year is printed.
	const ref = Date.UTC(2026, 8, 24);
	expect(stamp(Date.UTC(2026, 8, 24, 18, 5), "es", ref)).toBe("24 sept, 14:05");
	expect(stamp(Date.UTC(2020, 0, 1, 4), "es", ref)).toBe("1 ene 2020, 00:00");
	expect(stamp(Date.UTC(2026, 0, 1, 3), "es", ref)).toBe("31 dic 2025, 23:00");
});

test("Venezuelan number format", () => {
	expect(num(855.1234)).toBe("855,12");
	expect(int(12345)).toBe("12.345");
	expect(pct(12.44)).toBe("+12,4 %");
	expect(pct(-3.06)).toBe("−3,1 %");
	expect(pct(0)).toBe("0,0 %");
});
