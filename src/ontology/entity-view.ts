/**
 * An entity's page as data: the entity, its parents and children, what every live signal says about it now, its
 * incidents, its recent stories, the infrastructure in or near it, and how many people live there; plus its
 * timeline from the archive. Everything is read from the panels' own tested computations (so the entity page and
 * the panels can never disagree) and from the stored links (links-store.ts). No model, no new arithmetic beyond
 * counts and sums, each labelled "calculado por Vigía".
 */

import type { Flight } from "../adapters/adsb-flights/index.ts";
import { INPC_BASE } from "../adapters/bcv-inpc/index.ts";
import type { Intervention } from "../adapters/bcv-intervention/index.ts";
import type { MethanePlume } from "../adapters/carbon-mapper/index.ts";
import type { CloudflareRadar } from "../adapters/cloudflare-radar/index.ts";
import type { FrDocument } from "../adapters/federal-register/index.ts";
import type { FirmsValue } from "../adapters/firms-fires/index.ts";
import type { FlareValue } from "../adapters/firms-flares/index.ts";
import type { GacetaIssue } from "../adapters/gaceta-oficial/index.ts";
import type { GdacsEvent } from "../adapters/gdacs-events/index.ts";
import type { GdeltArticle } from "../adapters/gdelt-ve/index.ts";
import type { AlertsWeek } from "../adapters/gfw-alerts/index.ts";
import type { VesselDay } from "../adapters/gfw-vessels/index.ts";
import type { LightningWindow } from "../adapters/goes-glm/index.ts";
import type { PortDay } from "../adapters/imf-portwatch/index.ts";
import type { IodaEvent } from "../adapters/ioda-events/index.ts";
import type { IptvEntry } from "../adapters/iptv-ve/index.ts";
import type { FloodDay } from "../adapters/modis-floods/index.ts";
import type { ChangeValue, SnapshotValue } from "../adapters/ofac-sdn/index.ts";
import type { GeneralLicence, RecentAction } from "../adapters/ofac-venezuela/index.ts";
import type { PredictionMarket } from "../adapters/polymarket/index.ts";
import type { RadioEntry } from "../adapters/radio-browser/index.ts";
import type { AsnRouting } from "../adapters/ripestat-prefixes/index.ts";
import type { NewsItem } from "../adapters/rss/factory.ts";
import { OUTLETS } from "../adapters/rss/outlets.ts";
import type { Quake } from "../adapters/usgs-quakes/index.ts";
import type { OfficeValue } from "../adapters/wikidata-officials/index.ts";
import { bi, count, isSingular, num, pct as signedPct } from "../core/format.ts";
import type { FeedHealth, FeedState } from "../core/health.ts";
import type { Store } from "../core/store.ts";
import type { Adapter, Basis, Json } from "../core/types.ts";
import { showable } from "../crowd/counts.ts";
import { CROWD_LICENCE, CROWD_SOURCE } from "../crowd/rules.ts";
import type { CrowdAggregate } from "../crowd/service.ts";
import { crowdLabel, crowdMethod, crowdText } from "../crowd/text.ts";
import { distanceKm } from "../geo/index.ts";
import { INCIDENTS_SOURCE } from "../intel/archive.ts";
import { RULES as INCIDENT_RULES, type Incident, openingFamilies } from "../intel/incidents.ts";
import { publisherOf } from "../news/publishers.ts";
import { normalize } from "../news/text.ts";
import type { CensorshipView } from "../panels/censorship.ts";
import type { ConnectivityView, PlaceStatus } from "../panels/connectivity.ts";
import type { CrowdItem, CrowdView } from "../panels/crowd.ts";
import type { EnergyView } from "../panels/energy.ts";
import type { FiresView } from "../panels/fires.ts";
import { CAMEO_ROOTS } from "../panels/gdelt.ts";
import type { IncidentItem, IncidentsView } from "../panels/incidents.ts";
import type { NetwatchView } from "../panels/netwatch.ts";
import type { NewsView } from "../panels/news.ts";
import type { NightlightsView } from "../panels/nightlights.ts";
import type { QuakeRow, QuakesView } from "../panels/quakes.ts";
import type { ServicesView } from "../panels/services.ts";
import type { WeatherView } from "../panels/weather.ts";
import { placeAt } from "./geo.ts";
import { RULES as LINK_RULES, type Linker, type LinkRule, linkRulesText } from "./linker.ts";
import type { LinkedRow, LinkIndex } from "./links-store.ts";
import {
	GRID_METHOD,
	peopleWithin,
	populationOf,
	QUAKE_RADII_KM,
	statePeople,
	WORLDPOP_SOURCE,
} from "./population.ts";
import type { Registry } from "./registry.ts";
import { OFAC_STATE_BODIES } from "./state-names.ts";
import type { Entity } from "./types.ts";
import type {
	AnomaliesView,
	AnomalyItem,
	BilingualView,
	EntityDetail,
	EntityRef,
	EntityView,
	FigureSource,
	IncidentBrief,
	LocateView,
	NowItem,
	PopulationInAreaView,
	SearchView,
	StoryBrief,
	TimelineItem,
	TimelineView,
} from "./view.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A panel figure row, as src/server/v1/figures.ts produces it (only what the entity page reads). */
export type FeedFigure = {
	readonly feed: string | null;
	readonly path: string;
	readonly label: string | null;
	readonly value: number | string;
	readonly sourceUrl: string | null;
	readonly observedAt: number | null;
	readonly fetchedAt: number | null;
};

export interface EntityContext {
	readonly registry: Registry;
	readonly linker: Linker;
	readonly links: LinkIndex;
	readonly store: Store;
	/** A panel's cached view (the same the page draws). */
	readonly panel: (id: string) => Json | undefined;
	readonly health: () => readonly FeedHealth[];
	readonly adapters: ReadonlyMap<string, Adapter>;
	/** The public figures of one feed across the panels (what /api/v1/figures lists for it). */
	readonly figures: (feed: string) => readonly FeedFigure[];
	readonly now: number;
}

// ——— references ———

export function refOf(e: Entity): EntityRef {
	return {
		id: e.id,
		type: e.type,
		kind: e.kind,
		name: { es: e.name.es, en: e.name.en },
		short: e.short,
		href: `/api/v1/entities/${e.id}`,
	};
}

export function detailOf(reg: Registry, e: Entity): EntityDetail {
	const d = reg.datasets[e.dataset];
	return {
		...refOf(e),
		aliases: [...e.aliases],
		point: e.point ? { lat: e.point.lat, lon: e.point.lon } : null,
		geometry: e.geometry,
		codes: { ...e.codes },
		attributes: { ...e.attributes } as EntityDetail["attributes"],
		related: e.related.flatMap((r) => {
			const other = reg.get(r.id);
			return other ? [{ rel: r.rel, entity: refOf(other) }] : [];
		}),
		dataset: {
			id: d.id,
			name: d.name,
			url: d.url,
			licence: { ...d.licence },
			attribution: d.attribution,
			retrieved: d.retrieved,
		},
	};
}

// ——— words and numbers (Spanish decimals and agreeing nouns: core/format.ts) ———

/** "3 gacetas en 30 días" / "3 gazettes in 30 days". */
const inWindow = (n: { es: string; en: string }, es: string, en: string) => ({
	es: `${n.es} en ${es}`,
	en: `${n.en} in ${en}`,
});

/** A signed amount: "+0,52", "−1,3" (two decimals kept for levels in metres). */
const signed = (x: number, lang: "es" | "en") =>
	`${x > 0 ? "+" : x < 0 ? "−" : ""}${num(Math.abs(x), lang, 2, 2)}`;

/** A published figure as the publisher writes it: every decimal it gave (up to 8), Spanish grouping. */
const figureText = (v: number | string, lang: "es" | "en") => (typeof v === "number" ? num(v, lang, 8) : v);

/** The flaring panel's status words (web/src/panels/energy-view.ts says the same). */
const FLARE_STATUS: Readonly<Record<string, { es: string; en: string }>> = {
	"no-data": { es: "Pocas noches con datos", en: "Few nights with data" },
	"no-baseline": { es: "Sin línea base aún", en: "No baseline yet" },
	usual: { es: "Habitual", en: "Usual" },
	up: { es: "Más que lo habitual", en: "Above usual" },
	down: { es: "Menos que lo habitual", en: "Below usual" },
	dark: { es: "Sin llama vista", en: "No flame seen" },
	new: { es: "Actividad nueva", en: "New activity" },
	quiet: { es: "Sin actividad", en: "No activity" },
};

/** A feed's health in words (the status page's). */
const FEED_STATE: Readonly<Record<FeedState, { es: string; en: string }>> = {
	ok: { es: "al día", en: "up to date" },
	stale: { es: "con retraso", en: "delayed" },
	degraded: { es: "reintentando", en: "retrying" },
	failing: { es: "sin conexión con la fuente", en: "source unreachable" },
	locked: { es: "necesita clave", en: "needs a key" },
	off: { es: "apagada", en: "off" },
	pending: { es: "sin consultar todavía", en: "not fetched yet" },
};

// ——— figure plumbing ———

function sourceOf(
	ctx: EntityContext,
	feed: string | null,
	sourceUrl: string | null,
	name?: string,
): FigureSource {
	const a = feed ? ctx.adapters.get(feed) : undefined;
	return {
		feed,
		name: name ?? a?.name.es ?? feed ?? "",
		sourceUrl,
		licence: a?.licence.id ?? "vigia-derived",
		attribution: a?.licence.attribution ?? "Calculado por Vigía a partir de las fuentes citadas",
	};
}

/**
 * How an item's staleness is judged:
 * - "data": its feeds are not updating, or the datum is older than the feed's data budget (a reading: an IODA bin,
 *   a night-lights night);
 * - "health": its feeds are not updating (a count or an absence: no fire near a plant for two days is not stale);
 * - "most": more than half of its feeds are not updating (headlines, summed over hundreds of outlets).
 * Not updating = anything but ok or degraded: stale, failing, needs a key, turned off, or never run. A zero from
 * such a feed is not a measurement of zero.
 */
type StaleRule = "data" | "health" | "most";

function staleOf(
	ctx: EntityContext,
	feeds: readonly string[],
	observedAt: number | null,
	rule: StaleRule,
): boolean {
	if (feeds.length === 0) return false;
	const health = new Map(ctx.health().map((h) => [h.id, h]));
	const notUpdating = (f: string) => {
		const state = health.get(f)?.state ?? "pending";
		return state !== "ok" && state !== "degraded";
	};
	if (rule === "most") return feeds.filter(notUpdating).length * 2 > feeds.length;
	return feeds.every((f) => {
		if (notUpdating(f)) return true;
		if (rule === "health") return false;
		const budget = ctx.adapters.get(f)?.freshness.dataMs ?? null;
		return budget !== null && observedAt !== null && ctx.now - observedAt > budget;
	});
}

type NowInput = Omit<NowItem, "scope" | "stale" | "source"> & {
	scope: Entity;
	feeds: readonly string[];
	sourceUrl: string | null;
	sourceName?: string;
	staleRule?: StaleRule;
};

function item(ctx: EntityContext, i: NowInput): NowItem {
	const { scope, feeds, sourceUrl, sourceName, staleRule, ...rest } = i;
	return {
		...rest,
		scope: refOf(scope),
		source: sourceOf(ctx, feeds.length === 1 ? (feeds[0] as string) : null, sourceUrl, sourceName),
		stale: staleOf(ctx, feeds, i.observedAt, staleRule ?? "data"),
	};
}

