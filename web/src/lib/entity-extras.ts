/**
 * What the workstation's own panels add to an entity page, linked by fixed rules and never by a model:
 *
 * - OFAC's SDN list: an entry whose name has exactly the entity's words (accents, case and punctuation aside:
 *   "PETROLEOS DE VENEZUELA, S.A." is Petróleos de Venezuela, S.A.).
 * - OFAC's general licences: a licence whose title names the entity (its full name, or its acronym as a word).
 * - Public offices (Wikidata): the office of a fixed kind (the BCV's president, the National Assembly's), a minister
 *   whose portfolio words are the ministry's, a governor for the state.
 * - The BCV's monetary series (liquidity, reserves, exchange intervention) on the BCV's page.
 *
 * Each section says its rule. The views are the panels' (src/panels/sanctions.ts, officials.ts, monetary.ts): only
 * matching and wording here. Tested in entity-extras.test.ts.
 */
import type { EntityFact, EntityItem, EntitySection } from "./entity.ts";
import { int, type Lang, pct } from "./format.ts";
import { bigBs, calDate, musd } from "./monetary-view.ts";
import {
	dayText,
	licenceBadge,
	type OfficialsView,
	officeLine,
	programText,
	type SanctionsView,
} from "./sanctions-view.ts";

const tr = (lang: Lang, es: string, en: string) => (lang === "es" ? es : en);

