import { z } from "zod";
import type { Adapter, Licence, Observation, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";

/**
 * EASA Conflict Zone Information Bulletins (CZIB): the EU aviation safety agency's advisories on airspace where
 * armed conflict or military activity puts civil flights at risk. Keyless, official.
 *
 * Two small files per run (verified 2026-09-24): the JSON export of the CZIB list (13.8 KB, 33 bulletins: status
 * Active/Withdrawn, issue date, valid-until, countries) and the RSS feed (12 KB, the same 33 with each bulletin's
 * page link; the JSON has none). "Venezuela and neighbouring airspace", CZIB 2026-01-R2, was issued on 2026-01-03,
 * valid until 2026-02-16, and is withdrawn: the airspace panel shows that history, not only what is active.
 *
 * Quirks: dates come as "2017-03-31T00:00:00+0300" (offset without a colon), valid-until as "31/10/2026" or "" (no
 * end date), `updated` as an HTML <time> element, and names are HTML-escaped (&#039;).
 */

export const EASA_LICENCE: Licence = {
	id: "easa-reuse",
	name: "EASA: reutilización autorizada citando la fuente",
	url: "https://www.easa.europa.eu/en/legal-notice",
	attribution: "EASA",
	commercial: true,
};

export const JSON_URL =
	"https://www.easa.europa.eu/en/domains/air-operations/czibs/export-json?page&_format=json";
export const RSS_URL = "https://www.easa.europa.eu/en/domains/air-operations/czibs/feed.xml";
export const LIST_URL = "https://www.easa.europa.eu/en/domains/air-operations/czibs";

export type CzibValue = {
	nid: string;
	/** e.g. "2026-01-R2", from the bulletin's page link; null when the RSS lacks it. */
	number: string | null;
	name: string;
	status: "active" | "withdrawn";
	countries: string[];
	issuedAt: number;
	/** The issue date as EASA writes it (its own time zone), YYYY-MM-DD: what the UI shows. */
	issuedDate: string;
	/** YYYY-MM-DD, or null: "until further notice". */
	validUntil: string | null;
	updatedAt: number | null;
	/** Names Venezuela (title or countries). */
	venezuela: boolean;
};

const Entry = z.object({
	Nid: z.string().regex(/^\d+$/),
	issued_date: z.string(),
	valid_until_date: z.string(),
	name: z.string().min(1),
	status: z.string(),
	country: z.string(),
	updated: z.string(),
});
const Envelope = z.object({ conflict_zones: z.array(z.unknown()) });

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function unescapeHtml(s: string): string {
	return s
		.replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
		.replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m)
		.trim();
}

/** "2017-03-31T00:00:00+0300" or "...+03:00" → epoch ms; NaN when unparseable. */
export function parseOffsetDate(s: string): number {
	const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})([+-])(\d{2}):?(\d{2})$/.exec(s.trim());
	if (!m) return Number.NaN;
	return Date.parse(`${m[1]}${m[2]}${m[3]}:${m[4]}`);
}