const LEVEL: Record<string, { es: string; en: string }> = {
	normal: { es: "normal", en: "normal" },
	drop: { es: "caída de señal", en: "signal drop" },
	severe: { es: "caída fuerte", en: "severe drop" },
	"no-data": { es: "sin datos suficientes", en: "not enough data" },
};

function connectivityItem(ctx: EntityContext, scope: Entity, ps: PlaceStatus, method: string): NowItem {
	const figures: NowItem["figures"] = {
		level: ps.level,
		usableSignals: ps.usableSignals,
		agreeingSignals: ps.agreeing.length,
		events7d: ps.events7d,
	};
	for (const s of ps.signals) figures[`${s.signal}PctOfBaseline`] = s.pctOfBaseline;
	const fetched = ps.signals.reduce<number | null>(
		(m, s) => (s.fetchedAt !== null ? Math.max(m ?? 0, s.fetchedAt) : m),
		null,
	);
	return item(ctx, {
		layer: "connectivity",
		scope,
		label: { es: "Conectividad a internet (IODA)", en: "Internet connectivity (IODA)" },
		text: { es: ps.headline, en: `IODA: ${LEVEL[ps.level]?.en ?? ps.level}` },
		figures,
		feeds: [ps.feed],
		sourceUrl: ps.sourceUrl,
		observedAt: ps.lastBinAt,
		fetchedAt: fetched,
		basis: "measurement",
		computed: true,
		method,
	});
}

function probesItem(ctx: EntityContext, scope: Entity, ps: PlaceStatus): NowItem | null {
	const p = ps.probes;
	if (!p) return null;
	return item(ctx, {
		layer: "probes",
		scope,
		label: { es: "Sondas RIPE Atlas", en: "RIPE Atlas probes" },
		text: {
			es: `${num(p.connected)} de ${count(p.active, "sonda conectada", "sondas conectadas")}; ${num(p.droppedLastHour)} ${isSingular(p.droppedLastHour) ? "se desconectó" : "se desconectaron"} en la última hora`,
			en: `${num(p.connected, "en")} of ${count(p.active, "probe", "probes", "en")} connected; ${num(p.droppedLastHour, "en")} dropped in the last hour`,
		},
		figures: {
			connected: p.connected,
			disconnected: p.disconnected,
			active: p.active,
			droppedLastHour: p.droppedLastHour,
			disconnects24h: p.disconnects24h,
		},
		feeds: [p.feed],
		sourceUrl: p.sourceUrl,
		observedAt: p.observedAt,
		fetchedAt: null,
		basis: "measurement",
		computed: true,
		method: "Conteo de sondas por estado (nunca posiciones): calculado por Vigía.",
	});
}

function nightItem(ctx: EntityContext, scope: Entity, iso: string): NowItem | null {
	const v = ctx.panel("nightlights") as NightlightsView | undefined;
	const r = iso === "VE" ? v?.national : v?.states.find((s) => s.iso === iso);
	if (!v || !r) return null;
	const pct = r.pctChange === null ? null : Math.round(r.pctChange * 10) / 10;
	return item(ctx, {
		layer: "nightlights",
		scope,
		label: { es: "Luces nocturnas (NASA VIIRS)", en: "Night lights (NASA VIIRS)" },
		text:
			r.comparable && pct !== null
				? {
						es: `${signedPct(pct)} frente a la mediana de sus noches despejadas`,
						en: `${signedPct(pct, "en")} against the median of its clear nights`,
					}
				: { es: r.qualityNote, en: "Not comparable tonight (clouds or no baseline)" },
		figures: {
			radianceIndex: r.radianceIndex,
			baseline: r.baseline,
			pctChange: pct,
			comparable: r.comparable,
			quality: r.quality,
			clearFraction: r.clearFraction,
		},
		feeds: [v.feed],
		sourceUrl: v.sourceUrl,
		observedAt: v.observedAt,
		fetchedAt: v.fetchedAt,
		basis: "measurement",
		computed: true,
		method:
			"Índice de radiancia medio del estado frente a la mediana de sus noches despejadas anteriores (calculado por Vigía).",
	});
}

function weatherItem(ctx: EntityContext, scope: Entity, iso: string): NowItem | null {
	const v = ctx.panel("weather") as WeatherView | undefined;
	const c = v?.capitals.find((x) => x.stateIso === iso);
	if (!v || !c) return null;
	return item(ctx, {
		layer: "weather",
		scope,
		label: { es: `Tiempo en ${c.capital} (Open-Meteo)`, en: `Weather in ${c.capital} (Open-Meteo)` },
		text: {
			es: `${c.capital}: ${c.labelEs}, ${Math.round(c.temperatureC)} °C, ráfagas de ${Math.round(c.gustsKmh)} km/h`,
			en: `${c.capital}: ${Math.round(c.temperatureC)} °C, gusts ${Math.round(c.gustsKmh)} km/h`,
		},
		figures: {
			temperatureC: c.temperatureC,
			apparentC: c.apparentC,
			precipitationMmH: c.precipitationMmH,
			gustsKmh: c.gustsKmh,
			weatherCode: c.weatherCode,
			next24hPrecipMm: c.next24h.totalPrecipMm,
		},
		feeds: [v.feed],
		sourceUrl: v.sourceUrl,
		observedAt: c.observedAt,
		fetchedAt: c.fetchedAt,
		basis: "quote",
		computed: false,
		method: null,
	});
}

function firesStateItem(ctx: EntityContext, scope: Entity, iso: string): NowItem | null {
	const v = ctx.panel("fires") as FiresView | undefined;
	if (!v) return null;
	const r = iso === "VE" ? v.venezuela : v.byState.find((s) => s.stateIso === iso);
	if (!r) return null;
	const likely: number = "likelyFires24h" in r ? (r.likelyFires24h as number) : r.last24h - r.persistent24h;
	return item(ctx, {
		layer: "fires",
		scope,
		label: { es: "Focos de calor (NASA FIRMS, VIIRS)", en: "Heat detections (NASA FIRMS, VIIRS)" },
		text: {
			es: `${count(r.last24h, "detección", "detecciones")} en 24 h (${count(likely, "probable incendio", "probables incendios")}; ${num(r.persistent24h)} en fuentes de calor persistentes)`,
			en: `${count(r.last24h, "detection", "detections", "en")} in 24 h (${count(likely, "likely fire", "likely fires", "en")}; ${num(r.persistent24h, "en")} at persistent heat sources)`,
		},
		figures: {
			last24h: r.last24h,
			last48h: r.last48h,
			likelyFires24h: likely,
			persistent24h: r.persistent24h,
		},
		feeds: [v.feed],
		sourceUrl: v.sourceUrl,
		observedAt: v.newestDetectionAt,
		fetchedAt: v.file?.fetchedAt ?? null,
		basis: "measurement",
		computed: true,
		method:
			"Conteo de detecciones VIIRS en el estado; las de fuentes persistentes (mechurrios, industria) se restan de los probables incendios (calculado por Vigía).",
	});
}

function quakesWhere(ctx: EntityContext, keep: (q: QuakeRow) => boolean): QuakeRow[] {
	const v = ctx.panel("quakes") as QuakesView | undefined;
	return (v?.items ?? []).filter((q) => q.at >= ctx.now - 30 * DAY && keep(q));
}

function quakesItem(ctx: EntityContext, scope: Entity, rows: readonly QuakeRow[]): NowItem {
	const strongest = rows.reduce<QuakeRow | null>((b, q) => (!b || q.maxMag > b.maxMag ? q : b), null);
	const newest = rows.reduce<number | null>((m, q) => Math.max(m ?? 0, q.at), null);
	return item(ctx, {
		layer: "quakes",
		scope,
		label: { es: "Sismos en 30 días (USGS y FUNVISIS)", en: "Quakes in 30 days (USGS and FUNVISIS)" },
		text: strongest
			? rows.length === 1
				? {
						es: `1 sismo en 30 días: M${num(strongest.maxMag)} ${strongest.placeEs}`,
						en: `1 quake in 30 days: M${num(strongest.maxMag, "en")}`,
					}
				: {
						es: `${count(rows.length, "sismo", "sismos")} en 30 días; el mayor, M${num(strongest.maxMag)} ${strongest.placeEs}`,
						en: `${count(rows.length, "quake", "quakes", "en")} in 30 days; the strongest M${num(strongest.maxMag, "en")}`,
					}
			: { es: "Ningún sismo registrado en 30 días", en: "No quake recorded in 30 days" },
		figures: { quakes30d: rows.length, strongestMag: strongest?.maxMag ?? null, newestAt: newest },
		feeds: ["usgs-quakes", "funvisis-quakes"],
		sourceUrl: strongest ? (strongest.usgs?.url ?? strongest.funvisis?.url ?? null) : null,
		sourceName: "USGS y FUNVISIS",
		observedAt: newest,
		fetchedAt: null,
		basis: "measurement",
		computed: true,
		method:
			"Conteo de los sismos del panel (USGS y FUNVISIS emparejados) con epicentro en este lugar (calculado por Vigía).",
	});
}

/** Linked items in a window, as an exact count (headlines are keyword location, labelled as such). */
function linkedCountItem(
	ctx: EntityContext,
	scope: Entity,
	opts: {
		layer: string;
		sources: ReadonlySet<string>;
		windowMs: number;
		label: { es: string; en: string };
		text: (n: number) => { es: string; en: string };
		figure: string;
		feeds: readonly string[];
		basis: Basis;
		method: string;
		sourceName?: string;
		staleRule?: StaleRule;
	},
): NowItem {
	const from = ctx.now - opts.windowMs;
	const n = ctx.links.count(scope.id, from, ctx.now, opts.sources);
	const last = ctx.links.linked(scope.id, from, ctx.now, 1, opts.sources).rows[0];
	return item(ctx, {
		layer: opts.layer,
		scope,
		label: opts.label,
		text: opts.text(n),
		figures: { [opts.figure]: n },
		feeds: opts.feeds,
		sourceUrl: last?.sourceUrl ?? null,
		...(opts.sourceName ? { sourceName: opts.sourceName } : {}),
		observedAt: last?.observedAt ?? null,
		fetchedAt: last?.fetchedAt ?? null,
		basis: opts.basis,
		computed: true,
		method: opts.method,
		staleRule: opts.staleRule ?? "health",
	});
}

const OUTLET_FEEDS: ReadonlySet<string> = new Set(OUTLETS.map((o) => o.id));

/** One outlet's headline, whichever of its feeds carried it. */
const headlineKey = (feed: string, title: string) => `${publisherOf(feed).id}|${normalize(title)}`;

/** Timeline kinds and the sources they come from (the `kinds` filter of the timeline route). */
export const TIMELINE_KINDS: Readonly<Record<string, ReadonlySet<string>>> = {
	quake: new Set(["usgs-quakes", "funvisis-quakes"]),
	fire: new Set(["firms-fires"]),
	flare: new Set(["firms-flares"]),
	outage: new Set(["ioda-events"]),
	hazard: new Set(["gdacs-events"]),
	headline: OUTLET_FEEDS,
	gazette: new Set(["gaceta-oficial"]),
	routing: new Set(["ripestat-prefixes"]),
	incident: new Set([INCIDENTS_SOURCE]),
	crowd: new Set([CROWD_SOURCE]),
	sanction: new Set(["ofac-sdn"]),
	licence: new Set(["ofac-venezuela", "federal-register"]),
	intervention: new Set(["bcv-intervention"]),
	gdelt: new Set(["gdelt-ve"]),
	lightning: new Set(["goes-glm"]),
	broadcast: new Set(["iptv-ve", "radio-browser"]),
	office: new Set(["wikidata-officials"]),
	market: new Set(["polymarket", "kalshi"]),
	plume: new Set(["carbon-mapper"]),
	flood: new Set(["modis-floods"]),
	forest: new Set(["gfw-alerts"]),
	ships: new Set(["gfw-vessels"]),
	radar: new Set(["cloudflare-radar"]),
	flight: new Set(["adsb-flights"]),
};

