import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { ZipReader } from "../../formats/zip.ts";
import { bcvReserves, reserveColumns } from "./index.ts";

// Recorded 2026-09-28 (2_1_1.xlsx, 319,994 bytes). Scrubbed before commit with scripts/scrub-office-fixture.ts:
// docProps/core.xml authors set to "redacted" and xl/printerSettings/* removed (the adapter opens neither); every
// sheet reads identically (the script checks it).
const raws = loadFixture(join(import.meta.dir, "fixtures", "2026-09-28"));
const raw = raws[0] as RawResponse;
const obs = bcvReserves.normalise(raws).sort((a, b) => a.observedAt - b.observedAt);
const byDate = new Map(obs.map((o) => [o.value.date, o]));

test("reads every business day since 2016; newest 25/09/2026, provisional", () => {
	expect(obs.length).toBe(2588);
	expect(obs[0]?.value).toEqual({
		date: "2016-01-04",
		bcvMusd: 16327,
		femMusd: 3,
		totalMusd: 16330,
		provisional: false,
	});
	expect(obs.at(-1)?.value).toEqual({
		date: "2026-09-25",
		bcvMusd: 12724,
		femMusd: 3,
		totalMusd: 12727,
		provisional: true,
	});
	expect(new Date(obs.at(-1)?.observedAt ?? 0).toISOString()).toBe("2026-09-25T04:00:00.000Z");
	// The home page of 2026-09-24 said "Reservas Internacionales 23/09/2026: 12.912 MM US$".
	expect(byDate.get("2026-09-23")?.value.totalMusd).toBe(12912);
	expect(obs.filter((o) => o.value.provisional).length).toBe(18);
	for (const o of obs) {
		expect(o.source).toBe("bcv-reserves");
		expect(o.series).toBe("reserves");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(o.confidence).toBe(o.value.provisional ? 0.9 : 1);
		expect(o.value.bcvMusd + o.value.femMusd).toBe(o.value.totalMusd);
	}
});

test("a day written twice with different figures is dropped, not guessed (2021-10-22)", () => {
	expect(byDate.has("2021-10-22")).toBe(false);
	expect(byDate.has("2021-10-21")).toBe(true);
});

test("the header must say FECHA | BCV | FEM | TOTAL in millions of US$", () => {
	const rows = [
		["FECHA", "BCV", "FEM (1)", "TOTAL "],
		[null, "Millones de USD", null, null],
	];
	expect(reserveColumns(rows)).toBe(0);
	expect(
		reserveColumns([
			["FECHA", "BCV", "FIEM / FEM (1)", "TOTAL "],
			[null, "(Millones de US$)"],
		]),
	).toBe(0);
	expect(
		reserveColumns([
			["FECHA", "BCV", "FEM (1)", "TOTAL "],
			[null, "Millones de EUR"],
		]),
	).toBeNull();
	expect(reserveColumns([["Fecha", "Monto"]])).toBeNull();
});

test("the fixture carries no author names", () => {
	const zip = new ZipReader(new Uint8Array(Buffer.from(raw.body, "base64")));
	expect(zip.readText("docProps/core.xml")).toContain("<dc:creator>redacted</dc:creator>");
	expect(zip.names().some((n) => n.includes("printerSettings"))).toBe(false);
});

test("304 stores nothing; a broken file fails loudly", () => {
	expect(bcvReserves.normalise([{ ...raw, status: 304, body: "" }])).toEqual([]);
	expect(() => bcvReserves.normalise([{ ...raw, body: Buffer.from("nope").toString("base64") }])).toThrow(
		"ilegible",
	);
});
