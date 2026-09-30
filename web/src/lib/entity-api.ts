/**
 * The server's linked view of an entity (`/api/v1/entities/{id}`, src/ontology/entity-view.ts) adapted into the
 * client's view model (`EntityModel`, lib/entity.ts), plus the requests behind it (the entity, its timeline, a
 * search, "what is at this point") with a small cache for offline use.
 *
 * Nothing is computed here beyond picking the figure a line leads with and wording it: every number, count and sum
 * is the server's, with its source, times, stale flag and, for Vigía's own computations, "calculado por Vigía" and
 * the method. Loaded with the entity pages and the inspector, never in the first load.
 */
import type {
	EntityRef as ApiRef,
	EntityView as ApiView,
	IncidentBrief,
	LocateView,
	NowItem,
	SearchView,
	StoryBrief,
	TimelineView,
} from "../../../src/ontology/view.ts";
import type {
	Basis,
	EntityFact,
	EntityItem,
	EntityKind,
	EntityModel,
	EntityRef,
	EntitySection,
	FactTone,
	NearbyModel,
} from "./entity.ts";
import { newest, verdict } from "./entity.ts";
import { entityPath, stateIdOf } from "./entity-route.ts";
import { keyFacts, ofScope, scopePhrase, signalWords, unitOfLabel } from "./entity-signals.ts";
import { INFRA_PLURAL, kindWord, TYPE_PLURAL } from "./entity-words.ts";
import { int, type Lang, num, pct } from "./format.ts";
import { stateBySlug } from "./states.ts";

export type { ApiView, LocateView, SearchView, TimelineView };

const tr = (lang: Lang, es: string, en: string) => (lang === "es" ? es : en);

// ——— references ———

export function refFromApi(r: ApiRef, lang: Lang): EntityRef {
	const sub =
		r.type === "infrastructure" || r.type === "network" || r.type === "institution" || r.type === "outlet";
	return {
		id: r.id,
		kind: r.type as EntityKind,
		name: r.name[lang],
		path: entityPath(r.id),
		...(sub ? { sub: kindWord(r.type, r.kind, lang) } : {}),
	};
}

/** The state ISO code ("VE-V") of a place id, for the map and the linked selection; null outside places. */
export function isoOfPlace(id: string): string | null {
	const state = stateIdOf(id);
	return state ? stateBySlug(state.slice(3)) : null;
}

// ——— "now": one fact per live signal ———

const LEVEL: Record<string, { es: string; en: string; tone: FactTone }> = {
	normal: { es: "Normal", en: "Normal", tone: "ok" },
	drop: { es: "Caída de señal", en: "Signal drop", tone: "warn" },
	severe: { es: "Caída fuerte", en: "Severe drop", tone: "alert" },
	"no-data": { es: "Sin datos", en: "No data", tone: "muted" },
};

const FEED_STATE: Record<string, { es: string; en: string; tone: FactTone }> = {
	ok: { es: "Al día", en: "Current", tone: "normal" },
	stale: { es: "Atrasado", en: "Behind", tone: "warn" },
	degraded: { es: "Parcial", en: "Partial", tone: "warn" },
	failing: { es: "Falla", en: "Failing", tone: "alert" },
	locked: { es: "Necesita clave", en: "Needs a key", tone: "muted" },
	off: { es: "Apagado", en: "Off", tone: "muted" },
	pending: { es: "Pendiente", en: "Pending", tone: "muted" },
};

/** The gas-flare panel's statuses (src/panels/energy.ts statusOf) in the layer's own words. */
const FLARE_STATUS: Record<string, { es: string; en: string; tone: FactTone }> = {
	usual: { es: "Como de costumbre", en: "As usual", tone: "normal" },
	quiet: { es: "Sin quema", en: "No flaring", tone: "normal" },
	new: { es: "Quema nueva", en: "New flaring", tone: "warn" },
	up: { es: "Más que lo habitual", en: "Above usual", tone: "warn" },
	down: { es: "Menos que lo habitual", en: "Below usual", tone: "warn" },
	dark: { es: "Sin llama", en: "No flame", tone: "warn" },
	"no-baseline": { es: "Sin línea base aún", en: "No baseline yet", tone: "muted" },
	"no-data": { es: "Sin datos", en: "No data", tone: "muted" },
};