/**
 * Kinds a timeline holds when `kinds` is not given: events. GDELT's machine-coded articles (hundreds a day),
 * lightning windows (one every 15 minutes in a storm) and the directories (channels and stations, offices, markets)
 * are linked too, but come only when asked for by name.
 */
export const ON_REQUEST_KINDS: ReadonlySet<string> = new Set([
	"gdelt",
	"lightning",
	"broadcast",
	"office",
	"market",
]);
export const DEFAULT_TIMELINE_SOURCES: ReadonlySet<string> = new Set(
	Object.entries(TIMELINE_KINDS)
		.filter(([k]) => !ON_REQUEST_KINDS.has(k))
		.flatMap(([, v]) => [...v]),
);

/** The source block of users' reports: Vigía's own, CC0, never a measurement. */
const CROWD_FIGURE_SOURCE = {
	feed: CROWD_SOURCE,
	name: "Reportes de usuarios (esta instancia de Vigía)",
	licence: CROWD_LICENCE.id,
	attribution: CROWD_LICENCE.attribution,
};

/** A published crowd aggregate as a "now" item: "reportes de usuarios", with their count and age. */
function crowdItem(scope: Entity, c: CrowdItem): NowItem {
	return {
		layer: "crowd",
		scope: refOf(scope),
		label: c.label,
		text: c.text,
		figures: {
			reports: c.reports,
			si: c.answers?.si ?? null,
			no: c.answers?.no ?? null,
			intermitente: c.answers?.intermitente ?? null,
			held: c.held,
			flagged: c.flagged,
			windowMs: c.windowMs,
			minReporters: c.minReporters,
		},
		source: { ...CROWD_FIGURE_SOURCE, sourceUrl: `/api/v1/panels/crowd` },
		observedAt: c.observedAt,
		fetchedAt: c.fetchedAt,
		stale: c.stale,
		basis: "report",
		computed: true,
		method: c.method,
	};
}

function crowdNow(ctx: EntityContext, e: Entity): NowItem[] {
	const view = ctx.panel("crowd") as CrowdView | undefined;
	if (!view) return [];
	const list = e.type === "state" ? view.states : e.type === "municipality" ? view.municipalities : [];
	return list
		.filter((c) => c.entity === e.id)
		.sort((a, b) => a.service.localeCompare(b.service))
		.map((c) => crowdItem(e, c));
}

function headlinesItem(ctx: EntityContext, scope: Entity, windowMs: number): NowItem {
	return linkedCountItem(ctx, scope, {
		layer: "news",
		sources: OUTLET_FEEDS,
		windowMs,
		label: { es: "Titulares que lo nombran", en: "Headlines naming it" },
		text: (n) =>
			inWindow(
				bi(n, ["titular", "titulares"], ["headline", "headlines"]),
				`${Math.round(windowMs / HOUR)} h`,
				`${Math.round(windowMs / HOUR)} h`,
			),
		figure: `headlines${Math.round(windowMs / HOUR)}h`,
		feeds: [...OUTLET_FEEDS],
		staleRule: "most",
		basis: "report",
		sourceName: "Medios (titulares)",
		method:
			"Entradas de los feeds de medios vinculadas por el etiquetador de palabras clave o por nombre (ubicación por palabra clave), contadas por Vigía; un medio con dos feeds puede contar dos veces el mismo titular.",
	});
}

// ——— the new sources' "now" items (lightning, GDELT, directories, offices, sanctions, markets) ———

const GLM = new Set(["goes-glm"]);
const LIGHTNING_METHOD = `Destellos de buena calidad que GOES-19 GLM detectó en ventanas de 15 minutos: el conteo del estado, la suma de las celdas de ${LINK_RULES.lightning.cellDeg}° cuyo centro cae en el municipio, o la celda que contiene la instalación; sumados por Vigía. GLM detecta la mayoría de los rayos, no todos.`;

function lightningItem(ctx: EntityContext, e: Entity): NowItem | null {
	if (e.type === "infrastructure" && !LINK_RULES.lightning.kinds.includes(e.kind ?? "")) return null;
	const { rows } = ctx.links.linked(e.id, ctx.now - 24 * HOUR, ctx.now, 200, GLM);
	let day = 0;
	let hour = 0;
	for (const r of rows) {
		const n = flashesFor(e, r.value as unknown as LightningWindow);
		day += n;
		if (r.observedAt >= ctx.now - HOUR) hour += n;
	}
	const last = rows[0];
	return item(ctx, {
		layer: "lightning",
		scope: e,
		label: { es: "Rayos detectados (GOES-19 GLM)", en: "Lightning detected (GOES-19 GLM)" },
		text: {
			es: `${count(day, "destello", "destellos")} en 24 h (${num(hour)} en la última hora)${e.type === "infrastructure" ? ` en su celda de ${num(LINK_RULES.lightning.cellDeg)}°` : ""}`,
			en: `${count(day, "flash", "flashes", "en")} in 24 h (${num(hour, "en")} in the last hour)${e.type === "infrastructure" ? ` in its ${num(LINK_RULES.lightning.cellDeg, "en")}° cell` : ""}`,
		},
		figures: { flashes24h: day, flashes1h: hour, windowsWithFlashes24h: rows.length },
		feeds: ["goes-glm"],
		sourceUrl: last?.sourceUrl ?? null,
		observedAt: last?.observedAt ?? null,
		fetchedAt: last?.fetchedAt ?? null,
		basis: "measurement",
		computed: true,
		method: LIGHTNING_METHOD,
		staleRule: "health",
	});
}

function gdeltItem(ctx: EntityContext, e: Entity): NowItem {
	return linkedCountItem(ctx, e, {
		layer: "gdelt",
		sources: new Set(["gdelt-ve"]),
		windowMs: 24 * HOUR,
		label: { es: "Artículos codificados por GDELT (24 h)", en: "Articles coded by GDELT (24 h)" },
		text: (n) => ({
			es: `${count(n, "artículo", "artículos")} de la prensa mundial que GDELT sitúa aquí en 24 h`,
			en: `${count(n, "world press article", "world press articles", "en")} GDELT places here in 24 h`,
		}),
		figure: "articles24h",
		feeds: ["gdelt-ve"],
		basis: "report",
		method:
			"Artículos que la codificación automática de GDELT sitúa en este lugar (su propia geocodificación), contados por Vigía: cuánto escribió la prensa, no eventos verificados.",
	});
}

function broadcastItem(ctx: EntityContext, e: Entity): NowItem | null {
	const tv = ctx.links.count(e.id, 0, ctx.now, new Set(["iptv-ve"]));
	const radio = ctx.links.count(e.id, 0, ctx.now, new Set(["radio-browser"]));
	if (tv + radio === 0) return null;
	const how = e.type === "outlet" ? "del mismo medio" : "que atienden este estado";
	return item(ctx, {
		layer: "broadcast",
		scope: e,
		label: {
			es: "Canales de TV y radios del directorio",
			en: "TV channels and radio stations in the directory",
		},
		text: {
			es: `${count(tv, "canal de TV", "canales de TV")} y ${count(radio, "radio", "radios")} ${how} (iptv-org y Radio Browser)`,
			en: `${count(tv, "TV channel", "TV channels", "en")} and ${count(radio, "radio station", "radio stations", "en")} ${e.type === "outlet" ? "of the same outlet" : "serving this state"} (iptv-org and Radio Browser)`,
		},
		figures: { tvChannels: tv, radioStations: radio },
		feeds: ["iptv-ve", "radio-browser"],
		sourceUrl: null,
		sourceName: "iptv-org y Radio Browser",
		observedAt: null,
		fetchedAt: null,
		basis: "report",
		computed: true,
		method:
			"Entradas del directorio de TV y radio (solo las que Vigía reproduce) cuyo listado nombra este estado o cuyo sitio es el del medio, contadas por Vigía. Ver timeline con kinds=broadcast.",
		staleRule: "health",
	});
}

const OFFICE_STATUS: Record<string, { es: string; en: string }> = {
	current: { es: "en el cargo según Wikidata", en: "in office according to Wikidata" },
	ended: {
		es: "período terminado; Wikidata no registra sucesor",
		en: "term ended; Wikidata records no successor",
	},
	unknown: { es: "Wikidata no da fecha de fin", en: "Wikidata gives no end date" },
};

/** Who holds this institution's (or this state's) offices, as Wikidata records it: public officials only. */
function officeItems(ctx: EntityContext, e: Entity): NowItem[] {
	const { rows } = ctx.links.linked(e.id, 0, ctx.now + DAY, 50, new Set(["wikidata-officials"]));
	return rows.map((r) => {
		const o = r.value as unknown as OfficeValue;
		const t = o.latestTerm;
		const status = OFFICE_STATUS[o.status] ?? OFFICE_STATUS.unknown;
		return item(ctx, {
			layer: "office",
			scope: e,
			label: { es: `${o.office.label} (Wikidata)`, en: `${o.office.label} (Wikidata)` },
			text: t
				? {
						es: `${t.person.label}, desde ${t.start}${t.end ? ` hasta ${t.end}` : ""} (${status?.es})`,
						en: `${t.person.label}, since ${t.start}${t.end ? ` until ${t.end}` : ""} (${status?.en})`,
					}
				: { es: "Wikidata no tiene un período fechado", en: "Wikidata has no dated term" },
			figures: {
				holder: t?.person.label ?? null,
				start: t?.start ?? null,
				end: t?.end ?? null,
				status: o.status,
				wikidata: o.wikidataUrl,
			},
			feeds: ["wikidata-officials"],
			sourceUrl: o.wikidataUrl,
			observedAt: r.observedAt,
			fetchedAt: r.fetchedAt,
			basis: "report",
			computed: false,
			method: null,
			staleRule: "health",
		});
	});
}

/** Whether OFAC's latest list (Venezuela programmes) holds this state body's record, and its changes over time. */
function sanctionsItem(ctx: EntityContext, e: Entity): NowItem | null {
	const uids = Object.entries(OFAC_STATE_BODIES)
		.filter(([, b]) => b.entity === e.id)
		.map(([uid]) => uid);
	if (uids.length === 0) return null;
	const snap = ctx.store.latest<SnapshotValue>("ofac-sdn", "snapshot");
	const listed = snap ? snap.value.entities.filter((x) => uids.includes(x.uid)) : [];
	const changes = ctx.links.count(e.id, 0, ctx.now + DAY, new Set(["ofac-sdn"]));
	const programs = [...new Set(listed.flatMap((x) => x.programs))].join(", ");
	return item(ctx, {
		layer: "sanctions",
		scope: e,
		label: { es: "Lista SDN de OFAC (programas de Venezuela)", en: "OFAC SDN list (Venezuela programmes)" },
		text: snap
			? listed.length
				? {
						es: `En la lista de OFAC (${programs}); ${count(changes, "cambio leído", "cambios leídos")} de sus archivos`,
						en: `On OFAC's list (${programs}); ${count(changes, "change", "changes", "en")} read from its files`,
					}
				: {
						es: `No figura en la última lista leída; ${count(changes, "cambio leído", "cambios leídos")} de sus archivos`,
						en: `Not on the latest list read; ${count(changes, "change", "changes", "en")} read from its files`,
					}
			: { es: "La lista de OFAC no se ha leído todavía", en: "OFAC's list has not been read yet" },
		figures: { listed: snap ? listed.length > 0 : null, changesRead: changes, programs: programs || null },
		feeds: ["ofac-sdn"],
		sourceUrl: snap?.sourceUrl ?? null,
		observedAt: snap?.observedAt ?? null,
		fetchedAt: snap?.fetchedAt ?? null,
		basis: "official",
		computed: false,
		method: null,
		staleRule: "health",
	});
}

