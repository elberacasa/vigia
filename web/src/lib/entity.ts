/**
 * The entity view model: everything the room knows about one entity (a place, a facility, a network, an outlet, an
 * institution), as the inspector and the entity pages draw it.
 *
 * Two builders fill it. Online, `lib/entity-api.ts` adapts the server's linked view (`/api/v1/entities/{id}`, the
 * ontology: every signal attached to the entity, its parents, children, facilities, population). Offline, or before
 * the server answers, this file builds a state's or a municipality's model from the panels the page already has (no
 * extra request). The components take the model, never the panels or the payload. Rules kept as everywhere: every
 * fact carries its source, its freshness verdict and the time its source says it is true; no arithmetic beyond
 * counting rows the server already classified.
 */
import type { ConnectivityView, PlaceStatus } from "../panels/Connectivity.tsx";
import type { FiresView, WeatherView } from "../panels/Earth.tsx";
import type { NightlightsView } from "../panels/Imagery.tsx";
import type { IncidentItem, IncidentsView } from "../panels/Incidents.tsx";
import type { NewsView, Story } from "../panels/News.tsx";
import type { QuakesView } from "../panels/Quakes.tsx";
import { type Lang, num, pct } from "./format.ts";
import { groupFreshness, type HealthMap } from "./fresh.ts";
import { municipalitySlug, STATE_SLUG, slugify, stateName } from "./states.ts";
import { TOPICS, type Topic } from "./topics.ts";

export type EntityKind =
	| "country"
	| "state"
	| "municipality"
	| "parish"
	| "infrastructure"
	| "network"
	| "outlet"
	| "institution"
	| "camera";
export type FactTone = "normal" | "ok" | "warn" | "alert" | "muted";
/** How a figure was obtained, shown next to it: a measurement is never dressed as a report, nor a model as either. */
export type Basis =
	| "measured"
	| "forecast"
	| "keyword"
	| "name"
	| "reported"
	| "official"
	| "derived"
	| "quote"
	/** Vigía's judgement of a feed's freshness ("al día", "atrasado"). */
	| "status";

export interface EntityRef {
	/** Stable ontology id: "ve.zulia", "ve.zulia.maracaibo", "infra.guri", "net.cantv", "inst.bcv". */
	id: string;
	kind: EntityKind;
	name: string;
	/** Address of its page (/lugar/zulia, /infra/guri); null for an id this client cannot address. */
	path: string | null;
	parent?: EntityRef;
	/** Subtype in words ("Planta eléctrica", "Medio independiente"); absent for places. */
	sub?: string;
}

export interface Provenance {
	/** Who says it: "IODA (Georgia Tech)", "USGS · FUNVISIS". */
	source: string;
	/** Adapter ids behind it: the source sheet opens for one of them. */
	feeds: readonly string[];
	url?: string;
	/** When the source says it is true (UTC ms); null when the source gives no time. */
	observedAt: number | null;
	/** When Vigía read it (a count over linked rows has no observed time, only this); null when unknown. */
	fetchedAt?: number | null;
	basis: Basis;
}

export interface EntityFact {
	key: string;
	label: string;
	value: string;
	unit?: string;
	tone: FactTone;
	/** One line under the value. */
	detail?: string;
	prov: Provenance;
	/** Every feed behind it is past its budget: shown with the age of its last good data, never as live. */
	stale: boolean;
	/** A figure of an ancestor (the state, the ISP) shown on this entity's page, labelled as such. */
	inherited?: boolean;
	/** Computed by Vigía (a count, a sum, a comparison): shown as "calculado por Vigía" with its method. */
	computed?: boolean;
	method?: string;
	/** The value is a sentence, not a figure (drawn smaller). */
	textValue?: boolean;
	/** The signals table's words (lib/entity-signals.ts); absent on a model built from the panels. */
	name?: string;
	sourceShort?: string;
	/** Against its own normal, as the server gives it ("62 % · sondeo"). */
	vs?: string;
	/** One quiet line of context under the name. */
	context?: string;
	/** Nothing to say now, and why: the table folds it into "Sin datos ahora". */
	silent?: string;
	/** Every part behind the value, shown when the row opens. */
	breakdown?: string;
	/** Whose figure it is when an ancestor's ("estado Zulia"), and as a phrase ("del estado Zulia", "de Venezuela"). */
	scopeName?: string;
	scopeOf?: string;
	/** The server's own sentence, shown when the row opens. */
	text?: string;
}

