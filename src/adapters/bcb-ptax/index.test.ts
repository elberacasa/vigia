import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { bcbPtax, brasiliaToMs, ptaxUrl } from "./index.ts";

const raws = loadFixture(join(import.meta.dir, "fixtures", "2026-09-24"));
const raw = raws[0] as RawResponse;
const obs = bcbPtax.normalise(raws);

test("one closing PTAX per business day, stamped in Brasília time", () => {
	expect(obs.length).toBe(277);
	const newest = obs.reduce((a, b) => (b.observedAt > a.observedAt ? b : a));
	expect(newest.value).toEqual({ brlPerUsd: 5.1795, buy: 5.1789, date: "2026-09-24" });
	expect(new Date(newest.observedAt).toISOString()).toBe("2026-09-24T16:03:18.656Z");
	for (const o of obs) {
		expect(o.source).toBe("bcb-ptax");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(o.value.brlPerUsd).toBeGreaterThanOrEqual(o.value.buy);
	}
});

test("bad rows are skipped; a missing envelope fails; dates are Brasília", () => {
	const body = JSON.stringify({
		value: [
			{ cotacaoCompra: "5", cotacaoVenda: 5.1, dataHoraCotacao: "2026-09-10 13:00:00.1" },
			{ cotacaoCompra: 5.0, cotacaoVenda: 5.1, dataHoraCotacao: "2026-09-10 13:00:00.1" },
		],
	});
	expect(bcbPtax.normalise([{ ...raw, body }]).length).toBe(1);
	expect(() => bcbPtax.normalise([{ ...raw, body: "{}" }])).toThrow("value");
	expect(brasiliaToMs("2026-09-24 22:30:00")).toBe(Date.UTC(2026, 8, 25, 1, 30));
	expect(brasiliaToMs("2026-02-30 10:00:00")).toBeNull();
	expect(ptaxUrl(Date.UTC(2026, 8, 24, 12))).toContain(
		"@dataInicial='08-20-2025'&@dataFinalCotacao='09-24-2026'",
	);
});
