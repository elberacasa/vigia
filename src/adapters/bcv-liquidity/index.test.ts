import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { readCfbStream } from "../../formats/xls.ts";
import { bcvDateCell } from "../bcv-official/cells.ts";
import { bcvLiquidity, thousandsToVes } from "./index.ts";

// Recorded 2026-09-28 (legacy BIFF8 .xls, 340,480 bytes). Scrubbed before commit with
// scripts/scrub-office-fixture.ts: the document-property strings and the WRITEACCESS user name replaced with "x"
// of the same length; every cell is byte-for-byte as served (the script checks it).
const raws = loadFixture(join(import.meta.dir, "fixtures", "2026-09-28"));
const raw = raws[0] as RawResponse;
const obs = bcvLiquidity.normalise(raws).sort((a, b) => a.observedAt - b.observedAt);
const byWeek = new Map(obs.map((o) => [o.value.weekEnding, o]));

test("reads every week of the current-bolívar sheet, 01/10/2021 to 18/09/2026", () => {
	expect(obs.length).toBe(260);
	expect(obs[0]?.value.weekEnding).toBe("2021-10-01");
	const newest = obs.at(-1);
	expect(newest?.value).toEqual({
		weekEnding: "2026-09-18",
		currencyVes: 79_889_194_534.16,
		demandDepositsVes: 2_514_501_098_334.66,
		savingsDepositsVes: 236_888_778_512.7,
		m1Ves: 2_831_279_071_381.52,
		quasiMoneyVes: 7_866_916_123.29,
		m2Ves: 2_839_145_987_504.81,
		publishedChangePct: 3.349587230505069,
		provisional: true,
		rectified: false,
	});
	// Friday 18 Sep 2026, 00:00 Caracas.
	expect(new Date(newest?.observedAt ?? 0).toISOString()).toBe("2026-09-18T04:00:00.000Z");
	expect(newest?.confidence).toBe(0.9);
	for (const o of obs) {
		expect(o.source).toBe("bcv-liquidity");
		expect(o.series).toBe("m2");
		expect(o.basis).toBe("official");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(o.sourceUrl).toBe("https://www.bcv.org.ve/estadisticas/liquidez-monetaria");
		expect(new Date(o.observedAt - 4 * 3_600_000).getUTCDay()).toBe(5);
	}
});

test("marks: (*) provisional, * rectified", () => {
	expect(byWeek.get("2026-09-11")?.value).toMatchObject({ provisional: false, rectified: true });
	expect(byWeek.get("2026-09-04")?.value).toMatchObject({ provisional: false, rectified: false });
	expect(bcvDateCell("18/09/2026 (*)")).toEqual({ date: "2026-09-18", provisional: true, rectified: false });
	expect(bcvDateCell("25/09/2026(*)")).toEqual({ date: "2026-09-25", provisional: true, rectified: false });
	expect(bcvDateCell("11/09/2026 *")).toEqual({ date: "2026-09-11", provisional: false, rectified: true });
	expect(bcvDateCell("03/7/2026")).toEqual({ date: "2026-07-03", provisional: false, rectified: false });
	expect(bcvDateCell(46234)).toEqual({ date: "2026-07-31", provisional: false, rectified: false });
	expect(bcvDateCell("31/02/2026")).toBeNull();
	expect(bcvDateCell("Semana")).toBeNull();
});

test("the components add up (M1 = currency + demand + savings, M2 = M1 + quasi-money), as the BCV publishes them", () => {
	// Measured: two weeks of June 2026 where the BCV's M2 is 18.1 and 14.1 million Bs below M1 + quasi-money
	// (0.0008 %). Stored as published; the check pins that these are the only ones.
	const m1Off: string[] = [];
	const m2Off: string[] = [];
	for (const { value: v } of obs) {
		if (Math.abs(v.currencyVes + v.demandDepositsVes + v.savingsDepositsVes - v.m1Ves) >= 1)
			m1Off.push(v.weekEnding);
		if (Math.abs(v.m1Ves + v.quasiMoneyVes - v.m2Ves) >= 1) m2Off.push(v.weekEnding);
	}
	expect(m1Off).toEqual([]);
	expect(m2Off).toEqual(["2026-06-19", "2026-06-26"]);
});

test("the BCV's published % agrees with the levels, except two weeks (measured; the BCV gives no reason)", () => {
	const off: string[] = [];
	for (let i = 1; i < obs.length; i++) {
		const prev = obs[i - 1]?.value.m2Ves ?? 0;
		const cur = obs[i]?.value;
		if (!cur || cur.publishedChangePct === null) continue;
		if (Math.abs((cur.m2Ves / prev - 1) * 100 - cur.publishedChangePct) >= 0.005) off.push(cur.weekEnding);
	}
	expect(off).toEqual(["2023-02-24", "2025-05-09"]);
});

test("thousands to bolívares keeps céntimos and drops float noise", () => {
	expect(thousandsToVes(2734254.3279999997)).toBe(2_734_254_328);
	expect(thousandsToVes(0.01)).toBe(10);
});

test("the fixture's author metadata is scrubbed and never reaches an observation", () => {
	const bytes = new Uint8Array(Buffer.from(raw.body, "base64"));
	const summary = Buffer.from(readCfbStream(bytes, ["\x05SummaryInformation"])).toString("latin1");
	const runs = summary.replaceAll(String.fromCharCode(0), "").match(/[A-Za-z]{4,}/g) ?? [];
	expect(runs.every((r) => /^x+$/.test(r))).toBe(true);
	expect(JSON.stringify(obs)).not.toMatch(/xxxx/);
});

test("304 stores nothing; a file that is not an .xls or has no current sheet fails loudly", () => {
	expect(bcvLiquidity.normalise([{ ...raw, status: 304, body: "" }])).toEqual([]);
	expect(() => bcvLiquidity.normalise([{ ...raw, body: Buffer.from("<html>").toString("base64") }])).toThrow(
		"ilegible",
	);
	expect(() => bcvLiquidity.normalise([])).toThrow("no response");
});
