/**
 * One adapter per outlet feed (RSS 2.0, Atom, YouTube channel Atom). Each outlet gets its own health on the
 * status page, its own pace, and a failure in one never affects another.
 *
 * Stored per item: title, link, a short plain-text summary, published time, optional image URL. Never the full
 * article (headline + link, the way feed readers work). Tagging, topics and clustering happen in the news panel,
 * so improving the rules re-tags history without refetching.
 */
import { XMLParser } from "fast-xml-parser";
import type { Adapter, Licence, Observation } from "../../core/types.ts";
import { HttpError, SchemaError } from "../../core/types.ts";
import { publisherOf } from "../../news/publishers.ts";
import { stripHtml } from "../../news/text.ts";

export type Stance =
	| "independent"
	| "commercial"
	| "state"
	| "state-aligned"
	| "public-broadcaster"
	| "ngo"
	| "partisan"
	| "agency"
	| "state-funded"
	| "aggregator"
	| "multilateral"
	| "trade-body"
	/** A feed the user added by hand ("Mis fuentes"), labelled "añadida por ti". */
	| "user";

/**
 * One neutral label per stance, shown next to every outlet name (the web client keeps the same words). "state" is
 * owned or run by a government; "state-aligned" is not state-owned but openly supports the government; "state-funded"
 * is a foreign state's outlet; "trade-body" is a business chamber or professional association; "public-broadcaster" is public media with editorial independence by statute.
 */
export const STANCE_LABELS: Readonly<Record<Stance, { es: string; en: string }>> = {
	independent: { es: "independiente", en: "independent" },
	commercial: { es: "privado", en: "private" },
	state: { es: "estatal", en: "state" },
	"state-aligned": { es: "afín al gobierno", en: "government-aligned" },
	"state-funded": { es: "financiado por un Estado", en: "state-funded" },
	"public-broadcaster": { es: "servicio público", en: "public broadcaster" },
	ngo: { es: "ONG", en: "NGO" },
	partisan: { es: "partidista", en: "partisan" },
	agency: { es: "agencia", en: "agency" },
	aggregator: { es: "agregador", en: "aggregator" },
	multilateral: { es: "organismo multilateral", en: "multilateral body" },
	"trade-body": { es: "gremio", en: "trade or professional body" },
	user: { es: "añadida por ti", en: "added by you" },
};

/**
 * What kind of publisher this is, beside its stance. "news" (default): a newsroom. "fact-check": a verification
 * desk. "official": a government body's own press site (not a newsroom; its items are statements). "rights": a
 * civil-society monitor's reports.
 */
export type Genre = "news" | "fact-check" | "official" | "rights";

export type Lang = "es" | "en" | "pt";

export interface OutletSpec {
	readonly id: string;
	readonly name: string;
	readonly url: string;
	readonly kind: "rss" | "atom" | "youtube";
	/** "national", an ISO state code for regional outlets, or "international". */
	readonly region: string;
	readonly stance: Stance;
	readonly homepage: string;
	/** International desks: keep only items that mention Venezuela. */
	readonly onlyVenezuela?: boolean;
	/** Poll interval; defaults by volume (see OUTLETS). */
	readonly intervalMs?: number;
	/** Language of the feed's items (ISO 639-1; also read by the sources atlas). Default "es". */
	readonly lang?: Lang;
	/** Default "news". */
	readonly genre?: Genre;
	/**
	 * Id of the outlet entry this feed belongs to when one publisher has several feeds (a section feed, its YouTube
	 * channel). Counts and "distinct outlets" use the publisher, never the feed. Default: this entry's own id.
	 */
	readonly publisher?: string;
	/** Off unless the user turns it on, with the reason (e.g. the host's robots.txt excludes automated readers). */
	readonly optIn?: { readonly es: string; readonly en: string };
	/** Sources atlas: ISO 3166-1 country of the publisher, when region and TLD do not say. */
	readonly country?: string;
}

export type NewsItem = {
	readonly outlet: string;
	readonly title: string;
	readonly link: string;
	readonly summary: string;
	readonly image: string | null;
	/** The feed gave no usable date: observedAt is our fetch time. */
	readonly dateMissing: boolean;
	readonly video: boolean;
};

export const HEADLINE_LICENCE: Licence = {
	id: "headline-link",
	name: "Titular y enlace (uso de lector de noticias)",
	url: "https://www.rssboard.org/rss-specification",
	attribution: "Titulares y enlaces de cada medio; el contenido pertenece a su medio.",
	commercial: "unclear",
	// Display-only (title and link shown with the outlet's name): the raw endpoints never hand out the stored item
	// (summary, image), just as evidence bundles withhold its value.
	raw: false,
};

