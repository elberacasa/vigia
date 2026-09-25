import type { Adapter, Licence, Observation } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { unescapeHtml } from "../easa-czib/index.ts";

/**
 * FAA "Prohibitions, Restrictions and Notices": the US aviation regulator's page listing, per country, its
 * flight prohibitions (SFARs) and international security NOTAMs (KICZ) for US operators. Keyless HTML, US
 * government work (public domain). Verified 2026-09-24: 200, 139 KB, 0.3 s, "Last updated: Monday, September 14,
 * 2026", 24 country sections; Venezuela has none, neighbours do (Colombia KICZ A0050/26, Ecuador A0051/26,
 * Central America A0054/26, Panama, Haiti).
 *
 * The page is the FAA's own summary: it lists the documents in force, not their full text. A section appearing or
 * disappearing is the signal; the panel links each document. NOTAM search itself (notams.aim.faa.gov) refuses
 * non-browser clients (403) and the FAA NOTAM API needs an account, so neither is used.
 */

export const FAA_LICENCE: Licence = {
	id: "us-gov-public-domain",
	name: "Obra del Gobierno de EE. UU. (dominio público)",
	url: "https://www.faa.gov/privacy",
	attribution: "FAA",
	commercial: true,
};

export const PAGE_URL = "https://www.faa.gov/air_traffic/publications/us_restrictions";

export type FaaItem = { title: string; url: string };

export type FaaSection = {
	kind: "section";
	country: string;
	/** Anchor on the page, for the link. */
	anchor: string | null;
	items: FaaItem[];
	venezuela: boolean;
};

export type FaaPage = {
	kind: "page";
	/** "Last updated" date on the page, YYYY-MM-DD. */
	lastUpdated: string;
	sections: string[];
	/** A section named Venezuela exists. */
	venezuelaSection: boolean;
	/** Documents anywhere on the page naming Venezuela, SVZM (Maiquetía FIR) or Maiquetía. */
	venezuelaMentions: (FaaItem & { section: string })[];
};

export type FaaValue = FaaSection | FaaPage;

const MONTHS = [
	"january",
	"february",
	"march",
	"april",
	"may",
	"june",
	"july",
	"august",
	"september",
	"october",
	"november",
	"december",
];
const VENEZUELA = /venezuela|\bSVZM\b|maiquet/i;
/** Headings of the page's index blocks, which come before the country sections. */
const INDEX_END = /acronyms are used/i;

const text = (html: string) => unescapeHtml(html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));

export function parseFaaPage(html: string): { lastUpdated: string; sections: FaaSection[] } {
	const upd = /Last updated:\s*\w+,\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(html);
	const month = upd ? MONTHS.indexOf((upd[1] ?? "").toLowerCase()) : -1;
	if (!upd || month < 0) throw new SchemaError("FAA: no 'Last updated' date");
	const lastUpdated = `${upd[3]}-${String(month + 1).padStart(2, "0")}-${String(upd[2]).padStart(2, "0")}`;
	// The article ends at its "Last updated" line; the site's footer menus (also <h2>) come after it.
	const article = html.slice(0, upd.index);
	const chunks = article.split(/<h2\b/i).slice(1);
	const start = chunks.findIndex((c) => INDEX_END.test(text(c.split(/<\/h2>/i)[0] ?? "")));
	if (start < 0) throw new SchemaError("FAA: page layout changed (no acronyms heading)");
	const sections: FaaSection[] = [];
	for (const chunk of chunks.slice(start + 1)) {
		const [headRaw = "", ...rest] = chunk.split(/<\/h2>/i);
		if (!rest.length) break;
		const body = rest.join("</h2>");
		const country = text(`<h2${headRaw}`.replace(/^<h2[^>]*>/i, ""));
		if (!country) continue;
		const anchor =
			/<a[^>]*\bid="([^"]+)"/i.exec(headRaw)?.[1] ?? /\bid="([^"]+)"/i.exec(headRaw)?.[1] ?? null;
		const items: FaaItem[] = [];
		for (const m of body.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
			const href = unescapeHtml(m[1] ?? "");
			const title = text(m[2] ?? "");
			if (!title || href.startsWith("#") || href.startsWith("mailto:") || /^back to top$/i.test(title))
				continue;
			let url: string;
			try {
				url = new URL(href, `${PAGE_URL}/`).toString();
			} catch {
				continue;
			}
			if (!items.some((i) => i.url === url && i.title === title)) items.push({ title, url });
		}
		sections.push({
			kind: "section",
			country,
			anchor,
			items,
			venezuela: VENEZUELA.test(country) || items.some((i) => VENEZUELA.test(i.title)),
		});
	}
	if (sections.length === 0) throw new SchemaError("FAA: no country sections");
	return { lastUpdated, sections };
}

const slug = (s: string) =>
	s
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");

export const faaProhibitions: Adapter<FaaValue> = {
	id: "faa-prohibitions",
	layer: "society",
	name: {
		es: "Prohibiciones y avisos de vuelo por país (FAA)",
		en: "Flight prohibitions and notices by country (FAA)",
	},
	provider: "FAA",
	homepage: PAGE_URL,
	licence: FAA_LICENCE,
	keys: [],
	intervalMs: 6 * 3_600_000,
	// Changes a few times a month; stale only if the fetch fails for a day.
	freshness: { fetchMs: 24 * 3_600_000, dataMs: null },

	async fetch(ctx) {
		const raw = await ctx.http.request(PAGE_URL, {
			headers: { accept: "text/html" },
			hostGapMs: 2_000,
			timeoutMs: 30_000,
			maxBytes: 4 * 1024 * 1024,
			signal: ctx.signal,
		});
		return [raw];
	},

	normalise(raws) {
		const raw = raws[0];
		if (!raw) throw new SchemaError("no response");
		const { lastUpdated, sections } = parseFaaPage(raw.body);
		// The page gives a date, not a time: 00:00 UTC of that date, never later than the fetch.
		const observedAt = Math.min(Date.parse(`${lastUpdated}T00:00:00Z`), raw.fetchedAt);
		const base = {
			source: "faa-prohibitions",
			fetchedAt: raw.fetchedAt,
			observedAt,
			licence: FAA_LICENCE.id,
			confidence: 1,
			basis: "official" as const,
		};
		const out: Observation<FaaValue>[] = sections.map((s) => ({
			...base,
			series: `faa:${slug(s.country)}`,
			sourceUrl: s.anchor ? `${PAGE_URL}#${s.anchor}` : PAGE_URL,
			value: s,
		}));
		out.push({
			...base,
			series: "faa:page",
			sourceUrl: PAGE_URL,
			value: {
				kind: "page",
				lastUpdated,
				sections: sections.map((s) => s.country),
				venezuelaSection: sections.some((s) => /venezuela/i.test(s.country)),
				venezuelaMentions: sections.flatMap((s) =>
					s.items.filter((i) => VENEZUELA.test(i.title)).map((i) => ({ ...i, section: s.country })),
				),
			},
		});
		return out;
	},
};
