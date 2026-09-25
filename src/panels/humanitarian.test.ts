import { expect, test } from "bun:test";
import { join } from "node:path";
import { mppsBoletin } from "../adapters/mpps-boletin/index.ts";
import { WEEKS } from "../adapters/mpps-boletin/weeks.gen.ts";
import { ochaFts } from "../adapters/ocha-fts/index.ts";
import { r4vFigures } from "../adapters/r4v-figures/index.ts";
import { reliefwebVe } from "../adapters/reliefweb-ve/index.ts";
import { unhcrPopulation } from "../adapters/unhcr-population/index.ts";
import { whoGho } from "../adapters/who-gho/index.ts";
import { hasFixture, loadFixture } from "../core/fixtures.ts";
import { Store } from "../core/store.ts";
import type { Adapter, Observation } from "../core/types.ts";
import { healthFigures, humanitarianView, pctFunded, sumReported, weeksOf } from "./humanitarian.ts";

const NOW = Date.UTC(2026, 8, 25, 12);
const fixture = (a: Adapter) => join(import.meta.dir, "..", "adapters", a.id, "fixtures", "2026-09-25");

function storeWith(adapters: readonly Adapter[]): Store {
	const store = new Store(":memory:");
	for (const a of adapters) if (hasFixture(fixture(a))) store.insert(a.normalise(loadFixture(fixture(a))));
	return store;
}

test("rules: % funded and the UNHCR sum treat missing data as missing", () => {
	expect(pctFunded(404_312_654, 931_304_121)).toBeCloseTo(43.414, 3);
	expect(pctFunded(5, 0)).toBeNull();
	expect(sumReported(1, null, 2)).toBe(3);
	expect(sumReported(null, null)).toBeNull();
	expect(sumReported(0, null)).toBe(0);
});

test("health: the newest transcribed week, its change from the week before, and the year's weeks", () => {
	const figures = healthFigures(WEEKS);
	const malaria = figures.find((f) => f.id === "malaria");
	expect(malaria).toMatchObject({ week: 851, previous: 924, yearToDate: 69_740, previousYearToDate: 73_157 });
	expect(malaria?.weeks.length).toBe(36);
	const dengue = figures.find((f) => f.id === "dengue");
	expect(dengue).toMatchObject({ week: 311, previous: 330, yearToDate: 11_722, previousYearToDate: null });
	// A missing previous week gives no change, never a guess.
	const gap = healthFigures(WEEKS.filter((w) => w.week !== 35));
	expect(gap.find((f) => f.id === "dengue")?.previous).toBeNull();
	expect(
		weeksOf([...WEEKS, { ...(WEEKS[0] as (typeof WEEKS)[number]), dengueWeek: 1 }], 2026)[0]?.dengueWeek,
	).toBe(339);
	expect(healthFigures([])).toEqual([]);
});

test("review 4 L10: transcription checks: week above year to date, year to date going down, coverage shifts", () => {
	const w1 = WEEKS.find((w) => w.week === 1);
	if (!w1) throw new Error("week 1 is transcribed");
	// Week 1 as transcribed: malaria 1.388 in the week, 1.348 in the year.
	const first = healthFigures([w1]).find((f) => f.id === "malaria");
	expect(first).toMatchObject({ week: 1388, yearToDate: null, previousYearToDate: null });
	expect(first?.notes[0]?.es).toBe(
		"El boletín da más casos en la semana (1.388) que en el año (1.348): el acumulado no se muestra.",
	);
	const w2 = { ...w1, week: 2, malariaWeek: 900, malariaYear: 1200, coveragePct: w1.coveragePct };
	const down = healthFigures([{ ...w1, malariaYear: 1400 }, w2]).find((f) => f.id === "malaria");
	expect(down).toMatchObject({ yearToDate: null, previous: 1388 });
	expect(down?.notes[0]?.es).toContain("menor que el de la semana anterior");
	// Coverage 46,3 % → 58,7 %: no weekly change, said once per figure.
	const shifted = healthFigures([w1, { ...w2, malariaYear: 2300, coveragePct: 58.7 }]).find(
		(f) => f.id === "dengue",
	);
	expect(shifted?.previous).toBeNull();
	expect(shifted?.notes.map((n) => n.es)).toEqual([
		"Sin cambio semanal: la cobertura pasó de 46,3 % a 58,7 % de los centros.",
	]);
	// The current bulletin passes every check.
	for (const f of healthFigures(WEEKS)) expect(f.notes).toEqual([]);
});