/** Lowercase words without accents or punctuation. */
export function words(s: string): string[] {
	return s
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

/** Same words, any order: "General Directorate of Military Counterintelligence" is the DGCIM's English name. */
export function sameWords(a: string, b: string): boolean {
	const x = words(a).sort().join(" ");
	return x !== "" && x === words(b).sort().join(" ");
}

export interface EntityNames {
	id: string;
	type: string;
	name: { es: string; en: string };
	short: string | null;
	aliases: readonly string[];
}

function fullNames(e: EntityNames): string[] {
	return [e.name.es, e.name.en, ...e.aliases].filter((n) => words(n).length >= 2);
}

// ——— sanctions ———

export function sanctionsSection(
	e: EntityNames,
	v: SanctionsView | undefined,
	lang: Lang,
): EntitySection | null {
	if (!v) return null;
	const sdn = v.sdn;
	const names = fullNames(e);
	const hits = sdn.entities.filter((x) => names.some((n) => sameWords(n, x.name)));
	const asOf = sdn.asOf?.observedAt ?? null;
	const facts: EntityFact[] = [];
	const items: EntityItem[] = hits.map((h) => ({
		id: `sdn:${h.uid}`,
		title: h.name,
		url: h.url,
		// The list's date is when it was read, not when the entry was designated: no time is shown.
		at: 0,
		meta: [tr(lang, "en la lista SDN", "on the SDN list"), ...h.programs.map(programText)].join(" · "),
		tone: "warn",
	}));
	return {
		key: "sanctions",
		title: tr(lang, "Sanciones de EE. UU. (OFAC)", "US sanctions (OFAC)"),
		facts,
		items,
		empty: sdn.counts
			? tr(
					lang,
					`Ninguna entrada de la lista SDN (${int(sdn.counts.total, lang)} registros del programa de Venezuela) tiene su nombre.`,
					`No entry of the SDN list (${int(sdn.counts.total, lang)} records in the Venezuela programme) has its name.`,
				)
			: tr(
					lang,
					"La lista SDN no se ha leído todavía en esta instalación.",
					"The SDN list has not been read on this installation yet.",
				),
		note: tr(
			lang,
			"Regla: nombre idéntico en la lista (sin tildes, mayúsculas ni signos). Una empresa filial con otro nombre no aparece aquí.",
			"Rule: identical name on the list (accents, case and punctuation aside). A subsidiary under another name does not show here.",
		),
		module: "oficial",
		prov: {
			source: "OFAC (Tesoro de EE. UU.)",
			feeds: [sdn.feed],
			url: sdn.sourceUrl,
			observedAt: asOf,
			basis: "official",
		},
	};
}

/** Acronyms as a whole word in a title ("PdVSA" in "Involving PdVSA"). */
function hasWord(title: string, word: string): boolean {
	const w = words(word);
	if (w.length !== 1 || (w[0] as string).length < 3) return false;
	return words(title).includes(w[0] as string);
}

function namesIn(title: string, name: string): boolean {
	const t = ` ${words(title).join(" ")} `;
	const n = words(name).join(" ");
	return n.split(" ").length >= 2 && t.includes(` ${n} `);
}

export function licencesSection(
	e: EntityNames,
	v: SanctionsView | undefined,
	lang: Lang,
): EntitySection | null {
	if (!v?.licences.list.length) return null;
	const names = fullNames(e).map((n) => n.replace(/\s*\(.*\)\s*$/, ""));
	const hits = v.licences.list.filter(
		(l) => names.some((n) => namesIn(l.title, n)) || (e.short !== null && hasWord(l.title, e.short)),
	);
	if (!hits.length) return null;
	return {
		key: "licences",
		title: tr(lang, "Licencias generales de OFAC que la nombran", "OFAC general licences that name it"),
		facts: [],
		items: hits.map((l) => {
			const badge = licenceBadge(l);
			return {
				id: `gl:${l.id}`,
				title: `GL ${l.number}${l.revision}: ${l.title}`,
				url: l.url,
				at: Date.parse(`${l.issued}T12:00:00-04:00`) || 0,
				meta: [
					tr(lang, `emitida el ${dayText(l.issued, lang)}`, `issued ${dayText(l.issued, lang)}`),
					badge === "new"
						? tr(lang, "nueva", "new")
						: badge === "amended"
							? tr(lang, "enmendada", "amended")
							: null,
				]
					.filter(Boolean)
					.join(" · "),
			};
		}),
		note: tr(
			lang,
			"Regla: el título de la licencia contiene su nombre completo o su sigla como palabra.",
			"Rule: the licence's title contains its full name or its acronym as a word.",
		),
		module: "oficial",
		prov: {
			source: "OFAC (Tesoro de EE. UU.)",
			feeds: [v.licences.feed],
			url: v.licences.sourceUrl,
			observedAt: v.licences.listSince,
			basis: "official",
		},
	};
}

// ——— public offices ———

/** Offices of a fixed kind that belong to one institution. */
const KIND_OWNER: Record<string, string> = {
	"central-bank": "inst.bcv",
	president: "inst.presidencia",
	"vice-president": "inst.vicepresidencia",
	legislature: "inst.an",
};

const MINISTRY = /^ministerio del poder popular (?:para|de) (?:el |la |los |las )?/;
const MINISTER = /^ministros? (?:del poder popular (?:para|de) |de |del )(?:el |la |los |las )?/;

/** "Ministerio del Poder Popular para el Turismo" → "turismo"; "ministro de Turismo de Venezuela" → "turismo". */
export function portfolio(name: string): string | null {
	const w = words(name).join(" ");
	const m = MINISTRY.exec(w) ?? MINISTER.exec(w);
	if (!m) return null;
	return (
		w
			.slice(m[0].length)
			.replace(/ de venezuela$/, "")
			.trim() || null
	);
}

/** The institution an office belongs to, by the fixed rules above (null when none applies). */
export function officeOwner(office: { kind: string; office: { label: string } }): string | null {
	const fixed = KIND_OWNER[office.kind];
	if (fixed) return fixed;
	if (office.kind === "justice") {
		const w = words(office.office.label).join(" ");
		if (/fiscal|prosecutor/.test(w)) return "inst.ministerio-publico";
		if (/defensor del pueblo|ombudsman/.test(w)) return "inst.defensoria";
	}
	return null;
}

export function officesSection(
	e: EntityNames,
	v: OfficialsView | undefined,
	lang: Lang,
	stateIso: string | null,
): EntitySection | null {
	if (!v?.offices.length) return null;
	const mine = portfolio(e.name.es);
	const hits = v.offices.filter((o) =>
		e.type === "state"
			? o.kind === "governor" && o.state === stateIso
			: officeOwner(o) === e.id ||
				(mine !== null && o.kind === "minister" && portfolio(o.office.label) === mine),
	);
	if (!hits.length) return null;
	return {
		key: "offices",
		title: tr(lang, "Cargos (según Wikidata)", "Offices (per Wikidata)"),
		facts: [],
		items: hits.map((o) => ({
			id: `office:${o.office.qid}`,
			title: o.latestTerm ? `${o.office.label}: ${o.latestTerm.person.label}` : o.office.label,
			url: o.wikidataUrl,
			at: o.latestTerm ? Date.parse(`${o.latestTerm.start}T12:00:00-04:00`) || 0 : 0,
			meta: `${officeLine(o, lang)}${o.latestTerm?.datesInconsistent ? tr(lang, " · fechas inconsistentes en Wikidata", " · inconsistent dates in Wikidata") : ""}`,
			tone: o.status === "current" ? "normal" : "muted",
		})),
		note: `${v.rule} ${tr(
			lang,
			"Vínculo: el cargo de tipo fijo del órgano, o un ministro cuya cartera tiene las mismas palabras que el ministerio; en un estado, su gobernación.",
			"Link: the body's fixed-kind office, or a minister whose portfolio has the ministry's words; on a state, its governorship.",
		)}`,
		module: "oficial",
		prov: {
			source: "Wikidata (CC0)",
			feeds: [v.feed],
			observedAt: v.readAt,
			basis: "reported",
		},
	};
}

// ——— the BCV's monetary series ———

interface Change {
	pct: number;
}
export interface MonetaryLite {
	derivedLabel: string;
	liquidity: {
		latest: { weekEnding: string; m2Ves: number; provisional: boolean; observedAt: number } | null;
		changeWeek: Change | null;
		series: { m2Ves: number }[];
		stale: boolean;
		feed: string;
		sourceUrl: string;
	};
	reserves: {
		latest: { date: string; totalMusd: number; provisional: boolean; observedAt: number } | null;
		change30d: Change | null;
		series: { totalMusd: number }[];
		stale: boolean;
		feed: string;
		sourceUrl: string;
	};
	intervention: {
		latest: { date: string; number: string; observedAt: number } | null;
		days30: number;
		stale: boolean;
		note: string;
		feed: string;
		sourceUrl: string;
	};
}

export function monetarySection(
	e: EntityNames,
	v: MonetaryLite | undefined,
	lang: Lang,
): EntitySection | null {
	if (e.id !== "inst.bcv" || !v) return null;
	const facts: EntityFact[] = [];
	const l = v.liquidity;
	if (l.latest)
		facts.push({
			key: "liquidity",
			label: tr(lang, "Liquidez monetaria (M2)", "Money supply (M2)"),
			value: `${bigBs(l.latest.m2Ves, lang)}`,
			unit: "Bs.",
			tone: "normal",
			detail: `${tr(lang, "semana al", "week to")} ${calDate(l.latest.weekEnding, lang)}${
				l.changeWeek
					? ` · ${pct(l.changeWeek.pct, 1, lang)} ${tr(lang, "en la semana (cambio calculado por Vigía)", "on the week (change computed by Vigía)")}`
					: ""
			}${l.latest.provisional ? ` · ${tr(lang, "provisional", "provisional")}` : ""}`,
			prov: {
				source: "BCV",
				feeds: [l.feed],
				url: l.sourceUrl,
				observedAt: l.latest.observedAt,
				basis: "official",
			},
			stale: l.stale,
		});
	const r = v.reserves;
	if (r.latest)
		facts.push({
			key: "reserves",
			label: tr(lang, "Reservas internacionales", "International reserves"),
			value: musd(r.latest.totalMusd, lang),
			tone: "normal",
			detail: `${calDate(r.latest.date, lang)}${r.change30d ? ` · ${pct(r.change30d.pct, 1, lang)} ${tr(lang, "en 30 días (cambio calculado por Vigía)", "in 30 days (change computed by Vigía)")}` : ""}${
				r.latest.provisional ? ` · ${tr(lang, "provisional", "provisional")}` : ""
			}`,
			prov: {
				source: "BCV",
				feeds: [r.feed],
				url: r.sourceUrl,
				observedAt: r.latest.observedAt,
				basis: "official",
			},
			stale: r.stale,
		});
	const i = v.intervention;
	if (i.latest)
		facts.push({
			key: "intervention",
			label: tr(lang, "Intervención cambiaria, 30 días", "FX intervention, 30 days"),
			value: int(i.days30, lang),
			unit: tr(lang, "días", "days"),
			tone: "normal",
			detail: `${tr(lang, "última", "latest")} Nº ${i.latest.number}, ${calDate(i.latest.date, lang)}. ${i.note}`,
			prov: {
				source: "BCV",
				feeds: [i.feed],
				url: i.sourceUrl,
				observedAt: i.latest.observedAt,
				basis: "official",
			},
			stale: i.stale,
			computed: true,
			method: tr(
				lang,
				"Días con intervención publicada en los últimos 30, contados por Vigía.",
				"Days with a published intervention in the last 30, counted by Vigía.",
			),
		});
	if (!facts.length) return null;
	return {
		key: "monetary",
		title: tr(lang, "Series monetarias del BCV", "BCV monetary series"),
		facts,
		items: [],
		module: "dinero",
	};
}
