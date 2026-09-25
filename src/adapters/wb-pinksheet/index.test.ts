import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { findWorkbookUrl, monthStart, PINK_SERIES, parsePeriod, parseUpdated, wbPinksheet } from "./index.ts";

const raws = loadFixture(join(import.meta.dir, "fixtures", "2026-09-24"));
const obs = wbPinksheet.normalise(raws);
const at = (series: string, month: string) => obs.find((o) => o.series === series && o.value.month === month);

test("keeps five years of eleven commodities; newest month August 2026", () => {
	expect(obs.length).toBe(660);
	expect(new Set(obs.map((o) => o.series)).size).toBe(PINK_SERIES.length);
	expect(at("gold", "2026-08")?.value).toEqual({ value: 4411, unit: "US$/oz troy", month: "2026-08" });
	expect(at("iron-ore", "2026-08")?.value.value).toBe(96.3);
	// Two wheat columns exist (SRW 263.2, HRW 330): we read HRW.
	expect(at("wheat", "2026-08")?.value.value).toBe(330);
	// "Rice, Thai 5% " and "Urea " carry a trailing space in the workbook.
	expect(at("rice", "2026-08")?.value.value).toBe(471);
	expect(at("urea", "2026-08")?.value.value).toBe(390);
	expect(at("gold", "2026-08")?.observedAt).toBe(Date.UTC(2026, 7, 1));
	for (const o of obs) {
		expect(o.source).toBe("wb-pinksheet");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(o.value.value).toBeGreaterThan(0);
	}
});

test("parses the period, the update line and the workbook link", () => {
	expect(parsePeriod("2026M08")).toBe("2026-08");
	expect(parsePeriod("2026M13")).toBeNull();
	expect(parsePeriod(2026)).toBeNull();
	expect(parseUpdated([["Updated on September 02, 2026"]])).toBe("2026-09-02");
	expect(monthStart("2026-01")).toBe(Date.UTC(2026, 0, 1));
	expect(
		findWorkbookUrl(
			'<a href="https://thedocs.worldbank.org/en/doc/abc-0050012026/related/CMO-Historical-Data-Monthly.xlsx">',
		),
	).toBe("https://thedocs.worldbank.org/en/doc/abc-0050012026/related/CMO-Historical-Data-Monthly.xlsx");
	expect(findWorkbookUrl("<html></html>")).toBeNull();
});

test("a response that is not an xlsx, or no workbook at all, fails the run", () => {
	const raw = raws[0] as RawResponse;
	expect(() => wbPinksheet.normalise([{ ...raw, body: Buffer.from("<html>").toString("base64") }])).toThrow(
		"xlsx",
	);
	expect(() => wbPinksheet.normalise([{ ...raw, url: "https://example.org/x.xlsx" }])).toThrow(
		"libro mensual",
	);
});
