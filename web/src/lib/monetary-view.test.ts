import { expect, test } from "bun:test";
import {
	bigBs,
	calDate,
	changeText,
	musd,
	pointsText,
	priceText,
	usdWords,
	volumeText,
} from "./monetary-view.ts";

test("bolívar amounts in Spanish long scale: a billón is 10¹², said as trillion in English", () => {
	expect(bigBs(2_839_145_987_504.81, "es")).toBe("2,84 billones");
	expect(bigBs(2_839_145_987_504.81, "en")).toBe("2.84 trillion");
	expect(bigBs(79_889_194_534.16, "es")).toBe("79,89 millardos");
	expect(bigBs(7_866_916.1, "es")).toBe("7,9 millones");
});

test("reserves in millions of dollars as the BCV publishes them; dollar amounts in words", () => {
	expect(musd(12727, "es")).toBe("12.727 MM US$");
	expect(musd(12727, "en")).toBe("US$ 12,727 M");
	expect(usdWords(3_345_895_987.59, "es")).toBe("US$ 3,35 millardos");
	expect(usdWords(345_895_987.59, "es")).toBe("US$ 346 millones");
});

test("calendar dates read as the reader writes them", () => {
	expect(calDate("2026-09-18", "es")).toBe("18/09/2026");
	expect(calDate("2026-09-18", "en")).toBe("Sep 18, 2026");
	expect(calDate("n/a", "es")).toBe("n/a");
});

test("a change carries a glyph so it reads without colour; a rounded zero is flat", () => {
	expect(changeText(3.3495, "es")).toEqual({ glyph: "▲", text: "+3,3 %" });
	expect(changeText(-4.58, "es")).toEqual({ glyph: "▼", text: "−4,6 %" });
	expect(changeText(0.02, "es")).toEqual({ glyph: "=", text: "0,0 %" });
});

test("prices are what traders pay, never rounded to a false zero", () => {
	expect(priceText(0.635, "es")).toBe("63,5 %");
	expect(priceText(0.64, "es")).toBe("64 %");
	expect(priceText(0.001, "es")).toBe("0,1 %");
	expect(priceText(0.925, "en")).toBe("92.5%");
	expect(priceText(null, "es")).toBe("—");
	expect(pointsText(2.5, "es")).toBe("+2,5 pp");
	expect(pointsText(-0.3, "en")).toBe("−0.3 pts");
	expect(pointsText(0, "es")).toBe("sin cambio");
});

test("volume in its venue's own unit", () => {
	expect(volumeText(3_311_289.37, "USD", "es")).toBe("US$ 3,3 M");
	expect(volumeText(23_467.16, "USD", "es")).toBe("US$ 23,5 k");
	expect(volumeText(967_309.15, "contracts", "es")).toBe("967.309 contratos");
});
