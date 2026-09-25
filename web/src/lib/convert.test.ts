import { expect, test } from "bun:test";
import { convert, digitsFor, echoDigits, inWages, parseAmount, readAmount } from "./convert.ts";

test("amounts typed the Venezuelan way, the English way, and with currency marks", () => {
	expect(parseAmount("1.500")).toBe(1500);
	expect(parseAmount("1.500,50")).toBe(1500.5);
	expect(parseAmount("1500,5")).toBe(1500.5);
	expect(parseAmount("1,500.50")).toBe(1500.5);
	expect(parseAmount("1,500", "en")).toBe(1500);
	expect(parseAmount("2.50")).toBe(2.5);
	expect(parseAmount("2,5")).toBe(2.5);
	expect(parseAmount("12.345.678,9")).toBe(12345678.9);
	expect(parseAmount("Bs 1.200")).toBe(1200);
	expect(parseAmount("Bs. 130")).toBe(130);
	expect(parseAmount("$ 20")).toBe(20);
	expect(parseAmount(",5")).toBe(0.5);
	expect(parseAmount("0")).toBe(0);
});

test("anything that is not a non-negative amount is refused", () => {
	for (const bad of [
		"",
		" ",
		"abc",
		"-5",
		"1.2.3",
		"1,2,3",
		"1.500,50,1",
		"12,34.567,8",
		"1e5",
		"..",
		"1..5",
	])
		expect(parseAmount(bad)).toBeNull();
});

test("conversion: Bs ÷ rate to the foreign currency, × rate back; the wage at the BCV rate", () => {
	expect(convert(1000, 800, "toForeign")).toBe(1.25);
	expect(convert(20, 855.6625, "toVes")).toBeCloseTo(17113.25, 10);
	expect(convert(130, 853.4993, "toForeign")).toBeCloseTo(0.15231, 5);
	expect(convert(10, 0, "toForeign")).toBeNull();
	expect(convert(10, Number.NaN, "toVes")).toBeNull();
	expect(convert(-1, 800, "toVes")).toBeNull();
});

test("amounts in minimum wages and the digits shown", () => {
	expect(inWages(1300, 130)).toBe(10);
	expect(inWages(1300, 0)).toBeNull();
	expect(digitsFor(1234.5)).toBe(2);
	expect(digitsFor(0.1523)).toBe(2);
	expect(digitsFor(0.0042)).toBe(4);
	expect(digitsFor(0)).toBe(2);
});

test("review 4 M3: a leading zero is never a thousands group ('0,500' is 0,5, not 500)", () => {
	for (const [text, value] of [
		["0,500", 0.5],
		["0.500", 0.5],
		["000.500", 0.5],
		["0.050", 0.05],
		["0,05", 0.05],
		[",500", 0.5],
	] as const) {
		expect(readAmount(text, "es")).toEqual({ value, ambiguous: false });
		expect(readAmount(text, "en")).toEqual({ value, ambiguous: false });
	}
});

test("review 4 M3: one separator before exactly three digits is ambiguous, read by the language, and flagged", () => {
	expect(readAmount("1.500", "es")).toEqual({ value: 1500, ambiguous: true });
	expect(readAmount("1,500", "es")).toEqual({ value: 1.5, ambiguous: true });
	expect(readAmount("1.500", "en")).toEqual({ value: 1.5, ambiguous: true });
	expect(readAmount("1,500", "en")).toEqual({ value: 1500, ambiguous: true });
	expect(readAmount("999,999", "es")).toEqual({ value: 999.999, ambiguous: true });
	// Unambiguous forms are read the same in both languages.
	for (const l of ["es", "en"] as const) {
		expect(readAmount("1.500.000", l)).toEqual({ value: 1_500_000, ambiguous: false });
		expect(readAmount("1,500,000", l)).toEqual({ value: 1_500_000, ambiguous: false });
		expect(readAmount("1.500,5", l)).toEqual({ value: 1500.5, ambiguous: false });
		expect(readAmount("1,500.5", l)).toEqual({ value: 1500.5, ambiguous: false });
		expect(readAmount("1500,5", l)).toEqual({ value: 1500.5, ambiguous: false });
		expect(readAmount("1.5000", l)).toEqual({ value: 1.5, ambiguous: false });
		expect(readAmount("15,00", l)).toEqual({ value: 15, ambiguous: false });
		expect(readAmount("1500", l)).toEqual({ value: 1500, ambiguous: false });
	}
});

test("review 4 M3: currency marks, including US$, are stripped; malformed mixes refused", () => {
	expect(parseAmount("US$ 10")).toBe(10);
	expect(parseAmount("us$10,5")).toBe(10.5);
	expect(parseAmount("10 USD")).toBe(10);
	expect(parseAmount("VES 1.200")).toBe(1200);
	for (const bad of ["0.500,5", "1.50,5", "1,5.5", "1.500,", "1.,5", "1,5,00.5"])
		expect(parseAmount(bad)).toBeNull();
});

test("echo digits: what was read is shown exactly", () => {
	expect(echoDigits(0.5)).toBe(1);
	expect(echoDigits(1500)).toBe(0);
	expect(echoDigits(999.999)).toBe(3);
	expect(echoDigits(0.05)).toBe(2);
});
