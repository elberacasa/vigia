/**
 * The sources atlas: what each feed is, beyond how it is fetched. Category, kind, where its publisher is, language,
 * who publishes it, when it joined Vigía, and which panels it feeds. Served in /api/meta so the Sources page lists
 * every feed (hundreds of outlets included) with no client-side table to keep in sync.
 *
 * Adapters are described by the table below; outlets by their OutletSpec (region, kind) plus a few overrides.
 * A feed nobody described still gets a truthful entry from its layer, never a guess dressed up as a fact:
 * unknown country is "INT" and unknown language is null.
 */

import type { OutletSpec } from "../adapters/rss/factory.ts";
import { OUTLETS } from "../adapters/rss/outlets.ts";
import type { Adapter } from "../core/types.ts";
import { ADDED } from "./added.gen.ts";

/** Category ids; the client holds their labels. The first of a feed's categories is its primary one. */
export type Category =
	| "money"
	| "markets"
	| "energy"
	| "internet"
	| "censorship"
	| "earth"
	| "space"
	| "airspace"
	| "attention"
	| "news"
	| "social"
	| "society";

/** How the data reaches us. */
export type Kind = "api" | "web" | "feed" | "video" | "satellite" | "sensor" | "network";

export interface AtlasEntry {
	readonly category: readonly string[];
	readonly kind: Kind;
	/** "VE" national, an ISO 3166-2 state code ("VE-V"), "diaspora", or "intl". */
	readonly region: string;
	/** ISO 3166-1 alpha-2 of the publisher's base, "EU" for EU bodies, "INT" when there is no single one. */
	readonly country: string;
	/** ISO 639-1 of the content; null when the feed carries no text or it is not known. */
	readonly lang: string | null;
	/** Stable key of the publishing organisation, for counting distinct publishers. */
	readonly publisher: string;
	/** When the feed joined Vigía (ISO, UTC minute). Null: not dated yet (see `added` in /api/meta). */
	readonly added: string | null;
	/** Outlets only: the descriptive stance shown next to the outlet's name. */
	readonly stance?: string;
}

type Described = Omit<AtlasEntry, "added" | "stance">;

