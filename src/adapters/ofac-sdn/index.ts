import type { Adapter, Licence, Observation, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { usEasternIsoToMs } from "../../formats/time.ts";
import {
	bindings,
	OFFICE_HOLDERS_QUERY,
	type OfficeHolder,
	officeHolders,
	sparql,
	WIKIDATA_SPARQL,
} from "../wikidata-officials/sparql.ts";
import { isPublicOfficeTitle, officialMatches } from "./officials.ts";
import {
	type DeltaAction,
	type DeltaEntry,
	type Publication,
	parseDelta,
	parseHistory,
	type SdnRow,
	type SdnType,
	venezuelaRows,
} from "./parse.ts";

/**
 * OFAC's Specially Designated Nationals (SDN) list, Venezuela programmes (VENEZUELA, VENEZUELA-EO13850,
 * VENEZUELA-EO13884), from Treasury's Sanctions List Service. Three things per run, all from OFAC's own files:
 *
 * 1. The publication history (`/changes/history/<year>`, JSON, ~7 KB): every list update, with its id and time.
 * 2. The delta file of each publication not yet stored (`/changes/<id>`, XML, 5–260 KB): OFAC's own record of what it
 *    added, removed or updated. Designations and removals come from here, dated by OFAC, never inferred.
 * 3. When a publication is newer than the stored snapshot: the full `SDN.CSV` (5.7 MB, redirected to a signed S3
 *    URL), reduced at once to the Venezuela-programme rows, plus one Wikidata query (Venezuelan office holders, 0.75
 *    MB, ~2 s) used only to decide which individuals are public officials (officials.ts).
 *
 * Measured 2026-09-28: 97 publications in 2026 (the newest 984 on 2026-09-23 10:07 ET), five with Venezuela
 * entries (e.g. 841 on 2026-04-01: one removal; 884 on 2026-05-28: vessels removed; 959 on 2026-08-18: one entity
 * added). The list then had 409 Venezuela-programme entries: 190 individuals, 104 entities, 60 vessels, 55 aircraft.
 *
 * Who is named (docs/ETHICS.md): public officials, by OFAC's own title or an unambiguous Wikidata office holder (88 of the
 * 190 on 2026-09-28); companies and vessels by their listed names; aircraft only by model (government aircraft are
 * shown in aggregate). Every other individual is a count: no name, OFAC id, alias, birth date or document is stored.
 *
 * Licence: US government work, public domain. Politeness: one request to the service at a time, 1 s apart; the
 * 5.7 MB list only after a new publication (OFAC publishes about twice a week).
 */

export const OFAC_SLS = "https://sanctionslistservice.ofac.treas.gov";
export const SDN_CSV_URL = `${OFAC_SLS}/api/PublicationPreview/exports/SDN.CSV`;
export const OFAC_SEARCH = "https://sanctionssearch.ofac.treas.gov/";
export const OFAC_VENEZUELA_PAGE =
	"https://ofac.treasury.gov/sanctions-programs-and-country-information/venezuela-related-sanctions";

export const OFAC_LICENCE: Licence = {
	id: "us-gov-public-domain-ofac",
	name: "Dominio público (obra del gobierno de EE. UU.)",
	url: "https://ofac.treasury.gov/",
	attribution: "Fuente: Oficina de Control de Activos Extranjeros (OFAC), Tesoro de EE. UU.",
	commercial: true,
};

/** Delta files fetched per run at most (the first run backfills the last 365 days over several runs). */
export const MAX_DELTAS = 20;
const BACKFILL_MS = 365 * 86_400_000;
const REQUEST = { hostGapMs: 1_000, timeoutMs: 60_000 } as const;

export type NamedOfficial = {
	readonly uid: string;
	readonly name: string;
	/** OFAC's Title field, when it has one. */
	readonly title: string | null;
	/** Why the person may be named: OFAC's title names a public office, or Wikidata lists them as an office holder. */
	readonly basis: "ofac-title" | "wikidata";
	readonly wikidata: { readonly qid: string; readonly label: string; readonly position: string } | null;
};

export type Subject =
	| ({ readonly type: "individual"; readonly named: true } & NamedOfficial)
	| { readonly type: "individual"; readonly named: false }
	| { readonly type: "entity"; readonly uid: string; readonly name: string }
	| {
			readonly type: "vessel";
			readonly uid: string;
			readonly name: string;
			readonly vesselType: string | null;
			readonly flag: string | null;
	  }
	| { readonly type: "aircraft"; readonly model: string | null };

export type PublicationValue = {
	readonly kind: "publication";
	readonly publicationId: number;
	/** OFAC's time, US Eastern wall clock as the history prints it. */
	readonly publishedEt: string;
	readonly publicationType: string;
	readonly venezuelaEntries: number;
	readonly totalEntries: number;
};

export type ChangeValue = {
	readonly kind: "change";
	readonly publicationId: number;
	readonly action: DeltaAction;
	readonly subject: Subject;
	readonly programs: string[];
	/** When OFAC first listed the entry ("YYYY-MM-DD"). */
	readonly listedOn: string | null;
};

export type SnapshotValue = {
	readonly kind: "snapshot";
	/** The newest publication the list reflects. */
	readonly publicationId: number;
	readonly counts: {
		readonly total: number;
		readonly individuals: number;
		readonly entities: number;
		readonly vessels: number;
		readonly aircraft: number;
	};
	/** Entries per programme (an entry on two programmes counts in both). */
	readonly byProgram: Readonly<Record<string, number>>;
	readonly officials: (NamedOfficial & { readonly programs: string[] })[];
	/** Individuals who are not shown by name. */
	readonly unnamedIndividuals: number;
	readonly entities: {
		readonly uid: string;
		readonly name: string;
		readonly programs: string[];
	}[];
	readonly vessels: {
		readonly uid: string;
		readonly name: string;
		readonly vesselType: string | null;
		readonly flag: string | null;
		readonly imo: string | null;
		readonly programs: string[];
	}[];
	readonly aircraftByModel: { readonly model: string; readonly count: number }[];
	/** Whether the Wikidata cross-check was available for this snapshot (if not, only OFAC titles name anyone). */
	readonly wikidataChecked: boolean;
};

export type OfacValue = PublicationValue | ChangeValue | SnapshotValue;

// ---------------------------------------------------------------------------------------------------------
// Pure helpers

const historyUrl = (year: number) => `${OFAC_SLS}/changes/history/${year}`;
const deltaUrl = (id: number) => `${OFAC_SLS}/changes/${id}`;
const deltaId = (url: string): number | null => {
	const m = /\/changes\/(\d+)$/.exec(url);
	return m ? Number(m[1]) : null;
};

/** The history's "2026-09-23T10:07:28.650545" (US Eastern, no offset) → epoch ms. */
export function publishedAt(p: Publication): number | null {
	return usEasternIsoToMs(p.datePublished);
}

/** OFAC's recent-actions page for a US Eastern day: https://ofac.treasury.gov/recent-actions/20260401. */
export function recentActionsUrl(publishedEt: string): string {
	return `https://ofac.treasury.gov/recent-actions/${publishedEt.slice(0, 10).replaceAll("-", "")}`;
}

type Naming = (name: string, title: string | null) => NamedOfficial | null;

function namer(names: string[], holders: readonly OfficeHolder[] | null): Naming {
	const matches = holders ? officialMatches(names, holders) : new Map<string, OfficeHolder>();
	return (name, title) => {
		const wd = matches.get(name) ?? null;
		const wikidata = wd ? { qid: wd.qid, label: wd.label, position: wd.position } : null;
		if (isPublicOfficeTitle(title)) return { uid: "", name, title, basis: "ofac-title", wikidata };
		if (wikidata) return { uid: "", name, title, basis: "wikidata", wikidata };
		return null;
	};
}

function subjectOf(
	entry: Pick<DeltaEntry, "uid" | "type" | "name" | "title" | "vesselType" | "vesselFlag" | "aircraftModel">,
	name: Naming,
): Subject {
	switch (entry.type) {
		case "individual": {
			const official = name(entry.name, entry.title);
			return official
				? { type: "individual", named: true, ...official, uid: entry.uid }
				: { type: "individual", named: false };
		}
		case "entity":
			return { type: "entity", uid: entry.uid, name: entry.name };
		case "vessel":
			return {
				type: "vessel",
				uid: entry.uid,
				name: entry.name,
				vesselType: entry.vesselType,
				flag: entry.vesselFlag,
			};
		case "aircraft":
			return { type: "aircraft", model: entry.aircraftModel };
	}
}

function snapshot(
	rows: readonly SdnRow[],
	publicationId: number,
	name: Naming,
	wikidataChecked: boolean,
): SnapshotValue {
	const count = (t: SdnType) => rows.filter((r) => r.type === t).length;
	const byProgram: Record<string, number> = {};
	for (const r of rows) for (const p of r.programs) byProgram[p] = (byProgram[p] ?? 0) + 1;
	const officials: (NamedOfficial & { programs: string[] })[] = [];
	let unnamed = 0;
	for (const r of rows.filter((x) => x.type === "individual")) {
		const official = name(r.name, r.title);
		if (official) officials.push({ ...official, uid: r.uid, programs: r.programs });
		else unnamed++;
	}
	const models = new Map<string, number>();
	for (const r of rows.filter((x) => x.type === "aircraft")) {
		const model = r.aircraftModel ?? "modelo no indicado";
		models.set(model, (models.get(model) ?? 0) + 1);
	}
	const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);
	return {
		kind: "snapshot",
		publicationId,
		counts: {
			total: rows.length,
			individuals: count("individual"),
			entities: count("entity"),
			vessels: count("vessel"),
			aircraft: count("aircraft"),
		},
		byProgram,
		officials: officials.sort(byName),
		unnamedIndividuals: unnamed,
		entities: rows
			.filter((r) => r.type === "entity")
			.map((r) => ({ uid: r.uid, name: r.name, programs: r.programs }))
			.sort(byName),
		vessels: rows
			.filter((r) => r.type === "vessel")
			.map((r) => ({
				uid: r.uid,
				name: r.name,
				vesselType: r.vesselType,
				flag: r.vesselFlag,
				imo: r.imo,
				programs: r.programs,
			}))
			.sort(byName),
		aircraftByModel: [...models]
			.map(([model, n]) => ({ model, count: n }))
			.sort((a, b) => b.count - a.count || a.model.localeCompare(b.model)),
		wikidataChecked,
	};
}