function marketsItem(ctx: EntityContext, e: Entity): NowItem | null {
	const markets = new Set(["polymarket", "kalshi"]);
	// The venues list open markets only, so a closed one simply stops updating: count those that still close later.
	const open = ctx.links.linked(e.id, 0, ctx.now + DAY, 500, markets).rows.filter((r) => {
		const closesAt = (r.value as { closesAt?: unknown } | null)?.closesAt;
		return typeof closesAt !== "number" || closesAt > ctx.now;
	});
	const n = open.length;
	if (n === 0) return null;
	const last = open[0];
	return item(ctx, {
		layer: "markets",
		scope: e,
		label: {
			es: "Mercados de predicción (Polymarket y Kalshi)",
			en: "Prediction markets (Polymarket and Kalshi)",
		},
		text: {
			es: `${count(n, "mercado", "mercados")} sobre Venezuela con precio; un precio no es un pronóstico`,
			en: `${count(n, "market", "markets", "en")} about Venezuela with a price; a price is not a forecast`,
		},
		figures: { markets: n },
		feeds: ["polymarket", "kalshi"],
		sourceUrl: null,
		sourceName: "Polymarket y Kalshi",
		observedAt: last?.observedAt ?? null,
		fetchedAt: last?.fetchedAt ?? null,
		basis: "quote",
		computed: true,
		method:
			"Mercados de estas plataformas que nombran a Venezuela, contados por Vigía (kinds=market los lista).",
		staleRule: "health",
	});
}

// ——— the "now" block ———

function nowOf(ctx: EntityContext, e: Entity): NowItem[] {
	const reg = ctx.registry;
	const out: (NowItem | null)[] = [];
	const conn = ctx.panel("connectivity") as ConnectivityView | undefined;
	const method = conn?.method.baseline ?? "";
	const stateOf = (x: Entity): Entity | null =>
		x.type === "state" ? x : (reg.ancestors(x.id).find((a) => a.type === "state") ?? null);

	if (e.type === "country") {
		if (conn) out.push(connectivityItem(ctx, e, conn.country, method), probesItem(ctx, e, conn.country));
		out.push(nightItem(ctx, e, "VE"), firesStateItem(ctx, e, "VE"));
		out.push(
			quakesItem(
				ctx,
				e,
				quakesWhere(ctx, (q) => q.zone === "venezuela"),
			),
		);
	}
	if (e.type === "state" || e.type === "municipality" || e.type === "parish") {
		const state = stateOf(e);
		const iso = state?.codes.iso;
		if (state && iso) {
			const ps = conn?.states.find((s) => s.id === iso);
			if (ps) out.push(connectivityItem(ctx, state, ps, method), probesItem(ctx, state, ps));
			out.push(nightItem(ctx, state, iso), weatherItem(ctx, state, iso));
			if (e.type === "state") out.push(firesStateItem(ctx, e, iso));
		}
		if (e.type === "state")
			out.push(
				quakesItem(
					ctx,
					e,
					quakesWhere(ctx, (q) => q.zone === "venezuela" && q.state === iso),
				),
			);
		else {
			const code = e.codes.pcode;
			out.push(
				linkedCountItem(ctx, e, {
					layer: "fires",
					sources: new Set(["firms-fires"]),
					windowMs: 48 * HOUR,
					label: {
						es: "Focos de calor en 48 h (NASA FIRMS, VIIRS)",
						en: "Heat detections in 48 h (NASA FIRMS, VIIRS)",
					},
					text: (n) =>
						inWindow(bi(n, ["detección", "detecciones"], ["detection", "detections"]), "48 h", "48 h"),
					figure: "detections48h",
					feeds: ["firms-fires"],
					basis: "measurement",
					method:
						"Detecciones VIIRS cuyo píxel cae en este lugar (punto en polígono), contadas por Vigía; incluye fuentes de calor persistentes.",
				}),
				quakesItem(
					ctx,
					e,
					quakesWhere(ctx, (q) => {
						const p = placeAt(q.lat, q.lon);
						return e.type === "municipality" ? p.municipality === code : p.parish === code;
					}),
				),
			);
		}
		out.push(headlinesItem(ctx, e, 48 * HOUR));
		out.push(...crowdNow(ctx, e));
		if (e.type !== "parish") out.push(lightningItem(ctx, e));
		if (e.type === "state") out.push(gdeltItem(ctx, e), broadcastItem(ctx, e));
	}
	if (e.type === "country") out.push(marketsItem(ctx, e));
	if (e.type === "infrastructure") out.push(...infraNow(ctx, e), lightningItem(ctx, e));
	if (e.type === "network") out.push(...networkNow(ctx, e, conn, method));
	if (e.type === "outlet") out.push(...outletNow(ctx, e), broadcastItem(ctx, e), sanctionsItem(ctx, e));
	if (e.type === "institution") out.push(...institutionNow(ctx, e), sanctionsItem(ctx, e));
	if (e.type === "institution" || e.type === "state") out.push(...officeItems(ctx, e));
	return out.filter((x): x is NowItem => x !== null);
}

function infraNow(ctx: EntityContext, e: Entity): (NowItem | null)[] {
	const out: (NowItem | null)[] = [];
	const facility = e.codes.facility;
	if (facility) {
		const v = ctx.panel("energy") as EnergyView | undefined;
		const f = v?.facilities.find((x) => x.id === facility);
		out.push(
			item(ctx, {
				layer: "flares",
				scope: e,
				label: { es: "Quema de gas (NASA FIRMS, VIIRS)", en: "Gas flaring (NASA FIRMS, VIIRS)" },
				text: f
					? {
							es: `${FLARE_STATUS[f.status]?.es ?? f.status}: quema en ${num(f.d7.activeNights)} de ${count(f.d7.nightsWithData, "noche", "noches")} con datos en 7 días`,
							en: `${FLARE_STATUS[f.status]?.en ?? f.status}: flaring on ${num(f.d7.activeNights, "en")} of ${count(f.d7.nightsWithData, "night", "nights", "en")} with data in 7 days`,
						}
					: { es: "Sin quema detectada en 90 noches", en: "No flaring detected in 90 nights" },
				figures: f
					? {
							status: f.status,
							activeNights7d: f.d7.activeNights,
							meanNightFrpMW7d: f.d7.meanNightFrpMW,
							ratioToBaseline: f.ratio,
						}
					: { status: "quiet" },
				feeds: ["firms-flares"],
				sourceUrl: f?.url ?? null,
				observedAt: f?.lastDetectionAt ?? null,
				fetchedAt: null,
				basis: "measurement",
				computed: true,
				method: v?.facilityRule ?? "Regla de asignación del panel de quema.",
				staleRule: "health",
			}),
		);
	}
	const port = e.codes.portwatch;
	if (port) {
		const o = ctx.store.latest<PortDay>("imf-portwatch", `port:${port}`);
		if (o)
			out.push(
				item(ctx, {
					layer: "port-calls",
					scope: e,
					label: { es: "Escalas de buques (IMF PortWatch)", en: "Port calls (IMF PortWatch)" },
					text: {
						es: `${count(o.value.portCalls, "escala", "escalas")} el ${o.value.date} (${num(o.value.tankerCalls)} de tanqueros); los buques con AIS apagado no se cuentan`,
						en: `${count(o.value.portCalls, "call", "calls", "en")} on ${o.value.date} (${count(o.value.tankerCalls, "tanker", "tankers", "en")}); ships with AIS off are not counted`,
					},
					figures: {
						date: o.value.date,
						portCalls: o.value.portCalls,
						tankerCalls: o.value.tankerCalls,
						importT: o.value.importT,
						exportT: o.value.exportT,
					},
					feeds: ["imf-portwatch"],
					sourceUrl: o.sourceUrl,
					observedAt: o.observedAt,
					fetchedAt: o.fetchedAt,
					basis: o.basis,
					computed: false,
					method: null,
				}),
			);
	}
	if (e.codes.dahiti) {
		const g = (ctx.panel("services") as ServicesView | undefined)?.guri;
		if (g?.latest)
			out.push(
				item(ctx, {
					layer: "reservoir",
					scope: e,
					label: {
						es: "Nivel del embalse por altimetría (DAHITI)",
						en: "Reservoir level by altimetry (DAHITI)",
					},
					text: {
						es: `${num(g.latest.m, "es", 2, 2)} m (satelital, no es la cota oficial)${g.change30d ? `; ${signed(g.change30d.m, "es")} m en 30 días` : ""}`,
						en: `${num(g.latest.m, "en", 2, 2)} m (satellite, not the official gauge)${g.change30d ? `; ${signed(g.change30d.m, "en")} m in 30 days` : ""}`,
					},
					figures: {
						levelM: g.latest.m,
						change30dM: g.change30d?.m ?? null,
						change1yM: g.change1y?.m ?? null,
					},
					feeds: [g.feed],
					sourceUrl: g.sourceUrl,
					observedAt: g.latest.observedAt,
					fetchedAt: g.latest.fetchedAt,
					basis: "measurement",
					computed: true,
					method: g.ruleEs,
				}),
			);
	}
	out.push(
		linkedCountItem(ctx, e, {
			layer: "fires",
			sources: new Set(["firms-fires"]),
			windowMs: 48 * HOUR,
			label: { es: "Focos de calor cerca en 48 h (VIIRS)", en: "Heat detections nearby in 48 h (VIIRS)" },
			text: (n) => ({
				es: `${count(n, "detección", "detecciones")} en 48 h dentro de la distancia de la regla`,
				en: `${count(n, "detection", "detections", "en")} in 48 h within the rule's distance`,
			}),
			figure: "detectionsNear48h",
			feeds: ["firms-fires"],
			basis: "measurement",
			method:
				"Detecciones VIIRS a la distancia que fija la regla para este tipo de instalación (ver reglas), contadas por Vigía.",
		}),
	);
	return out;
}