test("the full view from the recorded fixtures", () => {
	const store = storeWith([mppsBoletin, whoGho, r4vFigures, unhcrPopulation, ochaFts, reliefwebVe]);
	const v = humanitarianView(store, NOW);

	expect(v.health.bulletin).toMatchObject({ year: 2026, week: 36, from: "2026-09-06", to: "2026-09-12" });
	expect(v.health.coveragePct).toBe(49.83);
	expect(v.health.measles).toEqual({
		suspected: 1819,
		discarded: 1636,
		investigating: 183,
		consistent: true,
	});
	expect(v.health.yellowFever).toEqual({ cases: 10, deaths: 3 });
	// WHO: reported and estimated malaria for the same year.
	expect(v.health.malaria).toEqual({
		year: 2024,
		reported: 101_924,
		estimated: 110_613,
		low: 98_000,
		high: 128_000,
	});
	expect(v.health.who.find((w) => w.id === "mcv1-coverage")).toMatchObject({ year: 2025, value: 53 });

	// FTS: the 2026 HRP first, then the RMRP, then older plans.
	expect(v.aid.plans[0]).toMatchObject({
		code: "HVEN26",
		fundedUsd: 404_312_654,
		gapUsd: 931_304_121 - 404_312_654,
	});
	expect(v.aid.plans[0]?.pctFunded).toBeCloseTo(43.41, 2);
	expect(v.aid.plans[1]?.code).toBe("RREG26b");
	expect(v.aid.plans.at(-1)?.code).toBe("HVEN19");
	expect(v.aid.stale).toBe(false);

	if (hasFixture(fixture(mppsBoletin))) {
		expect(v.health.listed).toMatchObject({ year: 2026, week: 36 });
		expect(v.health.untranscribed).toBe(0);
		expect(v.health.stale).toBe(false);
	}
	if (hasFixture(fixture(r4vFigures))) {
		expect(v.migration.r4v.total).toMatchObject({ people: 6_978_009, month: "2026-08" });
		expect(v.migration.r4v.countries[0]).toMatchObject({ countryEs: "Colombia", people: 2_844_498 });
		expect(v.migration.r4v.stale).toBe(false);
	}
	if (hasFixture(fixture(reliefwebVe))) {
		expect(v.aid.disasters[0]?.glide).toBe("EQ-2026-000093-VEN");
		expect(v.aid.reports.length).toBe(8);
	}

	expect(v.migration.unhcr.year).toBe(2025);
	expect(v.migration.unhcr.abroad?.total).toBe(417_010 + 1_181_156 + 6_042_706);
	expect(v.migration.unhcr.abroadByYear[0]).toEqual({ year: 2015, total: 7_455 + 15_087 });
	expect(v.migration.unhcr.hosted).toMatchObject({ year: 2025, total: 14_333 + 1_577 });
	expect(v.migration.unhcr.top[0]?.country).toBe("COL");
	expect(v.migration.unhcr.top.length).toBe(8);
	expect(v.security.years.at(-1)?.year).toBe(2023);
});

test("a ministry week newer than the transcription is counted, not shown as transcribed", () => {
	const store = new Store(":memory:");
	const week = (w: number): Observation => ({
		source: "mpps-boletin",
		series: `bulletin:2026-${w}`,
		sourceUrl: `https://mpps.gob.ve/wp-content/uploads/2026/10/Boletin-Epidemiologico-SEM-${w}.pdf`,
		fetchedAt: Date.UTC(2026, 9, 10),
		observedAt: Date.UTC(2026, 8, 20 + 7 * (w - 37)),
		licence: "mpps-attribution",
		value: { year: 2026, week: w, pdfUrl: "x", from: "a", to: "b" },
		confidence: 1,
		basis: "official",
	});
	store.insert([week(37), week(38)]);
	const v = humanitarianView(store, Date.UTC(2026, 9, 10));
	expect(v.health.bulletin?.week).toBe(36);
	expect(v.health.listed?.week).toBe(38);
	expect(v.health.untranscribed).toBe(2);
});

test("an empty store gives an honest empty view", () => {
	const v = humanitarianView(new Store(":memory:"), NOW);
	expect(v.health.listed).toBeNull();
	expect(v.health.stale).toBe(true);
	expect(v.health.malaria).toBeNull();
	expect(v.migration.r4v.total).toBeNull();
	expect(v.migration.unhcr.abroad).toBeNull();
	expect(v.aid.plans).toEqual([]);
	expect(v.aid.stale).toBe(true);
	// The transcribed bulletin needs no store: it is a tested file with its own sources.
	expect(v.health.bulletin?.week).toBe(36);
});
