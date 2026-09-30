import type { Adapter, Observation } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import {
	type Binding,
	bindings,
	OFFICES,
	OFFICES_QUERY,
	type OfficeKind,
	qid,
	sparql,
	WIKIDATA_LICENCE,
	WIKIDATA_SPARQL,
} from "./sparql.ts";

/**
 * Who holds Venezuela's public offices, according to Wikidata: president, vice-president, ministers, the National
 * Assembly's presidency, the BCV's presidency, the ombudsman and prosecutor general, and the governorships Wikidata
 * has items for. Public officials only (their office terms). A base for the "who holds which office" view that the
 * Official Gazette's appointments will cross-check.
 *
 * Wikidata is edited by anyone and its Venezuelan terms are patchy (measured 2026-09-28, 43 offices): some offices'
 * newest term is open ("current"), many ended with no successor recorded, others have no dated term at all. So the
 * rule is stated and never guessed: per office, the term with the latest start date decides. Open and the holder
 * alive: `current`. Ended (or holder dead): `ended`, "Wikidata no registra sucesor desde <fin>". No dated term: `unknown`.
 * Undated terms are counted, never used (a term with no start or end is usually an old one nobody closed).
 *
 * One SPARQL query a day (356 KB, ~1 s). CC0.
 */

export type OfficeStatus = "current" | "ended" | "unknown";

export type OfficeValue = {
	readonly office: { readonly qid: string; readonly label: string };
	readonly kind: OfficeKind;
	/** ISO 3166-2 for a governorship. */
	readonly state: string | null;
	readonly status: OfficeStatus;
	/** The term with the latest start date; null when no term is dated. */
	readonly latestTerm: {
		readonly person: { readonly qid: string; readonly label: string };
		readonly start: string;
		readonly end: string | null;
		readonly died: string | null;
		/** Wikidata gives an end before the start (measured: Portuguesa, 2025-05-25 → 2025-01-01). */
		readonly datesInconsistent: boolean;
	} | null;
	readonly termsRecorded: number;
	readonly undatedTerms: number;
	readonly wikidataUrl: string;
};

const day = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

export function offices(rows: readonly Binding[], at: number): OfficeValue[] {
	const today = new Date(at).toISOString().slice(0, 10);
	const byOffice = new Map<string, { label: string; terms: Binding[] }>();
	for (const b of rows) {
		const id = qid(b.pos?.value);
		const label = b.posLabel?.value ?? "";
		if (!id || !label || /^Q\d+$/.test(label)) continue;
		const entry = byOffice.get(id) ?? { label, terms: [] };
		entry.terms.push(b);
		byOffice.set(id, entry);
	}
	const known = new Map(OFFICES.map((o) => [o.qid, o]));
	const out: OfficeValue[] = [];
	for (const [id, { label, terms }] of byOffice) {
		const dated = terms.filter((t) => day(t.start?.value) !== null && qid(t.person?.value));
		// Latest start wins; on a tie, an open term over an ended one (a re-appointment recorded twice).
		const latest = dated.sort((a, b) => {
			const s = (day(b.start?.value) ?? "").localeCompare(day(a.start?.value) ?? "");
			return s !== 0 ? s : Number(!b.end) - Number(!a.end);
		})[0];
		const start = day(latest?.start?.value) ?? "";
		const end = day(latest?.end?.value);
		const died = day(latest?.died?.value);
		const open = latest !== undefined && (end === null || end > today) && died === null;
		const meta = known.get(id);
		out.push({
			office: { qid: id, label },
			kind: meta?.kind ?? "minister",
			state: meta?.state ?? null,
			status: !latest ? "unknown" : open ? "current" : "ended",
			latestTerm: latest
				? {
						person: { qid: qid(latest.person?.value) ?? "", label: latest.personLabel?.value ?? "" },
						start,
						end,
						died,
						datesInconsistent: end !== null && end < start,
					}
				: null,
			termsRecorded: terms.length,
			undatedTerms: terms.length - dated.length,
			wikidataUrl: `https://www.wikidata.org/wiki/${id}`,
		});
	}
	return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.office.label.localeCompare(b.office.label));
}

export const wikidataOfficials: Adapter<OfficeValue> = {
	id: "wikidata-officials",
	layer: "society",
	name: { es: "Cargos públicos de Venezuela según Wikidata", en: "Venezuela's public offices on Wikidata" },
	provider: "Wikidata (Wikimedia Foundation)",
	homepage: "https://www.wikidata.org/wiki/Q11942698",
	licence: WIKIDATA_LICENCE,
	keys: [],
	// Office holders change rarely and Wikidata's editors are slower still: once a day.
	intervalMs: 24 * 3_600_000,
	freshness: { fetchMs: 3 * 24 * 3_600_000, dataMs: null },

	async fetch(ctx) {
		return [await sparql(ctx, OFFICES_QUERY)];
	},

	normalise(raws) {
		const raw = raws.find((r) => r.url.startsWith(WIKIDATA_SPARQL));
		if (!raw) throw new SchemaError("Wikidata: falta la respuesta");
		const rows = bindings(raw);
		const list = offices(rows, raw.fetchedAt);
		if (list.length < 5) throw new SchemaError(`Wikidata: solo ${list.length} cargos en la respuesta`);
		// One reading per day: the day of the query, 00:00 UTC (the same answer twice in a day is stored once).
		const observedAt = Math.floor(raw.fetchedAt / 86_400_000) * 86_400_000;
		return list.map(
			(value): Observation<OfficeValue> => ({
				source: "wikidata-officials",
				series: `office:${value.office.qid}`,
				sourceUrl: value.wikidataUrl,
				fetchedAt: raw.fetchedAt,
				observedAt,
				licence: WIKIDATA_LICENCE.id,
				value,
				// Crowd-edited reference data: shown as "según Wikidata", not as an official record.
				confidence: 0.7,
				basis: "report",
			}),
		);
	},
};