function networkNow(
	ctx: EntityContext,
	e: Entity,
	conn: ConnectivityView | undefined,
	method: string,
): (NowItem | null)[] {
	const reg = ctx.registry;
	const isp = e.kind === "isp" ? e : reg.get(e.parents[0] ?? "");
	const ispId = isp?.codes.isp;
	if (!isp || !ispId) return [];
	const out: (NowItem | null)[] = [];
	const ps = conn?.isps.find((x) => x.id === ispId);
	if (ps) out.push(connectivityItem(ctx, isp, ps, method));
	const cen = (ctx.panel("censorship") as CensorshipView | undefined)?.byIsp.find((x) => x.isp === ispId);
	if (cen)
		out.push(
			item(ctx, {
				layer: "censorship",
				scope: isp,
				label: {
					es: "Bloqueos de sitios (OONI y VE sin Filtro)",
					en: "Website blocking (OONI and VE sin Filtro)",
				},
				text: {
					es: `VE sin Filtro: ${cen.vsf ? count(cen.vsf.blocked, "sitio bloqueado", "sitios bloqueados") : "sin dato"}; OONI: ${cen.ooni ? `${count(cen.ooni.flagged, "dominio", "dominios")} con anomalías de ${num(cen.ooni.tested)} ${isSingular(cen.ooni.tested) ? "probado" : "probados"}` : "sin dato"}`,
					en: `VE sin Filtro: ${cen.vsf ? count(cen.vsf.blocked, "blocked site", "blocked sites", "en") : "no data"}; OONI: ${cen.ooni ? `${count(cen.ooni.flagged, "flagged domain", "flagged domains", "en")} of ${num(cen.ooni.tested, "en")} tested` : "no data"}`,
				},
				figures: {
					vsfBlocked: cen.vsf?.blocked ?? null,
					ooniFlagged: cen.ooni?.flagged ?? null,
					ooniTested: cen.ooni?.tested ?? null,
					ooniAnomalyRatePct: cen.ooni?.anomalyRatePct ?? null,
				},
				feeds: ["ooni-ve", "vesinfiltro-blocks"],
				sourceUrl: null,
				sourceName: "OONI y VE sin Filtro",
				observedAt: null,
				fetchedAt: null,
				basis: "measurement",
				computed: true,
				method: "Conteos del panel de censura para este proveedor (calculado por Vigía).",
			}),
		);
	const route = (ctx.panel("netwatch") as NetwatchView | undefined)?.routing.isps.find(
		(x) => x.isp === ispId,
	);
	if (route)
		out.push(
			item(ctx, {
				layer: "routing",
				scope: isp,
				label: { es: "Cambios de rutas (RIPEstat)", en: "Routing changes (RIPEstat)" },
				text: {
					es: `${count(route.events, "cambio", "cambios")} de prefijos por encima de la regla en la ventana`,
					en: `${count(route.events, "prefix change", "prefix changes", "en")} above the rule in the window`,
				},
				figures: { events: route.events },
				feeds: ["ripestat-prefixes"],
				sourceUrl: `https://stat.ripe.net/app/launchpad/AS${route.asns[0] ?? ""}`,
				observedAt: route.at,
				fetchedAt: null,
				basis: "derived",
				computed: true,
				method:
					"Retiros, anuncios y traspasos de prefijos entre instantáneas de RIPEstat que superan la regla del panel (solo cifras derivadas).",
			}),
		);
	return out;
}

function outletNow(ctx: EntityContext, e: Entity): NowItem[] {
	const feeds = (e.attributes.feeds as string[] | undefined) ?? [];
	const health = new Map(ctx.health().map((h) => [h.id, h]));
	const out: NowItem[] = feeds.map((f) => {
		const h = health.get(f);
		return item(ctx, {
			layer: "feed",
			scope: e,
			label: {
				es: `Feed ${ctx.adapters.get(f)?.name.es ?? f}`,
				en: `Feed ${ctx.adapters.get(f)?.name.en ?? f}`,
			},
			text: {
				es: h ? `Estado del feed: ${FEED_STATE[h.state].es}` : "Feed no activo en esta instalación",
				en: h ? `Feed state: ${FEED_STATE[h.state].en}` : "Feed not active on this install",
			},
			figures: { state: h?.state ?? null, newestObservedAt: h?.newestObservedAt ?? null },
			feeds: [f],
			sourceUrl: ctx.adapters.get(f)?.homepage ?? null,
			observedAt: h?.newestObservedAt ?? null,
			fetchedAt: h?.lastSuccessAt ?? null,
			basis: "report",
			computed: false,
			method: null,
		});
	});
	out.push(
		linkedCountItem(ctx, e, {
			layer: "news",
			sources: new Set(feeds),
			windowMs: 24 * HOUR,
			label: { es: "Titulares en 24 h", en: "Headlines in 24 h" },
			text: (n) => inWindow(bi(n, ["titular", "titulares"], ["headline", "headlines"]), "24 h", "24 h"),
			figure: "headlines24h",
			feeds,
			basis: "report",
			method: "Titulares de sus feeds, contados por Vigía (una noticia por enlace).",
		}),
	);
	return out;
}

/**
 * The figures an institution publishes, by panel figure path: only these are shown on its page. A figure Vigía
 * computes from them (a year-on-year change) says so with its method; nothing else in a panel is attributed to
 * the institution.
 */
const PUBLISHED_FIGURES: Readonly<
	Record<
		string,
		readonly {
			path: string;
			label: { es: string; en: string };
			method: string | null;
			/** An index's base, as the publisher prints it (in the label, the text and `figures.base`). */
			base?: { es: string; en: string };
		}[]
	>
> = {
	"bcv-official": [
		{
			path: "official.usd.current.vesPerUnit",
			label: { es: "Tasa oficial del dólar (Bs.)", en: "Official US dollar rate (Bs.)" },
			method: null,
		},
		{
			path: "official.eur.current.vesPerUnit",
			label: { es: "Tasa oficial del euro (Bs.)", en: "Official euro rate (Bs.)" },
			method: null,
		},
	],
	"bcv-reserves": [
		{
			path: "reserves.latest.totalMusd",
			label: { es: "Reservas internacionales (MM US$)", en: "International reserves (US$ million)" },
			method: null,
		},
	],
	"bcv-liquidity": [
		{
			path: "liquidity.latest.m2Ves",
			label: { es: "Liquidez monetaria M2 (Bs.)", en: "Money supply M2 (Bs.)" },
			method: null,
		},
	],
	"bcv-intervention": [
		{
			path: "intervention.latest.vesPerEur",
			label: {
				es: "Última intervención cambiaria (Bs. por euro)",
				en: "Latest exchange intervention (Bs. per euro)",
			},
			method: null,
		},
	],
	"bcv-inpc": [
		{
			path: "inflation.latest.index",
			label: { es: `INPC (índice, base ${INPC_BASE.es})`, en: `Consumer price index (base ${INPC_BASE.en})` },
			method: null,
			base: INPC_BASE,
		},
		{
			path: "inflation.latest.monthlyPct",
			label: { es: "Inflación del mes (%)", en: "Monthly inflation (%)" },
			method: null,
		},
		{
			path: "inflation.yearOnYearPct",
			label: { es: "Inflación interanual (%)", en: "Year-on-year inflation (%)" },
			method: `Variación del INPC frente al mismo mes del año anterior, calculada por Vigía con los índices del BCV (base ${INPC_BASE.es}).`,
		},
	],
};

function institutionNow(ctx: EntityContext, e: Entity): NowItem[] {
	const out: NowItem[] = [];
	const seen = new Set<string>();
	const feeds = (e.attributes.publishes as string[] | undefined) ?? [];
	// A figure may come through either route to the same publication (bcv.org.ve or the bcv-api mirror).
	const allFigs = feeds.flatMap((f) => ctx.figures(f));
	for (const feed of feeds) {
		const a = ctx.adapters.get(feed);
		if (!a) continue;
		const published = PUBLISHED_FIGURES[feed] ?? [];
		for (const p of published) {
			const f = allFigs.find((x) => x.path === p.path);
			if (!f || seen.has(p.path)) continue;
			seen.add(p.path);
			out.push(
				item(ctx, {
					layer: "figure",
					scope: e,
					label: p.label,
					text: {
						es: `${p.label.es}: ${figureText(f.value, "es")}`,
						en: `${p.label.en}: ${figureText(f.value, "en")}`,
					},
					figures: { value: f.value, path: f.path, ...(p.base ? { base: p.base.es } : {}) },
					feeds: [f.feed ?? feed],
					sourceUrl: f.sourceUrl,
					observedAt: f.observedAt,
					fetchedAt: f.fetchedAt,
					basis: p.method ? "derived" : "official",
					computed: p.method !== null,
					method: p.method,
				}),
			);
		}
		// Feeds with no listed figure (the Gazette, a bulletin, a second route) show whether they are keeping up.
		if (published.length === 0) {
			const h = ctx.health().find((x) => x.id === feed);
			out.push(
				item(ctx, {
					layer: "feed",
					scope: e,
					label: { es: a.name.es, en: a.name.en },
					text: {
						es: h?.newestObservedAt
							? `Última publicación leída: ${new Date(h.newestObservedAt).toISOString().slice(0, 10)}`
							: "Sin publicaciones leídas todavía",
						en: h?.newestObservedAt
							? `Newest publication read: ${new Date(h.newestObservedAt).toISOString().slice(0, 10)}`
							: "No publication read yet",
					},
					figures: { state: h?.state ?? null },
					feeds: [feed],
					sourceUrl: a.homepage,
					observedAt: h?.newestObservedAt ?? null,
					fetchedAt: h?.lastSuccessAt ?? null,
					basis: "official",
					computed: false,
					method: null,
					staleRule: "health",
				}),
			);
		}
	}
	out.push(headlinesItem(ctx, e, 48 * HOUR));
	if ((e.attributes.gazetteOrgans as string[] | undefined)?.length)
		out.push(
			linkedCountItem(ctx, e, {
				layer: "gazette",
				sources: new Set(["gaceta-oficial"]),
				windowMs: 30 * DAY,
				label: {
					es: "Gacetas Oficiales con actos suyos (30 días)",
					en: "Official Gazettes with its acts (30 days)",
				},
				text: (n) => inWindow(bi(n, ["gaceta", "gacetas"], ["gazette", "gazettes"]), "30 días", "30 days"),
				figure: "gazettes30d",
				feeds: ["gaceta-oficial"],
				basis: "official",
				method: "Números de la Gaceta Oficial cuyo índice lista un acto de este órgano, contados por Vigía.",
			}),
		);
	return out;
}

// ——— incidents and the people living in their area ———

const WORLDPOP_NOTE =
	"Estimación modelada por WorldPop para 2026; no es un censo ni un conteo de personas afectadas.";

/**
 * Whether an incident may carry "people living in the area": at least RULES.minFamilies independent families that
 * can open an incident (users' reports join, never count), as the incidents panel counts them. A lone signal, and an
 * incident of the press alone (two outlets, one family), get no figure that could be read as its reach.
 */
export function populationAllowed(inc: Pick<IncidentItem, "tier" | "families">): boolean {
	return inc.tier === "incident" && openingFamilies(inc.families) >= INCIDENT_RULES.minFamilies;
}

