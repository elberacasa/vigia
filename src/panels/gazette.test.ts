import { expect, test } from "bun:test";
import { join } from "node:path";
import { type GacetaIssue, gacetaOficial } from "../adapters/gaceta-oficial/index.ts";
import type { ActCategory } from "../adapters/gaceta-oficial/redact.ts";
import { hasFixture, loadFixture } from "../core/fixtures.ts";
import { Store } from "../core/store.ts";
import type { Observation } from "../core/types.ts";
import { caracasDateToMs } from "../formats/time.ts";
import { gazetteIssue, gazettePanel, gazetteView, MAX_ACTS } from "./gazette.ts";

const DAY = 86_400_000;

function issue(
	number: number,
	kind: GacetaIssue["kind"],
	date: string,
	acts: GacetaIssue["acts"],
	fetchedAt?: number,
): Observation<GacetaIssue> {
	const at = caracasDateToMs(date) as number;
	return {
		source: "gaceta-oficial",
		series: `gaceta:${kind === "ordinaria" ? "o" : "e"}:${number}`,
		sourceUrl: `http://www.gacetaoficial.gob.ve/gacetas/${number}`,
		fetchedAt: fetchedAt ?? at + 10 * DAY,
		observedAt: at,
		licence: "gaceta-oficial-ve",
		value: {
			number,
			kind,
			date,
			pdfUrl: `http://www.gacetaoficial.gob.ve/storage/2026/${number}.pdf`,
			status: "PUBLICADO",
			actsListed: acts.length > 0,
			acts,
		},
		confidence: 1,
		basis: "official",
	};
}

const act = (
	instrument: string | null,
	withheld: ActCategory | null = null,
	title: string | null = withheld
		? null
		: `${instrument ?? "Decreto"} mediante el cual se dicta una norma de prueba.`,
) => ({
	organ: "MINISTERIO DE PRUEBA",
	entity: null,
	title,
	instrument,
	withheld,
});

test("empty: no issues, stale, no lag", () => {
	const v = gazettePanel.compute(new Store(":memory:"), Date.UTC(2026, 8, 24));
	expect(v.issues).toEqual([]);
	expect(v.newest).toBeNull();
	expect(v.lagDays).toBeNull();
	expect(v.stale).toBe(true);
});

test("withheld acts are counted per category, not listed; instruments counted; laws and decrees make an issue notable", () => {
	const g = gazetteIssue(
		issue(50001, "ordinaria", "2026-09-11", [
			act("Resolución", "designacion"),
			act("Resolución", "designacion"),
			act("Decreto"),
			act("Providencia"),
			act(null),
		]).value,
		1,
		2,
		"u",
	);
	expect(g.withheld).toEqual([{ category: "designacion", n: 2 }]);
	expect(g.acts.map((a) => a.instrument)).toEqual(["Decreto", "Providencia", null]);
	expect(g.instruments).toEqual([
		{ name: "Resolución", n: 2 },
		{ name: "Decreto", n: 1 },
		{ name: "Otro", n: 1 },
		{ name: "Providencia", n: 1 },
	]);
	expect(g.notable).toBe(true);
	const many = gazetteIssue(
		issue(
			50002,
			"ordinaria",
			"2026-09-12",
			Array.from({ length: MAX_ACTS + 3 }, () => act("Providencia")),
		).value,
		1,
		2,
		"u",
	);
	expect(many.acts).toHaveLength(MAX_ACTS);
	expect(many.moreActs).toBe(3);
	expect(many.notable).toBe(false);
});

test("newest first (extraordinary before ordinary on the same day), last 30 days only, lag in days", () => {
	const store = new Store(":memory:");
	store.insert([
		issue(50001, "ordinaria", "2026-09-11", [act("Ley")]),
		issue(9001, "extraordinaria", "2026-09-11", [act("Decreto")]),
		issue(9002, "extraordinaria", "2026-09-15", [act("Ley")]),
		issue(49000, "ordinaria", "2026-07-01", [act("Resolución")]),
	]);
	const now = Date.UTC(2026, 8, 24, 16);
	const v = gazetteView(store, now);
	expect(v.issues.map((i) => i.number)).toEqual([9002, 9001, 50001]);
	expect(v.newest?.date).toBe("2026-09-15");
	expect(v.lagDays).toBe(9);
	expect(v.stale).toBe(false);
	expect(gazetteView(store, now + 13 * DAY).stale).toBe(true);
});

