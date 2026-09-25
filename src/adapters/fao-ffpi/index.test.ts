import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { faoFfpi, findCsvUrl, parseFfpiCsv } from "./index.ts";

const raws = loadFixture(join(import.meta.dir, "fixtures", "2026-09-24"));
const raw = raws[0] as RawResponse;
const obs = faoFfpi.normalise(raws);
const at = (series: string, month: string) => obs.find((o) => o.series === series && o.value.month === month);

test("five years of the index and its five groups; newest month August 2026", () => {
	expect(obs.length).toBe(360);
	expect(at("ffpi", "2026-08")?.value).toEqual({ index: 133.3, month: "2026-08" });
	expect(at("ffpi", "2025-08")?.value.index).toBeGreaterThan(0);
	expect(at("oils", "2026-08")?.value.index).toBe(196.9);
	expect(at("sugar", "2026-08")?.value.index).toBe(106.4);
	for (const o of obs) {
		expect(o.source).toBe("fao-ffpi");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
	}
});

test("finds the current CSV link (not the 2018 path) and decodes &amp;", () => {
	const html =
		'<a href="https://www.fao.org/media/docs/x/food_price_indices_data.csv?sfvrsn=1_83&amp;download=true">CSV</a>';
	expect(findCsvUrl(html)).toBe(
		"https://www.fao.org/media/docs/x/food_price_indices_data.csv?sfvrsn=1_83&download=true",
	);
	expect(findCsvUrl("<a href='x.csv'>")).toBeNull();
});

test("empty cells are skipped; a missing column or header fails the run", () => {
	const rows = parseFfpiCsv(
		"t\nDate,Food Price Index,Meat,Dairy,Cereals,Oils,Sugar,,\n,,,\n2026-09,130.0,,1,1,1,1,,\n",
	);
	expect(rows).toHaveLength(1);
	expect(rows[0]?.values.has("meat")).toBe(false);
	expect(rows[0]?.values.get("ffpi")).toBe(130);
	expect(() => faoFfpi.normalise([{ ...raw, body: "Date,Food Price Index\n2026-01,1\n" }])).toThrow(
		"columna",
	);
	expect(() => faoFfpi.normalise([{ ...raw, body: "<html>" }])).toThrow("cabecera");
});
