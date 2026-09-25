import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { bcvOfficial } from "../bcv-official/index.ts";
import type { BcvApiRate, BcvApiRead } from "./index.ts";
import { bcvApi, READ_SERIES } from "./index.ts";

const raws = loadFixture(join(import.meta.dir, "fixtures", "2026-09-24"));
const raw = raws[0] as RawResponse;
const recorded = JSON.parse(raw.body) as Record<string, unknown>;
const withJson = (patch: Record<string, unknown>, fetchedAt = raw.fetchedAt): RawResponse[] => [
	{ ...raw, body: JSON.stringify({ ...recorded, ...patch }), fetchedAt },
];

test("normalises the recorded answer: USD, EUR and one read, Fecha Valor of the next business day", () => {
	const obs = bcvApi.normalise(raws);
	expect(obs.map((o) => o.series)).toEqual(["usd-ves", "eur-ves", READ_SERIES]);
	const [usd, eur, read] = obs;
	expect(usd?.value).toEqual({
		currency: "USD",
		vesPerUnit: 855.6625,
		valueDate: "2026-09-25",
		changedAt: Date.parse("2026-09-24T19:36:45.700Z"),
	});
	expect((eur?.value as BcvApiRate | undefined)?.vesPerUnit).toBe(972.648677);
	// Fecha Valor 2026-09-25 00:00 Caracas = 04:00 UTC, the same instant bcv-official uses.
	expect(new Date(usd?.observedAt ?? 0).toISOString()).toBe("2026-09-25T04:00:00.000Z");
	// The read is observed at scraped_at: bcv-api's own last read of the BCV, never our later fetch time.
	expect(new Date(read?.observedAt ?? 0).toISOString()).toBe("2026-09-25T03:18:33.021Z");
	expect((read?.value as BcvApiRead | undefined)?.valueDate).toBe("2026-09-25");
	for (const o of obs) {
		expect(o.source).toBe("bcv-api");
		expect(o.basis).toBe("official");
		expect(o.licence).toBe("bcv-api-mirror");
		expect(o.sourceUrl).toBe("https://bcv-api.umbrabadge.workers.dev/");
		// Documented skew: the Fecha Valor may be up to 7 days after the fetch.
		expect(o.observedAt - o.fetchedAt).toBeLessThanOrEqual(7 * 86_400_000);
	}
});

test("the same recorded day read by both routes gives the same figures, series and instants", () => {
	const direct = loadFixture(join(import.meta.dir, "..", "bcv-official", "fixtures", "2026-09-24"));
	const official = bcvOfficial.normalise(direct);
	for (const o of bcvApi.normalise(raws).filter((x) => x.series !== READ_SERIES)) {
		const twin = official.find((d) => d.series === o.series);
		expect(twin?.observedAt).toBe(o.observedAt);
		expect(twin?.value.vesPerUnit).toBe((o.value as BcvApiRate).vesPerUnit);
		expect(twin?.value.valueDate).toBe((o.value as BcvApiRate).valueDate);
	}
});

test("Friday afternoon: a Monday Fecha Valor is accepted and dated 00:00 Caracas Monday", () => {
	const friday = Date.parse("2026-09-25T20:30:00Z"); // Friday 16:30 Caracas
	const obs = bcvApi.normalise(
		withJson(
			{ fecha_valor: "2026-09-28", scraped_at: "2026-09-25T20:25:00Z", changed_at: "2026-09-25T20:21:00Z" },
			friday,
		),
	);
	expect(obs[0]?.observedAt).toBe(Date.parse("2026-09-28T04:00:00Z"));
	expect((obs[0]?.value as BcvApiRate | undefined)?.valueDate).toBe("2026-09-28");
});

test("stale=true stores nothing and fails loudly", () => {
	expect(() => bcvApi.normalise(withJson({ stale: true }))).toThrow("stale=true");
});

test("a missing or broken EUR is skipped; a missing USD fails the envelope", () => {
	expect(bcvApi.normalise(withJson({ bcv_eur: null })).map((o) => o.series)).toEqual([
		"usd-ves",
		READ_SERIES,
	]);
	expect(bcvApi.normalise(withJson({ bcv_eur: "972,64" })).map((o) => o.series)).toEqual([
		"usd-ves",
		READ_SERIES,
	]);
	expect(() => bcvApi.normalise(withJson({ bcv_usd: null }))).toThrow("bcv-api");
	expect(() => bcvApi.normalise(withJson({ bcv_usd: -1 }))).toThrow("bcv-api");
});

test("envelope guards: not JSON, not the BCV, bad dates, future clocks, out-of-range Fecha Valor", () => {
	expect(() => bcvApi.normalise([{ ...raw, body: "<html>" }])).toThrow("no es JSON");
	expect(() => bcvApi.normalise(withJson({ source: "https://example.com/" }))).toThrow("bcv-api");
	expect(() => bcvApi.normalise(withJson({ fecha_valor: "2026-02-30" }))).toThrow("fecha_valor inválida");
	expect(() => bcvApi.normalise(withJson({ scraped_at: "2026-09-25 03:18" }))).toThrow("bcv-api");
	expect(() => bcvApi.normalise(withJson({ scraped_at: "2026-09-25T04:00:00Z" }))).toThrow("futuro");
	expect(() => bcvApi.normalise(withJson({ fecha_valor: "2026-10-09" }))).toThrow("fuera de rango");
	expect(() => bcvApi.normalise(withJson({ fecha_valor: "2026-06-01" }))).toThrow("fuera de rango");
});

test("a small clock lead is tolerated and clamped: the read is never later than our fetch", () => {
	const ahead = new Date(raw.fetchedAt + 60_000).toISOString();
	const read = bcvApi.normalise(withJson({ scraped_at: ahead })).at(-1);
	expect(read?.observedAt).toBe(raw.fetchedAt);
});
