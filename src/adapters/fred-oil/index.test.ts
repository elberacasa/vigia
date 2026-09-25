import { expect, test } from "bun:test";
import { join } from "node:path";
import pkg from "../../../package.json" with { type: "json" };
import { loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { csvUrl, fredOil, fredUserAgent } from "./index.ts";

const raws = loadFixture(join(import.meta.dir, "fixtures", "2026-09-24"));
const [brentRaw] = raws as [RawResponse, RawResponse];
const obs = fredOil.normalise(raws);
const latest = (series: string) =>
	obs.filter((o) => o.series === series).reduce((a, b) => (b.observedAt > a.observedAt ? b : a));

test("normalises two years of Brent and WTI; newest day 2026-09-22", () => {
	expect(obs.length).toBe(1001);
	expect(latest("brent").value).toEqual({ usdPerBarrel: 114.89, date: "2026-09-22" });
	expect(latest("wti").value).toEqual({ usdPerBarrel: 96.41, date: "2026-09-22" });
	expect(new Date(latest("brent").observedAt).toISOString()).toBe("2026-09-22T00:00:00.000Z");
	for (const o of obs) {
		expect(o.source).toBe("fred-oil");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(o.sourceUrl).toStartWith("https://fred.stlouisfed.org/series/DCOIL");
		expect(o.value.usdPerBarrel).toBeGreaterThan(0);
	}
});

test("holiday rows (empty or '.') are skipped, never read as zero", () => {
	const body = `${brentRaw.body.trimEnd()}\n2026-09-23,\n2026-09-24,.\n`;
	const extra = fredOil.normalise([{ ...brentRaw, body }]);
	expect(extra.filter((o) => o.value.date >= "2026-09-23").length).toBe(0);
});

test("a changed header or an unknown series fails the run", () => {
	expect(() => fredOil.normalise([{ ...brentRaw, body: "<html>blocked</html>" }])).toThrow("cabecera");
	expect(() =>
		fredOil.normalise([{ ...brentRaw, url: "https://fred.stlouisfed.org/graph/fredgraph.csv?id=X" }]),
	).toThrow("serie inesperada");
});

test("sends the runtime's real name first in the User-Agent, and trims to two years", () => {
	expect(fredUserAgent("1.4.2")).toBe(
		`Bun/1.4.2 Vigia/${pkg.version} (open-source situation room for Venezuela)`,
	);
	expect(new URL(csvUrl("DCOILWTICO", Date.UTC(2026, 8, 24))).searchParams.get("cosd")).toBe("2024-09-24");
});
