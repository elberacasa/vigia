import { z } from "zod";
import type { Adapter, Licence, Observation } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { usEasternToMs } from "../../formats/time.ts";

/**
 * The US Federal Register (the government's official journal) through its public API: the newest documents that
 * mention Venezuela (`documents.json?conditions[term]=venezuela&order=newest`), with the fields Vigía uses only.
 *
 * Measured 2026-09-28: 2,327 documents match in all; 50 per page reach back about six months, ~70 KB, 0.4–0.7 s; no
 * key; robots.txt does not cover /api/. Full-text search is broad: of the newest 20, 4 name Venezuela in the title or
 * abstract (OFAC general licences 5X/5Y, 50A/51A, 30B/51; a presidential determination on assistance), 2 are OFAC
 * sanctions notices, and the rest only mention it in the body (a drug-transit determination, trade barriers,
 * silicomanganese from India…). Each document is stored with its `relevance`:
 * - `title`: "Venezuela"/"venezolano" in the title or abstract;
 * - `ofac`: published by OFAC (its notices list people and firms designated under any programme);
 * - `text`: only the body mentions it. For these the title and abstract are **not stored** (a body-only match can be
 *   a notice about a private person); only the number, type, agencies, date and the short link (`/d/<number>`, no
 *   title slug) are, and the panel counts them.
 *
 * Licence: Federal Register content is a US government work in the public domain.
 */

export const FR_LICENCE: Licence = {
	id: "us-gov-public-domain-fr",
	name: "Dominio público (obra del gobierno de EE. UU.)",
	url: "https://www.federalregister.gov/reader-aids/using-federalregister-gov/understanding-the-federal-register",
	attribution: "Fuente: Federal Register (Registro Federal de EE. UU.)",
	commercial: true,
};

const FIELDS = [
	"document_number",
	"title",
	"type",
	"abstract",
	"publication_date",
	"agencies",
	"html_url",
	"pdf_url",
];
export const FR_API =
	"https://www.federalregister.gov/api/v1/documents.json?conditions%5Bterm%5D=venezuela&order=newest&per_page=50&" +
	FIELDS.map((f) => `fields%5B%5D=${f}`).join("&");
export const FR_SEARCH = "https://www.federalregister.gov/documents/search?conditions%5Bterm%5D=venezuela";

const Agency = z.object({
	name: z.string().nullish(),
	raw_name: z.string().nullish(),
	slug: z.string().nullish(),
});
const Doc = z.object({
	document_number: z.string(),
	title: z.string().nullish(),
	type: z.string().nullish(),
	abstract: z.string().nullish(),
	publication_date: z.string(),
	agencies: z.array(Agency).nullish(),
	html_url: z.string().url(),
	pdf_url: z.string().nullish(),
});
const Envelope = z.object({ count: z.number(), results: z.array(z.unknown()) });

export type Relevance = "title" | "ofac" | "text";

export type FrDocument = {
	readonly number: string;
	/** "Rule", "Notice", "Proposed Rule", "Presidential Document". */
	readonly type: string;
	readonly publicationDate: string;
	readonly agencies: string[];
	readonly relevance: Relevance;
	/** Null when `relevance` is "text" (not stored, see above). */
	readonly title: string | null;
	/** At most 600 characters; null when absent or not stored. */
	readonly abstract: string | null;
	readonly htmlUrl: string;
	readonly pdfUrl: string | null;
};

const VENEZUELA = /venezuel|venezolan/i;
const OFAC_SLUG = "foreign-assets-control-office";

/** federalregister.gov/d/<number>: the Register's own short link, which carries no title. */
export const shortUrl = (documentNumber: string) =>
	`https://www.federalregister.gov/d/${encodeURIComponent(documentNumber)}`;

export function relevanceOf(title: string, abstract: string, agencySlugs: readonly string[]): Relevance {
	if (VENEZUELA.test(title) || VENEZUELA.test(abstract)) return "title";
	if (agencySlugs.includes(OFAC_SLUG)) return "ofac";
	return "text";
}

export const federalRegister: Adapter<FrDocument> = {
	id: "federal-register",
	layer: "society",
	name: {
		es: "Registro Federal de EE. UU.: documentos sobre Venezuela",
		en: "US Federal Register: documents on Venezuela",
	},
	provider: "Office of the Federal Register (NARA) and GPO",
	homepage: FR_SEARCH,
	licence: FR_LICENCE,
	keys: [],
	// The Register is published once each federal business day (early morning ET); every 6 h catches it.
	intervalMs: 6 * 3_600_000,
	// Event feed: no Venezuela document for weeks is normal.
	freshness: { fetchMs: 36 * 3_600_000, dataMs: null },

	async fetch(ctx) {
		return [
			await ctx.http.request(FR_API, {
				headers: { accept: "application/json" },
				hostGapMs: 2_000,
				maxBytes: 8 * 1024 * 1024,
				signal: ctx.signal,
			}),
		];
	},

	normalise(raws) {
		const raw = raws[0];
		if (!raw) throw new SchemaError("no response");
		let json: unknown;
		try {
			json = JSON.parse(raw.body);
		} catch {
			throw new SchemaError("Federal Register: la respuesta no es JSON");
		}
		const envelope = Envelope.safeParse(json);
		if (!envelope.success) throw new SchemaError("Federal Register: respuesta sin count/results");
		const out: Observation<FrDocument>[] = [];
		for (const item of envelope.data.results) {
			const doc = Doc.safeParse(item);
			if (!doc.success) continue;
			const d = doc.data;
			const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.publication_date);
			if (!m) continue;
			const observedAt = usEasternToMs(Number(m[1]), Number(m[2]), Number(m[3]));
			if (observedAt > raw.fetchedAt + 86_400_000) continue;
			const agencies = (d.agencies ?? []).map((a) => a.name ?? a.raw_name ?? "").filter(Boolean);
			const slugs = (d.agencies ?? []).map((a) => a.slug ?? "");
			const title = d.title ?? "";
			const abstract = d.abstract ?? "";
			const relevance = relevanceOf(title, abstract, slugs);
			const keep = relevance !== "text";
			// The document page's URL carries the title as a slug: a body-only match gets the short link instead.
			const htmlUrl = keep ? d.html_url : shortUrl(d.document_number);
			out.push({
				source: "federal-register",
				series: `doc:${d.document_number}`,
				sourceUrl: htmlUrl,
				fetchedAt: raw.fetchedAt,
				observedAt,
				licence: FR_LICENCE.id,
				value: {
					number: d.document_number,
					type: d.type ?? "",
					publicationDate: d.publication_date,
					agencies,
					relevance,
					title: keep && title ? title : null,
					abstract: keep && abstract ? abstract.slice(0, 600) : null,
					htmlUrl,
					pdfUrl: keep ? (d.pdf_url ?? null) : null,
				},
				confidence: 1,
				basis: "official",
			});
		}
		return out;
	},
};