function n(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A published figure as people read it: "857,01" for a rate, "8,9 %" for a percentage, grouped integers. */
function figureValue(v: number, label: string, lang: Lang): { value: string; unit?: string } {
	if (/%/.test(label)) return { value: pct(v, 1, lang) };
	if (/Bs\./.test(label)) return { value: num(v, 2, lang), unit: "Bs." };
	if (Number.isInteger(v)) return { value: int(v, lang) };
	return { value: num(v, Math.abs(v) >= 100 ? 1 : 2, lang) };
}

interface Lead {
	value: string;
	unit?: string;
	tone: FactTone;
	/** The value is the sentence itself. */
	text?: boolean;
}

/** The figure a "now" line leads with, per signal; the full sentence stays underneath. */
export function leadOf(item: NowItem, lang: Lang): Lead {
	const f = item.figures;
	const count = (key: string, unit?: string): Lead | null => {
		const v = n(f[key]);
		return v === null ? null : { value: int(v, lang), ...(unit ? { unit } : {}), tone: "normal" };
	};
	switch (item.layer) {
		case "connectivity": {
			const w = LEVEL[String(f.level)];
			return w ? { value: w[lang], tone: w.tone } : { value: item.text[lang], tone: "muted", text: true };
		}
		case "probes": {
			const c = n(f.connected);
			const a = n(f.active);
			if (c === null || a === null) break;
			return {
				value: `${int(c, lang)}/${int(a, lang)}`,
				unit: tr(lang, "conectadas", "connected"),
				tone: (n(f.droppedLastHour) ?? 0) > 0 ? "warn" : "normal",
			};
		}
		case "nightlights": {
			const p = n(f.pctChange);
			if (f.comparable === true && p !== null)
				return { value: pct(p, 0, lang), tone: p <= -30 ? "warn" : "normal" };
			return { value: tr(lang, "Sin comparar", "Not compared"), tone: "muted" };
		}
		case "weather": {
			const c = n(f.temperatureC);
			if (c !== null) return { value: `${num(c, 0, lang)}°`, tone: "normal" };
			break;
		}
		case "fires":
			return (
				count("likelyFires24h") ??
				count("detections48h") ??
				count("detectionsNear48h") ??
				count("last24h") ?? { value: item.text[lang], tone: "normal", text: true }
			);
		case "quakes":
			return count("quakes30d") ?? { value: item.text[lang], tone: "normal", text: true };
		case "news":
			return count("headlines48h") ?? count("headlines24h") ?? { value: "—", tone: "muted" };
		case "gazette":
			return count("gazettes30d") ?? { value: "—", tone: "muted" };
		case "censorship": {
			const v = n(f.vsfBlocked);
			if (v !== null)
				return { value: int(v, lang), unit: tr(lang, "sitios bloqueados", "sites blocked"), tone: "normal" };
			const o = n(f.ooniFlagged);
			if (o !== null)
				return {
					value: int(o, lang),
					unit: tr(lang, "dominios con anomalías", "domains flagged"),
					tone: "normal",
				};
			break;
		}
		case "routing":
			return count("events", tr(lang, "cambios", "changes")) ?? { value: "—", tone: "muted" };
		case "figure": {
			const v = n(f.value);
			if (v !== null) return { ...figureValue(v, item.label.es, lang), tone: "normal" };
			break;
		}
		case "feed": {
			const w = FEED_STATE[String(f.state)];
			if (w) return { value: w[lang], tone: w.tone };
			break;
		}
		case "flares": {
			const w = FLARE_STATUS[String(f.status)];
			if (w) return { value: w[lang], tone: w.tone };
			break;
		}
		case "port-calls":
			return count("portCalls", tr(lang, "escalas", "calls")) ?? { value: "—", tone: "muted" };
		case "reservoir": {
			const m = n(f.levelM);
			if (m !== null) return { value: num(m, 2, lang), unit: "m", tone: "normal" };
			break;
		}
		case "lightning":
			return count("flashes24h", tr(lang, "destellos", "flashes")) ?? { value: "—", tone: "muted" };
		case "gdelt":
			return count("articles24h", tr(lang, "artículos", "articles")) ?? { value: "—", tone: "muted" };
		case "markets":
			return count("markets", tr(lang, "mercados", "markets")) ?? { value: "—", tone: "muted" };
		case "broadcast": {
			const tv = n(f.tvChannels);
			const radio = n(f.radioStations);
			if (tv === null || radio === null) break;
			return { value: `${int(tv, lang)} TV · ${int(radio, lang)} radio`, tone: "normal" };
		}
		case "office":
			// A public official in office, as Wikidata records it: the name leads, the term is the detail.
			// A term that ended with no successor recorded is never shown as the current holder.
			if (f.status === "ended")
				return { value: tr(lang, "Sin titular registrado", "No holder on record"), tone: "muted" };
			if (typeof f.holder === "string" && f.holder) return { value: f.holder, tone: "normal" };
			return { value: "—", tone: "muted" };
		case "sanctions":
			if (f.listed === true) return { value: tr(lang, "En la lista", "Listed"), tone: "normal" };
			if (f.listed === false) return { value: tr(lang, "No figura", "Not listed"), tone: "normal" };
			return { value: "—", tone: "muted" };
		case "crowd": {
			// "reportes de usuarios", with their count: never a percentage or a measurement's tone.
			const r = n(f.reports);
			if (r !== null)
				return {
					value: int(r, lang),
					unit: r === 1 ? tr(lang, "reporte", "report") : tr(lang, "reportes", "reports"),
					tone: "normal",
				};
			break;
		}
	}
	return { value: item.text[lang], tone: "normal", text: true };
}

const BASIS: Record<NowItem["basis"], Basis> = {
	measurement: "measured",
	official: "official",
	quote: "quote",
	report: "reported",
	derived: "derived",
};

/** "(estado Zulia)", "(CANTV)": whose figure it is when it belongs to an ancestor. */
function scopeWord(scope: ApiRef, lang: Lang): string {
	return scopePhrase(scope, lang);
}

/** Only http(s) links reach the page (a server string is never trusted as a scheme). */
export function safeUrl(url: string | null | undefined): string | undefined {
	return url && /^https?:\/\//i.test(url) ? url : undefined;
}

/**
 * How a headline count is linked, by the entity's type (the linker's rules): places by keyword location, outlets by
 * their own feeds, facilities and institutions by their names in the title (never the summary alone).
 */
function headlineBasis(type: string): Basis {
	if (type === "outlet") return "reported";
	if (type === "infrastructure" || type === "institution" || type === "network") return "name";
	return "keyword";
}

export function factOf(
	item: NowItem,
	entityId: string,
	index: number,
	lang: Lang,
	entityType = "state",
): EntityFact {
	const lead = leadOf(item, lang);
	const inherited = item.scope.id !== entityId;
	// Weather is a model's forecast whatever the payload calls it: the reader sees "pronóstico".
	// A feed's "al día / atrasado" is Vigía's own freshness judgement, not the publisher's word.
	const feedStatus = item.layer === "feed";
	const basis: Basis = item.layer === "weather" ? "forecast" : feedStatus ? "status" : BASIS[item.basis];
	const news = item.layer === "news";
	const words = signalWords(item, lang, entityType);
	const unit = lead.unit ?? (item.layer === "figure" ? unitOfLabel(item.label[lang]) : null);
	return {
		key: `${item.layer}:${index}`,
		label: inherited ? `${item.label[lang]} (${scopeWord(item.scope, lang)})` : item.label[lang],
		value: lead.value,
		...(unit ? { unit } : {}),
		name: words.name,
		sourceShort: words.source,
		...(words.vs ? { vs: words.vs } : {}),
		...(words.context ? { context: words.context } : {}),
		...(words.silent ? { silent: words.silent } : {}),
		...(words.breakdown ? { breakdown: words.breakdown } : {}),
		...(inherited ? { scopeName: scopeWord(item.scope, lang), scopeOf: ofScope(item.scope, lang) } : {}),
		text: item.text[lang],
		tone: lead.tone,
		...(lead.text
			? { textValue: true }
			: item.text[lang].startsWith(`${item.label[lang]}:`)
				? {}
				: { detail: item.text[lang] }),
		prov: {
			source: item.source.name,
			// User reports are Vigía's own count, not a feed with a health and a licence sheet: said in words.
			feeds: item.source.feed && item.layer !== "crowd" ? [item.source.feed] : [],
			...(safeUrl(item.source.sourceUrl) ? { url: safeUrl(item.source.sourceUrl) as string } : {}),
			observedAt: item.observedAt,
			fetchedAt: item.fetchedAt,
			basis: news ? headlineBasis(entityType) : basis,
		},
		stale: item.stale,
		...(inherited ? { inherited: true } : {}),
		...(item.computed
			? { computed: true, ...(item.method ? { method: item.method } : {}) }
			: feedStatus
				? {
						computed: true,
						method: tr(
							lang,
							"Vigía compara la última lectura buena del feed con su plazo de frescura: «al día» dentro del plazo, «atrasado» fuera de él.",
							"Vigía compares the feed's last good read with its freshness budget: “current” within it, “behind” past it.",
						),
					}
				: {}),
	};
}

// ——— lists ———

const RULE_WORD: Record<string, { es: string; en: string }> = {
	"text-place": { es: "palabra clave", en: "keyword" },
	"text-name": { es: "nombre en el título", en: "name in the title" },
	outlet: { es: "del medio", en: "the outlet's" },
};

export function storyItem(s: StoryBrief, lang: Lang): EntityItem {
	const rule = RULE_WORD[s.rule]?.[lang];
	const outlets = s.outlets > 1 ? tr(lang, `${s.outlets} medios`, `${s.outlets} outlets`) : null;
	return {
		id: `story:${s.url}`,
		title: s.title,
		...(safeUrl(s.url) ? { url: safeUrl(s.url) as string } : {}),
		at: s.at,
		// Keyword location has its own label on the item; "by name" is said in words.
		meta: [s.outletName, outlets, s.rule === "text-name" ? rule : null].filter(Boolean).join(" · "),
		...(s.rule === "text-place" ? { keyword: true } : {}),
	};
}

/** A modelled count of people, rounded so it does not read as a census: "4,5 millones", "186.000", "9.300". */
export function roughPeople(n: number, lang: Lang): string {
	if (n >= 1e6) return tr(lang, `${num(n / 1e6, 1, lang)} millones`, `${num(n / 1e6, 1, lang)} million`);
	if (n >= 1e5) return int(Math.round(n / 1e3) * 1e3, lang);
	if (n >= 1e3) return int(Math.round(n / 100) * 100, lang);
	return int(Math.round(n / 10) * 10, lang);
}

export function incidentItem(i: IncidentBrief, entityId: string, lang: Lang): EntityItem {
	const families = tr(
		lang,
		`${i.corroboration} ${i.corroboration === 1 ? "familia de fuentes" : "familias de fuentes"}`,
		`${i.corroboration} source ${i.corroboration === 1 ? "family" : "families"}`,
	);
	const state = i.status === "active" ? tr(lang, "en curso", "ongoing") : tr(lang, "terminado", "ended");
	const about =
		i.scope && i.scope.id !== entityId
			? tr(lang, `sobre ${i.scope.name.es}`, `about ${i.scope.name.en}`)
			: null;
	// "People living in the area" only for a corroborated incident, never for a lone family (API.md), whatever the
	// payload carries.
	const p = !i.reportsOnly && i.corroboration >= 2 ? i.populationInArea : null;
	const tier = i.tier === "watch" ? tr(lang, "en observación", "watch") : null;
	return {
		id: `incident:${i.id}`,
		incident: i.id,
		title: i.title[lang],
		at: i.lastEvidenceAt,
		meta: [state, tier, families, about].filter(Boolean).join(" · "),
		tone: i.status === "active" ? (i.reportsOnly ? "warn" : "alert") : "muted",
		...(i.reportsOnly ? { unverified: true } : {}),
		...(p
			? {
					estimate: {
						label: p.area[lang],
						value: roughPeople(p.people, lang),
						source: p.source,
						note: p.note,
						caveat: p.caveat[lang],
						method: p.method,
					},
				}
			: {}),
	};
}

function nearbyOf(v: ApiView, lang: Lang): NearbyModel | null {
	const nb = v.nearby;
	const byKind = Object.entries(nb.byKind)
		.map(([kind, count]) => ({ kind, label: INFRA_PLURAL[kind]?.[lang] ?? kind, n: count }))
		.sort((a, b) => b.n - a.n);
	if (!byKind.length && !nb.items.length) return null;
	return {
		rule: nb.rule[lang],
		// The server says how it listed them (API.md): nearest to the entity's point first, or by kind.
		nearest: nb.order === "distance",
		byKind,
		items: nb.items.map((x) => ({
			ref: refFromApi(x.entity, lang),
			km: x.km,
			inside: x.relation === "inside",
		})),
		truncated: nb.truncated,
	};
}

const REL_WORD: Record<string, { es: string; en: string }> = {
	operator: { es: "Operador", en: "Operator" },
	"network-of": { es: "Red de", en: "Network of" },
	publishes: { es: "Publica", en: "Publishes" },
	"attached-to": { es: "Adscrito a", en: "Attached to" },
};

/** OSM's generator:source / plant:source values in words. */
const ENERGY: Record<string, { es: string; en: string }> = {
	hydro: { es: "hidroeléctrica", en: "hydro" },
	gas: { es: "gas", en: "gas" },
	"fuel oil": { es: "fueloil", en: "fuel oil" },
	oil: { es: "petróleo", en: "oil" },
	diesel: { es: "diésel", en: "diesel" },
	coal: { es: "carbón", en: "coal" },
	solar: { es: "solar", en: "solar" },
	wind: { es: "eólica", en: "wind" },
	biomass: { es: "biomasa", en: "biomass" },
	thermal: { es: "térmica", en: "thermal" },
};

const CODE_LABEL: Record<string, string> = {
	facility: "id (quema de gas)",
	camera: "id (cámara)",
	ourairports: "OurAirports",
	pcode: "P-code",
	iso: "ISO 3166-2",
	asn: "ASN",
	iata: "IATA",
	icao: "OACI/ICAO",
	osm: "OSM",
	portwatch: "PortWatch",
	isp: "ISP",
	outlet: "id",
	dahiti: "DAHITI",
	voltageKV: "kV",
};

function codeUrl(key: string, value: string): string | undefined {
	if (key === "osm" && /^(node|way|relation)\/\d+$/.test(value))
		return `https://www.openstreetmap.org/${value}`;
	if (key === "asn" && /^\d+$/.test(value)) return `https://stat.ripe.net/AS${value}`;
	return undefined;
}

/** Dataset attributes worth a line, in words (capacity, source of power, airport type, operator tag, region). */
function attributesOf(v: ApiView, lang: Lang): { label: string; value: string; key?: string }[] {
	const a = v.entity.attributes;
	const out: { label: string; value: string; key?: string }[] = [];
	const cap = n(a.capacityMW);
	if (cap !== null)
		out.push({
			key: "capacity",
			label: tr(lang, "Capacidad declarada", "Stated capacity"),
			value: `${int(cap, lang)} MW`,
		});
	if (typeof a.source === "string" && v.entity.type === "infrastructure")
		out.push({
			key: "energy",
			label: tr(lang, "Fuente de energía (OSM)", "Energy source (OSM)"),
			value: a.source
				.split(";")
				.map((x) => ENERGY[x.trim()]?.[lang] ?? x.trim())
				.join(", "),
		});
	if (typeof a.operatorTag === "string")
		out.push({ label: tr(lang, "Operador según OSM", "Operator per OSM"), value: a.operatorTag });
	if (typeof a.airportType === "string")
		out.push({
			label: tr(lang, "Tipo (OurAirports)", "Type (OurAirports)"),
			value:
				{
					large_airport: tr(lang, "grande", "large"),
					medium_airport: tr(lang, "mediano", "medium"),
					small_airport: tr(lang, "pequeño", "small"),
				}[a.airportType] ?? a.airportType,
		});
	if (typeof a.scheduledService === "boolean")
		out.push({
			label: tr(lang, "Vuelos regulares", "Scheduled service"),
			value: a.scheduledService ? tr(lang, "sí", "yes") : tr(lang, "no", "no"),
		});
	if (typeof a.servedCity === "string")
		out.push({ key: "city", label: tr(lang, "Ciudad", "City"), value: a.servedCity });
	const area = n(a.areaKm2);
	if (area !== null)
		out.push({
			key: "area",
			label: tr(lang, "Superficie", "Area"),
			value: `${num(area, area < 10 ? 1 : 0, lang)} km²`,
		});
	if (typeof a.capital === "string")
		out.push({ key: "capital", label: tr(lang, "Capital", "Capital"), value: a.capital });
	if (typeof a.holder === "string")
		out.push({ key: "holder", label: tr(lang, "Titular (registro)", "Holder (registry)"), value: a.holder });
	if (Array.isArray(a.asns) && a.asns.length)
		out.push({
			key: "asns",
			label: tr(lang, "Sistemas autónomos", "Autonomous systems"),
			value: a.asns.map((x) => `AS${String(x)}`).join(", "),
		});
	if (typeof a.service === "string")
		out.push({
			key: "service",
			label: tr(lang, "Servicio", "Service"),
			value: { fijo: tr(lang, "fijo", "fixed"), movil: tr(lang, "móvil", "mobile") }[a.service] ?? a.service,
		});
	if (typeof a.region === "string" && v.entity.type === "outlet")
		out.push({
			key: "reach",
			label: tr(lang, "Alcance", "Reach"),
			value: a.region === "national" ? tr(lang, "nacional", "national") : a.region,
		});
	if (typeof a.homepage === "string" && /^https?:\/\//.test(a.homepage))
		out.push({
			key: "homepage",
			label: tr(lang, "Sitio web", "Website"),
			value: a.homepage.replace(/^https?:\/\//, "").replace(/\/$/, ""),
		});
	if (typeof a.note === "string") out.push({ label: tr(lang, "Nota", "Note"), value: a.note });
	return out;
}

/**
 * The status line of a facility, network, institution or outlet: its worst signal if any is out of the ordinary,
 * else how many live signals it has and how many are out of date. Never "no anomaly" (a place's verdict rests on
 * a measured normal; these have no such reading).
 */
export function signalsLine(facts: readonly EntityFact[], lang: Lang): { tone: FactTone; text: string } {
	const worst = facts.find((f) => f.tone === "alert") ?? facts.find((f) => f.tone === "warn");
	if (worst)
		return {
			tone: worst.tone,
			text: `${worst.label}: ${worst.value}${worst.stale ? ` (${tr(lang, "desactualizado", "out of date")})` : ""}`,
		};
	if (!facts.length)
		return {
			tone: "muted",
			text: tr(
				lang,
				"Ninguna señal en vivo vinculada; su cronología dice lo que el archivo guarda",
				"No live signal linked; its timeline shows what the archive holds",
			),
		};
	const stale = facts.filter((f) => f.stale).length;
	const n = facts.length;
	return {
		tone: "muted",
		text:
			tr(
				lang,
				`${n} ${n === 1 ? "señal vinculada" : "señales vinculadas"}`,
				`${n} linked ${n === 1 ? "signal" : "signals"}`,
			) +
			(stale ? tr(lang, `, ${stale} desactualizada${stale === 1 ? "" : "s"}`, `, ${stale} out of date`) : ""),
	};
}

/**
 * A place's verdict; on a municipality or parish, when the reading that decides it is its state's (IODA, night
 * lights), the line says so: "Zulia (estado): Sin anomalías…".
 */
function placeVerdict(
	type: string,
	facts: readonly EntityFact[],
	parents: readonly EntityRef[],
	lang: Lang,
): { tone: FactTone; text: string } {
	const v = verdict(facts, lang);
	if (type !== "municipality" && type !== "parish") return v;
	const worst = facts.find((f) => f.tone === "alert") ?? facts.find((f) => f.tone === "warn");
	const deciding = worst
		? [worst]
		: facts.filter((f) => f.tone === "ok" && !f.stale && f.prov.basis === "measured");
	const state = parents.find((p) => p.kind === "state");
	if (!state || !deciding.length || !deciding.every((f) => f.inherited)) return v;
	return { ...v, text: `${state.name} (${tr(lang, "estado", "state")}): ${v.text}` };
}

/** The model of any entity from the server's linked view. */
export function adaptEntity(v: ApiView, lang: Lang, now: number): EntityModel {
	const e = v.entity;
	const facts = v.now.map((item, i) => factOf(item, e.id, i, lang, e.type));
	const parents = v.parents.map((p) => refFromApi(p, lang));
	const crumbs = [...parents].reverse();
	const ref: EntityRef = { ...refFromApi(e, lang), ...(parents[0] ? { parent: parents[0] } : {}) };
	const place =
		e.type === "country" || e.type === "state" || e.type === "municipality" || e.type === "parish";

	const sections: EntitySection[] = [];
	if (v.incidents.length || place)
		sections.push({
			key: "incidents",
			title: tr(lang, "Incidentes", "Incidents"),
			facts: [],
			items: v.incidents.map((i) => incidentItem(i, e.id, lang)),
			empty: tr(
				lang,
				"Ninguna coincidencia de fuentes independientes sobre este lugar.",
				"No agreement of independent sources about this place.",
			),
			note: tr(
				lang,
				"Un incidente es una coincidencia de familias de fuentes independientes en un lugar y un rato; la fuerza es cuántas coinciden. «Personas que viven en el área» es una estimación de WorldPop calculada por Vigía, nunca el número de afectados.",
				"An incident is independent source families agreeing about one place and time; its strength is how many agree. “People living in the area” is a WorldPop estimate computed by Vigía, never the number affected.",
			),
			module: "situacion",
		});
	const keywordStories = v.stories.some((s) => s.rule === "text-place");
	// Headlines are never linked to the country (API.md) nor to a camera: no empty section that would read as "no news".
	if (e.type !== "country" && e.type !== "camera")
		sections.push({
			key: "news",
			title:
				e.type === "outlet"
					? tr(lang, "Sus titulares", "Its headlines")
					: tr(lang, "Últimos titulares que lo nombran", "Latest headlines that name it"),
			facts: [],
			items: v.stories.map((s) => storyItem(s, lang)),
			empty: tr(lang, "Ningún titular reciente vinculado.", "No recent headline linked."),
			...(keywordStories
				? {
						note: tr(
							lang,
							"Ubicación por palabra clave: el etiquetador del panel de noticias encontró el lugar en el título, o en el resumen si el título no nombra ninguno (confianza ≥ 0,7); puede equivocarse con nombres repetidos.",
							"Located by keyword: the news panel's tagger found the place in the title, or in the summary when the title names none (confidence ≥ 0.7); it can be wrong with repeated names.",
						),
					}
				: v.stories.some((x) => x.rule === "text-name")
					? {
							note: tr(
								lang,
								"Vinculados por su nombre o sigla en el título del titular (lista revisada a mano).",
								"Linked by its name or acronym in the headline's title (hand-checked list).",
							),
						}
					: {}),
			module: "noticias",
		});

	const groups = Object.entries(v.children.byType)
		.map(([type, total]) => ({
			key: type,
			// Facilities directly under a state (or the country) are those placed only that far.
			label:
				type === "infrastructure" && (e.type === "state" || e.type === "country")
					? e.type === "state"
						? tr(lang, "Instalaciones sin municipio asignado", "Facilities without a municipality")
						: tr(lang, "Instalaciones sin estado asignado", "Facilities without a state")
					: (TYPE_PLURAL[type]?.[lang] ?? type),
			total,
			items: v.children.items.filter((c) => c.type === type).map((c) => refFromApi(c, lang)),
			truncated: v.children.truncated || v.children.items.filter((c) => c.type === type).length < total,
		}))
		.sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key));

	const iso = place ? (e.type === "country" ? null : isoOfPlace(e.id)) : null;
	const pcode = e.codes.pcode ?? null;
	const muni = e.type === "municipality" ? pcode : e.type === "parish" && pcode ? pcode.slice(0, 6) : null;
	const d = e.dataset;
	return {
		ref,
		asOf: newest(facts, now),
		status: place
			? placeVerdict(e.type, facts, parents, lang)
			: e.type === "camera"
				? {
						tone: "muted",
						text: tr(
							lang,
							"Cámara que su operador publica; su estado y su imagen, del censo de cámaras de Vigía",
							"A camera its operator publishes; its state and picture, from Vigía's camera census",
						),
					}
				: signalsLine(facts, lang),
		facts,
		sections,
		children: [],
		origin: "api",
		crumbs,
		codes: Object.entries(e.codes)
			.filter(([k]) => k !== "outlet" && k !== "isp")
			.map(([k, value]) => ({
				label: CODE_LABEL[k] ?? k,
				value,
				...(codeUrl(k, value) ? { url: codeUrl(k, value) as string } : {}),
			})),
		attributes: attributesOf(v, lang),
		point: e.point,
		map: {
			iso: iso ?? (e.point ? isoOfPlace(parents.find((p) => p.kind === "state")?.id ?? "") : null),
			muni,
		},
		relations: e.related.map((r) => ({
			label: REL_WORD[r.rel]?.[lang] ?? r.rel,
			ref: refFromApi(r.entity, lang),
		})),
		nearby: nearbyOf(v, lang),
		childGroups: groups,
		population: v.population
			? {
					census: v.population.census2011,
					worldpop: v.population.worldpop2026,
					computed: v.population.computed,
					method: v.population.method,
				}
			: null,
		dataset: {
			name: d.name,
			licence: d.licence.name,
			licenceUrl: d.licence.url,
			url: d.url,
			attribution: d.attribution,
			retrieved: d.retrieved,
		},
		timeline: v.links.timeline,
		rules: v.links.rules[lang],
		backlog: v.links.backlog,
		anomalies: v.anomalies ?? [],
		keyFacts: keyFacts({ ...v, anomalies: v.anomalies ?? [] }, lang),
	};
}

const ORDER = [
	"state",
	"municipality",
	"parish",
	"infrastructure",
	"network",
	"institution",
	"outlet",
	"country",
];

// ——— requests, with a small offline copy ———

export type Fetched<T> =
	| { state: "loading" }
	| { state: "ok"; data: T; savedAt: number; offline: boolean; serverError?: boolean }
	| { state: "missing" }
	| { state: "error"; offline: boolean };

const STORE_KEY = "vigia:entities:v1";
/** Entity views kept on this device for offline use: the few most recently opened. */
const KEEP = 8;
const memory = new Map<string, { at: number; data: ApiView }>();

function readStore(): Record<string, { at: number; data: ApiView }> {
	try {
		const raw = localStorage.getItem(STORE_KEY);
		return raw ? (JSON.parse(raw) as Record<string, { at: number; data: ApiView }>) : {};
	} catch {
		return {};
	}
}

function keep(id: string, data: ApiView, at: number): void {
	memory.set(id, { at, data });
	try {
		const all = readStore();
		all[id] = { at, data };
		const ids = Object.keys(all).sort((a, b) => (all[b]?.at ?? 0) - (all[a]?.at ?? 0));
		for (const old of ids.slice(KEEP)) delete all[old];
		localStorage.setItem(STORE_KEY, JSON.stringify(all));
	} catch {
		// Storage full or disabled: the page still works online.
	}
}

/** The copy of an entity already on this device (this visit, or a previous one), if any. */
export function savedEntity(id: string): { at: number; data: ApiView } | null {
	return memory.get(id) ?? readStore()[id] ?? null;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<{ status: number; data: T | null }> {
	const res = await fetch(path, { headers: { accept: "application/json" }, ...(signal ? { signal } : {}) });
	if (!res.ok) return { status: res.status, data: null };
	return { status: res.status, data: (await res.json()) as T };
}

/** One entity: the server's answer, or this device's copy when the server cannot be reached. */
export async function fetchEntity(id: string, signal?: AbortSignal): Promise<Fetched<ApiView>> {
	let serverAnswered = false;
	try {
		const r = await getJson<ApiView>(`/api/v1/entities/${encodeURIComponent(id)}`, signal);
		serverAnswered = true;
		if (r.status === 404) return { state: "missing" };
		if (!r.data) throw new Error(String(r.status));
		const at = Date.now();
		keep(id, r.data, at);
		return { state: "ok", data: r.data, savedAt: at, offline: false };
	} catch (err) {
		if ((err as Error).name === "AbortError") throw err;
		// "offline" only when the request never reached the server; an error answer is the server's.
		const offline = !serverAnswered;
		const saved = savedEntity(id);
		return saved
			? { state: "ok", data: saved.data, savedAt: saved.at, offline: true, serverError: !offline }
			: { state: "error", offline };
	}
}

export async function fetchTimeline(
	path: string,
	q: { from: number; to: number; limit: number; kinds: readonly string[] },
	signal?: AbortSignal,
): Promise<TimelineView | null> {
	const params = new URLSearchParams({
		from: String(Math.round(q.from)),
		to: String(Math.round(q.to)),
		limit: String(q.limit),
	});
	if (q.kinds.length) params.set("kinds", q.kinds.join(","));
	const r = await getJson<TimelineView>(`${path}?${params}`, signal);
	return r.data;
}

export async function locate(lat: number, lon: number, signal?: AbortSignal): Promise<LocateView | null> {
	const r = await getJson<LocateView>(`/api/v1/locate?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`, signal);
	return r.data;
}
