import { expect, test } from "bun:test";
import { bi, count, num, pct } from "./format.ts";

test("numbers: Spanish decimals and grouping, English for English text", () => {
	expect(num(6.82)).toBe("6,82");
	expect(num(6.8249)).toBe("6,82");
	expect(num(43401)).toBe("43.401");
	expect(num(1234.5)).toBe("1.234,5");
	expect(num(637409769724325.1, "es", 1)).toBe("637.409.769.724.325,1");
	expect(num(1234.5, "en")).toBe("1,234.5");
	expect(num(0.7)).toBe("0,7");
	expect(num(0.25, "es", 2, 2)).toBe("0,25");
	expect(num(5, "es", 2, 2)).toBe("5,00");
	expect(num(-0.001)).toBe("0");
	expect(num(Number.NaN)).toBe("—");
});

test("percentages carry a sign and a true minus", () => {
	expect(pct(8.04)).toBe("+8 %");
	expect(pct(-0.54)).toBe("−0,5 %");
	expect(pct(0)).toBe("0 %");
	expect(pct(-0.01)).toBe("0 %");
	expect(pct(12.345, "en", 2)).toBe("+12.35 %");
});

test("counts agree with their number", () => {
	expect(count(1, "gaceta", "gacetas")).toBe("1 gaceta");
	expect(count(0, "gaceta", "gacetas")).toBe("0 gacetas");
	expect(count(6, "gaceta", "gacetas")).toBe("6 gacetas");
	expect(count(1250, "titular", "titulares")).toBe("1.250 titulares");
	expect(count(1.5, "millón", "millones", "es", 1)).toBe("1,5 millones");
	expect(bi(1, ["detección", "detecciones"], ["detection", "detections"])).toEqual({
		es: "1 detección",
		en: "1 detection",
	});
	expect(bi(2000, ["sismo", "sismos"], ["quake", "quakes"])).toEqual({
		es: "2.000 sismos",
		en: "2,000 quakes",
	});
});
