/*
 * Pure helpers for "Sanciones de EE. UU." and "Cargos públicos" (panels/Sanctions.tsx): the badge a general licence
 * earns, the 12-month change strip, programme names in words, dates as the sources print them, and offices grouped
 * by kind. The views are computed on the server (src/panels/sanctions.ts, src/panels/officials.ts); here only
 * grouping and wording. Tested in sanctions-view.test.ts.
 */

type Lang = "es" | "en";

/* ---------- Mirrors of the server's views ---------- */

export type Action = "add" | "remove" | "update";

export type Subject =
	| {
			type: "individual";
			named: true;
			uid: string;
			name: string;
			title: string | null;
			basis: "ofac-title" | "wikidata";
			wikidata: { qid: string; label: string; position: string } | null;
	  }
	| { type: "individual"; named: false }
	| { type: "entity"; uid: string; name: string }
	| { type: "vessel"; uid: string; name: string; vesselType: string | null; flag: string | null }
	| { type: "aircraft"; model: string | null };

export interface ChangeRow {
	at: number;
	publicationId: number;
	action: Action;
	subject: Subject;
	programs: string[];
	listedOn: string | null;
	url: string;
}

export interface Tally {
	add: number;
	remove: number;
	update: number;
}

export interface NamedOfficial {
	uid: string;
	name: string;
	title: string | null;
	basis: "ofac-title" | "wikidata";
	wikidata: { qid: string; label: string; position: string } | null;
	programs: string[];
	url: string;
}

export interface GeneralLicence {
	id: string;
	number: string;
	revision: string;
	title: string;
	issued: string;
	url: string;
	recent: boolean;
}

export interface FrDocument {
	number: string;
	type: string;
	publicationDate: string;
	agencies: string[];
	relevance: "title" | "ofac" | "text";
	title: string | null;
	abstract: string | null;
	htmlUrl: string;
	pdfUrl: string | null;
}

export interface SanctionsView {
	now: number;
	namingRule: string;
	sdn: {
		asOf: { publicationId: number; observedAt: number; fetchedAt: number } | null;
		publicationsBehind: number;
		counts: {
			total: number;
			individuals: number;
			entities: number;
			vessels: number;
			aircraft: number;
		} | null;
		byProgram: { program: string; n: number }[];
		officials: NamedOfficial[];
		unnamedIndividuals: number;
		entities: { uid: string; name: string; programs: string[]; url: string }[];
		vessels: {
			uid: string;
			name: string;
			vesselType: string | null;
			flag: string | null;
			imo: string | null;
			programs: string[];
			url: string;
		}[];
		aircraftByModel: { model: string; count: number }[];
		wikidataChecked: boolean;
		changes: ChangeRow[];
		tally: { days30: Tally; days365: Tally };
		sinceLast: { publicationId: number; totalBefore: number; totalNow: number } | null;
		publicationsRead: number;
		feed: string;
		sourceUrl: string;
		attribution: string;
	};
	licences: {
		list: GeneralLicence[];
		removed: string[];
		listSince: number | null;
		recentCount: number;
		actions: { title: string; date: string; url: string }[];
		feed: string;
		sourceUrl: string;
		attribution: string;
	};
	register: {
		documents: FrDocument[];
		bodyOnly30d: number;
		feed: string;
		sourceUrl: string;
		attribution: string;
	};
}

export type OfficeKind =
	| "president"
	| "vice-president"
	| "minister"
	| "legislature"
	| "central-bank"
	| "justice"
	| "governor"
	| "other";

export interface Office {
	office: { qid: string; label: string };
	kind: OfficeKind;
	state: string | null;
	stateName: string | null;
	status: "current" | "ended" | "unknown";
	latestTerm: {
		person: { qid: string; label: string };
		start: string;
		end: string | null;
		died: string | null;
		datesInconsistent: boolean;
	} | null;
	termsRecorded: number;
	undatedTerms: number;
	wikidataUrl: string;
}

export interface OfficialsView {
	rule: string;
	offices: Office[];
	counts: { current: number; ended: number; unknown: number };
	readAt: number | null;
	feed: string;
	attribution: string;
	stale: boolean;
}

/* ---------- Words ---------- */

const MONTHS_ES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic"];
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A source's calendar date ("2026-09-23") as printed, never shifted by a time zone: "23 sept 2026". */
export function dayText(iso: string, lang: Lang): string {
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
	if (!m) return iso;
	const month = (lang === "es" ? MONTHS_ES : MONTHS_EN)[Number(m[2]) - 1] ?? m[2];
	const day = Number(m[3]);
	return lang === "es" ? `${day} ${month} ${m[1]}` : `${month} ${day}, ${m[1]}`;
}