function populationInAreaOf(ctx: EntityContext, inc: IncidentItem): PopulationInAreaView | null {
	if (!populationAllowed(inc)) return null;
	if (inc.kind === "corte" && inc.state) {
		const people = statePeople(ctx.registry, inc.state).worldpop2026;
		const name = inc.stateName ?? inc.state;
		if (people === null) return null;
		return {
			area: {
				es: `Personas que viven en ${name} (todo el estado)`,
				en: `People living in ${name} (the whole state)`,
			},
			people,
			radii: null,
			basis: "estimate",
			source: WORLDPOP_SOURCE,
			licence: "CC BY 4.0",
			note: WORLDPOP_NOTE,
			computed: true,
			method: "WorldPop 2026 sumado por municipio (calculado por Vigía).",
			caveat: {
				es: "No es el número de personas sin servicio: las señales se miden por estado y no dicen qué parte del estado está afectada.",
				en: "Not the number of people without service: the signals are per state and do not say which part of it is affected.",
			},
		};
	}
	if (inc.kind === "sismo") {
		const q = (ctx.panel("quakes") as QuakesView | undefined)?.items.find((x) => x.id === inc.key);
		if (!q) return null;
		const radii = QUAKE_RADII_KM.map((km) => ({ km, people: peopleWithin(q.lat, q.lon, km) }));
		const mid = radii[1] ?? radii[0];
		if (!mid) return null;
		return {
			area: {
				es: `Personas que viven a menos de ${mid.km} km del epicentro, en Venezuela`,
				en: `People living within ${mid.km} km of the epicentre, in Venezuela`,
			},
			people: mid.people,
			radii,
			basis: "estimate",
			source: WORLDPOP_SOURCE,
			licence: "CC BY 4.0",
			note: WORLDPOP_NOTE,
			computed: true,
			method: `${GRID_METHOD} La malla cubre solo Venezuela: no cuenta a quienes viven al otro lado de la frontera.`,
			caveat: {
				es: "Distancias fijas: no dicen cuántas personas sintieron el sismo ni si hubo daños.",
				en: "Fixed distances: they do not say how many people felt the quake or whether there was damage.",
			},
		};
	}
	return null;
}

function incidentsOf(ctx: EntityContext, e: Entity): IncidentBrief[] {
	const v = ctx.panel("incidents") as IncidentsView | undefined;
	if (!v) return [];
	const reg = ctx.registry;
	const scopes = new Set([e.id, ...reg.ancestors(e.id).map((a) => a.id)]);
	const out: IncidentBrief[] = [];
	for (const inc of [...v.incidents, ...v.watches]) {
		const scope = inc.state ? reg.byCode(`iso:${inc.state}`) : undefined;
		if (!scope || !scopes.has(scope.id)) continue;
		out.push({
			id: inc.id,
			kind: inc.kind,
			title: { es: inc.title.es, en: inc.title.en },
			status: inc.status,
			tier: inc.tier,
			corroboration: inc.corroboration,
			families: [...inc.families],
			reportsOnly: inc.reportsOnly,
			startAt: inc.startAt,
			lastEvidenceAt: inc.lastEvidenceAt,
			scope: refOf(scope),
			populationInArea: populationInAreaOf(ctx, inc),
			href: `/api/v1/incidents/${encodeURIComponent(inc.id)}`,
		});
	}
	return out.sort((a, b) =>
		a.status === b.status ? b.lastEvidenceAt - a.lastEvidenceAt : a.status === "active" ? -1 : 1,
	);
}

// ——— stories ———

function storiesOf(ctx: EntityContext, e: Entity, limit = 12): StoryBrief[] {
	const news = ctx.panel("news") as NewsView | undefined;
	const storyOfUrl = new Map<string, { id: string; outlets: number }>();
	for (const s of Object.values(news?.stories ?? {}))
		for (const o of s.outlets) storyOfUrl.set(o.url, { id: s.id, outlets: s.outletCount });
	const { rows } = ctx.links.linked(e.id, ctx.now - 48 * HOUR, ctx.now + 15 * MIN, 200, OUTLET_FEEDS);
	const out: StoryBrief[] = [];
	const seen = new Set<string>();
	for (const r of rows) {
		const v = r.value as unknown as NewsItem;
		if (typeof v?.title !== "string") continue;
		const story = storyOfUrl.get(v.link) ?? null;
		// One story once, and one outlet's headline once even when two of its feeds (or a re-published item) carry it.
		const keys = [story?.id ?? v.link, headlineKey(r.source, v.title)];
		if (keys.some((k) => seen.has(k))) continue;
		for (const k of keys) seen.add(k);
		const outlet = ctx.registry.byCode(`feed:${r.source}`);
		out.push({
			title: v.title,
			url: v.link,
			at: r.observedAt,
			fetchedAt: r.fetchedAt,
			outlet: outlet ? refOf(outlet) : null,
			outletName: outlet?.name.es ?? r.source,
			storyId: story?.id ?? null,
			outlets: story?.outlets ?? 1,
			rule: r.rule,
			confidence: r.confidence,
		});
		if (out.length >= limit) break;
	}
	return out;
}

// ——— nearby infrastructure ———

/** At the same distance, which facilities list first: the ones whose failure reaches most people. */
const KIND_ORDER = [
	"power-plant",
	"refinery",
	"petrochemical",
	"oil-terminal",
	"port",
	"airport",
	"dam",
	"substation",
	"fuel-depot",
	"oil-field",
	"gas-field",
	"reservoir",
	"hospital",
	"power-grid",
];
const rank = (e: Entity) => {
	const k = KIND_ORDER.indexOf(e.kind ?? "");
	const size =
		Number(e.attributes.capacityMW ?? 0) ||
		Math.max(0, ...((e.attributes.voltagesKV as number[] | undefined) ?? [0]));
	return [k === -1 ? 99 : k, -size] as const;
};

export const NEARBY_KM = 20;
const NEARBY_MAX = 40;

/** Nearest first; the same distance (to 0.1 km) by kind (KIND_ORDER), then the larger, then the id. */
const byDistance = (a: { x: Entity; km: number }, b: { x: Entity; km: number }) => {
	const [ka, sa] = rank(a.x);
	const [kb, sb] = rank(b.x);
	return a.km - b.km || ka - kb || sa - sb || a.x.id.localeCompare(b.x.id);
};

function nearbyOf(ctx: EntityContext, e: Entity): EntityView["nearby"] {
	const reg = ctx.registry;
	const byKind: Record<string, number> = {};
	if (e.type === "country" || e.type === "state" || e.type === "municipality" || e.type === "parish") {
		const inside = reg.within(e.id).filter((x) => x.type === "infrastructure");
		for (const x of inside) byKind[x.kind ?? ""] = (byKind[x.kind ?? ""] ?? 0) + 1;
		const from = e.point;
		const sorted = inside
			.map((x) => ({
				x,
				km:
					from && x.point
						? Math.round(distanceKm(from.lat, from.lon, x.point.lat, x.point.lon) * 10) / 10
						: 0,
			}))
			.sort(byDistance);
		return {
			rule: from
				? {
						es: "Instalaciones dentro de este lugar (punto en polígono), de la más cercana a la más lejana de su punto de referencia; a igual distancia, por tipo",
						en: "Facilities inside this place (point in polygon), nearest to its reference point first; at the same distance, by kind",
					}
				: {
						es: "Instalaciones dentro de este lugar (punto en polígono), por tipo: el lugar no tiene un punto propio",
						en: "Facilities inside this place (point in polygon), by kind: the place has no point of its own",
					},
			order: from ? "distance" : "kind",
			byKind,
			items: sorted
				.slice(0, NEARBY_MAX)
				.map(({ x, km }) => ({ entity: refOf(x), km, relation: "inside" as const })),
			truncated: sorted.length > NEARBY_MAX,
		};
	}
	if (e.type === "infrastructure" && e.point) {
		const kinds = Object.fromEntries(KIND_ORDER.map((k) => [k, NEARBY_KM]));
		const near = ctx.linker
			.near(e.point.lat, e.point.lon, kinds)
			.filter((l) => l.entity !== e.id)
			.flatMap((l) => {
				const x = reg.get(l.entity);
				return x ? [{ x, km: l.km ?? 0 }] : [];
			})
			.sort(byDistance);
		for (const n of near) byKind[n.x.kind ?? ""] = (byKind[n.x.kind ?? ""] ?? 0) + 1;
		return {
			rule: {
				es: `Otras instalaciones a menos de ${NEARBY_KM} km, de la más cercana a la más lejana; a igual distancia, por tipo`,
				en: `Other facilities within ${NEARBY_KM} km, nearest first; at the same distance, by kind`,
			},
			order: "distance",
			byKind,
			items: near
				.slice(0, NEARBY_MAX)
				.map((n) => ({ entity: refOf(n.x), km: n.km, relation: "near" as const })),
			truncated: near.length > NEARBY_MAX,
		};
	}
	return {
		rule: { es: "Sin ubicación propia", en: "No location of its own" },
		order: "kind",
		byKind,
		items: [],
		truncated: false,
	};
}

// ——— the page ———

const CHILDREN_MAX = 200;

export function entityView(ctx: EntityContext, id: string): EntityView | null {
	const reg = ctx.registry;
	const e = reg.get(id);
	if (!e) return null;
	const kids = reg.children(id);
	const byType: Record<string, number> = {};
	for (const k of kids) byType[k.type] = (byType[k.type] ?? 0) + 1;
	return {
		entity: detailOf(reg, e),
		parents: reg.ancestors(id).map(refOf),
		children: {
			total: kids.length,
			byType,
			items: kids.slice(0, CHILDREN_MAX).map(refOf),
			truncated: kids.length > CHILDREN_MAX,
		},
		now: nowOf(ctx, e),
		incidents: incidentsOf(ctx, e),
		stories: storiesOf(ctx, e),
		nearby: nearbyOf(ctx, e),
		population: populationOf(reg, e),
		anomalies: anomaliesOf(ctx, e),
		anomaliesJudged: anomaliesJudgedOf(ctx, e),
		links: {
			timeline: `/api/v1/entities/${id}/timeline`,
			rules: linkRulesText(),
			backlog: ctx.links.backlog(),
		},
		asOf: ctx.now,
	};
}

/** The anomaly engine's items about this entity or its state (a municipality shows its state's), highest first. */
function anomaliesOf(ctx: EntityContext, e: Entity): AnomalyItem[] {
	const view = ctx.panel("anomalies") as AnomaliesView | undefined;
	if (!view?.items) return [];
	// Its own readings and its state's; never the country's (every entity has it as an ancestor: an oil price is not
	// news about a power plant) nor its descendants'.
	const state = ctx.registry.ancestors(e.id).find((a) => a.type === "state");
	const scopes = new Set([e.id, ...(state ? [state.id] : [])]);
	// A state's drop folded into a regional item stays on the state's page as its own reading (with its groupId).
	return [...view.items, ...(view.grouped ?? [])]
		.filter((i) => scopes.has(i.entity.id))
		.sort(
			(a, b) =>
				Number(a.reverted !== null) - Number(b.reverted !== null) || Math.abs(b.score) - Math.abs(a.score),
		);
}

/** Series judged now about the entity or its state (the same scopes as `anomaliesOf`). */
function anomaliesJudgedOf(ctx: EntityContext, e: Entity): number {
	const view = ctx.panel("anomalies") as AnomaliesView | undefined;
	const by = view?.counts?.judgedByEntity;
	if (!by) return 0;
	const state = ctx.registry.ancestors(e.id).find((a) => a.type === "state");
	return (by[e.id] ?? 0) + (state && state.id !== e.id ? (by[state.id] ?? 0) : 0);
}

// ——— the timeline ———

const finite = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

