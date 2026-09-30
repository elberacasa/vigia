import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import type { Adapter, Licence, Observation, RawResponse } from "../../core/types.ts";
import { MissingKeyError, SchemaError } from "../../core/types.ts";
import { itemId } from "../rss/factory.ts";

/**
 * ReliefWeb (OCHA): the humanitarian community's reports on Venezuela, and the disasters it tracks there.
 *
 * **Route: the API with an approved appname (since 2026-09-29).** Until then Vigía read two public RSS feeds. From
 * this machine reliefweb.int now answers every request, robots.txt included, with HTTP 444 and "The humanitarian
 * website that you requested is not available for scraping. If you feel you have a legitimate need to scrape this
 * site please get in touch" (AWS load balancer; the feed had worked 22 % of runs since 2026-09-25, at 2 requests every
 * 2 h with the project User-Agent). The operator blocks us, and when a source blocks us Vigía stops: it no longer
 * reads the site and uses the route ReliefWeb offers for software: api.reliefweb.int/v2, which since 1 November 2025 requires an appname
 * that ReliefWeb approves on request (a short form; api.reliefweb.int answers 403 "not using an approved appname"
 * without one, measured the same day). The appname is a key in the setup guide; without it the feed is locked.
 *
 * Two API requests per run:
 * - reports whose primary country is Venezuela (`primary_country.iso3 = ven`), 20 newest by creation date: title,
 *   the publishing organisations, the date, the report's page;
 * - disasters affecting Venezuela (`country.iso3 = ven`), 20 newest: name, GLIDE number, the event's date and the
 *   disaster's page ("Venezuela: Earthquakes - Jun 2026", 24 June 2026).
 *
 * Only titles, organisations, dates and links are kept: the reports belong to their publishers ("respect the
 * intellectual property rights of the original source"), so Vigía shows the headline and links to it, and the raw
 * endpoints never hand the rows out. `normalise` still reads the RSS bodies recorded before the move.
 */

export const RELIEFWEB_LICENCE: Licence = {
	id: "reliefweb-headlines",
	name: "Titulares y enlaces de ReliefWeb (el contenido es de cada organización)",
	url: "https://reliefweb.int/terms-conditions",
	attribution: "Fuente: ReliefWeb (OCHA); cada informe es de la organización que lo publica",
	commercial: "unclear",
	raw: false,
};

/** The RSS feeds read until 2026-09-29 (now refused with 444); kept so recorded bodies still parse. */
export const RW_UPDATES = "https://reliefweb.int/updates/rss.xml?advanced-search=%28PC250%29";
export const RW_DISASTERS = "https://reliefweb.int/disasters/rss.xml?advanced-search=%28C250%29";
export const RW_COUNTRY = "https://reliefweb.int/country/ven";

export const RELIEFWEB_KEY_ID = "reliefweb-appname";
export const RW_API = "https://api.reliefweb.int/v2";

/** The two API queries, without the appname (added in fetch, never stored in a sourceUrl). */
export function apiQuery(kind: "reports" | "disasters"): string {
	const p = new URLSearchParams();
	if (kind === "reports") {
		p.set("filter[field]", "primary_country.iso3");
		p.set("filter[value]", "ven");
		for (const f of ["title", "url", "url_alias", "source.name", "date.created"])
			p.append("fields[include][]", f);
	} else {
		p.set("filter[field]", "country.iso3");
		p.set("filter[value]", "ven");
		for (const f of ["name", "url", "url_alias", "glide", "date.event", "date.created"])
			p.append("fields[include][]", f);
	}
	p.append("sort[]", "date.created:desc");
	p.set("limit", "20");
	return `${RW_API}/${kind}?${p.toString()}`;
}

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

const ApiEnvelope = z.object({
	data: z.array(
		z.object({ id: z.union([z.number(), z.string()]), fields: z.record(z.string(), z.unknown()) }),
	),
});

