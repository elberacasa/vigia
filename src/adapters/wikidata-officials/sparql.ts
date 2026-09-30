import { z } from "zod";
import type { FetchContext, Licence, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";

/**
 * Wikidata Query Service: the shared client and the queries about Venezuelan public offices. Wikidata is CC0 and
 * edited by anyone, so everything read here is shown as "según Wikidata" with a link to the item, never as an
 * official record.
 *
 * Politeness (Wikimedia's policy): a User-Agent with contact (the project's), one query at a time, results cached by
 * the callers for a day or until OFAC publishes; the service allows 60 s of query time per minute per client, and
 * each query here takes 1–10 s (measured 2026-09-28).
 */

export const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";

export const WIKIDATA_LICENCE: Licence = {
	id: "cc0-wikidata",
	name: "CC0 1.0 (Wikidata)",
	url: "https://www.wikidata.org/wiki/Wikidata:Licensing",
	attribution: "Wikidata (CC0), editable por cualquiera",
	commercial: true,
};

/** Wikidata ids of Venezuela (Q717) and the office "Presidente del Banco Central de Venezuela", which has no P1001. */
const VENEZUELA = "wd:Q717";
const BCV_PRESIDENT = "wd:Q137530422";

/**
 * Every person who ever held a Venezuelan public office in Wikidata: an office whose jurisdiction (P1001) is
 * Venezuela or one of its subdivisions, plus the BCV presidency. One row per person × office × start date.
 * Measured 2026-09-28: 1,072 people, 1.8 s.
 */
export const OFFICE_HOLDERS_QUERY = `SELECT ?person ?personLabel ?posLabel ?start WHERE {
  { ?pos wdt:P1001 ${VENEZUELA} . } UNION { ?pos wdt:P1001 ?jur . ?jur wdt:P17 ${VENEZUELA} . }
  UNION { VALUES ?pos { ${BCV_PRESIDENT} } }
  ?person p:P39 ?st . ?st ps:P39 ?pos . ?person wdt:P31 wd:Q5 .
  OPTIONAL { ?st pq:P580 ?start }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "es,en". }
}`;

const Term = z.object({ type: z.string(), value: z.string() });
export const SparqlJson = z.object({
	head: z.object({ vars: z.array(z.string()) }),
	results: z.object({ bindings: z.array(z.record(z.string(), Term)) }),
});
export type Binding = Record<string, { type: string; value: string }>;

export async function sparql(ctx: FetchContext, query: string): Promise<RawResponse> {
	return ctx.http.request(`${WIKIDATA_SPARQL}?query=${encodeURIComponent(query)}`, {
		headers: { accept: "application/sparql-results+json" },
		hostGapMs: 2_000,
		timeoutMs: 60_000,
		maxBytes: 16 * 1024 * 1024,
		signal: ctx.signal,
	});
}

export function bindings(raw: RawResponse): Binding[] {
	let json: unknown;
	try {
		json = JSON.parse(raw.body);
	} catch {
		throw new SchemaError("Wikidata: la respuesta no es JSON");
	}
	const parsed = SparqlJson.safeParse(json);
	if (!parsed.success)
		throw new SchemaError(`Wikidata: respuesta SPARQL inesperada (${parsed.error.issues[0]?.message})`);
	return parsed.data.results.bindings;
}

/** "http://www.wikidata.org/entity/Q15081116" → "Q15081116"; null for anything else. */
export function qid(uri: string | undefined): string | null {
	const m = /^https?:\/\/www\.wikidata\.org\/entity\/(Q\d+)$/.exec(uri ?? "");
	return m?.[1] ?? null;
}

export type OfficeHolder = {
	readonly qid: string;
	readonly label: string;
	/** The office of the holder's most recent dated term (or any office when none is dated), Spanish label. */
	readonly position: string;
};

/** One entry per person; people whose label is only their Q-id (no Spanish or English label) are left out. */
export function officeHolders(rows: readonly Binding[]): OfficeHolder[] {
	const by = new Map<string, OfficeHolder & { start: string }>();
	for (const b of rows) {
		const id = qid(b.person?.value);
		const label = b.personLabel?.value ?? "";
		const position = b.posLabel?.value ?? "";
		if (!id || !label || /^Q\d+$/.test(label) || !position || /^Q\d+$/.test(position)) continue;
		const start = b.start?.value ?? "";
		const seen = by.get(id);
		if (!seen || start > seen.start) by.set(id, { qid: id, label, position, start });
	}
	return [...by.values()].map(({ qid: q, label, position }) => ({ qid: q, label, position }));
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

/**
 * Offices followed by name (found 2026-09-28 by querying positions whose jurisdiction is Venezuela or a state, and
 * the governorships that carry no jurisdiction): ministers are added by `OFFICES_QUERY` from their labels.
 */
export const OFFICES: readonly { qid: string; kind: OfficeKind; state?: string }[] = [
	{ qid: "Q11942698", kind: "president" },
	{ qid: "Q3556895", kind: "vice-president" },
	{ qid: "Q6597955", kind: "legislature" },
	{ qid: "Q21970629", kind: "legislature" },
	{ qid: "Q137530422", kind: "central-bank" },
	{ qid: "Q141161530", kind: "justice" },
	{ qid: "Q131748591", kind: "justice" },
	{ qid: "Q9011409", kind: "governor", state: "VE-A" },
	{ qid: "Q5881770", kind: "governor", state: "VE-Z" },
	{ qid: "Q125415784", kind: "governor", state: "VE-E" },
	{ qid: "Q114609939", kind: "governor", state: "VE-Y" },
	{ qid: "Q6572123", kind: "governor", state: "VE-J" },
	{ qid: "Q6572222", kind: "governor", state: "VE-X" },
	{ qid: "Q114609974", kind: "governor", state: "VE-M" },
	{ qid: "Q114609923", kind: "governor", state: "VE-N" },
	{ qid: "Q5881748", kind: "governor", state: "VE-O" },
	{ qid: "Q5881750", kind: "governor", state: "VE-P" },
	{ qid: "Q114604983", kind: "governor", state: "VE-R" },
	{ qid: "Q6572236", kind: "governor", state: "VE-V" },
];

/**
 * Every recorded term (P39 "position held") of the followed offices and of every office whose jurisdiction is
 * Venezuela and whose Spanish label begins "Ministr…": holder, start, end, holder's death. Measured 2026-09-28: 43
 * offices, 500 terms, 356 KB, 0.7–1.6 s.
 */
export const OFFICES_QUERY = `SELECT ?pos ?posLabel ?person ?personLabel ?start ?end ?died WHERE {
  { VALUES ?pos { ${OFFICES.map((o) => `wd:${o.qid}`).join(" ")} } }
  UNION { ?pos wdt:P1001 ${VENEZUELA} ; rdfs:label ?l . FILTER(LANG(?l) = "es" && REGEX(?l, "^ministr", "i")) }
  ?person p:P39 ?st . ?st ps:P39 ?pos .
  OPTIONAL { ?st pq:P580 ?start } OPTIONAL { ?st pq:P582 ?end } OPTIONAL { ?person wdt:P570 ?died }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "es,en". }
}`;
