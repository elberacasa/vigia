import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { ZipReader } from "../../formats/zip.ts";
import { bcvHistory, cellDate, unitOn } from "./index.ts";

// Recorded 2026-09-24. The fixture was scrubbed before commit: docProps author fields set to "redacted" and
// xl/printerSettings/* removed (the adapter never opens either); every sheet is byte-for-byte as served.
const raws = loadFixture(join(import.meta.dir, "fixtures", "2026-09-24"));
const raw = raws[0] as RawResponse;
const obs = bcvHistory.normalise(raws);
const byDate = new Map(obs.map((o) => [o.value.valueDate, o]));

test("reads every yearly sheet since 2016, newest row = Fecha Valor 2026-09-23", () => {
	expect(obs.length).toBe(2588);
	const newest = obs.reduce((a, b) => (b.observedAt > a.observedAt ? b : a));
	expect(newest.value).toMatchObject({
		valueDate: "2026-09-23",
		vesPerUsd: 853.4993,
		bidVesPerUsd: 851.36555175,
	});
	expect(new Date(newest.observedAt).toISOString()).toBe("2026-09-23T04:00:00.000Z");
	const oldest = obs.reduce((a, b) => (b.observedAt < a.observedAt ? b : a));
	expect(oldest.value.valueDate.slice(0, 4)).toBe("2016");
	for (const o of obs) {
		expect(o.source).toBe("bcv-history");
		expect(o.series).toBe("usd-ves");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(o.sourceUrl).toStartWith("https://www.bcv.org.ve/");
	}
});

test("at least two years of daily history (about 245 business days a year)", () => {
	const twoYearsAgo = raw.fetchedAt - 2 * 365 * 86_400_000;
	expect(obs.filter((o) => o.observedAt >= twoYearsAgo).length).toBeGreaterThanOrEqual(475);
});

test("redenomination table: Bs.F ÷ 1e11, Bs.S ÷ 1e6, today's Bs. unchanged; labelled", () => {
	expect(unitOn("2018-08-17")).toEqual({ unit: "Bs.F", divisor: 1e11 });
	expect(unitOn("2018-08-20")).toEqual({ unit: "Bs.S", divisor: 1e6 });
	expect(unitOn("2021-09-30")).toEqual({ unit: "Bs.S", divisor: 1e6 });
	expect(unitOn("2021-10-01")).toEqual({ unit: "Bs.", divisor: 1 });

	const bsS = byDate.get("2021-09-29")?.value;
	expect(bsS).toMatchObject({ publishedAsk: 4138617.5603, publishedUnit: "Bs.S", divisor: 1e6 });
	expect(bsS?.vesPerUsd).toBeCloseTo(4.1386175603, 12);
	expect(bsS?.conversion).toContain("1.000.000");
	expect(byDate.get("2021-09-29")?.basis).toBe("derived");

	const bs = byDate.get("2021-10-04")?.value;
	expect(bs).toMatchObject({ publishedUnit: "Bs.", divisor: 1, conversion: null });
	expect(byDate.get("2021-10-04")?.basis).toBe("official");
	// The 2021 reconversion is continuous in today's bolívares (4.139 → 4.182).
	expect((bs?.vesPerUsd ?? 0) / (bsS?.vesPerUsd ?? 1)).toBeCloseTo(1.0104, 3);

	// 2018-08-20 was a bank holiday for the reconversion: the first Bs.S row is the 21st; the last Bs.F row the 17th.
	expect(byDate.get("2018-08-17")?.value).toMatchObject({ publishedAsk: 248832, publishedUnit: "Bs.F" });
	expect(byDate.get("2018-08-21")?.value).toMatchObject({ publishedAsk: 60, publishedUnit: "Bs.S" });
	expect(byDate.get("2018-08-21")?.value.vesPerUsd).toBeCloseTo(0.00006, 15);
	const bsF = byDate.get("2018-02-01")?.value; // Convenio 39: 3.345,00 Bs.F
	expect(bsF).toMatchObject({ publishedAsk: 3345, publishedUnit: "Bs.F", divisor: 1e11 });
	expect(bsF?.conversion).toContain("100.000.000.000");
});

test("2016 dates are text (dd/mm/yyyy); later years are Excel serials", () => {
	expect(cellDate("30/12/2016")).toBe("2016-12-30");
	expect(cellDate("31/02/2016")).toBeNull();
	expect(cellDate(46288)).toBe("2026-09-23");
	expect(cellDate("1/ Se refiere a la cotización")).toBeNull();
	expect(byDate.get("2016-12-30")?.value.publishedAsk).toBe(10);
});

test("never reads the workbook's author metadata", () => {
	const zip = new ZipReader(new Uint8Array(Buffer.from(raw.body, "base64")));
	expect(zip.readText("docProps/core.xml")).toContain("<dc:creator>redacted</dc:creator>");
	expect(JSON.stringify(obs)).not.toContain("redacted");
});

test("a file that is not an xlsx, or has no yearly sheets, fails loudly", () => {
	expect(() => bcvHistory.normalise([{ ...raw, body: Buffer.from("<html>").toString("base64") }])).toThrow(
		"ilegible",
	);
});
