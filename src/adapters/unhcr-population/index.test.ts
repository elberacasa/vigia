import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { unhcrPopulation, unhcrUrls, yearEnd } from "./index.ts";

const raws = loadFixture(join(import.meta.dir, "fixtures", "2026-09-25"));
const obs = unhcrPopulation.normalise(raws);
const at = (series: string, year: number) =>
	obs.find((o) => o.series === series && o.value.year === year)?.value;

test("year-end stocks abroad and hosted, 2015-2025; '-' is null, never 0", () => {
	expect(at("abroad", 2025)).toEqual({
		year: 2025,
		refugees: 417_010,
		asylumSeekers: 1_181_156,
		otherInNeed: 6_042_706,
		country: null,
		countryName: null,
	});
	// "Other people in need of international protection" did not exist before 2018: "-".
	expect(at("abroad", 2015)?.otherInNeed).toBeNull();
	expect(at("hosted", 2025)).toMatchObject({ refugees: 14_333, asylumSeekers: 1_577, otherInNeed: null });
	expect(obs.filter((o) => o.series === "abroad").length).toBe(11);
	for (const o of obs) {
		expect(o.source).toBe("unhcr-population");
		expect(o.observedAt).toBe(yearEnd(o.value.year));
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
	}
});

test("per host country for the recent years, keyed by ISO3", () => {
	expect(at("abroad:COL", 2025)).toMatchObject({
		refugees: 1_097,
		asylumSeekers: 16_320,
		otherInNeed: 2_810_778,
	});
	expect(at("abroad:COL", 2025)?.countryName).toBe("Colombia");
	expect(obs.some((o) => o.series === "abroad:-")).toBe(false);
});

test("URLs ask for eleven years of totals and three of countries", () => {
	const u = unhcrUrls(Date.UTC(2026, 8, 25));
	expect(u.abroad).toContain("coo=VEN&yearFrom=2015&yearTo=2026");
	expect(u.hosted).toContain("coa=VEN");
	expect(u.byCountry).toContain("coa_all=true&yearFrom=2023");
});

test("a malformed item is skipped; a body without items or not JSON fails the run", () => {
	const raw = raws[0] as RawResponse;
	const item = (refugees: unknown) =>
		JSON.stringify({
			items: [{ year: 2024, coa_iso: "-", coa_name: "-", refugees, asylum_seekers: "0", oip: "-" }],
		});
	expect(unhcrPopulation.normalise([{ ...raw, body: item("12") }])[0]?.value.refugees).toBe(12);
	expect(() => unhcrPopulation.normalise([{ ...raw, body: item(-4) }])).toThrow("ninguna fila");
	expect(() => unhcrPopulation.normalise([{ ...raw, body: item("n/a") }])).toThrow("ninguna fila");
	expect(() => unhcrPopulation.normalise([{ ...raw, body: "{}" }])).toThrow("items");
	expect(() => unhcrPopulation.normalise([{ ...raw, body: "<html>" }])).toThrow("JSON");
});