export interface EntityItem {
	id: string;
	title: string;
	/** An outside link (the article, the source's page). */
	url?: string;
	/** Another entity's page inside Vigía. */
	entity?: EntityRef;
	/** An incident of the room: the title opens it in the incidents panel. */
	incident?: string;
	at: number;
	/** "3 medios · Política", "M4,3 · USGS". */
	meta?: string;
	tone?: FactTone;
	/** Unverified reports carry the label ("sin verificar"). */
	unverified?: boolean;
	/** Keyword location carries its label ("palabra clave"). */
	keyword?: boolean;
	/** A labelled estimate attached to the item (people living in an incident's area). */
	estimate?: { label: string; value: string; source: string; note: string; caveat: string; method: string };
}

export interface EntitySection {
	key: string;
	title: string;
	facts: EntityFact[];
	items: EntityItem[];
	/** What an empty section means, said plainly ("Ningún sismo con epicentro aquí en 30 días"). */
	empty?: string;
	/** How the section is built, when it is not obvious ("Ubicación por palabra clave"). */
	note?: string;
	/** The module that holds the full panel. */
	module?: string;
	prov?: Provenance;
}

/** People living in the entity's area: two sources side by side, never blended (DECISIONS, ontology). */
export interface PopulationModel {
	census: { people: number; source: string; licence: string; note: string } | null;
	worldpop: { people: number; source: string; licence: string; note: string } | null;
	computed: boolean;
	method: string;
}

export interface NearbyModel {
	rule: string;
	/** The list is the nearest first (to the entity's point); by kind when the entity has no point. */
	nearest: boolean;
	/** Facilities inside or near it, by kind, with the count of each (the list is truncated, the counts are not). */
	byKind: { kind: string; label: string; n: number }[];
	items: { ref: EntityRef; km: number; inside: boolean }[];
	truncated: boolean;
}

export interface EntityModel {
	ref: EntityRef;
	/** Newest datum among the facts (UTC ms). */
	asOf: number | null;
	status: { tone: FactTone; text: string };
	/** The few figures that describe the entity right now. */
	facts: EntityFact[];
	sections: EntitySection[];
	/** Places inside it (municipalities of a state), when the model has no grouped children. */
	children: EntityRef[];
	/** "api": the server's linked view; "panels": built on this device from the loaded panels (offline fallback). */
	origin: "api" | "panels";
	/** Ancestors, the country first. */
	crumbs?: EntityRef[];
	/** External codes (P-code, ISO, ASN, IATA/ICAO, OSM). */
	codes?: { label: string; value: string; url?: string }[];
	/** What the dataset says about it (capacity, operator tag, airport type). */
	attributes?: { label: string; value: string; key?: string }[];
	point?: { lat: number; lon: number } | null;
	/** What the map inset outlines: the state, and a municipality inside it. */
	map?: { iso: string | null; muni: string | null };
	relations?: { label: string; ref: EntityRef }[];
	nearby?: NearbyModel | null;
	childGroups?: { key: string; label: string; total: number; items: EntityRef[]; truncated: boolean }[];
	population?: PopulationModel | null;
	/** Where the entity itself comes from (not its signals). */
	dataset?: {
		name: string;
		licence: string;
		licenceUrl: string;
		url: string;
		attribution: string;
		retrieved: string;
	};
	/** The API path of its timeline. */
	timeline?: string | null;
	/** How its signals are linked to it (code, never a model). */
	rules?: string[];
	/** Archived observations the link index has not reached yet (after a restart). */
	backlog?: number;
	/** The header strip's key facts (lib/entity-signals.ts `keyFacts`). */
	keyFacts?: import("./entity-signals.ts").KeyFact[];
	/**
	 * "Lo inusual ahora" about it or its state (the anomaly engine's items, as the server sends them; words in
	 * lib/anomaly-view.ts).
	 */
	anomalies?: import("../../../src/ontology/view.ts").AnomalyItem[];
}

