import { expect, test } from "bun:test";
import { OVV_YEARS } from "./security-ovv.ts";

test("OVV: each year's components add up to its published total; links to its own report", () => {
	for (const y of OVV_YEARS) {
		expect(y.homicides + y.interventionDeaths + y.underInvestigation).toBe(y.violentDeaths);
		expect(y.url).toContain(`informe-anual-de-violencia-${y.year}`);
		expect(y.publishedOn.startsWith(String(y.year))).toBe(true);
		expect(y.ratePer100k).toBeGreaterThan(0);
	}
	expect(OVV_YEARS.map((y) => y.year)).toEqual([2021, 2022, 2023]);
});

test("OVV: the published rate agrees with the population the report states (to its one decimal)", () => {
	for (const y of OVV_YEARS) {
		if (y.population === null) continue;
		expect(Math.abs((y.violentDeaths / y.population) * 100_000 - y.ratePer100k)).toBeLessThan(0.1);
	}
});
