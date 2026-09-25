import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { bcvOfficial, parseRate, parseValueDate } from "./index.ts";

const raws = loadFixture(join(import.meta.dir, "fixtures", "2026-09-24"));
const raw = raws[0] as RawResponse;
const withBody = (body: string, fetchedAt = raw.fetchedAt): RawResponse[] => [{ ...raw, body, fetchedAt }];

test("normalises the recorded home page: five currencies, Fecha Valor of the next business day", () => {
	const obs = bcvOfficial.normalise(raws);
	expect(obs.map((o) => o.series)).toEqual(["usd-ves", "eur-ves", "cny-ves", "try-ves", "rub-ves"]);
	const usd = obs[0];
	expect(usd?.value).toEqual({ currency: "USD", vesPerUnit: 855.6625, valueDate: "2026-09-25" });
	expect(obs[1]?.value.vesPerUnit).toBe(972.648677);
	expect(obs[2]?.value.vesPerUnit).toBe(127.50149009);
	expect(obs[3]?.value.vesPerUnit).toBe(17.54485339);
	expect(obs[4]?.value.vesPerUnit).toBe(10.0676244);
	// Fecha Valor 2026-09-25 00:00 Caracas = 04:00 UTC.
	expect(new Date(usd?.observedAt ?? 0).toISOString()).toBe("2026-09-25T04:00:00.000Z");
	for (const o of obs) {
		expect(o.source).toBe("bcv-official");
		expect(o.basis).toBe("official");
		expect(o.confidence).toBe(1);
		expect(o.sourceUrl).toBe("https://www.bcv.org.ve/");
		// Documented skew: the BCV publishes the next business day's rate the afternoon before, so observedAt
		// (the Fecha Valor) may be up to 7 days after the fetch.
		expect(o.observedAt - o.fetchedAt).toBeLessThanOrEqual(7 * 86_400_000);
	}
});

test("never reads the stale 2019 block that is still in the HTML", () => {
	expect(raw.body).toContain("15/05/2019");
	expect(raw.body).toContain("5.368,9281");
	const values = bcvOfficial.normalise(raws).map((o) => o.value.vesPerUnit);
	expect(values).not.toContain(5368.9281);
	expect(values).not.toContain(5355.5058);
});

test("a page without the dolar block (only the 2019 block) fails loudly instead of guessing", () => {
	const body = raw.body.replace(/id="dolar"/g, 'id="dolar-x"');
	expect(() => bcvOfficial.normalise(withBody(body))).toThrow("Fecha Valor");
});

test("a missing optional currency is skipped; a missing USD rate throws", () => {
	const noYuan = raw.body.replace("127,50149009", "n/d");
	expect(bcvOfficial.normalise(withBody(noYuan)).map((o) => o.series)).not.toContain("cny-ves");
	const noUsd = raw.body.replace("855,66250000", "n/d");
	expect(() => bcvOfficial.normalise(withBody(noUsd))).toThrow("USD");
});

test("a currency block with the wrong code is not trusted", () => {
	expect(parseRate(raw.body.replace("<span> USD</span>", "<span> XXX</span>"), "dolar", "USD")).toBeNull();
});

test("Fecha Valor must be near the fetch time: a far-future or very old date throws", () => {
	const future = Date.parse("2026-09-10T12:00:00Z"); // 15 days before the Fecha Valor
	expect(() => bcvOfficial.normalise(withBody(raw.body, future))).toThrow("fuera de rango");
	const past = Date.parse("2026-12-31T12:00:00Z");
	expect(() => bcvOfficial.normalise(withBody(raw.body, past))).toThrow("fuera de rango");
	// A Friday fetch that already shows Monday's rate is fine.
	const friday = Date.parse("2026-09-25T20:00:00Z");
	const monday = raw.body.replace(
		/content="2026-09-25T00:00:00-04:00"/,
		'content="2026-09-28T00:00:00-04:00"',
	);
	expect(bcvOfficial.normalise(withBody(monday, friday))[0]?.value.valueDate).toBe("2026-09-28");
});

test("parses the Fecha Valor in Caracas time", () => {
	expect(parseValueDate(raw.body)).toEqual({ valueDate: "2026-09-25", observedAt: Date.UTC(2026, 8, 25, 4) });
	expect(
		parseValueDate(
			raw.body.replace('content="2026-09-25T00:00:00-04:00"', 'content="2026-09-25T00:00:00+00:00"'),
		),
	).toBeNull();
});