function timelineItem(ctx: EntityContext, e: Entity, r: LinkedRow): TimelineItem {
	const a = ctx.adapters.get(r.source);
	const raw = a ? a.licence.raw !== false : false;
	const base = {
		at: r.observedAt,
		source: sourceOf(ctx, r.source, r.sourceUrl),
		url: r.sourceUrl,
		observedAt: r.observedAt,
		fetchedAt: r.fetchedAt,
		rule: r.rule as LinkRule,
		confidence: r.confidence,
		km: r.km,
	};
	const v = r.value as Record<string, Json>;
	const figures = (f: TimelineItem["figures"]) => (raw ? f : null);
	switch (r.source) {
		case "usgs-quakes":
		case "funvisis-quakes": {
			const q = v as unknown as Quake;
			const label = r.source === "usgs-quakes" ? "USGS" : "FUNVISIS";
			return {
				...base,
				kind: "quake",
				title: {
					es: `Sismo M${num(q.mag)} (${label}), ${q.placeEs}`,
					en: `M${num(q.mag, "en")} quake (${label}), ${q.placeEs}`,
				},
				figures: figures({ mag: finite(q.mag), depthKm: finite(q.depthKm) }),
			};
		}
		case "firms-fires": {
			const f = v as unknown as Extract<FirmsValue, { kind: "detection" }>;
			return {
				...base,
				kind: "fire",
				title: {
					es: `Foco de calor VIIRS, ${f.placeEs} (${num(f.frpMW)} MW)`,
					en: `VIIRS heat detection, ${f.placeEs} (${num(f.frpMW, "en")} MW)`,
				},
				figures: figures({
					frpMW: finite(f.frpMW),
					confidenceClass: f.confidenceClass,
					daynight: f.daynight,
				}),
			};
		}
		case "firms-flares": {
			const f = v as unknown as Extract<FlareValue, { kind: "detection" }>;
			const facility = ctx.registry.byCode(`facility:${f.facilityId}`);
			return {
				...base,
				kind: "flare",
				title: {
					es: `Quema de gas en ${facility?.name.es ?? f.facilityId} (${num(f.frpMW)} MW)`,
					en: `Gas flaring at ${facility?.name.en ?? f.facilityId} (${num(f.frpMW, "en")} MW)`,
				},
				figures: figures({ frpMW: finite(f.frpMW), facilityKm: finite(f.facilityKm), daynight: f.daynight }),
			};
		}
		case "ioda-events": {
			const ev = v as unknown as IodaEvent;
			const min = Math.round(ev.durationS / 60);
			return {
				...base,
				at: ev.startS * 1000,
				kind: "outage",
				title: {
					es: `IODA: caída de señal (${ev.datasource}) en ${ev.entityName}, ${num(min)} min`,
					en: `IODA: signal drop (${ev.datasource}) in ${ev.entityName}, ${num(min, "en")} min`,
				},
				figures: null,
			};
		}
		case "gdacs-events": {
			const g = v as unknown as GdacsEvent;
			return {
				...base,
				kind: "hazard",
				title: {
					es: `GDACS: ${g.typeEs}, ${g.name} (alerta ${{ green: "verde", orange: "naranja", red: "roja" }[g.alertLevel] ?? g.alertLevel})`,
					en: `GDACS: ${g.name} (${g.alertLevel} alert)`,
				},
				figures: figures({ alertLevel: g.alertLevel, alertScore: finite(g.alertScore) }),
			};
		}
		case "gaceta-oficial": {
			const issue = v as unknown as GacetaIssue;
			const organs = new Set((e.attributes.gazetteOrgans as string[] | undefined) ?? []);
			const acts = organs.size ? issue.acts.filter((x) => organs.has(x.organ)) : issue.acts;
			const first = acts.find((x) => x.title)?.title ?? null;
			const n = num(issue.number);
			return {
				...base,
				kind: "gazette",
				title: {
					es: `Gaceta Oficial ${issue.kind} Nº ${n}: ${first ?? count(acts.length, "acto", "actos")}${first && acts.length > 1 ? ` (y ${count(acts.length - 1, "acto más", "actos más")})` : ""}`,
					en: `Official Gazette ${issue.kind} No. ${n}: ${first ?? count(acts.length, "act", "acts", "en")}${first && acts.length > 1 ? ` (and ${count(acts.length - 1, "more act", "more acts", "en")})` : ""}`,
				},
				figures: figures({ acts: acts.length }),
			};
		}
		case "ripestat-prefixes": {
			const rt = v as unknown as AsnRouting;
			return {
				...base,
				kind: "routing",
				title: {
					es: `RIPEstat: cambio de prefijos anunciados por AS${rt.asn}`,
					en: `RIPEstat: change in prefixes announced by AS${rt.asn}`,
				},
				figures: null,
			};
		}
		case "gdelt-ve": {
			const a = v as unknown as GdeltArticle;
			const roots = (a.roots ?? []).map((r) => CAMEO_ROOTS[r]).filter((x) => x !== undefined);
			const what = (lang: "es" | "en") =>
				roots.map((r) => r[lang]).join(", ") || (lang === "es" ? "eventos" : "events");
			return {
				...base,
				kind: "gdelt",
				title: {
					es: `Codificación automática de GDELT: ${what("es")} en ${a.place} (${a.domain})`,
					en: `GDELT automatic coding: ${what("en")} in ${a.place} (${a.domain})`,
				},
				figures: figures({
					events: finite(a.events),
					tone: finite(a.tone),
					goldsteinMin: finite(a.goldsteinMin),
				}),
			};
		}
		case "goes-glm": {
			const w = v as unknown as LightningWindow;
			const n = flashesFor(e, w);
			const where =
				e.type === "infrastructure"
					? `la celda de ${num(LINK_RULES.lightning.cellDeg)}° de ${e.name.es}`
					: e.name.es;
			const whereEn =
				e.type === "infrastructure"
					? `the ${num(LINK_RULES.lightning.cellDeg, "en")}° cell of ${e.name.en}`
					: e.name.en;
			return {
				...base,
				kind: "lightning",
				title: {
					es: `Rayos detectados por GLM: ${count(n, "destello", "destellos")} en 15 min en ${where}${w.complete ? "" : " (ventana incompleta)"}`,
					en: `Lightning detected by GLM: ${count(n, "flash", "flashes", "en")} in 15 min in ${whereEn}${w.complete ? "" : " (incomplete window)"}`,
				},
				figures: figures({ flashes: n, venezuela: finite(w.venezuela), complete: w.complete === true }),
			};
		}
		case "iptv-ve":
		case "radio-browser": {
			const tv = r.source === "iptv-ve";
			const c = v as unknown as Partial<IptvEntry & RadioEntry>;
			const name = `${c.name ?? ""}${!tv && c.frequency ? ` ${c.frequency}` : ""}`;
			return {
				...base,
				kind: "broadcast",
				title: {
					es: `${tv ? "Canal de TV" : "Radio"} en el directorio: ${name}${c.ownership === "state" ? " (medio estatal)" : ""}`,
					en: `${tv ? "TV channel" : "Radio station"} in the directory: ${name}${c.ownership === "state" ? " (state media)" : ""}`,
				},
				figures: figures({ ownership: c.ownership ?? null, states: (c.states ?? []).join(" ") }),
			};
		}
		case "ofac-sdn": {
			const c = v as unknown as ChangeValue;
			const s = c.subject;
			const who =
				s.type === "entity" || s.type === "vessel"
					? s.name
					: s.type === "individual" && s.named
						? `${s.name}${s.title ? ` (${s.title})` : s.wikidata ? ` (${s.wikidata.position})` : ""}`
						: "";
			const act = {
				add: { es: "designación", en: "designation" },
				remove: { es: "exclusión de la lista", en: "removal from the list" },
				update: { es: "cambio en el registro", en: "record update" },
			}[c.action];
			return {
				...base,
				kind: "sanction",
				title: { es: `OFAC: ${act.es} de ${who}`, en: `OFAC: ${act.en} of ${who}` },
				figures: figures({ action: c.action, programs: c.programs.join(" "), publication: c.publicationId }),
			};
		}
		case "ofac-venezuela": {
			const d = v as unknown as GeneralLicence | RecentAction;
			const title =
				d.kind === "licence"
					? {
							es: `OFAC: licencia general ${d.id} (${d.issued}): ${d.title}`,
							en: `OFAC: general licence ${d.id} (${d.issued}): ${d.title}`,
						}
					: { es: `OFAC: ${d.title}`, en: `OFAC: ${d.title}` };
			return { ...base, kind: "licence", title, figures: null };
		}
		case "federal-register": {
			const d = v as unknown as FrDocument;
			const t = d.title ?? d.type;
			return {
				...base,
				kind: "licence",
				title: {
					es: `Federal Register (${d.publicationDate}): ${t}`,
					en: `Federal Register (${d.publicationDate}): ${t}`,
				},
				figures: null,
			};
		}
		case "wikidata-officials": {
			const o = v as unknown as OfficeValue;
			const t = o.latestTerm;
			const status = {
				current: "en el cargo",
				ended: "terminado, sin sucesor en Wikidata",
				unknown: "sin fecha de fin en Wikidata",
			}[o.status];
			return {
				...base,
				kind: "office",
				title: {
					es: t
						? `${o.office.label}: ${t.person.label}, desde ${t.start} (${status})`
						: `${o.office.label}: sin período fechado en Wikidata`,
					en: t
						? `${o.office.label}: ${t.person.label}, since ${t.start} (${o.status})`
						: `${o.office.label}: no dated term in Wikidata`,
				},
				figures: figures({ status: o.status, start: t?.start ?? null, end: t?.end ?? null }),
			};
		}
		case "bcv-intervention": {
			const i = v as unknown as Intervention;
			return {
				...base,
				kind: "intervention",
				title: {
					es: `BCV: intervención cambiaria Nº ${i.number} a ${figureText(i.vesPerEur, "es")} Bs. por euro`,
					en: `BCV: exchange intervention No. ${i.number} at ${figureText(i.vesPerEur, "en")} Bs. per euro`,
				},
				figures: figures({ vesPerEur: finite(i.vesPerEur), number: i.number }),
			};
		}
		case "polymarket":
		case "kalshi": {
			const m = v as unknown as PredictionMarket;
			const venue = r.source === "polymarket" ? "Polymarket" : "Kalshi";
			const price = m.lastPrice === null ? null : Math.round(m.lastPrice * 1000) / 10;
			return {
				...base,
				kind: "market",
				title: {
					es: `${venue}: ${m.question}${price === null ? "" : ` (último precio ${num(price, "es", 1)} %: un precio, no un pronóstico)`}`,
					en: `${venue}: ${m.question}${price === null ? "" : ` (last price ${num(price, "en", 1)} %: a price, not a forecast)`}`,
				},
				url: m.eventUrl,
				figures: figures({
					lastPrice: finite(m.lastPrice),
					volume: finite(m.volume),
					volumeUnit: m.volumeUnit,
				}),
			};
		}
		case INCIDENTS_SOURCE: {
			const inc = v as unknown as Incident;
			return {
				...base,
				at: inc.startAt,
				kind: "incident",
				title: { es: inc.title.es, en: inc.title.en },
				url: `/api/v1/incidents/${encodeURIComponent(inc.id)}`,
				source: sourceOf(ctx, null, null, "Vigía (incidentes)"),
				figures: { corroboration: inc.corroboration, tier: inc.tier },
			};
		}
		case CROWD_SOURCE: {
			const c = v as unknown as CrowdAggregate;
			const label = crowdLabel(c.service);
			const text = crowdText(c);
			return {
				...base,
				kind: "crowd",
				title: { es: `${label.es}: ${text.es}`, en: `${label.en}: ${text.en}` },
				url: `/api/v1/entities/${encodeURIComponent(e.id)}`,
				source: { ...CROWD_FIGURE_SOURCE, sourceUrl: r.sourceUrl },
				// CC0: Vigía's own counts are always passed on.
				figures: {
					service: c.service,
					reports: c.reports,
					si: c.answers?.si ?? null,
					no: c.answers?.no ?? null,
					intermitente: c.answers?.intermitente ?? null,
					held: c.held,
					flagged: c.flagged,
					windowMs: c.windowMs,
					method: crowdMethod(c.level, c.minReporters),
				},
			};
		}
		case "carbon-mapper":
		case "modis-floods":
		case "gfw-alerts":
		case "gfw-vessels":
		case "cloudflare-radar":
		case "adsb-flights": {
			const s = spaceTimelineItem(e, r.source, v);
			return { ...base, kind: s.kind, title: s.title, figures: figures(s.figures) };
		}
		default: {
			const n = v as unknown as NewsItem;
			const outlet = ctx.registry.byCode(`feed:${r.source}`);
			return {
				...base,
				kind: "headline",
				title: { es: String(n.title ?? ""), en: String(n.title ?? "") },
				url: typeof n.link === "string" ? n.link : r.sourceUrl,
				source: { ...base.source, name: outlet?.name.es ?? base.source.name },
				figures: null,
			};
		}
	}
}

