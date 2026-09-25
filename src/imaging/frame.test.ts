import { expect, test } from "bun:test";
import { frameSize, gibsDegPerPx, pixelCentre, VENEZUELA_FRAME } from "./frame.ts";

test("the frame is on the GIBS level-6 pixel grid and contains the UI map frame", () => {
	const deg = gibsDegPerPx(6);
	for (const edge of [VENEZUELA_FRAME.west, VENEZUELA_FRAME.east]) {
		expect(Number.isInteger((edge + 180) / deg)).toBe(true);
	}
	for (const edge of [VENEZUELA_FRAME.north, VENEZUELA_FRAME.south]) {
		expect(Number.isInteger((90 - edge) / deg)).toBe(true);
	}
	expect(VENEZUELA_FRAME.west).toBeLessThan(-73.6);
	expect(VENEZUELA_FRAME.east).toBeGreaterThan(-59.5);
	expect(VENEZUELA_FRAME.south).toBeLessThan(0.5);
	expect(VENEZUELA_FRAME.north).toBeGreaterThan(12.9);
	expect(frameSize(6)).toEqual({ width: 1708, height: 1536 });
	expect(frameSize(5)).toEqual({ width: 854, height: 768 });
	expect(frameSize(4)).toEqual({ width: 427, height: 384 });
	expect(pixelCentre(0, 0, 1708, 1536)).toEqual({ lon: -74.00390625 + deg / 2, lat: 13.5 - deg / 2 });
});
