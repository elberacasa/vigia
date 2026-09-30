import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { SchemaError } from "../../core/types.ts";
import { parseCsv } from "../../formats/csv.ts";

/**
 * Readers for OFAC's Sanctions List Service files, keeping only what Vigía may use (officials.ts decides names):
 *
 * - `SDN.CSV`: one row per listed party, no header: ent_num, SDN_Name, SDN_Type, Program, Title, Call_Sign, Vess_type,
 *   Tonnage, GRT, Vess_flag, Vess_owner, Remarks; "-0-" means empty; the last line is a lone SUB (0x1A). Programmes
 *   are "VENEZUELA-EO13850] [RUSSIA-EO14024" (joined by "] ["). Remarks hold dates of birth, identity numbers and
 *   links to other parties: only an IMO number (vessels) and an aircraft model are ever read from them.
 * - The delta files (`/changes/<publicationID>`, XML, namespace DeltaFile/1.0): each publication's added, removed and
 *   updated entries. Only the entry id, action, type, OFAC title, programmes, primary name and, for vessels and
 *   aircraft, type/flag/model features are read.
 * - The publication history (`/changes/history/<year>`, JSON): publication ids and their US Eastern times.
 */

export type SdnType = "individual" | "entity" | "vessel" | "aircraft";

export type SdnRow = {
	readonly uid: string;
	readonly name: string;
	readonly type: SdnType;
	readonly programs: string[];
	/** OFAC's Title field, individuals only; null when "-0-". */
	readonly title: string | null;
	readonly vesselType: string | null;
	readonly vesselFlag: string | null;
	readonly imo: string | null;
	readonly aircraftModel: string | null;
};

/** The Venezuela sanctions programmes: VENEZUELA, VENEZUELA-EO13850, VENEZUELA-EO13884 (2026-09-28). */
export const isVenezuelaProgram = (program: string): boolean => /^VENEZUELA(\b|-)/.test(program.trim());

const empty = (v: string | undefined): string | null => {
	const t = (v ?? "").trim();
	return t === "" || t === "-0-" ? null : t;
};

function sdnType(raw: string): SdnType | null {
	const t = raw.trim().toLowerCase();
	if (t === "individual" || t === "vessel" || t === "aircraft") return t;
	return t === "-0-" || t === "" ? "entity" : null;
}

export function programs(raw: string): string[] {
	return raw
		.split(/\]\s*\[/)
		.map((p) => p.replace(/[[\]]/g, "").trim())
		.filter((p) => p !== "" && p !== "-0-");
}

/** Every row of SDN.CSV on a Venezuela programme. Throws on a file that is not the SDN CSV. */
export function venezuelaRows(csv: string): SdnRow[] {
	// The file ends with a lone SUB (0x1A), the old DOS end-of-file mark.
	const sub = String.fromCharCode(0x1a);
	const body = csv.trimEnd().endsWith(sub) ? csv.trimEnd().slice(0, -1) : csv;
	const rows = parseCsv(body);
	if (rows.length < 1_000 || rows.some((r) => r.length !== 12 && !(r.length === 1 && r[0]?.trim() === ""))) {
		throw new SchemaError(`OFAC SDN.CSV: ${rows.length} filas o columnas inesperadas (se esperaban 12)`);
	}
	const out: SdnRow[] = [];
	for (const r of rows) {
		const uid = (r[0] ?? "").trim();
		const type = sdnType(r[2] ?? "");
		const progs = programs(r[3] ?? "");
		if (!/^\d+$/.test(uid) || type === null || !progs.some(isVenezuelaProgram)) continue;
		const remarks = r[11] ?? "";
		out.push({
			uid,
			name: (r[1] ?? "").trim(),
			type,
			programs: progs,
			title: type === "individual" ? empty(r[4]) : null,
			vesselType: type === "vessel" ? empty(r[6]) : null,
			vesselFlag: type === "vessel" ? empty(r[9]) : null,
			imo: type === "vessel" ? (/\bIMO (\d{7})\b/.exec(remarks)?.[1] ?? null) : null,
			aircraftModel:
				type === "aircraft" ? (/Aircraft Model ([^;]+?)\s*(;|$)/.exec(remarks)?.[1] ?? null) : null,
		});
	}
	return out;
}

// ---------------------------------------------------------------------------------------------------------
// Publication history

const History = z.array(z.object({ publicationID: z.number().int().positive(), datePublished: z.string() }));
export type Publication = { readonly id: number; readonly datePublished: string };

export function parseHistory(body: string): Publication[] {
	let json: unknown;
	try {
		json = JSON.parse(body);
	} catch {
		throw new SchemaError("OFAC: el historial de publicaciones no es JSON");
	}
	const parsed = History.safeParse(json);
	if (!parsed.success) throw new SchemaError("OFAC: historial de publicaciones con forma inesperada");
	return parsed.data.map((p) => ({ id: p.publicationID, datePublished: p.datePublished }));
}