/** The slice of /api/panels this reads (structural: the full panel views fit). */
export interface EntityInput {
	connectivity?: ConnectivityView;
	weather?: WeatherView;
	fires?: FiresView;
	nightlights?: NightlightsView;
	news?: NewsView;
	quakes?: QuakesView;
	incidents?: IncidentsView;
	/** The news outlets' feed ids: the headline count is stale when none of them is current. */
	newsFeeds?: readonly string[];
}

const IODA_FEEDS = ["ioda-states"] as const;
const DAY = 86_400_000;

function tr(lang: Lang, es: string, en: string): string {
	return lang === "es" ? es : en;
}

/** "55 min", "8 h 24 min", "2 d 3 h": a duration in minutes as people say it. */
export function duration(min: number): string {
	const m = Math.max(0, Math.round(min));
	if (m < 60) return `${m} min`;
	if (m < 1440) return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`;
	const h = Math.round(m / 60);
	return h % 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${h / 24} d`;
}

function levelWord(level: PlaceStatus["level"], lang: Lang): string {
	switch (level) {
		case "normal":
			return tr(lang, "Normal", "Normal");
		case "drop":
			return tr(lang, "Caída de señal", "Signal drop");
		case "severe":
			return tr(lang, "Caída fuerte", "Severe drop");
		default:
			return tr(lang, "Sin datos", "No data");
	}
}

const LEVEL_TONE: Record<PlaceStatus["level"], FactTone> = {
	normal: "ok",
	drop: "warn",
	severe: "alert",
	"no-data": "muted",
};

const SIGNAL_NAME: Record<string, { es: string; en: string }> = {
	bgp: { es: "Rutas (BGP)", en: "Routes (BGP)" },
	"ping-slash24": { es: "Sondeo activo", en: "Active probing" },
	"merit-nt": { es: "Telescopio de red", en: "Network telescope" },
};

export function stateRef(iso: string): EntityRef {
	const slug = STATE_SLUG.get(iso) ?? slugify(iso);
	return { id: `ve.${slug}`, kind: "state", name: stateName(iso), path: `/lugar/${slug}` };
}

/** A municipality's reference from its INE code and name (the names-only index the client ships). */
export function municipalityRef(muni: { code: string; name: string; stateIso: string }): EntityRef {
	const parent = stateRef(muni.stateIso);
	const slug = municipalitySlug(muni.name);
	return {
		id: `${parent.id}.${slug}`,
		kind: "municipality",
		name: muni.name,
		path: `${parent.path}/${slug}`,
		parent,
	};
}

function fact(f: Omit<EntityFact, "stale">, health: HealthMap, inherited = false): EntityFact {
	return { ...f, stale: groupFreshness(f.prov.feeds, health).stale, ...(inherited ? { inherited } : {}) };
}

function storyItem(s: Story, lang: Lang): EntityItem {
	const topics = s.topics
		.slice(0, 2)
		.map((k) => TOPICS[k]?.[lang] ?? k)
		.join(", ");
	const outlets =
		s.outletCount === 1
			? tr(lang, "1 medio", "1 outlet")
			: tr(lang, `${s.outletCount} medios`, `${s.outletCount} outlets`);
	return {
		id: `story:${s.id}`,
		title: s.title,
		url: s.url,
		at: s.at,
		meta: topics ? `${outlets} · ${topics}` : outlets,
	};
}

