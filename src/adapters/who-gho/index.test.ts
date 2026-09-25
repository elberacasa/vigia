import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { GHO_INDICATORS, ghoUrl, whoGho } from "./index.ts";

const raws = loadFixture(join(import.meta.dir, "fixtures", "2026-09-25"));
const obs = whoGho.normalise(raws);
const at = (series: string, year: number) => obs.find((o) => o.series === series && o.value.year === year);

test("reported malaria next to WHO's estimate, reported cases and WUENIC coverage, per year", () => {
	expect(raws.length).toBe(GHO_INDICATORS.length);
	expect(at("malaria-reported", 2024)?.value.value).toBe(101_924);
	expect(at("malaria-reported", 2024)?.basis).toBe("official");
	expect(at("malaria-estimated", 2024)?.value).toMatchObject({ value: 110_613, low: 98_000, high: 128_000 });
	expect(at("malaria-estimated", 2024)?.basis).toBe("quote");
	// "0E-9" is zero cases.
	expect(at("measles-reported", 2025)?.value.value).toBe(0);
	expect(at("diphtheria-reported", 2024)?.value.value).toBe(2);
	expect(at("mcv1-coverage", 2025)?.value).toMatchObject({ value: 53, updated: "2026-07-14" });
	expect(at("dtp3-coverage", 2025)?.value.value).toBe(50);
	for (const o of obs) {
		expect(o.source).toBe("who-gho");
		expect(o.observedAt).toBe(Date.UTC(o.value.year, 11, 31));
		expect(o.sourceUrl.startsWith("https://www.who.int/data/gho/")).toBe(true);
	}
});

const raw = (code: string, value: unknown[]): RawResponse => ({
	url: ghoUrl(code),
	status: 200,
	contentType: "application/json",
	body: JSON.stringify({ value }),
	fetchedAt: Date.UTC(2026, 8, 25),
});
const row = (over: Record<string, unknown>) => ({
	IndicatorCode: "WHS8_110",
	SpatialDim: "VEN",
	TimeDim: 2025,
	Dim1: null,
	NumericValue: 53,
	Date: "2026-07-14T14:45:35.19+02:00",
	...over,
});

test("breakdowns, other countries, impossible percentages and future years are skipped", () => {
	const out = whoGho.normalise([
		raw("WHS8_110", [
			row({}),
			row({ Dim1: "SEX_FMLE" }),
			row({ SpatialDim: "COL" }),
			row({ NumericValue: 140 }),
			row({ TimeDim: 2027 }),
			row({ NumericValue: "n/a" }),
		]),
	]);
	expect(out.map((o) => [o.series, o.value.year, o.value.value])).toEqual([["mcv1-coverage", 2025, 53]]);
});

test("an empty or malformed response fails the run", () => {
	expect(() => whoGho.normalise([raw("WHS8_110", [])])).toThrow("ninguna cifra");
	expect(() => whoGho.normalise([{ ...raw("WHS8_110", []), body: "<html>" }])).toThrow("JSON");
	expect(() => whoGho.normalise([{ ...raw("WHS8_110", []), body: "{}" }])).toThrow("value");
});
