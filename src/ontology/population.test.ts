import { expect, test } from "bun:test";
import { POPULATION_META, peopleWithin, populationOf, statePeople } from "./population.ts";
import { registry } from "./registry.ts";

const reg = registry();

test("every municipality has both figures; every parish has WorldPop's", () => {
	for (const m of reg.all.filter((e) => e.type === "municipality")) {
		const p = populationOf(reg, m);
		expect(p?.census2011?.people ?? 0, m.id).toBeGreaterThan(0);
		expect(p?.worldpop2026?.people ?? -1, m.id).toBeGreaterThanOrEqual(0);
	}
	for (const p of reg.all.filter((e) => e.type === "parish")) {
		const v = populationOf(reg, p);
		expect(v?.census2011, p.id).toBeNull();
		expect(v?.worldpop2026, p.id).not.toBeNull();
	}
	const bcv = reg.get("inst.bcv");
	if (!bcv) throw new Error("no BCV");
	expect(populationOf(reg, bcv)).toBeNull();
});

test("sums: a state is the sum of its municipalities, the country of everything, and says it was computed", () => {
	const zulia = reg.get("ve.zulia");
	if (!zulia) throw new Error("no Zulia");
	const p = populationOf(reg, zulia);
	const munis = reg.within("ve.zulia").filter((e) => e.type === "municipality");
	const sum = munis.reduce((s, m) => s + (populationOf(reg, m)?.census2011?.people ?? 0), 0);
	expect(p?.census2011?.people).toBe(sum);
	expect(p?.computed).toBe(true);
	expect(p?.method).toContain("calculado por Vigía");
	// Census 2011: the municipal table (OCHA COD-PS) sums to 27,225,775, the published 27,227,930 less the
	// Dependencias Federales, which the table leaves out (so their census figure is null, not zero).
	const country = populationOf(reg, reg.get("ve") ?? zulia);
	expect(country?.census2011?.people).toBe(27_225_775);
	expect(populationOf(reg, reg.get("ve.dependencias-federales") ?? zulia)?.census2011).toBeNull();
	expect(populationOf(reg, reg.get("ve.la-guaira.vargas") ?? zulia)?.census2011?.people).toBe(352_920);
	// WorldPop: the municipal sums plus the islands account for the whole grid except the few coastal cells
	// the aggregation could not place (reported in its metadata).
	const grid = POPULATION_META.worldpop2026.gridTotal;
	expect(Math.abs((country?.worldpop2026?.people ?? 0) - grid)).toBeLessThan(100);
	expect(statePeople(reg, "VE-V").worldpop2026).toBe(p?.worldpop2026?.people ?? -1);
	expect(statePeople(reg, "VE-XX")).toEqual({ census2011: null, worldpop2026: null });
});

test("people within R km: grows with the radius, zero at sea, a million-plus around central Caracas", () => {
	const caracas = { lat: 10.5061, lon: -66.9146 };
	const r10 = peopleWithin(caracas.lat, caracas.lon, 10);
	const r25 = peopleWithin(caracas.lat, caracas.lon, 25);
	const r50 = peopleWithin(caracas.lat, caracas.lon, 50);
	expect(r10).toBeGreaterThan(1_000_000);
	expect(r25).toBeGreaterThan(r10);
	expect(r50).toBeGreaterThan(r25);
	expect(peopleWithin(13.5, -66, 25)).toBe(0);
	// The whole grid sits within 1,500 km of the country's middle.
	expect(peopleWithin(7, -66, 1_500)).toBeCloseTo(POPULATION_META.worldpop2026.gridTotal, -3);
});
