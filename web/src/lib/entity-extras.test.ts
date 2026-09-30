import { expect, test } from "bun:test";
import {
	licencesSection,
	type MonetaryLite,
	monetarySection,
	officeOwner,
	officesSection,
	portfolio,
	sameWords,
	sanctionsSection,
} from "./entity-extras.ts";
import type { OfficialsView, SanctionsView } from "./sanctions-view.ts";

const PDVSA = {
	id: "inst.pdvsa",
	type: "institution",
	name: { es: "Petróleos de Venezuela, S.A.", en: "Petróleos de Venezuela (state oil company)" },
	short: "PDVSA",
	aliases: [],
};
const BCV = {
	id: "inst.bcv",
	type: "institution",
	name: { es: "Banco Central de Venezuela", en: "Central Bank of Venezuela" },
	short: "BCV",
	aliases: [],
};
const DGCIM = {
	id: "inst.dgcim",
	type: "institution",
	name: {
		es: "Dirección General de Contrainteligencia Militar",
		en: "Directorate General of Military Counterintelligence",
	},
	short: "DGCIM",
	aliases: [],
};

function sanctions(): SanctionsView {
	const entities = [
		{ uid: "1", name: "PETROLEOS DE VENEZUELA, S.A.", programs: ["VENEZUELA-EO13850"], url: "https://x/1" },
		{ uid: "2", name: "BANCO CENTRAL DE VENEZUELA", programs: ["VENEZUELA-EO13850"], url: "https://x/2" },
		{
			uid: "3",
			name: "GENERAL DIRECTORATE OF MILITARY COUNTERINTELLIGENCE",
			programs: ["VENEZUELA"],
			url: "https://x/3",
		},
		{ uid: "4", name: "PDV HOLDING, INC.", programs: ["VENEZUELA-EO13850"], url: "https://x/4" },
	];
	const licence = (number: string, title: string) => ({
		id: number,
		number,
		revision: "",
		title,
		issued: "2026-09-16",
		url: `https://ofac/${number}`,
		recent: false,
	});
	return {
		sdn: {
			asOf: { publicationId: 1, observedAt: 1, fetchedAt: 2 },
			counts: { total: 409, individuals: 190, entities: 104, vessels: 60, aircraft: 55 },
			entities,
		},
		licences: {
			list: [
				licence(
					"5",
					"Authorizing Certain Transactions Related to the Petróleos de Venezuela, S.A. 2020 8.5 Percent Bond",
				),
				licence("10", "Authorizing the Purchase in Venezuela of Refined Petroleum Products from PdVSA"),
				licence("58", "Authorizing Certain Services to the Government of Venezuela"),
			],
			feed: "ofac-venezuela",
			sourceUrl: "https://ofac",
			listSince: null,
		},
	} as unknown as SanctionsView;
}

test("an SDN entry is linked only by its exact words, in any order, never by a similar name", () => {
	expect(sameWords("Petróleos de Venezuela, S.A.", "PETROLEOS DE VENEZUELA, S.A.")).toBe(true);
	expect(sameWords("Petróleos de Venezuela", "PETROLEOS DE VENEZUELA, S.A.")).toBe(false);
	expect(sanctionsSection(PDVSA, sanctions(), "es")?.items.map((i) => i.id)).toEqual(["sdn:1"]);
	expect(sanctionsSection(BCV, sanctions(), "es")?.items.map((i) => i.id)).toEqual(["sdn:2"]);
	// The DGCIM's English name, words reordered as OFAC writes them.
	expect(sanctionsSection(DGCIM, sanctions(), "es")?.items.map((i) => i.id)).toEqual(["sdn:3"]);
	// No match says what was searched, and how many records.
	const none = sanctionsSection(
		{ ...BCV, id: "inst.x", name: { es: "Otro Ente", en: "Other Body" } },
		sanctions(),
		"es",
	);
	expect(none?.items).toEqual([]);
	expect(none?.empty).toContain("409 registros");
});

test("a general licence names the entity by its full name or its acronym as a word", () => {
	expect(licencesSection(PDVSA, sanctions(), "es")?.items.map((i) => i.id)).toEqual(["gl:5", "gl:10"]);
	expect(licencesSection(BCV, sanctions(), "es")).toBeNull();
});