/** Hand-described adapters. `publisher` groups feeds of one organisation (three IODA feeds are one publisher). */
const ADAPTER_ATLAS: Readonly<Record<string, Described>> = {
	"bcv-official": {
		category: ["money"],
		kind: "web",
		region: "VE",
		country: "VE",
		lang: "es",
		publisher: "bcv",
	},
	"bcv-api": {
		category: ["money"],
		kind: "api",
		region: "VE",
		country: "VE",
		lang: null,
		publisher: "bcv",
	},
	"bcv-history": {
		category: ["money"],
		kind: "web",
		region: "VE",
		country: "VE",
		lang: "es",
		publisher: "bcv",
	},
	"bcv-inpc": { category: ["money"], kind: "web", region: "VE", country: "VE", lang: "es", publisher: "bcv" },
	yadio: {
		category: ["money", "markets"],
		kind: "api",
		region: "intl",
		country: "INT",
		lang: null,
		publisher: "yadio",
	},
	"binance-p2p": {
		category: ["money", "markets"],
		kind: "api",
		region: "intl",
		country: "INT",
		lang: null,
		publisher: "binance",
	},
	"bybit-p2p": {
		category: ["money", "markets"],
		kind: "api",
		region: "intl",
		country: "INT",
		lang: null,
		publisher: "bybit",
	},
	"fred-oil": {
		category: ["energy", "markets"],
		kind: "api",
		region: "intl",
		country: "US",
		lang: null,
		publisher: "fred",
	},
	"firms-flares": {
		category: ["energy", "space"],
		kind: "satellite",
		region: "intl",
		country: "US",
		lang: null,
		publisher: "nasa",
	},
	"ioda-states": {
		category: ["internet"],
		kind: "network",
		region: "intl",
		country: "US",
		lang: null,
		publisher: "ioda",
	},
	"ioda-asn": {
		category: ["internet"],
		kind: "network",
		region: "intl",
		country: "US",
		lang: null,
		publisher: "ioda",
	},
	"ioda-events": {
		category: ["internet"],
		kind: "network",
		region: "intl",
		country: "US",
		lang: null,
		publisher: "ioda",
	},
	"ripe-atlas-probes": {
		category: ["internet"],
		kind: "network",
		region: "intl",
		country: "NL",
		lang: null,
		publisher: "ripe-ncc",
	},
	"ripestat-routing": {
		category: ["internet"],
		kind: "network",
		region: "intl",
		country: "NL",
		lang: null,
		publisher: "ripe-ncc",
	},
	"ripestat-prefixes": {
		category: ["internet"],
		kind: "network",
		region: "intl",
		country: "NL",
		lang: null,
		publisher: "ripe-ncc",
	},
	"gibs-nightlights": {
		category: ["space", "energy"],
		kind: "satellite",
		region: "intl",
		country: "US",
		lang: null,
		publisher: "nasa",
	},
	"ooni-ve": {
		category: ["censorship"],
		kind: "network",
		region: "intl",
		country: "IT",
		lang: null,
		publisher: "ooni",
	},
	"ooni-methods": {
		category: ["censorship"],
		kind: "network",
		region: "intl",
		country: "IT",
		lang: null,
		publisher: "ooni",
	},
	"vesinfiltro-blocks": {
		category: ["censorship"],
		kind: "network",
		region: "VE",
		country: "VE",
		lang: "es",
		publisher: "vesinfiltro",
	},
	"tor-metrics": {
		category: ["censorship", "internet"],
		kind: "network",
		region: "intl",
		country: "US",
		lang: null,
		publisher: "tor",
	},
	"portal-probe": {
		category: ["internet", "censorship"],
		kind: "network",
		region: "VE",
		country: "VE",
		lang: null,
		publisher: "vigia",
	},
	"usgs-quakes": {
		category: ["earth"],
		kind: "sensor",
		region: "intl",
		country: "US",
		lang: null,
		publisher: "usgs",
	},
	"funvisis-quakes": {
		category: ["earth"],
		kind: "sensor",
		region: "VE",
		country: "VE",
		lang: "es",
		publisher: "funvisis",
	},
	"goes-nsa": {
		category: ["space", "earth"],
		kind: "satellite",
		region: "intl",
		country: "US",
		lang: null,
		publisher: "noaa",
	},
	"open-meteo-weather": {
		category: ["earth"],
		kind: "api",
		region: "intl",
		country: "CH",
		lang: null,
		publisher: "open-meteo",
	},
	"firms-fires": {
		category: ["earth", "space"],
		kind: "satellite",
		region: "intl",
		country: "US",
		lang: null,
		publisher: "nasa",
	},
	"gdacs-events": {
		category: ["earth"],
		kind: "api",
		region: "intl",
		country: "EU",
		lang: "en",
		publisher: "gdacs",
	},
	"nhc-storms": {
		category: ["earth"],
		kind: "api",
		region: "intl",
		country: "US",
		lang: "en",
		publisher: "noaa",
	},
	"easa-czib": {
		category: ["airspace"],
		kind: "web",
		region: "intl",
		country: "EU",
		lang: "en",
		publisher: "easa",
	},
	"faa-prohibitions": {
		category: ["airspace"],
		kind: "web",
		region: "intl",
		country: "US",
		lang: "en",
		publisher: "faa",
	},
	"wiki-attention": {
		category: ["attention"],
		kind: "api",
		region: "intl",
		country: "US",
		lang: null,
		publisher: "wikimedia",
	},
	"dahiti-guri": {
		category: ["energy", "space"],
		kind: "satellite",
		region: "VE-F",
		country: "DE",
		lang: null,
		publisher: "dgfi-tum",
	},
	"gaceta-oficial": {
		category: ["society"],
		kind: "web",
		region: "VE",
		country: "VE",
		lang: "es",
		publisher: "imprenta-nacional",
	},
	"mpps-boletin": {
		category: ["society"],
		kind: "web",
		region: "VE",
		country: "VE",
		lang: "es",
		publisher: "mpps",
	},
	"who-gho": {
		category: ["society"],
		kind: "api",
		region: "intl",
		country: "INT",
		lang: null,
		publisher: "who",
	},
	"r4v-figures": {
		category: ["society"],
		kind: "web",
		region: "diaspora",
		country: "INT",
		lang: "es",
		publisher: "r4v",
	},
	"unhcr-population": {
		category: ["society"],
		kind: "api",
		region: "diaspora",
		country: "INT",
		lang: null,
		publisher: "unhcr",
	},
	"ocha-fts": {
		category: ["society"],
		kind: "api",
		region: "VE",
		country: "INT",
		lang: null,
		publisher: "ocha",
	},
	"reliefweb-ve": {
		category: ["society", "news"],
		kind: "feed",
		region: "VE",
		country: "INT",
		lang: "en",
		publisher: "ocha",
	},
};

/** Layer → category for adapters not in the table (a new feed still lands in the right group). */
const LAYER_CATEGORY: Readonly<Record<string, Category>> = {
	money: "money",
	oil: "energy",
	earth: "earth",
	internet: "internet",
	news: "news",
	social: "social",
	society: "society",
};

