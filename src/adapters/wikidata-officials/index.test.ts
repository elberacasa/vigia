import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { offices, wikidataOfficials } from "./index.ts";
import { type Binding, officeHolders, qid } from "./sparql.ts";

// Recorded 2026-09-29 02:5x UTC: one SPARQL answer (CC0), 500 terms of 43 offices.
const raws = loadFixture(join(import.meta.dir, "fixtures", "2026-09-28"));
const obs = wikidataOfficials.normalise(raws);
const by = (label: string) => obs.find((o) => o.value.office.label === label)?.value;

test("43 offices; the rule decides current, ended or unknown", () => {
	expect(obs.length).toBe(43);
	const counts = { current: 0, ended: 0, unknown: 0 };
	for (const o of obs) counts[o.value.status]++;
	expect(counts).toEqual({ current: 8, ended: 29, unknown: 6 });
	expect(by("presidente de Venezuela")).toMatchObject({
		kind: "president",
		status: "current",
		latestTerm: { person: { qid: "Q15081116", label: "Delcy Rodríguez" }, start: "2026-01-05", end: null },
	});
	expect(by("Vicepresidente de Venezuela")).toMatchObject({
		status: "ended",
		latestTerm: { end: "2026-01-03" },
	});
	expect(by("Gobernador del Estado Zulia")).toMatchObject({
		kind: "governor",
		state: "VE-V",
		status: "ended",
	});
	expect(by("Gobernador de Portuguesa")?.latestTerm?.datesInconsistent).toBe(true);
	expect(by("Defensor del Pueblo de Venezuela")).toMatchObject({
		status: "unknown",
		latestTerm: null,
		undatedTerms: 3,
	});
	for (const o of obs) {
		expect(o.source).toBe("wikidata-officials");
		expect(o.basis).toBe("report");
		expect(o.sourceUrl).toMatch(/^https:\/\/www\.wikidata\.org\/wiki\/Q\d+$/);
		// One reading per UTC day.
		expect(o.observedAt % 86_400_000).toBe(0);
	}
});

const term = (pos: string, person: string, start?: string, end?: string, died?: string): Binding => ({
	pos: { type: "uri", value: `http://www.wikidata.org/entity/${pos}` },
	posLabel: { type: "literal", value: `Office ${pos}` },
	person: { type: "uri", value: `http://www.wikidata.org/entity/${person}` },
	personLabel: { type: "literal", value: `Person ${person}` },
	...(start ? { start: { type: "literal", value: `${start}T00:00:00Z` } } : {}),
	...(end ? { end: { type: "literal", value: `${end}T00:00:00Z` } } : {}),
	...(died ? { died: { type: "literal", value: `${died}T00:00:00Z` } } : {}),
});

test("latest start decides; undated terms never do; a dead holder's term is over", () => {
	const at = Date.UTC(2026, 8, 28);
	const list = offices(
		[
			term("Q1", "Q10", "2010-01-01", "2015-01-01"),
			term("Q1", "Q11", "2015-01-01"),
			term("Q1", "Q12"), // undated: ignored
			term("Q2", "Q20", "2020-01-01", "2030-01-01"), // ends in the future: current
			term("Q3", "Q30", "2019-01-01", undefined, "2024-02-02"),
			term("Q4", "Q40"),
			term("Q5", "Q50", "2021-01-01", "2021-06-01"),
			term("Q5", "Q51", "2021-01-01"), // same start, open one wins
		],
		at,
	);
	const s = Object.fromEntries(list.map((o) => [o.office.qid, [o.status, o.latestTerm?.person.qid ?? null]]));
	expect(s).toEqual({
		Q1: ["current", "Q11"],
		Q2: ["current", "Q20"],
		Q3: ["ended", "Q30"],
		Q4: ["unknown", null],
		Q5: ["current", "Q51"],
	});
	expect(list.find((o) => o.office.qid === "Q1")).toMatchObject({ termsRecorded: 3, undatedTerms: 1 });
});

test("helpers and envelope", () => {
	expect(qid("http://www.wikidata.org/entity/Q717")).toBe("Q717");
	expect(qid("https://example.org/Q1")).toBeNull();
	// A holder whose only label is the Q-id is left out (no name to match on).
	expect(
		officeHolders([
			term("Q1", "Q10", "2010-01-01"),
			{ ...term("Q1", "Q11"), personLabel: { type: "literal", value: "Q11" } },
		]),
	).toEqual([{ qid: "Q10", label: "Person Q10", position: "Office Q1" }]);
	const raw = raws[0] as RawResponse;
	expect(() => wikidataOfficials.normalise([{ ...raw, body: "<html>" }])).toThrow("JSON");
	expect(() =>
		wikidataOfficials.normalise([{ ...raw, body: '{"head":{"vars":[]},"results":{"bindings":[]}}' }]),
	).toThrow("cargos");
});
