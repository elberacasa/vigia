import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { bcvIntervention, parseInterventions } from "./index.ts";

// Recorded 2026-09-28 22:xx Caracas: the BCV's intervention page (440 KB of Drupal HTML).
const raws = loadFixture(join(import.meta.dir, "fixtures", "2026-09-28"));
const raw = raws[0] as RawResponse;
const obs = bcvIntervention.normalise(raws);
const byDate = new Map(obs.map((o) => [o.value.date, o]));

test("every intervention since May 2019; newest 28/09/2026 N° 030-26 at 976,90 Bs/EUR", () => {
	expect(obs.length).toBe(606);
	expect(obs[0]?.value).toEqual({
		date: "2026-09-28",
		number: "030-26",
		vesPerEur: 976.9,
		publishedRate: 976.9,
		publishedUnit: "Bs.",
		divisor: 1,
		conversion: null,
	});
	expect(new Date(obs[0]?.observedAt ?? 0).toISOString()).toBe("2026-09-28T04:00:00.000Z");
	expect(obs.at(-1)?.value.date).toBe("2019-05-13");
	for (const o of obs) {
		expect(o.source).toBe("bcv-intervention");
		expect(o.series).toBe("intervention");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(o.value.number).toMatch(/^\d{3}-\d{2}$/);
		expect(o.value.number.slice(4)).toBe(o.value.date.slice(2, 4));
	}
});

test("rates before the 2021 reconversion are converted and labelled; after it they are as published", () => {
	const old = byDate.get("2021-09-24")?.value;
	expect(old).toMatchObject({ publishedRate: 4744589.26, publishedUnit: "Bs.S", divisor: 1_000_000 });
	expect(old?.vesPerEur).toBeCloseTo(4.74458926, 8);
	expect(old?.conversion).toContain("1.000.000");
	expect(byDate.get("2021-09-24")?.basis).toBe("derived");
	expect(byDate.get("2021-10-04")?.value).toMatchObject({ vesPerEur: 4.85, divisor: 1, conversion: null });
});

test("the rate equals the BCV euro reference rate of that day to two decimals (25/09: 972,648677)", () => {
	expect(byDate.get("2026-09-25")?.value.vesPerEur).toBe(972.65);
});

test("a day listed twice with different rates is dropped, not guessed (2021-07-19)", () => {
	expect(parseInterventions(raw.body).filter((r) => r.date === "2021-07-19").length).toBe(2);
	expect(byDate.has("2021-07-19")).toBe(false);
});

test("a table whose rate column changed meaning fails loudly; 304 stores nothing", () => {
	const renamed = raw.body.replace("Tipo de Cambio Bs./EUR", "Monto (millones de EUR)");
	expect(() => bcvIntervention.normalise([{ ...raw, body: renamed }])).toThrow("Tipo de Cambio");
	expect(bcvIntervention.normalise([{ ...raw, status: 304, body: "" }])).toEqual([]);
});

test("a malformed row is skipped", () => {
	const html = `<th class="views-field views-field-field-monto-intervencion" >Tipo de Cambio Bs./EUR</th>
<tr><td class="views-field views-field-field-fecha-del-indicador" ><span content="2026-09-28T00:00:00-04:00">28-09-2026</span></td>
<td class="views-field views-field-field-nro-de-intervencion" >030-26</td><td class="views-field views-field-field-monto-intervencion" >976,90</td></tr>
<tr><td class="views-field views-field-field-fecha-del-indicador" ><span content="2026-09-25T00:00:00-04:00">25-09-2026</span></td>
<td class="views-field views-field-field-nro-de-intervencion" >029-26</td><td class="views-field views-field-field-monto-intervencion" >n/d</td></tr>`;
	const out = bcvIntervention.normalise([{ ...raw, body: html }]);
	expect(out.map((o) => o.value.date)).toEqual(["2026-09-28"]);
});
