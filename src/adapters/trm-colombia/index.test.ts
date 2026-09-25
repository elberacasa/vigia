import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { bogotaMidnight, trmColombia, trmUrl } from "./index.ts";

const raws = loadFixture(join(import.meta.dir, "fixtures", "2026-09-24"));
const raw = raws[0] as RawResponse;
const obs = trmColombia.normalise(raws);

test("one observation per validity period; the next day's TRM is kept, dated when it takes force", () => {
	expect(obs.length).toBe(259);
	const newest = obs.reduce((a, b) => (b.observedAt > a.observedAt ? b : a));
	expect(newest.value).toEqual({ copPerUsd: 3329.61, validFrom: "2026-09-25", validTo: "2026-09-25" });
	expect(new Date(newest.observedAt).toISOString()).toBe("2026-09-25T05:00:00.000Z");
	expect(newest.observedAt).toBeGreaterThan(newest.fetchedAt);
	// A weekend is one row.
	expect(obs.find((o) => o.value.validFrom === "2026-09-19")?.value.validTo).toBe("2026-09-21");
	for (const o of obs) {
		expect(o.source).toBe("trm-colombia");
		expect(o.observedAt - o.fetchedAt).toBeLessThan(5 * 86_400_000);
	}
});

test("bad rows are skipped, far-future rows refused, a non-list fails", () => {
	const body = JSON.stringify([
		{
			valor: "abc",
			unidad: "COP",
			vigenciadesde: "2026-09-10T00:00:00.000",
			vigenciahasta: "2026-09-10T00:00:00.000",
		},
		{
			valor: "4000",
			unidad: "COP",
			vigenciadesde: "2027-01-10T00:00:00.000",
			vigenciahasta: "2027-01-10T00:00:00.000",
		},
		{
			valor: "3200.5",
			unidad: "COP",
			vigenciadesde: "2026-09-10T00:00:00.000",
			vigenciahasta: "2026-09-10T00:00:00.000",
		},
	]);
	expect(trmColombia.normalise([{ ...raw, body }]).map((o) => o.value.copPerUsd)).toEqual([3200.5]);
	expect(() => trmColombia.normalise([{ ...raw, body: '{"error":true}' }])).toThrow("lista");
	expect(bogotaMidnight("2026-02-30")).toBeNull();
	expect(new URL(trmUrl(Date.UTC(2026, 8, 24))).searchParams.get("$where")).toBe(
		"vigenciadesde >= '2025-08-20T00:00:00'",
	);
});
