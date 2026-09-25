import { expect, test } from "bun:test";
import { Store } from "../../core/store.ts";
import type { Json, Observation } from "../../core/types.ts";
import { sealDays, verifyChain } from "../../intel/chain.ts";
import { purgeStoredGaceta } from "./purge.ts";

const DAY = 86_400_000;
const LEAK =
	"Resolución mediante la cual se designa al Ciudadano Coronel PEDRO ÁLVAREZ, C.I. V-12.345.678, como Director";
const LAW = "Ley Orgánica de Reforma Parcial de la Ley Orgánica del Tribunal Supremo de Justicia.";
const PENSION =
	"Resolución mediante la cual se otorga pensión a la ciudadana Rosa Elena Ñúñez, C.I. V-9.876.543";
const PROMOTED =
	"Resolución mediante la cual se asciende al General de Brigada JUAN PÉREZ al grado de General de División";
const CREDENTIALS =
	"Nota Diplomática mediante la cual la ciudadana Ana Ruiz, Presidenta (E) de la República, recibió en audiencia solemne las cartas credenciales del Embajador";
/** The appointment as today's rule keeps it: the official's name, without the identity number. */
const KEPT = "Resolución mediante la cual se designa al Ciudadano Coronel PEDRO ÁLVAREZ, como Director";

/** A row as versions before 25 Sept 2026 stored it: `personal: false` on a title the old redaction missed. */
function oldRow(number: number, fetchedAt: number): Observation {
	return {
		source: "gaceta-oficial",
		series: `gaceta:o:${number}`,
		sourceUrl: `http://www.gacetaoficial.gob.ve/gacetas/${number}`,
		fetchedAt,
		observedAt: fetchedAt - DAY,
		licence: "gaceta-oficial-ve",
		value: {
			number,
			kind: "ordinaria",
			date: "2026-09-11",
			pdfUrl: null,
			status: "PUBLICADO",
			actsListed: true,
			acts: [
				{ organ: "MINISTERIO", entity: null, title: LEAK, instrument: "Resolución", personal: false },
				{ organ: "MINISTERIO", entity: null, title: PENSION, instrument: "Resolución", personal: false },
				{ organ: "ASAMBLEA NACIONAL", entity: null, title: LAW, instrument: "Ley", personal: false },
			],
		} as unknown as Json,
		confidence: 1,
		basis: "official",
	};
}

const stored = (store: Store) =>
	store.db.query<{ value: string; fetched_at: number }, []>("SELECT value, fetched_at FROM obs").all();

test("stored private titles and ID numbers are purged, officials' appointments kept; a sealed day verifies", () => {
	const store = new Store(":memory:");
	const sealedAt = Date.UTC(2026, 8, 20, 12);
	const now = Date.UTC(2026, 8, 25, 12);
	store.insert([oldRow(50001, sealedAt), oldRow(50002, now - 3_600_000)]);
	sealDays(store, now);
	expect(verifyChain(store).every((d) => d.ok)).toBe(true);
	expect(JSON.stringify(stored(store))).toContain("Ñúñez");

	expect(purgeStoredGaceta(store, now)).toBe(2);
	const rows = stored(store);
	expect(rows).toHaveLength(2);
	const text = JSON.stringify(rows);
	expect(text).not.toMatch(/Ñúñez|Rosa Elena|12\.345\.678|9\.876\.543|C\.I\./u);
	expect(text).toContain(LAW);
	for (const r of rows) {
		const acts = (JSON.parse(r.value) as { acts: { title: string | null; withheld: string | null }[] }).acts;
		expect(acts.map((a) => a.withheld)).toEqual([null, "jubilacion", null]);
		expect(acts.map((a) => a.title)).toEqual([KEPT, null, LAW]);
	}
	// The sealed day's row was replaced by a new row received now; the unsealed day's kept its time.
	expect(rows.map((r) => r.fetched_at).sort()).toEqual([now - 3_600_000, now]);
	const checks = verifyChain(store);
	expect(checks.every((d) => d.ok)).toBe(true);
	expect(checks.find((d) => d.day === "2026-09-20")?.pruned).toBe(1);

	// Idempotent: a second start changes nothing.
	expect(purgeStoredGaceta(store, now + 1)).toBe(0);
});

test("a row stored under today's rule (officials' appointment, promotion, credentials listed) is never rewritten", () => {
	const store = new Store(":memory:");
	const now = Date.UTC(2026, 8, 25, 12);
	const row = oldRow(50003, now - 3_600_000);
	const value = {
		...(row.value as Record<string, Json>),
		acts: [
			{ organ: "MINISTERIO", entity: null, title: KEPT, instrument: "Resolución", withheld: null },
			{ organ: "MINISTERIO", entity: null, title: PROMOTED, instrument: "Resolución", withheld: null },
			{ organ: "PRESIDENCIA", entity: null, title: CREDENTIALS, instrument: "Nota", withheld: null },
			{ organ: "MINISTERIO", entity: null, title: null, instrument: "Resolución", withheld: "jubilacion" },
		],
	};
	store.insert([{ ...row, value: value as unknown as Json }]);
	const before = stored(store);
	expect(purgeStoredGaceta(store, now)).toBe(0);
	expect(stored(store)).toEqual(before);
	expect(JSON.stringify(before)).toContain("PEDRO ÁLVAREZ");
});