/** Outlet facts the spec does not carry: country and language where the TLD or region would mislead. */
const OUTLET_OVERRIDES: Readonly<Record<string, { country?: string; lang?: string }>> = {
	"caracas-chronicles": { country: "US", lang: "en" },
	"diario-las-americas": { country: "US" },
	"yt-vpitv": { country: "US" },
	"aljazeera-es": { country: "QA", lang: "en" },
	"bbc-mundo": { country: "GB", lang: "es" },
	"dw-es": { country: "DE", lang: "es" },
	"dw-es-top": { country: "DE", lang: "es" },
	"el-mundo-es": { country: "ES", lang: "es" },
	"elpais-america": { country: "ES", lang: "es" },
	"elpais-venezuela": { country: "ES", lang: "es" },
	"euronews-es": { country: "FR", lang: "es" },
	"france24-es": { country: "FR", lang: "es" },
	"france24-latam": { country: "FR", lang: "es" },
	"guardian-ve": { country: "GB", lang: "en" },
	"infobae-venezuela": { country: "AR", lang: "es" },
	"nyt-es": { country: "US", lang: "en" },
	"rfi-es": { country: "FR", lang: "es" },
	telesur: { country: "VE", lang: "es" },
	"yt-cnn-es": { country: "US", lang: "es" },
	"yt-ntn24": { country: "CO", lang: "es" },
	"el-tiempo-co": { country: "CO", lang: "es" },
};

/** Country-code TLDs we can read a publisher's country from (second-level forms like .com.ve included). */
const TLD_COUNTRY: Readonly<Record<string, string>> = {
	ve: "VE",
	es: "ES",
	co: "CO",
	ar: "AR",
	mx: "MX",
	cl: "CL",
	pe: "PE",
	ec: "EC",
	uy: "UY",
	br: "BR",
	pa: "PA",
	do: "DO",
	cu: "CU",
	fr: "FR",
	de: "DE",
	uk: "GB",
	it: "IT",
	nl: "NL",
	ch: "CH",
};

const SPANISH = new Set(["VE", "ES", "CO", "AR", "MX", "CL", "PE", "EC", "UY", "PA", "DO", "CU"]);

function host(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}

function tldCountry(url: string): string | undefined {
	const parts = host(url).split(".");
	return TLD_COUNTRY[parts.at(-1) ?? ""];
}

/**
 * One publisher per site: two feeds of elpais.com are one publisher. A YouTube channel has no site of its own, so its
 * name (without "(YouTube)") is its key, and it joins the site outlet of exactly that name when there is one.
 */
export function outletPublisher(outlet: OutletSpec, siteByName: ReadonlyMap<string, string>): string {
	const h = host(outlet.homepage);
	if (outlet.kind !== "youtube" && h !== "youtube.com") return h || outlet.id;
	const name = outlet.name
		.replace(/\s*\(youtube\)\s*$/i, "")
		.trim()
		.toLowerCase();
	return siteByName.get(name) ?? `yt:${name}`;
}

function outletEntry(
	outlet: OutletSpec,
	siteByName: ReadonlyMap<string, string>,
	byId: ReadonlyMap<string, OutletSpec> = new Map(),
): Described & { stance: string } {
	const o = {
		...OUTLET_OVERRIDES[outlet.id],
		...(outlet.lang ? { lang: outlet.lang } : {}),
		...(outlet.country ? { country: outlet.country } : {}),
	};
	const region =
		outlet.region === "national"
			? "VE"
			: outlet.region.startsWith("VE-")
				? outlet.region
				: outlet.region === "diaspora"
					? "diaspora"
					: "intl";
	const venezuelan = region === "VE" || region.startsWith("VE-");
	return {
		category: ["news"],
		kind: outlet.kind === "youtube" ? "video" : "feed",
		region,
		country: o.country ?? (venezuelan ? "VE" : (tldCountry(outlet.homepage) ?? "INT")),
		// Venezuelan, diaspora and Spanish-speaking-country outlets write in Spanish; elsewhere only an override may say.
		lang:
			o.lang ??
			(venezuelan || region === "diaspora" || SPANISH.has(tldCountry(outlet.homepage) ?? "") ? "es" : null),
		// A feed that names its publisher (an outlet's YouTube channel or section) counts as that outlet.
		publisher: outletPublisher((outlet.publisher && byId.get(outlet.publisher)) || outlet, siteByName),
		stance: outlet.stance,
	};
}

/**
 * Atlas entries for every adapter, keyed by id. `added` is null for a feed merged since the last
 * `scripts/atlas-added.ts`; the server then dates it by its first run on this machine and says so.
 */
export function buildAtlas(
	adapters: readonly Adapter[],
	outlets: readonly OutletSpec[] = OUTLETS,
): Map<string, AtlasEntry> {
	const outletById = new Map(outlets.map((o) => [o.id, o]));
	const siteByName = new Map<string, string>();
	for (const o of outlets) {
		if (o.kind !== "youtube") siteByName.set(o.name.trim().toLowerCase(), host(o.homepage) || o.id);
	}
	const out = new Map<string, AtlasEntry>();
	for (const a of adapters) {
		const outlet = outletById.get(a.id);
		const described: Described & { stance?: string } = outlet
			? outletEntry(outlet, siteByName, outletById)
			: (ADAPTER_ATLAS[a.id] ?? {
					category: [LAYER_CATEGORY[a.layer] ?? a.layer],
					kind: "api",
					region: "intl",
					country: "INT",
					lang: null,
					publisher: a.provider.trim().toLowerCase(),
				});
		out.set(a.id, { ...described, added: ADDED[a.id] ?? null });
	}
	return out;
}