const parser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "@",
	textNodeName: "#text",
	processEntities: true,
	htmlEntities: true,
	trimValues: true,
	// Feeds are small; still cap nesting and entity expansion defensively.
	isArray: (name) => name === "item" || name === "entry" || name === "link" || name === "media:content",
});

/**
 * Feeds a user added by hand (src/userfeeds) are untrusted XML: the same parsing, with the entity-expansion limits
 * pinned here instead of left to the library's defaults, so an upgrade cannot loosen them. Built-in outlets keep
 * the parser above unchanged.
 */
const untrustedParser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "@",
	textNodeName: "#text",
	processEntities: {
		enabled: true,
		maxEntitySize: 10_000,
		maxExpansionDepth: 10,
		maxTotalExpansions: 1_000,
		maxExpandedLength: 100_000,
		maxEntityCount: 100,
	},
	htmlEntities: true,
	trimValues: true,
	isArray: (name) => name === "item" || name === "entry" || name === "link" || name === "media:content",
});

function text(node: unknown): string {
	if (node === undefined || node === null) return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (typeof node === "object" && "#text" in node)
		return String((node as { "#text": unknown })["#text"] ?? "");
	return "";
}

function atomLink(links: unknown): string {
	const list = Array.isArray(links) ? links : [links];
	for (const l of list) {
		if (typeof l === "string") return l;
		if (l && typeof l === "object") {
			const rel = (l as Record<string, unknown>)["@rel"];
			const href = (l as Record<string, unknown>)["@href"];
			if (typeof href === "string" && (rel === undefined || rel === "alternate")) return href;
		}
	}
	return "";
}

function imageOf(item: Record<string, unknown>): string | null {
	const enclosure = item.enclosure as Record<string, unknown> | undefined;
	if (
		enclosure &&
		typeof enclosure["@url"] === "string" &&
		String(enclosure["@type"] ?? "").startsWith("image/")
	) {
		return enclosure["@url"];
	}
	const media = item["media:content"] as Record<string, unknown>[] | undefined;
	const m = media?.find((x) => typeof x["@url"] === "string" && x["@medium"] !== "video");
	if (m) return String(m["@url"]);
	const group = item["media:group"] as Record<string, unknown> | undefined;
	const thumb = (group?.["media:thumbnail"] ?? item["media:thumbnail"]) as
		| Record<string, unknown>
		| undefined;
	if (thumb && typeof thumb["@url"] === "string") return thumb["@url"];
	return null;
}

function parseDate(raw: string): number | null {
	if (!raw) return null;
	const t = Date.parse(raw);
	return Number.isFinite(t) ? t : null;
}

/** Stable id for an item: its link without tracking parameters, hashed. */
export function itemId(link: string): string {
	let clean = link.trim();
	try {
		const u = new URL(clean);
		for (const p of [...u.searchParams.keys()])
			if (/^(utm_|at_|fbclid|gclid|ref$)/.test(p)) u.searchParams.delete(p);
		u.hash = "";
		clean = u.toString();
	} catch {
		// Not a URL: hash as is.
	}
	return Bun.hash(clean).toString(36);
}

const VENEZUELA = /venezuel|caracas|maracaibo|\bpdvsa\b|chavis|\bdelcy\b|esequib|essequib/i;
/** Capitalised only: "maduro" is also an adjective (ripe, mature). */
const VENEZUELA_CASED = /\bMaduro\b/;

/** International desks keep an item only if it is about Venezuela (names, places, PDVSA, the Essequibo dispute). */
export function mentionsVenezuela(text: string): boolean {
	return VENEZUELA.test(text) || VENEZUELA_CASED.test(text);
}
const FUTURE_TOLERANCE_MS = 15 * 60_000;

