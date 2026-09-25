import { z } from "zod";
import type { Adapter, Licence, Observation, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";

/**
 * What the world is reading about Venezuela: daily Wikipedia pageviews (human readers, all platforms) of a fixed
 * list of articles in Spanish, English and Portuguese, from the Wikimedia REST API. Keyless, CC0.
 *
 * Verified 2026-09-24: ~0.25 s per article, daily granularity, the newest day is yesterday (UTC), and days with zero
 * views are OMITTED from the response (es "Bolívar digital": 33 of 35 days). An article with no views in the whole
 * range answers 404. So `normalise` fills zeros, but only up to the newest day that any article in the same run
 * has: a missing latest day means "not processed yet", not zero.
 *
 * This is attention, not news: a spike says many people looked something up, not what happened. The panel says so.
 * Titles are the canonical article titles (a redirect's views are not counted by the API), checked by hand.
 * Median daily views 2026-08-27..09-23: en Venezuela ~3,500, es Venezuela ~1,200, es CANTV ~28.
 */

export const WIKIMEDIA_LICENCE: Licence = {
	id: "cc0-wikimedia-pageviews",
	name: "CC0 (datos de páginas vistas de Wikimedia)",
	url: "https://wikitech.wikimedia.org/wiki/Analytics/AQS/Pageviews",
	attribution: "Wikimedia Foundation (páginas vistas de Wikipedia)",
	commercial: true,
};

export type Article = {
	/** "es.wikipedia" | "en.wikipedia" | "pt.wikipedia" */
	project: string;
	/** Canonical title, underscores for spaces. */
	title: string;
	/** Topic the panel groups by. */
	topic: string;
};

export const TOPICS: Record<string, { es: string; en: string }> = {
	venezuela: { es: "Venezuela", en: "Venezuela" },
	caracas: { es: "Caracas", en: "Caracas" },
	presidency: { es: "Presidencia de Venezuela", en: "Presidency of Venezuela" },
	crisis: { es: "Crisis en Venezuela", en: "Crisis in Venezuela" },
	pdvsa: { es: "PDVSA", en: "PDVSA" },
	bolivar: { es: "Bolívar (moneda)", en: "Bolívar (currency)" },
	bcv: { es: "Banco Central de Venezuela", en: "Central Bank of Venezuela" },
	blackouts: { es: "Apagones de 2019", en: "2019 blackouts" },
	cantv: { es: "CANTV", en: "CANTV" },
};

export const ARTICLES: readonly Article[] = [
	{ project: "es.wikipedia", title: "Venezuela", topic: "venezuela" },
	{ project: "en.wikipedia", title: "Venezuela", topic: "venezuela" },
	{ project: "pt.wikipedia", title: "Venezuela", topic: "venezuela" },
	{ project: "es.wikipedia", title: "Caracas", topic: "caracas" },
	{ project: "en.wikipedia", title: "Caracas", topic: "caracas" },
	{ project: "pt.wikipedia", title: "Caracas", topic: "caracas" },
	{ project: "es.wikipedia", title: "Presidente_de_Venezuela", topic: "presidency" },
	{ project: "en.wikipedia", title: "President_of_Venezuela", topic: "presidency" },
	{ project: "pt.wikipedia", title: "Presidente_da_Venezuela", topic: "presidency" },
	{ project: "es.wikipedia", title: "Crisis_en_Venezuela", topic: "crisis" },
	{ project: "en.wikipedia", title: "Crisis_in_Venezuela", topic: "crisis" },
	{ project: "pt.wikipedia", title: "Crise_na_Venezuela", topic: "crisis" },
	{ project: "es.wikipedia", title: "Petróleos_de_Venezuela", topic: "pdvsa" },
	{ project: "en.wikipedia", title: "PDVSA", topic: "pdvsa" },
	{ project: "en.wikipedia", title: "Venezuelan_bolívar", topic: "bolivar" },
	{ project: "es.wikipedia", title: "Bolívar_digital", topic: "bolivar" },
	{ project: "es.wikipedia", title: "Banco_Central_de_Venezuela", topic: "bcv" },
	{ project: "es.wikipedia", title: "Apagones_de_Venezuela_de_2019", topic: "blackouts" },
	{ project: "en.wikipedia", title: "2019_Venezuelan_blackouts", topic: "blackouts" },
	{ project: "es.wikipedia", title: "CANTV", topic: "cantv" },
	{ project: "en.wikipedia", title: "CANTV", topic: "cantv" },
];

/** Days requested per article: the panel needs 28 days of baseline plus the newest day; 60 leaves margin. */
export const DAYS = 60;
const API = "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article";

const ymd = (t: number) => new Date(t).toISOString().slice(0, 10).replaceAll("-", "");

export function pageviewsUrl(a: Article, now: number): string {
	const end = ymd(now);
	const start = ymd(now - DAYS * 86_400_000);
	return `${API}/${a.project}.org/all-access/user/${encodeURIComponent(a.title)}/daily/${start}/${end}`;
}

/** A page a person can open: the Pageviews Analysis tool for the article, last 60 days. */
export function toolUrl(a: Article): string {
	return `https://pageviews.wmcloud.org/?project=${a.project}.org&platform=all-access&agent=user&range=latest-60&pages=${encodeURIComponent(a.title)}`;
}

export function articleUrl(a: Article): string {
	return `https://${a.project}.org/wiki/${encodeURIComponent(a.title)}`;
}

export type PageviewsValue = {
	project: string;
	title: string;
	topic: string;
	/** UTC day, YYYY-MM-DD. */
	date: string;
	views: number;
	/** The API omitted the day and a later day exists: zero views, filled here. */
	filled: boolean;
};

const Item = z.object({
	project: z.string(),
	article: z.string(),
	granularity: z.literal("daily"),
	timestamp: z.string().regex(/^\d{10}$/),
	views: z.number().int().nonnegative(),
});
const Envelope = z.object({ items: z.array(z.unknown()) });

/** Which article a response is for, from its URL. */
function articleOf(url: string): Article | undefined {
	return ARTICLES.find((a) =>
		url.includes(`/${a.project}.org/all-access/user/${encodeURIComponent(a.title)}/`),
	);
}

function startOf(url: string): string | null {
	const m = /\/daily\/(\d{8})\/(\d{8})$/.exec(url);
	return m?.[1] ? `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}` : null;
}

export const wikiAttention: Adapter<PageviewsValue> = {
	id: "wiki-attention",
	layer: "society",
	name: {
		es: "Atención internacional: lecturas de Wikipedia sobre Venezuela",
		en: "International attention: Wikipedia reads about Venezuela",
	},
	provider: "Wikimedia",
	homepage: "https://pageviews.wmcloud.org/",
	licence: WIKIMEDIA_LICENCE,
	keys: [],
	// The API publishes each day once, a few hours after midnight UTC: every 3 h picks it up soon enough.
	intervalMs: 3 * 3_600_000,
	// Stale if the newest day is 3 days old (normal: 1 day, plus processing delay), or no fetch for 12 h.
	freshness: { fetchMs: 12 * 3_600_000, dataMs: 3 * 86_400_000 },

	async fetch(ctx) {
		const out: RawResponse[] = [];
		for (const a of ARTICLES) {
			out.push(
				await ctx.http.request(pageviewsUrl(a, ctx.now()), {
					headers: { accept: "application/json" },
					// Wikimedia allows far more; one request every 0.5 s is 21 requests in ~10 s.
					hostGapMs: 500,
					timeoutMs: 20_000,
					maxBytes: 512 * 1024,
					// 404: no views at all in the range (or a renamed title): kept as "no data".
					okStatuses: [404],
					signal: ctx.signal,
				}),
			);
		}
		return out;
	},

	normalise(raws) {
		type Parsed = { a: Article; raw: RawResponse; days: Map<string, number>; start: string };
		const parsed: Parsed[] = [];
		let invalid = 0;
		for (const raw of raws) {
			const a = articleOf(raw.url);
			const start = startOf(raw.url);
			if (!a || !start) {
				invalid++;
				continue;
			}
			// 404: the API has nothing for this article in the range (no views, or a renamed title). That is "no
			// data", never zeros: 60 stored zeros would overwrite the real history (review 3 M7).
			if (raw.status === 404) continue;
			let body: unknown;
			try {
				body = JSON.parse(raw.body);
			} catch {
				invalid++;
				continue;
			}
			const env = Envelope.safeParse(body);
			if (!env.success) {
				invalid++;
				continue;
			}
			const days = new Map<string, number>();
			for (const item of env.data.items) {
				const r = Item.safeParse(item);
				if (!r.success) continue;
				const t = r.data.timestamp;
				days.set(`${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`, r.data.views);
			}
			parsed.push({ a, raw, days, start });
		}
		const notFound = raws.filter((r) => r.status === 404).length;
		if (raws.length > notFound && parsed.length === 0) {
			throw new SchemaError(`Wikimedia: none of ${raws.length} responses readable`);
		}
		if (invalid * 2 > raws.length)
			throw new SchemaError(`Wikimedia: ${invalid} of ${raws.length} unreadable`);
		// The newest day the API has published in this run, across all articles.
		let newest = "";
		for (const p of parsed) for (const d of p.days.keys()) if (d > newest) newest = d;
		if (!newest) return [];
		const out: Observation<PageviewsValue>[] = [];
		for (const { a, raw, days } of parsed) {
			// Zeros are filled only between two days this response reported (the API omits zero-view days); before
			// the first and after the last it reported, nothing is claimed.
			const reported = [...days.keys()].sort();
			const first = reported[0];
			const last = reported.at(-1);
			if (first === undefined || last === undefined) continue;
			for (let t = Date.parse(`${first}T00:00:00Z`); ; t += 86_400_000) {
				const date = new Date(t).toISOString().slice(0, 10);
				if (date > last) break;
				const views = days.get(date);
				out.push({
					source: "wiki-attention",
					series: `pv:${a.project}:${a.title}`,
					sourceUrl: toolUrl(a),
					fetchedAt: raw.fetchedAt,
					// A day's total is complete (true) at the end of that UTC day.
					observedAt: Math.min(t + 86_400_000, raw.fetchedAt),
					licence: WIKIMEDIA_LICENCE.id,
					value: {
						project: a.project,
						title: a.title,
						topic: a.topic,
						date,
						views: views ?? 0,
						filled: views === undefined,
					},
					confidence: 1,
					basis: "measurement",
				});
			}
		}
		return out;
	},
};