test("offices: fixed kinds, ministers by the words of their portfolio, governors on their state", () => {
	expect(portfolio("Ministerio del Poder Popular para el Turismo")).toBe("turismo");
	expect(portfolio("ministro de Turismo de Venezuela")).toBe("turismo");
	expect(portfolio("Ministro del Poder Popular para la Defensa")).toBe("defensa");
	expect(portfolio("Banco Central de Venezuela")).toBeNull();
	expect(
		officeOwner({ kind: "central-bank", office: { label: "Presidente del Banco Central de Venezuela" } }),
	).toBe("inst.bcv");
	expect(officeOwner({ kind: "justice", office: { label: "Prosecutor General of Venezuela" } })).toBe(
		"inst.ministerio-publico",
	);
	const office = (kind: string, label: string, state: string | null = null) => ({
		office: { qid: label, label },
		kind,
		state,
		stateName: null,
		status: "current",
		latestTerm: {
			person: { qid: "Q1", label: "Nombre" },
			start: "2025-01-01",
			end: null,
			died: null,
			datesInconsistent: false,
		},
		termsRecorded: 1,
		undatedTerms: 0,
		wikidataUrl: `https://www.wikidata.org/wiki/${label}`,
	});
	const view = {
		rule: "Según Wikidata.",
		offices: [
			office("minister", "ministro de Turismo de Venezuela"),
			office("central-bank", "Presidente del Banco Central de Venezuela"),
			office("governor", "Gobernador del Estado Zulia", "VE-V"),
		],
		counts: { current: 3, ended: 0, unknown: 0 },
		readAt: 1,
		feed: "wikidata-officials",
		attribution: "Wikidata",
		stale: false,
	} as unknown as OfficialsView;
	const turismo = {
		id: "inst.mpp-turismo",
		type: "institution",
		name: { es: "Ministerio del Poder Popular para el Turismo", en: "Ministry of Tourism" },
		short: null,
		aliases: [],
	};
	expect(officesSection(turismo, view, "es", null)?.items).toHaveLength(1);
	expect(officesSection(BCV, view, "es", null)?.items[0]?.title).toContain("Banco Central");
	const zulia = {
		id: "ve.zulia",
		type: "state",
		name: { es: "Zulia", en: "Zulia" },
		short: null,
		aliases: [],
	};
	expect(officesSection(zulia, view, "es", "VE-V")?.items[0]?.title).toContain("Zulia");
	expect(officesSection(zulia, view, "es", "VE-G")).toBeNull();
});

test("the BCV's series show on the BCV's page only, official; only their changes are Vigía's, and say so", () => {
	const v: MonetaryLite = {
		derivedLabel: "calculado por Vigía a partir de las cifras publicadas por el BCV",
		liquidity: {
			latest: { weekEnding: "2026-09-18", m2Ves: 2_839_145_987_504.81, provisional: true, observedAt: 1 },
			changeWeek: { pct: 3.35 },
			series: [],
			stale: false,
			feed: "bcv-liquidity",
			sourceUrl: "https://bcv",
		},
		reserves: {
			latest: { date: "2026-09-25", totalMusd: 12_727, provisional: true, observedAt: 2 },
			change30d: null,
			series: [],
			stale: true,
			feed: "bcv-reserves",
			sourceUrl: "https://bcv",
		},
		intervention: {
			latest: null,
			days30: 0,
			stale: false,
			note: "",
			feed: "bcv-intervention",
			sourceUrl: "https://bcv",
		},
	};
	expect(monetarySection(PDVSA, v, "es")).toBeNull();
	const s = monetarySection(BCV, v, "es");
	expect(s?.facts.map((f) => f.key)).toEqual(["liquidity", "reserves"]);
	// The figure is the BCV's; only its change is Vigía's, and the detail says so.
	expect(s?.facts[0]).toMatchObject({ value: "2,84 billones", unit: "Bs." });
	expect(s?.facts[0]?.computed).toBeUndefined();
	expect(s?.facts[0]?.detail).toContain("cambio calculado por Vigía");
	expect(s?.facts[0]?.prov.basis).toBe("official");
	expect(s?.facts[1]).toMatchObject({ value: "12.727 MM US$", stale: true });
	expect(s?.facts[1]?.computed).toBeUndefined();
});
