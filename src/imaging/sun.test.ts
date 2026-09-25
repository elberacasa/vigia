import { expect, test } from "bun:test";
import { solarZenithDeg } from "./sun.ts";

test("solar zenith: equinox noon on the equator, Caracas sunrise and midnight", () => {
	// 2026-03-20 12:00 UTC at 0°,0°: the sun is within about a degree of overhead.
	expect(solarZenithDeg(0, 0, Date.UTC(2026, 2, 20, 12, 7))).toBeLessThan(1.5);
	// Caracas (10.49 N, 66.88 W), 2026-09-24: sunrise about 06:13 local = 10:13 UTC.
	expect(Math.abs(solarZenithDeg(10.49, -66.88, Date.UTC(2026, 8, 24, 10, 13)) - 90.8)).toBeLessThan(1);
	// Local noon is near 12:20 local (16:20 UTC): zenith ≈ |10.5 − (−0.9)| ≈ 11.4°.
	expect(Math.abs(solarZenithDeg(10.49, -66.88, Date.UTC(2026, 8, 24, 16, 20)) - 11.4)).toBeLessThan(1);
	expect(solarZenithDeg(10.49, -66.88, Date.UTC(2026, 8, 25, 4, 20))).toBeGreaterThan(150);
});