// ---------------------------------------------------------------------------------------------------------
// Delta files

export type DeltaAction = "add" | "remove" | "update";

export type DeltaEntry = {
	readonly uid: string;
	readonly action: DeltaAction;
	readonly type: SdnType;
	readonly name: string;
	readonly title: string | null;
	readonly programs: string[];
	/** Date OFAC first listed it (the SDN List's datePublished), "YYYY-MM-DD". */
	readonly listedOn: string | null;
	readonly vesselType: string | null;
	readonly vesselFlag: string | null;
	readonly aircraftModel: string | null;
};

export type Delta = {
	/** Publication date as OFAC prints it, with its offset: "2026-09-23T00:00:00-04:00". */
	readonly datePublished: string;
	readonly publicationType: string;
	/** Entries on a Venezuela programme only. */
	readonly entries: DeltaEntry[];
	/** All entries in the publication, any programme. */
	readonly totalEntries: number;
};

const xml = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "@_",
	textNodeName: "#text",
	trimValues: true,
	parseTagValue: false,
	parseAttributeValue: false,
	isArray: (name) =>
		["entity", "sanctionsProgram", "sanctionsList", "name", "translation", "feature"].includes(name),
});

const text = (v: unknown): string => {
	if (typeof v === "string") return v.trim();
	if (v && typeof v === "object" && "#text" in v) return String((v as { "#text": unknown })["#text"]).trim();
	return "";
};
const list = (v: unknown): unknown[] =>
	Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v];
const obj = (v: unknown): Record<string, unknown> =>
	v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const ENTITY_TYPES: Readonly<Record<string, SdnType>> = {
	Individual: "individual",
	Entity: "entity",
	Vessel: "vessel",
	Aircraft: "aircraft",
};

function primaryName(entity: Record<string, unknown>): string {
	for (const n of list(obj(entity.names).name).map(obj)) {
		if (text(n.isPrimary) !== "true") continue;
		const translations = list(obj(n.translations).translation).map(obj);
		const t = translations.find((x) => text(x.isPrimary) === "true") ?? translations[0];
		if (t) return text(t.formattedFullName);
	}
	return "";
}

function feature(entity: Record<string, unknown>, type: RegExp): string | null {
	for (const f of list(obj(entity.features).feature).map(obj)) {
		if (type.test(text(f.type))) return text(f.value) || null;
	}
	return null;
}

export function parseDelta(body: string): Delta {
	let doc: Record<string, unknown>;
	try {
		doc = obj(xml.parse(body));
	} catch (error) {
		throw new SchemaError(`OFAC delta XML ilegible: ${(error as Error).message}`);
	}
	const root = obj(doc.sanctionsData);
	const info = obj(root.publicationInfo);
	const datePublished = text(info.datePublished);
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[-+]\d{2}:\d{2}$/.test(datePublished)) {
		throw new SchemaError(`OFAC delta: fecha de publicación inesperada «${datePublished}»`);
	}
	const all = list(obj(root.entities).entity).map(obj);
	const entries: DeltaEntry[] = [];
	for (const e of all) {
		const uid = String(e["@_id"] ?? "");
		const action = String(e["@_action"] ?? "");
		const general = obj(e.generalInfo);
		const type = ENTITY_TYPES[text(general.entityType)];
		const progs = list(obj(e.sanctionsPrograms).sanctionsProgram).map(text).filter(Boolean);
		if (!/^\d+$/.test(uid) || !type || (action !== "add" && action !== "remove" && action !== "update"))
			continue;
		if (!progs.some(isVenezuelaProgram)) continue;
		const sdnList = list(obj(e.sanctionsLists).sanctionsList)
			.map(obj)
			.find((l) => text(l) === "SDN List" || text(l["#text"]) === "SDN List");
		const listedOn = String(sdnList?.["@_datePublished"] ?? "");
		entries.push({
			uid,
			action,
			type,
			name: primaryName(e),
			title: type === "individual" ? text(general.title) || null : null,
			programs: progs,
			listedOn: /^\d{4}-\d{2}-\d{2}$/.test(listedOn) ? listedOn : null,
			vesselType: type === "vessel" ? feature(e, /^vessel type$/i) : null,
			vesselFlag: type === "vessel" ? feature(e, /^vessel flag$/i) : null,
			aircraftModel: type === "aircraft" ? feature(e, /^aircraft model$/i) : null,
		});
	}
	return {
		datePublished,
		publicationType: text(info.publicationType),
		entries,
		totalEntries: all.length,
	};
}