/** OFAC's programme tags in words: "VENEZUELA-EO13850" → "Venezuela · EO 13850". */
export function programText(program: string): string {
	const eo = /^(.*?)-?EO(\d+)$/.exec(program);
	const base = (eo ? eo[1] : program) ?? program;
	const name = base
		.split("-")
		.filter(Boolean)
		.map((w) => (w.length <= 4 && w !== "IRAN" ? w : w[0] + w.slice(1).toLowerCase()))
		.join(" ");
	return eo ? `${name || "EO"} · EO ${eo[2]}` : name;
}

/** "nueva" for a licence first issued in the last 30 days, "enmendada" for a new revision of an earlier one. */
export function licenceBadge(l: Pick<GeneralLicence, "recent" | "revision">): "new" | "amended" | null {
	if (!l.recent) return null;
	return l.revision ? "amended" : "new";
}

/* ---------- The 12-month change strip ---------- */

const CARACAS_MS = 4 * 3_600_000;

/** "2026-09" for a moment, in Caracas (UTC−4, no daylight saving). */
function monthKey(at: number): string {
	return new Date(at - CARACAS_MS).toISOString().slice(0, 7);
}

export interface MonthBin extends Tally {
	month: string;
}

/**
 * Twelve Caracas months ending with `now`'s, oldest first, each with the designations, removals and updates OFAC
 * published that month. Changes outside the twelve months are left out (the server sends one year).
 */
export function changesByMonth(
	changes: readonly Pick<ChangeRow, "at" | "action">[],
	now: number,
): MonthBin[] {
	const last = monthKey(now);
	const [y, m] = last.split("-").map(Number) as [number, number];
	const bins: MonthBin[] = [];
	for (let i = 11; i >= 0; i--) {
		const total = y * 12 + (m - 1) - i;
		const month = `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
		bins.push({ month, add: 0, remove: 0, update: 0 });
	}
	const byMonth = new Map(bins.map((b) => [b.month, b]));
	for (const c of changes) {
		const b = byMonth.get(monthKey(c.at));
		if (b) b[c.action]++;
	}
	return bins;
}

export function monthText(month: string, lang: Lang): string {
	const [y, m] = month.split("-");
	const name = (lang === "es" ? MONTHS_ES : MONTHS_EN)[Number(m) - 1] ?? m;
	return `${name} ${y?.slice(2)}`;
}

/* ---------- Offices ---------- */

export const KIND_ORDER: readonly OfficeKind[] = [
	"president",
	"vice-president",
	"minister",
	"legislature",
	"central-bank",
	"justice",
	"governor",
	"other",
];

export const KIND_LABEL: Readonly<Record<OfficeKind, { es: string; en: string }>> = {
	president: { es: "Presidencia", en: "Presidency" },
	"vice-president": { es: "Vicepresidencia", en: "Vice presidency" },
	minister: { es: "Ministerios", en: "Ministries" },
	legislature: { es: "Asamblea Nacional", en: "National Assembly" },
	"central-bank": { es: "Banco Central", en: "Central bank" },
	justice: { es: "Justicia y poder ciudadano", en: "Justice and citizen power" },
	governor: { es: "Gobernaciones", en: "Governorships" },
	other: { es: "Otros cargos", en: "Other offices" },
};

/** Offices in groups by kind, in the fixed order, keeping the server's order within a group; empty groups dropped. */
export function groupOffices<O extends Pick<Office, "kind">>(
	offices: readonly O[],
): { kind: OfficeKind; offices: O[] }[] {
	return KIND_ORDER.map((kind) => ({ kind, offices: offices.filter((o) => o.kind === kind) })).filter(
		(g) => g.offices.length > 0,
	);
}

/**
 * What can honestly be said of an office's latest term: who holds it since when; or that the term ended (on a date,
 * or with the holder's death) with no successor recorded; or that Wikidata dates no term at all.
 */
export function officeLine(o: Pick<Office, "status" | "latestTerm">, lang: Lang): string {
	const es = lang === "es";
	const term = o.latestTerm;
	if (o.status === "unknown" || !term)
		return es ? "sin períodos con fecha en Wikidata" : "no dated term in Wikidata";
	if (o.status === "current")
		return es ? `desde el ${dayText(term.start, lang)}` : `since ${dayText(term.start, lang)}`;
	const ended = term.end
		? es
			? `terminó el ${dayText(term.end, lang)}`
			: `ended ${dayText(term.end, lang)}`
		: term.died
			? es
				? `falleció el ${dayText(term.died, lang)}`
				: `died ${dayText(term.died, lang)}`
			: es
				? "terminado"
				: "ended";
	return es
		? `${ended}; sin sucesor registrado (período desde el ${dayText(term.start, lang)})`
		: `${ended}; no successor recorded (term from ${dayText(term.start, lang)})`;
}