test("a later fetch of the same issue replaces the earlier one", () => {
	const store = new Store(":memory:");
	store.insert([
		issue(50001, "ordinaria", "2026-09-11", [], Date.UTC(2026, 8, 20)),
		issue(50001, "ordinaria", "2026-09-11", [act("Decreto")], Date.UTC(2026, 8, 21)),
	]);
	const v = gazetteView(store, Date.UTC(2026, 8, 24));
	expect(v.issues).toHaveLength(1);
	expect(v.issues[0]?.acts).toHaveLength(1);
});

const dir = join(import.meta.dir, "..", "adapters", "gaceta-oficial", "fixtures", "2026-09-24");
test.skipIf(!hasFixture(dir))(
	"recorded 2026-09-24: the TSJ law reform leads; officials named, no ID numbers",
	() => {
		const store = new Store(":memory:");
		store.insert(gacetaOficial.normalise(loadFixture(dir)));
		const v = gazetteView(store, Date.UTC(2026, 8, 25, 2));
		expect(v.issues[0]?.number).toBe(7074);
		expect(v.issues[0]?.notable).toBe(true);
		expect(v.issues[0]?.acts[0]?.title).toContain("Tribunal Supremo de Justicia");
		expect(v.lagDays).toBe(9);
		const text = JSON.stringify(v);
		expect(text).not.toContain("persona nombrada");
		expect(text).not.toMatch(/c[ée]dula|C\.I\.|\b\d{1,3}\.\d{3}\.\d{3}\b/u);
		// Appointments are listed with the official's name; the pension act of that week is only counted.
		expect(text).toMatch(/se designa (?:al|a la) ciudadan[oa] \p{Lu}/u);
		expect(v.issues.some((i) => i.withheld.some((w) => w.category === "jubilacion" && w.n > 0))).toBe(true);
		expect(v.issues.some((i) => i.withheld.some((w) => w.category === "designacion"))).toBe(false);
		// General-scope acts come before the appointments in each issue.
		for (const i of v.issues) {
			const firstNamed = i.acts.findIndex((a) =>
				/\b(?:designa|nombra|delega|traslada|condecoraci)/iu.test(a.title),
			);
			if (firstNamed >= 0)
				expect(
					i.acts
						.slice(firstNamed)
						.some((a) =>
							/^(?:Ley|Decreto N° [\d.]+, mediante el cual se (?:declara|autoriza|modifica))/u.test(a.title),
						),
				).toBe(false);
		}
	},
);

test("a row stored by an older version (name in a 'general' title, old shape) is re-checked on read", () => {
	const old = {
		organ: "MINISTERIO DE PRUEBA",
		entity: null,
		title:
			"Resolución mediante la cual se designa al Ciudadano Coronel PEDRO ÁLVAREZ, C.I. V-12.345.678, como Director",
		instrument: "Resolución",
		personal: false,
	} as unknown as GacetaIssue["acts"][number];
	const pension = {
		...old,
		title: "Resolución mediante la cual se otorga pensión a la ciudadana ANA RUIZ, C.I. V-9.876.543",
	} as GacetaIssue["acts"][number];
	const g = gazetteIssue(
		issue(50001, "ordinaria", "2026-09-11", [old, pension, act("Decreto")]).value,
		1,
		2,
		"u",
	);
	// The appointment is listed with the official's name (after the general act), never with the ID number.
	expect(g.acts).toHaveLength(2);
	expect(g.acts[1]?.title).toBe(
		"Resolución mediante la cual se designa al Ciudadano Coronel PEDRO ÁLVAREZ, como Director",
	);
	expect(g.withheld).toEqual([{ category: "jubilacion", n: 1 }]);
	expect(JSON.stringify(g)).not.toMatch(/12\.345|9\.876|C\.I\.|ANA RUIZ/u);
});