const ApiItem = z.object({
	title: z.string().optional(),
	name: z.string().optional(),
	url: z.string().optional(),
	url_alias: z.string().optional(),
	glide: z.string().optional(),
	source: z.array(z.object({ name: z.string() })).optional(),
	date: z.object({ created: z.string().optional(), event: z.string().optional() }).optional(),
});

/** One API answer (`/v2/reports` or `/v2/disasters`), the same values the RSS gave. */
export function parseApi(raw: RawResponse, kind: ReliefItem["kind"]): Observation<ReliefItem>[] {
	let json: unknown;
	try {
		json = JSON.parse(raw.body);
	} catch {
		throw new SchemaError("ReliefWeb: la API no devolvió JSON");
	}
	const envelope = ApiEnvelope.safeParse(json);
	if (!envelope.success) throw new SchemaError("ReliefWeb: respuesta de la API sin 'data'");
	const out: Observation<ReliefItem>[] = [];
	for (const row of envelope.data.data) {
		const it = ApiItem.safeParse(row.fields);
		if (!it.success) continue;
		const f = it.data;
		const title = (kind === "report" ? f.title : f.name)?.replace(/\s+/g, " ").trim() ?? "";
		const url = reliefwebUrl(f.url_alias ?? f.url ?? "");
		// A disaster is dated by the event (as the RSS did); a report by its publication on ReliefWeb.
		const at = Date.parse((kind === "disaster" ? (f.date?.event ?? f.date?.created) : f.date?.created) ?? "");
		if (!title || !url || !Number.isFinite(at)) continue;
		if (at - raw.fetchedAt > 10 * 60_000) continue;
		const glide =
			kind === "disaster" && f.glide && /^[A-Z]{2}-\d{4}-\d{6}-[A-Z]{3}$/.test(f.glide) ? f.glide : null;
		out.push({
			source: "reliefweb-ve",
			series: `${kind}:${itemId(url)}`,
			sourceUrl: url,
			fetchedAt: raw.fetchedAt,
			observedAt: Math.min(at, raw.fetchedAt),
			licence: RELIEFWEB_LICENCE.id,
			value: {
				kind,
				title: title.slice(0, 300),
				url,
				orgs: (f.source ?? [])
					.map((o) => o.name.trim())
					.filter(Boolean)
					.slice(0, 5),
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
	keys: [RELIEFWEB_KEY_ID],
	// A handful of reports a day at most; every 2 hours keeps up without load (two requests, ~220 KB).
	intervalMs: 2 * 3_600_000,
	// An event feed: a quiet week is not staleness, so no data budget; the fetch must succeed at least daily.
	freshness: { fetchMs: 24 * 3_600_000, dataMs: null },

	async fetch(ctx) {
		const appname = ctx.key(RELIEFWEB_KEY_ID);
		if (!appname) throw new MissingKeyError(RELIEFWEB_KEY_ID);
		const opts = {
			headers: { accept: "application/json" },
			hostGapMs: 3_000,
			maxBytes: 3 * 1024 * 1024,
			signal: ctx.signal,
		};
		const withApp = (url: string) => `${url}&appname=${encodeURIComponent(appname)}`;
		const reports = await ctx.http.request(withApp(apiQuery("reports")), opts);
		const disasters = await ctx.http.request(withApp(apiQuery("disasters")), opts);
		// The appname stays out of what is stored: the recorded URL is the query without it.
		return [
			{ ...reports, url: apiQuery("reports") },
			{ ...disasters, url: apiQuery("disasters") },
		];
	},

	normalise(raws) {
		const out: Observation<ReliefItem>[] = [];
		for (const raw of raws) {
			if (raw.url.startsWith(`${RW_API}/reports`)) out.push(...parseApi(raw, "report"));
			else if (raw.url.startsWith(`${RW_API}/disasters`)) out.push(...parseApi(raw, "disaster"));
			else if (raw.url.includes("/updates/")) out.push(...parseRelief(raw, "report"));
			else if (raw.url.includes("/disasters/")) out.push(...parseRelief(raw, "disaster"));
		}
		return out;
	},
};