/** Nid → page link and bulletin number, from the RSS guid ("142977 on Sat, …") and link. */
export function linksFromRss(xml: string): Map<string, { url: string; number: string | null }> {
	const out = new Map<string, { url: string; number: string | null }>();
	for (const item of xml.split(/<item>/).slice(1)) {
		const link = /<link>([^<]+)<\/link>/.exec(item)?.[1]?.trim();
		const nid = /<guid[^>]*>\s*(\d+)\s/.exec(item)?.[1];
		if (!link || !nid || !/^https:\/\/www\.easa\.europa\.eu\//.test(link)) continue;
		const slug = link.split("/").pop() ?? "";
		const num = /^(?:czib-)?(\d{4}-\d{2})-?(r\d+)?$/i.exec(slug);
		out.set(nid, {
			url: link,
			number: num ? `${num[1]}${num[2] ? `-${num[2].toUpperCase()}` : ""}` : null,
		});
	}
	return out;
}

export const easaCzib: Adapter<CzibValue> = {
	id: "easa-czib",
	layer: "society",
	name: {
		es: "Boletines de zonas de conflicto para la aviación (EASA)",
		en: "Conflict zone bulletins for aviation (EASA)",
	},
	provider: "EASA",
	homepage: LIST_URL,
	licence: EASA_LICENCE,
	keys: [],
	// Bulletins change a few times a year; every 6 h is plenty and costs ~26 KB a run.
	intervalMs: 6 * 3_600_000,
	// An event feed: no new bulletin for months is normal. Stale only if the fetch fails for a day.
	freshness: { fetchMs: 24 * 3_600_000, dataMs: null },

	async fetch(ctx) {
		const opts = { hostGapMs: 2_000, timeoutMs: 30_000, maxBytes: 2 * 1024 * 1024, signal: ctx.signal };
		const json = await ctx.http.request(JSON_URL, { ...opts, headers: { accept: "application/json" } });
		// The links are a nicety: without the RSS the bulletins still load, pointing at the list page.
		try {
			const rss = await ctx.http.request(RSS_URL, { ...opts, headers: { accept: "application/rss+xml" } });
			return [json, rss];
		} catch {
			return [json];
		}
	},

	normalise(raws) {
		const jsonRaw = raws.find((r) => r.url.includes("export-json"));
		if (!jsonRaw) throw new SchemaError("no JSON response");
		const rssRaw: RawResponse | undefined = raws.find((r) => r.url.includes("feed.xml"));
		let parsed: unknown;
		try {
			parsed = JSON.parse(jsonRaw.body);
		} catch {
			throw new SchemaError(`EASA: not JSON (${jsonRaw.body.slice(0, 60).trim()})`);
		}
		const env = Envelope.safeParse(parsed);
		if (!env.success) throw new SchemaError("EASA: no conflict_zones list");
		const links = rssRaw
			? linksFromRss(rssRaw.body)
			: new Map<string, { url: string; number: string | null }>();
		const out: Observation<CzibValue>[] = [];
		for (const item of env.data.conflict_zones) {
			const e = Entry.safeParse(item);
			if (!e.success) continue;
			const d = e.data;
			const status = d.status.trim().toLowerCase();
			if (status !== "active" && status !== "withdrawn") continue;
			const issuedAt = parseOffsetDate(d.issued_date);
			if (Number.isNaN(issuedAt)) continue;
			const updatedRaw = /datetime="([^"]+)"/.exec(d.updated)?.[1];
			const updatedAt = updatedRaw ? parseOffsetDate(updatedRaw) : Number.NaN;
			const until = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d.valid_until_date.trim());
			const name = unescapeHtml(d.name);
			const countries = unescapeHtml(d.country)
				.split(",")
				.map((c) => c.trim())
				.filter(Boolean);
			const link = links.get(d.Nid);
			const observedAt = Math.min(Number.isNaN(updatedAt) ? issuedAt : updatedAt, jsonRaw.fetchedAt);
			out.push({
				source: "easa-czib",
				series: `czib:${d.Nid}`,
				sourceUrl: link?.url ?? LIST_URL,
				fetchedAt: jsonRaw.fetchedAt,
				observedAt,
				licence: EASA_LICENCE.id,
				value: {
					nid: d.Nid,
					number: link?.number ?? null,
					name,
					status,
					countries,
					issuedAt,
					issuedDate: d.issued_date.slice(0, 10),
					validUntil: until ? `${until[3]}-${until[2]}-${until[1]}` : null,
					updatedAt: Number.isNaN(updatedAt) ? null : updatedAt,
					venezuela: /venezuela/i.test(name) || countries.some((c) => /venezuela/i.test(c)),
				},
				confidence: 1,
				basis: "official",
			});
		}
		if (env.data.conflict_zones.length > 0 && out.length === 0) {
			throw new SchemaError("EASA: no bulletin parsed (format changed?)");
		}
		return out;
	},
};