function incidentItem(i: IncidentItem, lang: Lang): EntityItem {
	return {
		id: `incident:${i.id}`,
		incident: i.id,
		title: lang === "es" ? i.title.es : i.title.en,
		at: i.lastEvidenceAt,
		meta: `${lang === "es" ? i.strength.es : i.strength.en} · ${
			i.status === "active" ? tr(lang, "activo", "active") : tr(lang, "terminado", "ended")
		}`,
		tone: i.status === "active" ? (i.reportsOnly ? "warn" : "alert") : "muted",
		...(i.reportsOnly ? { unverified: true } : {}),
	};
}

/**
 * A state's model. `children` are its municipalities when the caller has the names (they live in a lazily loaded
 * index), otherwise empty.
 */
export function stateModel(
	iso: string,
	p: EntityInput,
	health: HealthMap,
	now: number,
	lang: Lang,
	children: readonly EntityRef[] = [],
): EntityModel {
	const ref = stateRef(iso);
	const facts: EntityFact[] = [];
	const sections: EntitySection[] = [];
	const conn = p.connectivity?.states.find((s) => s.kind === "state" && s.id === iso);
	const nightState = p.nightlights?.states.find((s) => s.iso === iso);
	const weather = p.weather?.capitals.find((c) => c.stateIso === iso);
	const fires = p.fires?.byState.find((f) => f.stateIso === iso);
	const newsState = p.news?.byState[iso];
	const quakes = (p.quakes?.items ?? []).filter((q) => q.state === iso);
	const incidents = [...(p.incidents?.incidents ?? [])].filter((i) => i.state === iso);
	const active = incidents.filter((i) => i.status === "active");

	// Internet: the level the server gave the state, with its own headline.
	if (conn) {
		facts.push(
			fact(
				{
					key: "internet",
					label: tr(lang, "Internet", "Internet"),
					value: levelWord(conn.level, lang),
					tone: LEVEL_TONE[conn.level],
					detail: conn.headline,
					prov: {
						source: "IODA (Georgia Tech)",
						feeds: [conn.feed || IODA_FEEDS[0]],
						url: conn.sourceUrl,
						observedAt: conn.lastBinAt,
						basis: "measured",
					},
				},
				health,
			),
		);
	}
	if (active.length) {
		facts.push(
			fact(
				{
					key: "incidents",
					label: tr(lang, "Incidentes activos", "Active incidents"),
					value: String(active.length),
					tone: active.some((i) => !i.reportsOnly) ? "alert" : "warn",
					detail: (lang === "es" ? active[0]?.title.es : active[0]?.title.en) ?? "",
					prov: {
						source: tr(lang, "Vigía: señales que coinciden", "Vigía: agreeing signals"),
						feeds: p.incidents?.feeds ?? IODA_FEEDS,
						observedAt: Math.max(...active.map((i) => i.lastEvidenceAt)),
						basis: active.every((i) => i.reportsOnly) ? "reported" : "measured",
					},
				},
				health,
			),
		);
	}
	if (nightState) {
		const comparable = nightState.comparable && nightState.pctChange !== null;
		facts.push(
			fact(
				{
					key: "nightlights",
					label: tr(lang, "Luz nocturna", "Night light"),
					value: comparable
						? pct(nightState.pctChange as number, 0, lang)
						: tr(lang, "Sin comparar", "Not compared"),
					tone:
						comparable && (nightState.pctChange as number) <= -30 ? "warn" : comparable ? "normal" : "muted",
					detail: comparable
						? tr(lang, "frente a su línea base", "against its baseline")
						: nightState.qualityNote,
					prov: {
						source: "NASA Black Marble (VIIRS)",
						feeds: ["gibs-nightlights"],
						...(p.nightlights?.sourceUrl ? { url: p.nightlights.sourceUrl } : {}),
						observedAt: p.nightlights?.observedAt ?? null,
						basis: "measured",
					},
				},
				health,
			),
		);
	}
	if (weather) {
		facts.push(
			fact(
				{
					key: "weather",
					label: tr(lang, `Clima en ${weather.capital}`, `Weather in ${weather.capital}`),
					value: `${num(weather.temperatureC, 0, lang)}°`,
					tone: weather.next24h.stormHours ? "warn" : "normal",
					detail: `${weather.labelEs} · ${tr(lang, "24 h", "24 h")}: ${num(weather.next24h.totalPrecipMm, 1, lang)} mm${
						weather.next24h.stormHours
							? tr(
									lang,
									`, ${weather.next24h.stormHours} h de tormenta`,
									`, ${weather.next24h.stormHours} h of storms`,
								)
							: ""
					}`,
					prov: {
						source: tr(lang, "Open-Meteo (modelo)", "Open-Meteo (model)"),
						feeds: [p.weather?.feed ?? "open-meteo-weather"],
						...(p.weather?.sourceUrl ? { url: p.weather.sourceUrl } : {}),
						observedAt: weather.observedAt,
						basis: "forecast",
					},
				},
				health,
			),
		);
	}
	if (fires) {
		facts.push(
			fact(
				{
					key: "fires",
					label: tr(lang, "Focos de calor, 24 h", "Heat spots, 24 h"),
					value: String(fires.likelyFires24h),
					tone: "normal",
					detail: fires.persistent24h
						? tr(
								lang,
								`${fires.persistent24h} más en fuentes persistentes (industria)`,
								`${fires.persistent24h} more at persistent (industrial) sources`,
							)
						: tr(lang, "probables incendios", "likely fires"),
					prov: {
						source: "NASA FIRMS (VIIRS)",
						feeds: [p.fires?.feed ?? "firms-fires"],
						...(p.fires?.sourceUrl ? { url: p.fires.sourceUrl } : {}),
						observedAt: p.fires?.newestDetectionAt ?? null,
						basis: "measured",
					},
				},
				health,
			),
		);
	}
	const newestStory =
		(newsState?.top ?? []).map((id) => p.news?.stories[id]?.at ?? 0).reduce((a, b) => Math.max(a, b), 0) ||
		null;
	if (newsState) {
		facts.push(
			fact(
				{
					key: "news",
					label: tr(lang, "Titulares, 24 h", "Headlines, 24 h"),
					value: String(newsState.items),
					tone: "normal",
					detail: tr(lang, `${newsState.stories} historias`, `${newsState.stories} stories`),
					prov: {
						source: tr(lang, "Prensa, ubicada por palabra clave", "Press, located by keyword"),
						feeds: p.newsFeeds ?? [],
						// The newest located headline, not the time the panel was computed.
						observedAt: newestStory,
						basis: "keyword",
					},
				},
				health,
			),
		);
	}
	const month = quakes.filter((q) => now - q.at < 30 * DAY);
	facts.push(
		fact(
			{
				key: "quakes",
				label: tr(lang, "Sismos, 30 días", "Earthquakes, 30 days"),
				value: String(month.length),
				tone: month.some((q) => q.maxMag >= 4.5 && now - q.at < DAY) ? "warn" : "normal",
				detail: month[0]
					? tr(
							lang,
							`el mayor M${num(Math.max(...month.map((q) => q.maxMag)), 1, lang)}`,
							`largest M${num(Math.max(...month.map((q) => q.maxMag)), 1, lang)}`,
						)
					: tr(lang, "con epicentro en el estado", "with an epicentre in the state"),
				prov: {
					source: "USGS · FUNVISIS",
					feeds: ["usgs-quakes", "funvisis-quakes"],
					observedAt: month[0]?.at ?? null,
					basis: "measured",
				},
			},
			health,
		),
	);

	// Sections: the lists behind the figures.
	sections.push({
		key: "incidents",
		title: tr(lang, "Incidentes", "Incidents"),
		facts: [],
		items: incidents
			.sort((a, b) => b.lastEvidenceAt - a.lastEvidenceAt)
			.slice(0, 6)
			.map((i) => incidentItem(i, lang)),
		empty: tr(
			lang,
			"Ninguna coincidencia de fuentes independientes sobre este estado.",
			"No agreement of independent sources about this state.",
		),
		note: tr(
			lang,
			"Un incidente es una coincidencia de familias de fuentes independientes en un lugar y un rato; la fuerza es cuántas coinciden.",
			"An incident is independent source families agreeing about one place and time; its strength is how many agree.",
		),
		module: "situacion",
	});
	if (conn) {
		sections.push({
			key: "internet",
			title: tr(lang, "Internet por señal", "Internet by signal"),
			facts: conn.signals.map((s) =>
				fact(
					{
						key: `signal:${s.signal}`,
						label: SIGNAL_NAME[s.signal]?.[lang] ?? s.signal,
						value: s.pctOfBaseline === null ? "—" : `${num(s.pctOfBaseline, 0, lang)} %`,
						tone: LEVEL_TONE[s.level],
						detail: s.noData ?? tr(lang, "del nivel habitual a esta hora", "of the usual level at this hour"),
						prov: {
							source: "IODA",
							feeds: [conn.feed || IODA_FEEDS[0]],
							url: conn.sourceUrl,
							observedAt: s.observedAt,
							basis: "measured",
						},
					},
					health,
				),
			),
			items: (p.connectivity?.events ?? [])
				.filter(
					(e) => e.kind === "state" && (e.key === iso || e.name === conn.name) && now - e.startAt < 7 * DAY,
				)
				.slice(0, 5)
				.map((e) => ({
					id: `outage:${e.id}`,
					title: tr(
						lang,
						`Caída de señal · ${duration(e.durationMin)}`,
						`Signal drop · ${duration(e.durationMin)}`,
					),
					url: e.url,
					at: e.startAt,
					meta: e.openAtFetch ? tr(lang, "en curso", "ongoing") : "IODA",
					tone: e.openAtFetch ? "warn" : "muted",
				})),
			empty: tr(lang, "Sin caídas registradas en 7 días.", "No drops recorded in 7 days."),
			module: "internet",
		});
	}
	const stories = (newsState?.top ?? [])
		.map((id) => p.news?.stories[id])
		.filter((s): s is Story => s !== undefined)
		.slice(0, 6);
	const topics = newsState
		? (Object.entries(newsState.topics) as [Topic, number][])
				.sort((a, b) => b[1] - a[1])
				.slice(0, 4)
				.map(([k, n]) => `${TOPICS[k]?.[lang] ?? k} ${n}`)
				.join(" · ")
		: "";
	sections.push({
		key: "news",
		title: tr(lang, "Noticias, 24 h", "News, 24 h"),
		facts: [],
		items: stories.map((s) => storyItem(s, lang)),
		empty: tr(lang, "Ningún titular ubicado aquí en 24 h.", "No headline located here in 24 h."),
		note: `${topics ? `${topics}. ` : ""}${tr(lang, "Ubicación por palabra clave.", "Located by keyword.")}`,
		module: "noticias",
	});
	sections.push({
		key: "quakes",
		title: tr(lang, "Sismos, 30 días", "Earthquakes, 30 days"),
		facts: [],
		items: month.slice(0, 5).map((q) => ({
			id: `quake:${q.id}`,
			title: `M${num(q.maxMag, 1, lang)} · ${q.placeEs}`,
			...((q.usgs ?? q.funvisis)?.url ? { url: (q.usgs ?? q.funvisis)?.url as string } : {}),
			at: q.at,
			meta: [q.funvisis ? "FUNVISIS" : null, q.usgs ? "USGS" : null].filter(Boolean).join(" · "),
			tone: q.maxMag >= 4.5 ? "warn" : "normal",
		})),
		empty: tr(
			lang,
			"Ninguno registrado con epicentro en el estado.",
			"None recorded with an epicentre in the state.",
		),
		module: "tierra",
	});

	const country: EntityRef = { id: "ve", kind: "country", name: "Venezuela", path: "/lugar" };
	return {
		ref,
		asOf: newest(facts, now),
		status: verdict(facts, lang),
		facts,
		sections,
		children: [...children],
		origin: "panels",
		crumbs: [country],
		codes: [{ label: "ISO 3166-2", value: iso }],
		map: { iso, muni: null },
	};
}

