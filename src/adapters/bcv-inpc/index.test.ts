import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { readCfbStream } from "../../formats/xls.ts";
import { bcvInpc, monthNumber, yearHeader } from "./index.ts";

// Recorded 2026-09-24 (legacy BIFF8 .xls). Scrubbed before commit: the text in the SummaryInformation /
// DocumentSummaryInformation streams and the WRITEACCESS record (user names) replaced; cell data untouched.
const raws = loadFixture(join(import.meta.dir, "fixtures", "2026-09-24"));
const raw = raws[0] as RawResponse;
const obs = bcvInpc.normalise(raws).sort((a, b) => a.observedAt - b.observedAt);
const byPeriod = new Map(obs.map((o) => [o.value.period, o]));

test("reads every month from December 2007 to August 2026", () => {
	expect(obs.length).toBe(225);
	expect(obs[0]?.value).toEqual({ period: "2007-12", index: 100, monthlyPct: null, provisional: false });
	expect(byPeriod.get("2026-08")?.value).toEqual({
		period: "2026-08",
		index: 637409769724325.1,
		monthlyPct: 8.9,
		provisional: true,
	});
	// observedAt = first day of the month, 00:00 Caracas.
	expect(new Date(byPeriod.get("2026-08")?.observedAt ?? 0).toISOString()).toBe("2026-08-01T04:00:00.000Z");
	for (const o of obs) {
		expect(o.source).toBe("bcv-inpc");
		expect(o.series).toBe("inpc");
		expect(o.basis).toBe("official");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
	}
});

test("years marked (*) are provisional, with lower confidence", () => {
	expect(byPeriod.get("2025-01")?.value.provisional).toBe(true);
	expect(byPeriod.get("2025-01")?.confidence).toBe(0.9);
	expect(byPeriod.get("2024-12")?.value.provisional).toBe(false);
	expect(byPeriod.get("2024-12")?.confidence).toBe(1);
});

test("the published monthly % agrees with the index levels (within rounding) for all 224 months", () => {
	for (let i = 1; i < obs.length; i++) {
		const prev = obs[i - 1]?.value.index ?? 0;
		const cur = obs[i]?.value;
		const computed = ((cur?.index ?? 0) / prev - 1) * 100;
		expect(Math.abs(computed - (cur?.monthlyPct ?? Number.NaN))).toBeLessThan(0.051);
	}
});

test("month and year labels", () => {
	expect(monthNumber("Septiembre")).toBe(9);
	expect(monthNumber(" setiembre ")).toBe(9);
	expect(monthNumber("Índice")).toBeNull();
	expect(yearHeader("2026(*)")).toEqual({ year: 2026, provisional: true });
	expect(yearHeader("2019")).toEqual({ year: 2019, provisional: false });
	expect(yearHeader("( BASE Diciembre 2007 = 100 )")).toBeNull();
});

test("author metadata stays out of the fixture and the observations", () => {
	const bytes = new Uint8Array(Buffer.from(raw.body, "base64"));
	const summary = Buffer.from(readCfbStream(bytes, ["\x05SummaryInformation"])).toString("latin1");
	const runs = summary.replaceAll(String.fromCharCode(0), "").match(/[A-Za-z]{4,}/g) ?? [];
	expect(runs.every((r) => /^x+$/.test(r))).toBe(true);
	expect(JSON.stringify(obs)).not.toMatch(/xxxx/);
});

test("a file that is not an .xls fails loudly", () => {
	expect(() => bcvInpc.normalise([{ ...raw, body: Buffer.from("<html>").toString("base64") }])).toThrow(
		"ilegible",
	);
});