/**
 * The place of a GLM cell centre, remembered: the 0.25° grid over the region has about 2,700 cells, and a storm day
 * asks for the same ones in every window (≈9 µs each by point in polygon, measured 2026-09-28).
 */
const cellPlaces = new Map<string, ReturnType<typeof placeAt>>();
function cellPlace(lat: number, lon: number): ReturnType<typeof placeAt> {
	const k = `${lat},${lon}`;
	let p = cellPlaces.get(k);
	if (!p) {
		p = placeAt(lat, lon);
		cellPlaces.set(k, p);
	}
	return p;
}

/**
 * The flashes of a GLM window that belong to this entity: its state's count; the cells whose centre lies in a
 * municipality or parish; the cell that contains a facility; the whole of Venezuela otherwise.
 */
export function flashesFor(e: Entity, w: LightningWindow): number {
	const cells = w.cells ?? [];
	if (e.type === "state") return w.byState?.[e.codes.iso ?? ""] ?? 0;
	if (e.type === "municipality" || e.type === "parish") {
		const code = e.codes.pcode;
		return cells.reduce((sum, [lat, lon, n]) => {
			const p = cellPlace(lat, lon);
			return sum + ((e.type === "municipality" ? p.municipality : p.parish) === code ? n : 0);
		}, 0);
	}
	if (e.type === "infrastructure" && e.point) {
		const d = LINK_RULES.lightning.cellDeg;
		const cy = Math.floor(e.point.lat / d);
		const cx = Math.floor(e.point.lon / d);
		return cells.find(([lat, lon]) => Math.floor(lat / d) === cy && Math.floor(lon / d) === cx)?.[2] ?? 0;
	}
	return w.venezuela ?? 0;
}

/** Timeline wording for the space and movement sources (figures are the entity's own share where the value has one). */
function spaceTimelineItem(
	e: Entity,
	source: string,
	v: Record<string, Json>,
): { kind: string; title: BilingualView; figures: TimelineItem["figures"] } {
	const fmt = (n: number) => new Intl.NumberFormat("es-VE", { maximumFractionDigits: 1 }).format(n);
	if (source === "carbon-mapper") {
		const p = v as unknown as MethanePlume;
		const rate = p.emissionKgH !== null ? `${fmt(p.emissionKgH)} ± ${fmt(p.uncertaintyKgH ?? 0)} kg/h` : null;
		return {
			kind: "plume",
			title: {
				es: `Pluma de metano vista (Carbon Mapper)${rate ? `, ${rate} según su estimación` : ""}`,
				en: `Methane plume seen (Carbon Mapper)${rate ? `, ${rate} by its estimate` : ""}`,
			},
			figures: { emissionKgH: p.emissionKgH, uncertaintyKgH: p.uncertaintyKgH, instrument: p.instrument },
		};
	}
	if (source === "modis-floods") {
		const d = v as unknown as FloodDay;
		const own =
			e.type === "country"
				? d.venezuela
				: e.type === "state"
					? d.states[e.codes.iso ?? ""]
					: d.municipalities[e.codes.pcode ?? ""];
		const km2 = own?.floodKm2 ?? null;
		const unseen =
			own && own.areaKm2 > 0 ? Math.round(((own.insufficientKm2 + own.nodataKm2) / own.areaKm2) * 100) : null;
		const seen = (es: boolean) =>
			km2 === null
				? ""
				: `: ${fmt(km2)} km²${unseen !== null ? (es ? ` (${unseen} % sin ver por nubes)` : ` (${unseen} % unseen, cloud)`) : ""}`;
		return {
			kind: "flood",
			title: {
				es: `Inundación vista por satélite (NASA MODIS)${seen(true)}, calculado por Vigía`,
				en: `Flood seen from space (NASA MODIS)${seen(false)}, computed by Vigía`,
			},
			figures: {
				floodKm2: km2,
				recurringKm2: own?.recurringKm2 ?? null,
				insufficientKm2: own?.insufficientKm2 ?? null,
			},
		};
	}
	if (source === "gfw-alerts") {
		const w = v as unknown as AlertsWeek;
		const own =
			e.type === "country"
				? w.venezuela
				: e.type === "state"
					? w.states?.[e.codes.iso ?? ""]
					: Object.values(w.municipalities ?? {})
							.filter((m) => m.municipality === e.codes.pcode)
							.reduce<{ forestHa: number[] } | null>(
								(acc, m) => ({ forestHa: m.forestHa.map((x, i) => x + (acc?.forestHa[i] ?? 0)) }),
								null,
							);
		const ha = own ? Math.round(((own.forestHa[1] ?? 0) + (own.forestHa[2] ?? 0)) * 10) / 10 : null;
		return {
			kind: "forest",
			title: {
				es: `Alertas en bosque natural, semana del ${w.week} (GFW)${ha !== null ? `: ${fmt(ha)} ha de confianza alta o máxima` : ""}`,
				en: `Natural forest alerts, week of ${w.week} (GFW)${ha !== null ? `: ${fmt(ha)} ha high or highest confidence` : ""}`,
			},
			figures: { forestHaHigh: ha, week: w.week ?? null },
		};
	}
	if (source === "gfw-vessels") {
		const d = v as unknown as VesselDay;
		return {
			kind: "ships",
			title: {
				es: `${d.detections} buques vistos por radar en la zona, ${d.withoutAis} sin AIS emparejado (Global Fishing Watch)`,
				en: `${d.detections} vessels seen by radar in the area, ${d.withoutAis} with no matching AIS (Global Fishing Watch)`,
			},
			figures: { detections: d.detections, withoutAis: d.withoutAis },
		};
	}
	if (source === "adsb-flights") {
		const f = v as unknown as Flight;
		const name = f.airlineName ?? f.airline;
		const route = f.route.join("–");
		return {
			kind: "flight",
			title: {
				es: `Vuelo ${f.callsign} (${name}) visto, ruta ${route}`,
				en: `Flight ${f.callsign} (${name}) seen, route ${route}`,
			},
			figures: { class: f.class, route },
		};
	}
	const r = v as unknown as CloudflareRadar;
	if (r.kind === "outage")
		return {
			kind: "radar",
			title: {
				es: `Cloudflare Radar: corte de internet${r.scope ? ` (${r.scope})` : ""}${r.cause ? `, causa según Cloudflare: ${r.cause.toLowerCase().replaceAll("_", " ")}` : ""}`,
				en: `Cloudflare Radar: internet outage${r.scope ? ` (${r.scope})` : ""}${r.cause ? `, cause per Cloudflare: ${r.cause.toLowerCase().replaceAll("_", " ")}` : ""}`,
			},
			figures: { cause: r.cause, outageType: r.outageType },
		};
	const a = r as Extract<CloudflareRadar, { kind: "anomaly" }>;
	return {
		kind: "radar",
		title: {
			es: `Cloudflare Radar: anomalía de tráfico ${a.status === "VERIFIED" ? "verificada" : "sin verificar"}${a.asnName ? ` en ${a.asnName}` : ""}`,
			en: `Cloudflare Radar: ${a.status === "VERIFIED" ? "verified" : "unverified"} traffic anomaly${a.asnName ? ` on ${a.asnName}` : ""}`,
		},
		figures: { status: a.status, asn: a.asn },
	};
}

export const TIMELINE_MAX = 500;

export function timelineView(
	ctx: EntityContext,
	id: string,
	from: number,
	to: number,
	limit: number,
	kinds?: readonly string[],
): TimelineView | null {
	const e = ctx.registry.get(id);
	if (!e) return null;
	const sources = kinds?.length
		? new Set(kinds.flatMap((k) => [...(TIMELINE_KINDS[k] ?? [])]))
		: DEFAULT_TIMELINE_SOURCES;
	const { rows, truncated } = ctx.links.linked(id, from, to, Math.min(TIMELINE_MAX, limit), sources);
	// A headline carried by two feeds of one outlet (or re-published under a new link) is one item.
	const seen = new Set<string>();
	const unique = rows.filter((r) => {
		// A public instance never shows what a personal Vigía published on the same database (minimum of one).
		if (r.source === CROWD_SOURCE) return showable(ctx.store, (r.value as { mode?: unknown } | null)?.mode);
		const title = (r.value as { title?: unknown } | null)?.title;
		if (!OUTLET_FEEDS.has(r.source) || typeof title !== "string") return true;
		const key = headlineKey(r.source, title);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return {
		entity: refOf(e),
		from,
		to,
		// Newest first by the time each item is about (an incident is dated by its start, stored by its last evidence).
		items: unique.map((r) => timelineItem(ctx, e, r)).sort((a, b) => b.at - a.at),
		truncated,
		rules: linkRulesText(),
		backlog: ctx.links.backlog(),
	};
}

// ——— search and locate ———

/** Search results; `truncated` says more matched than `limit`. */
export function searchView(
	reg: Registry,
	query: string,
	type: Entity["type"] | null,
	limit: number,
): SearchView {
	const hits = reg.search(query, { type: type ?? undefined, limit: limit + 1 });
	return {
		query,
		type,
		truncated: hits.length > limit,
		results: hits.slice(0, limit).map((h) => {
			const parent = reg.get(h.entity.parents[0] ?? "");
			return {
				entity: refOf(h.entity),
				parent: parent ? refOf(parent) : null,
				score: h.score,
				matched: h.matched,
			};
		}),
	};
}

export const LOCATE_RADIUS_KM = 5;

export function locateView(
	ctx: Pick<EntityContext, "registry" | "linker">,
	lat: number,
	lon: number,
): LocateView {
	const links = ctx.linker.place(lat, lon);
	const places = links.flatMap((l) => {
		const x = ctx.registry.get(l.entity);
		return x ? [refOf(x)] : [];
	});
	const p = placeAt(lat, lon);
	const kinds = Object.fromEntries(KIND_ORDER.map((k) => [k, LOCATE_RADIUS_KM]));
	const near = ctx.linker.near(lat, lon, kinds).flatMap((l) => {
		const x = ctx.registry.get(l.entity);
		return x ? [{ entity: refOf(x), km: l.km ?? 0, relation: "near" as const }] : [];
	});
	return {
		lat,
		lon,
		places,
		how: p.how === "snapped" ? "outside" : p.how,
		near: near.slice(0, 20),
		radiusKm: LOCATE_RADIUS_KM,
	};
}