export function parseFeed(
	body: string,
	outlet: OutletSpec,
	fetchedAt: number,
	options: { untrusted?: boolean } = {},
): Observation<NewsItem>[] {
	let doc: Record<string, unknown>;
	try {
		doc = (options.untrusted ? untrustedParser : parser).parse(body) as Record<string, unknown>;
	} catch (e) {
		throw new SchemaError(`XML no válido: ${e instanceof Error ? e.message : e}`);
	}
	const rss = doc.rss as { channel?: { item?: Record<string, unknown>[] } } | undefined;
	const feed = doc.feed as { entry?: Record<string, unknown>[] } | undefined;
	const rdf = doc["rdf:RDF"] as { item?: Record<string, unknown>[] } | undefined;
	const raw = rss?.channel?.item ?? feed?.entry ?? rdf?.item;
	if (!rss && !feed && !rdf) throw new SchemaError("no es RSS ni Atom");
	const out: Observation<NewsItem>[] = [];
	for (const item of raw ?? []) {
		const title = stripHtml(text(item.title));
		const link = (
			feed ? atomLink(item.link) : text(Array.isArray(item.link) ? item.link[0] : item.link)
		).trim();
		if (!title || !/^https?:\/\//.test(link)) continue;
		const summaryRaw =
			text(item.description) ||
			text(item.summary) ||
			text((item["media:group"] as Record<string, unknown> | undefined)?.["media:description"]) ||
			text(item["content:encoded"]);
		const summary = stripHtml(summaryRaw).slice(0, 400);
		if (outlet.onlyVenezuela && !mentionsVenezuela(`${title} ${summary}`)) continue;
		const published = parseDate(
			text(item.pubDate) || text(item.published) || text(item.updated) || text(item["dc:date"]),
		);
		const dateMissing = published === null || published > fetchedAt + FUTURE_TOLERANCE_MS;
		out.push({
			source: outlet.id,
			series: `item:${itemId(link)}`,
			sourceUrl: link,
			fetchedAt,
			observedAt: dateMissing ? fetchedAt : (published as number),
			licence: HEADLINE_LICENCE.id,
			value: {
				outlet: outlet.id,
				title,
				link,
				summary,
				image: imageOf(item),
				dateMissing,
				video: outlet.kind === "youtube",
			},
			confidence: dateMissing ? 0.6 : 1,
			basis: "report",
			...(dateMissing ? { keepFirst: true as const } : {}),
		});
	}
	return out;
}

/** Newest-item budget by polling class: busy feeds should have something within a day; small ones within weeks. */
function dataBudget(intervalMs: number | undefined): number {
	const day = 86_400_000;
	if (!intervalMs || intervalMs <= 10 * 60_000) return day;
	if (intervalMs <= 20 * 60_000) return 3 * day;
	return 14 * day;
}

/**
 * Validators of the last feed that parsed, per adapter. Sent back as If-None-Match / If-Modified-Since so an unchanged
 * feed costs a 304 with no body (measured: most WordPress feeds support it). Only a body that parses is remembered: a
 * broken feed must be fetched in full next time, not answered with 304 forever.
 */
type Validators = { etag?: string; lastModified?: string };

export function conditionalHeaders(v: Validators | null): Record<string, string> {
	if (!v) return {};
	return {
		...(v.etag ? { "if-none-match": v.etag } : {}),
		...(v.lastModified ? { "if-modified-since": v.lastModified } : {}),
	};
}

export function rssAdapter(outlet: OutletSpec): Adapter<NewsItem> {
	let validators: Validators | null = null;
	return {
		id: outlet.id,
		layer: "news",
		name: { es: outlet.name, en: outlet.name },
		// The publisher, so the sources page groups an outlet's feeds (its YouTube channel, a section) under one name.
		provider: publisherOf(outlet.id).name,
		homepage: outlet.homepage,
		licence: HEADLINE_LICENCE,
		keys: [],
		...(outlet.optIn ? { optIn: outlet.optIn } : {}),
		intervalMs: outlet.intervalMs ?? 15 * 60_000,
		// A feed that answers 200 but whose newest item is old has stopped publishing (measured: several do).
		freshness: { fetchMs: 4 * (outlet.intervalMs ?? 15 * 60_000), dataMs: dataBudget(outlet.intervalMs) },
		async fetch(ctx) {
			const raw = await ctx.http.request(outlet.url, {
				headers: {
					accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5",
					...conditionalHeaders(validators),
				},
				maxBytes: 5 * 1024 * 1024,
				hostGapMs: 2_000,
				okStatuses: validators ? [304] : [],
				signal: ctx.signal,
			});
			if (raw.status === 304 && validators) return [raw];
			// Captcha walls answer 202 (SiteGround) or 200 with an HTML challenge instead of XML.
			if (raw.status !== 200)
				throw new HttpError(`respuesta ${raw.status}: probable muro anti-bots`, raw.status, outlet.url);
			if (/^\s*<!doctype html|^\s*<html/i.test(raw.body)) {
				throw new SchemaError("la fuente devolvió una página HTML (muro anti-bots o feed movido)");
			}
			validators = null;
			if (raw.etag || raw.lastModified) {
				try {
					parseFeed(raw.body, outlet, raw.fetchedAt);
					validators = {
						...(raw.etag ? { etag: raw.etag } : {}),
						...(raw.lastModified ? { lastModified: raw.lastModified } : {}),
					};
				} catch {
					// normalise reports the error; nothing is remembered.
				}
			}
			return [raw];
		},
		normalise(raws) {
			const raw = raws[0];
			if (!raw) throw new SchemaError("sin respuesta");
			// Not modified since the last feed that parsed: nothing new, and the run is a success.
			if (raw.status === 304) return [];
			return parseFeed(raw.body, outlet, raw.fetchedAt);
		},
	};
}