// ---------------------------------------------------------------------------------------------------------

export const ofacSdn: Adapter<OfacValue> = {
	id: "ofac-sdn",
	layer: "society",
	name: {
		es: "Sanciones de EE. UU. a Venezuela (OFAC, lista SDN)",
		en: "US sanctions on Venezuela (OFAC SDN list)",
	},
	provider: "OFAC, US Department of the Treasury",
	homepage: OFAC_VENEZUELA_PAGE,
	licence: OFAC_LICENCE,
	keys: [],
	// OFAC publishes about twice a week, at any hour; every 2 h costs one 7 KB request when nothing changed.
	intervalMs: 2 * 3_600_000,
	// Publications are events (a week without one is normal), so no data budget; a day without a successful read is
	// stale.
	freshness: { fetchMs: 24 * 3_600_000, dataMs: null },

	async fetch(ctx) {
		const now = ctx.now();
		const year = new Date(now).getUTCFullYear();
		const opts = { ...REQUEST, signal: ctx.signal, headers: { accept: "application/json" } };
		const raws: RawResponse[] = [await ctx.http.request(historyUrl(year), opts)];
		const previous = await ctx.http.request(historyUrl(year - 1), opts).catch(() => null);
		if (previous) raws.push(previous);
		const pubs = raws
			.flatMap((r) => parseHistory(r.body))
			.map((p) => ({ ...p, at: publishedAt(p) }))
			.filter((p): p is Publication & { at: number } => p.at !== null && p.at > now - BACKFILL_MS)
			.sort((a, b) => b.at - a.at);
		const newest = pubs[0];
		if (!newest) return raws;
		// Newest first, so a long backfill never delays today's publication. Without a store (recording a fixture)
		// the newest three are read.
		const pending = ctx.seen
			? pubs.filter((p) => !ctx.seen?.(`publication:${p.id}`, p.at)).slice(0, MAX_DELTAS)
			: pubs.slice(0, 3);
		// The service redirects every file to a signed S3 URL (with temporary credentials in its query string): each
		// response keeps the service URL it was asked for, which also names the publication.
		const get = async (url: string, maxBytes: number): Promise<RawResponse> => ({
			...(await ctx.http.request(url, { ...REQUEST, signal: ctx.signal, maxBytes })),
			url,
		});
		for (const p of pending) raws.push(await get(deltaUrl(p.id), 16 * 1024 * 1024));
		if (!ctx.seen?.("snapshot", newest.at)) {
			raws.push(await get(SDN_CSV_URL, 64 * 1024 * 1024));
			// Wikidata only refines who may be named; if it is down the run goes on with OFAC's titles alone.
			const wd = await sparql(ctx, OFFICE_HOLDERS_QUERY).catch(() => null);
			if (wd) raws.push(wd);
		}
		return raws;
	},

	normalise(raws) {
		const histories = raws.filter((r) => /\/changes\/history\/\d{4}$/.test(r.url));
		if (histories.length === 0) throw new SchemaError("OFAC: falta el historial de publicaciones");
		const pubs = new Map<number, Publication & { at: number }>();
		for (const h of histories) {
			for (const p of parseHistory(h.body)) {
				const at = publishedAt(p);
				if (at !== null) pubs.set(p.id, { ...p, at });
			}
		}
		const fetchedAt = histories[0]?.fetchedAt ?? 0;
		const deltas = raws
			.map((r) => ({ raw: r, id: deltaId(r.url) }))
			.filter((d): d is { raw: RawResponse; id: number } => d.id !== null)
			.map((d) => ({ ...d, delta: parseDelta(d.raw.body) }));
		const csv = raws.find((r) => r.url === SDN_CSV_URL);
		const wdRaw = raws.find((r) => r.url.startsWith(WIKIDATA_SPARQL));
		const holders = wdRaw ? officeHolders(bindings(wdRaw)) : null;
		const rows = csv ? venezuelaRows(csv.body) : [];
		// Every individual judged in this run, so the one-to-one Wikidata match sees them all.
		const names = [
			...rows.filter((r) => r.type === "individual").map((r) => r.name),
			...deltas.flatMap((d) => d.delta.entries.filter((e) => e.type === "individual").map((e) => e.name)),
		];
		const name = namer(names, holders);

		const out: Observation<OfacValue>[] = [];
		const push = (series: string, observedAt: number, sourceUrl: string, value: OfacValue, at = fetchedAt) =>
			out.push({
				source: "ofac-sdn",
				series,
				sourceUrl,
				fetchedAt: at,
				observedAt,
				licence: OFAC_LICENCE.id,
				value,
				confidence: 1,
				basis: "official",
			});

		for (const { raw, id, delta } of deltas) {
			const pub = pubs.get(id);
			// The history's time of day when it lists the publication, else the delta's own date (midnight ET).
			const observedAt = pub?.at ?? Date.parse(delta.datePublished);
			const publishedEt = pub?.datePublished ?? delta.datePublished.slice(0, 19);
			const url = recentActionsUrl(publishedEt);
			push(
				`publication:${id}`,
				observedAt,
				url,
				{
					kind: "publication",
					publicationId: id,
					publishedEt,
					publicationType: delta.publicationType,
					venezuelaEntries: delta.entries.length,
					totalEntries: delta.totalEntries,
				},
				raw.fetchedAt,
			);
			delta.entries.forEach((e, i) => {
				const subject = subjectOf(e, name);
				// A named entry links to its OFAC record; anything else to the day's recent-actions page.
				const named =
					subject.type === "entity" ||
					subject.type === "vessel" ||
					(subject.type === "individual" && subject.named);
				push(
					`change:${id}:${i}`,
					observedAt,
					named ? `${OFAC_SEARCH}Details.aspx?id=${e.uid}` : url,
					{
						kind: "change",
						publicationId: id,
						action: e.action,
						subject,
						programs: e.programs,
						listedOn: e.listedOn,
					},
					raw.fetchedAt,
				);
			});
		}

		if (csv) {
			// No Venezuela row at all means the programme names changed (or the file is not the list): fail loudly.
			if (rows.length === 0) throw new SchemaError("OFAC SDN.CSV: ninguna entrada en programas VENEZUELA*");
			const newest = [...pubs.values()].sort((a, b) => b.at - a.at)[0];
			if (!newest) throw new SchemaError("OFAC: lista sin publicación a la que atribuirla");
			push(
				"snapshot",
				newest.at,
				OFAC_SEARCH,
				snapshot(rows, newest.id, name, holders !== null),
				csv.fetchedAt,
			);
		}
		return out;
	},
};