/** Newest datum among the facts, never in the future (UTC ms). */
export function newest(facts: readonly EntityFact[], now: number): number | null {
	const times = facts.map((f) => f.prov.observedAt).filter((t): t is number => t !== null && t <= now);
	return times.length ? Math.max(...times) : null;
}

/**
 * The verdict line: the worst anomaly (a stale one says so); "no anomaly" only when at least one current
 * measurement says normal, never from silence or from old data.
 */
export function verdict(facts: readonly EntityFact[], lang: Lang): { tone: FactTone; text: string } {
	const worst = facts.find((f) => f.tone === "alert") ?? facts.find((f) => f.tone === "warn");
	const measuredOk = facts.some((f) => f.tone === "ok" && !f.stale && f.prov.basis === "measured");
	if (worst)
		return {
			tone: worst.tone,
			text: `${worst.label}: ${worst.value}${worst.stale ? ` (${tr(lang, "desactualizado", "out of date")})` : ""}`,
		};
	if (measuredOk)
		return {
			tone: "ok",
			text: tr(lang, "Sin anomalías en las señales medidas", "No anomaly in the measured signals"),
		};
	if (facts.some((f) => f.prov.observedAt !== null))
		return {
			tone: "muted",
			text: tr(
				lang,
				"Sin mediciones al día para dar un veredicto",
				"No current measurement to give a verdict",
			),
		};
	return { tone: "muted", text: tr(lang, "Esperando datos", "Waiting for data") };
}

