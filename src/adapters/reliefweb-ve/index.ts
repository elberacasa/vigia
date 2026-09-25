import { XMLParser } from "fast-xml-parser";
import type { Adapter, Licence, Observation, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { itemId } from "../rss/factory.ts";

/**
 * ReliefWeb (OCHA): the humanitarian community's reports on Venezuela, and the disasters it tracks there. Two
 * public RSS feeds per run, keyless (verified 2026-09-24):
 *
 * - updates whose primary country is Venezuela, `(PC250)`: 20 newest reports, 163 KB, 0.6 s. Each has a title,
 *   the publishing organisation(s) in `<author>`, and its date;
 * - disasters affecting Venezuela, `(C250)`: 20 newest, with ReliefWeb's disaster page and GLIDE number; the date
 *   is the event's start ("Venezuela: Earthquakes - Jun 2026", 24 June 2026).
 *
 * The JSON API (api.reliefweb.int/v2) now answers 403 "not using an approved appname" without an appname that
 * ReliefWeb approved on request; the RSS feeds need none. Only titles, organisations, dates and links are kept:
 * the reports belong to their publishers ("respect the intellectual property rights of the original source"), so
 * Vigía shows the headline and links to it, and the raw endpoints never hand the rows out.
 */

export const RELIEFWEB_LICENCE: Licence = {
	id: "reliefweb-headlines",
	name: "Titulares y enlaces de ReliefWeb (el contenido es de cada organización)",
	url: "https://reliefweb.int/terms-conditions",
	attribution: "Fuente: ReliefWeb (OCHA); cada informe es de la organización que lo publica",
	commercial: "unclear",
	raw: false,
};

export const RW_UPDATES = "https://reliefweb.int/updates/rss.xml?advanced-search=%28PC250%29";
export const RW_DISASTERS = "https://reliefweb.int/disasters/rss.xml?advanced-search=%28C250%29";
export const RW_COUNTRY = "https://reliefweb.int/country/ven";

export type ReliefItem = {
	readonly kind: "report" | "disaster";
	readonly title: string;
	readonly url: string;
	/** Publishing organisations (reports). */
	readonly orgs: string[];
	/** GLIDE number (disasters), e.g. "EQ-2026-000093-VEN". */
	readonly glide: string | null;
};

const parser = new XMLParser({
	ignoreAttributes: true,
	processEntities: true,
	htmlEntities: true,
	trimValues: true,
	isArray: (name) => name === "item" || name === "author" || name === "category",
});

const str = (v: unknown): string => (typeof v === "string" || typeof v === "number" ? String(v).trim() : "");

/** ReliefWeb's own pages only: an item link elsewhere is not shown. */
function reliefwebUrl(link: string): string | null {
	try {
		const u = new URL(link);
		return u.protocol === "https:" && u.hostname === "reliefweb.int" ? u.toString() : null;
	} catch {
		return null;
	}
}

export function parseRelief(raw: RawResponse, kind: ReliefItem["kind"]): Observation<ReliefItem>[] {
	let doc: unknown;
	try {
		doc = parser.parse(raw.body);
	} catch {
		throw new SchemaError("ReliefWeb: el RSS no es XML");
	}
	const channel = (doc as { rss?: { channel?: { item?: unknown } } })?.rss?.channel;
	if (!channel) throw new SchemaError("ReliefWeb: sin <rss><channel>");
	const items = Array.isArray(channel.item) ? channel.item : [];
	const out: Observation<ReliefItem>[] = [];
	for (const it of items as Record<string, unknown>[]) {
		const title = str(it.title).replace(/\s+/g, " ");
		const url = reliefwebUrl(str(it.link));
		const at = Date.parse(str(it.pubDate));
		if (!title || !url || !Number.isFinite(at)) continue;
		const observedAt = Math.min(at, raw.fetchedAt);
		if (at - raw.fetchedAt > 10 * 60_000) continue;
		const categories = ((it.category as unknown[]) ?? []).map(str);
		const glide =
			kind === "disaster"
				? (categories.find((c) => /^[A-Z]{2}-\d{4}-\d{6}-[A-Z]{3}$/.test(c)) ?? null)
				: null;
		out.push({
			source: "reliefweb-ve",
			series: `${kind}:${itemId(url)}`,
			sourceUrl: url,
			fetchedAt: raw.fetchedAt,
			observedAt,
			licence: RELIEFWEB_LICENCE.id,
			value: {
				kind,
				title: title.slice(0, 300),
				url,
				orgs: ((it.author as unknown[]) ?? []).map(str).filter(Boolean).slice(0, 5),
				glide,
			},
			confidence: 1,
			basis: "report",
		});
	}
	return out;
}

export const reliefwebVe: Adapter<ReliefItem> = {
	id: "reliefweb-ve",
	layer: "society",
	name: {
		es: "ReliefWeb: informes y desastres en Venezuela",
		en: "ReliefWeb: reports and disasters in Venezuela",
	},
	provider: "ReliefWeb (OCHA)",
	homepage: RW_COUNTRY,
	licence: RELIEFWEB_LICENCE,
	keys: [],
	// A handful of reports a day at most; every 2 hours keeps up without load (two requests, ~220 KB).
	intervalMs: 2 * 3_600_000,
	// An event feed: a quiet week is not staleness, so no data budget; the fetch must succeed at least daily.
	freshness: { fetchMs: 24 * 3_600_000, dataMs: null },

	async fetch(ctx) {
		const opts = {
			headers: { accept: "application/rss+xml, application/xml" },
			hostGapMs: 3_000,
			maxBytes: 3 * 1024 * 1024,
			signal: ctx.signal,
		};
		return [await ctx.http.request(RW_UPDATES, opts), await ctx.http.request(RW_DISASTERS, opts)];
	},

	normalise(raws) {
		const out: Observation<ReliefItem>[] = [];
		for (const raw of raws) {
			if (raw.url.includes("/updates/")) out.push(...parseRelief(raw, "report"));
			else if (raw.url.includes("/disasters/")) out.push(...parseRelief(raw, "disaster"));
		}
		return out;
	},
};
