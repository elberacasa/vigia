import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { fredMarkets, MARKET_SERIES } from "./index.ts";

const raws = loadFixture(join(import.meta.dir, "fixtures", "2026-09-24"));
const obs = fredMarkets.normalise(raws);
const latest = (series: string) =>
	obs.filter((o) => o.series === series).reduce((a, b) => (b.observedAt > a.observedAt ? b : a));

test("normalises two years of four FRED series with their units", () => {
	expect(raws.length).toBe(MARKET_SERIES.length);
	expect(obs.length).toBe(1981);
	expect(latest("gasoline-usgc").value).toEqual({ value: 3.891, unit: "US$/gal", date: "2026-09-22" });
	expect(latest("diesel-usgc").value).toEqual({ value: 4.992, unit: "US$/gal", date: "2026-09-22" });
	expect(latest("henry-hub").value).toEqual({ value: 2.9, unit: "US$/MMBtu", date: "2026-09-22" });
	// The Fed's H.10 is weekly: the newest day lags the EIA series.
	expect(latest("usd-broad").value).toEqual({ value: 119.5133, unit: "ene 2006 = 100", date: "2026-09-18" });
	for (const o of obs) {
		expect(o.source).toBe("fred-markets");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(o.sourceUrl).toStartWith("https://fred.stlouisfed.org/series/");
		expect(o.value.value).toBeGreaterThan(0);
	}
});

test("holiday rows are skipped; a foreign series or a changed header fails the run", () => {
	const gas = raws[0] as RawResponse;
	const body = `${gas.body.trimEnd()}\n2026-09-23,.\n`;
	expect(fredMarkets.normalise([{ ...gas, body }]).filter((o) => o.value.date === "2026-09-23")).toEqual([]);
	expect(() => fredMarkets.normalise([{ ...gas, body: "<html>" }])).toThrow("cabecera");
	expect(() =>
		fredMarkets.normalise([{ ...gas, url: "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DCOILWTICO" }]),
	).toThrow("serie inesperada");
});