/**
 * A municipality's model: its own headlines (stories whose places name it), and its state's figures marked as the
 * state's (no layer is measured per municipality yet; saying so beats pretending).
 */
export function municipalityModel(
	muni: { code: string; name: string; stateIso: string },
	p: EntityInput,
	health: HealthMap,
	now: number,
	lang: Lang,
): EntityModel {
	const parent = stateRef(muni.stateIso);
	const ref = municipalityRef(muni);
	const state = stateModel(muni.stateIso, p, health, now, lang);
	const needle = muni.name.toLocaleLowerCase("es");
	const stories = Object.values(p.news?.stories ?? {})
		.filter(
			(s) =>
				(s.state === muni.stateIso || s.states.includes(muni.stateIso)) &&
				s.places.some((place) => place.toLocaleLowerCase("es") === needle),
		)
		.sort((a, b) => b.at - a.at)
		.slice(0, 8);
	const facts = state.facts
		.filter((f) => f.key !== "news")
		.map((f) => ({ ...f, inherited: true, label: `${f.label} (${tr(lang, "estado", "state")})` }));
	const sections: EntitySection[] = [
		{
			key: "news",
			title: tr(lang, "Noticias que lo nombran", "News that names it"),
			facts: [],
			items: stories.map((s) => storyItem(s, lang)),
			empty: tr(
				lang,
				`Ningún titular reciente nombra ${muni.name}.`,
				`No recent headline names ${muni.name}.`,
			),
			note: tr(lang, "Ubicación por palabra clave.", "Located by keyword."),
			module: "noticias",
		},
		// The state's lists, titled as the state's: none of them is about the municipality alone.
		...state.sections
			.filter((s) => s.key !== "news")
			.map((s) => ({
				...s,
				title: `${s.title} (${tr(lang, `estado ${parent.name}`, `${parent.name} state`)})`,
			})),
	];
	return {
		ref,
		asOf: state.asOf,
		// The status is the state's (no signal is measured per municipality): it says so.
		status: {
			tone: state.status.tone,
			text: `${parent.name} (${tr(lang, "estado", "state")}): ${state.status.text}`,
		},
		facts,
		sections,
		children: [],
		origin: "panels",
		crumbs: [...(state.crumbs ?? []), parent],
		codes: [{ label: "P-code", value: muni.code }],
		map: { iso: muni.stateIso, muni: muni.code },
	};
}
