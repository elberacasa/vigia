import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { isHrp, isRmrp, ochaFts, plansFrom } from "./index.ts";

const raws = loadFixture(join(import.meta.dir, "fixtures", "2026-09-25"));
const obs = ochaFts.normalise(raws);
const plan = (code: string) => obs.find((o) => o.series === `plan:${code}`)?.value;

test("eight Venezuela HRPs and the 2026 RMRP, with requirements and funding as FTS reported them", () => {
	expect(obs.length).toBe(9);
	expect(plan("HVEN26")).toEqual({
		planId: 1517,
		code: "HVEN26",
		name: "Venezuela Plan de Respuesta Humanitaria 2026",
		year: 2026,
		kind: "hrp",
		requirementsUsd: 931_304_121,
		originalRequirementsUsd: 632_191_972,
		fundedUsd: 404_312_654,
	});
	expect(plan("RREG26b")?.kind).toBe("rmrp");
	expect(plan("RREG26b")?.requirementsUsd).toBe(763_092_338);
	// FTS gives no original requirements for 2025: null, not 0.
	expect(plan("HVEN25")?.originalRequirementsUsd).toBeNull();
	for (const o of obs) {
		expect(o.source).toBe("ocha-fts");
		expect(o.observedAt).toBe(o.fetchedAt);
		expect(o.sourceUrl).toMatch(/^https:\/\/fts\.unocha\.org\/plans\/\d+\/summary$/);
	}
});

test("plan codes: HVENyy are HRPs; the RMRP is recognised by a regional code and its name", () => {
	expect(isHrp("HVEN26")).toBe(true);
	expect(isHrp("HVEN2026")).toBe(false);
	expect(isRmrp("RREG26b", "Venezuela Regional Refugee and Migrant Response Plan (RMRP) 2026")).toBe(true);
	expect(isRmrp("RREG26a", "Sudan Emergency: Regional Refugee Response Plan 2026")).toBe(false);
	expect(isRmrp("HVEN26", "Venezuela RMRP")).toBe(false);
});

test("a malformed plan row is skipped; a malformed envelope or flow fails the run", () => {
	expect(
		plansFrom(
			{ data: [{ id: "x" }, { id: 5, planVersion: { code: "HVEN30", name: "n", startDate: "2030-01-01" } }] },
			false,
		),
	).toEqual([{ id: 5, code: "HVEN30", name: "n", year: 2030, kind: "hrp" }]);
	const [country, year, flow] = raws as [RawResponse, RawResponse, RawResponse];
	expect(() => ochaFts.normalise([{ ...country, body: "{}" }, year, flow])).toThrow("lista de planes");
	expect(() => ochaFts.normalise([country, year, { ...flow, body: "<html>" }])).toThrow("JSON");
	expect(() => ochaFts.normalise([country, year, { ...flow, body: '{"data":{}}' }])).toThrow("flujos");
});

test("a plan with requirements and no reported funding is funded 0; one with no requirements is left out", () => {
	const [country, year, flow] = raws as [RawResponse, RawResponse, RawResponse];
	const body = JSON.stringify({
		data: {
			requirements: { objects: [{ id: 1517, revisedRequirements: 100 }, { id: 1277 }] },
			report3: { fundingTotals: { objects: [] } },
		},
	});
	const out = ochaFts.normalise([country, year, { ...flow, body }]);
	expect(out.map((o) => [o.series, o.value.fundedUsd, o.value.requirementsUsd])).toEqual([
		["plan:HVEN26", 0, 100],
	]);
});
