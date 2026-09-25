import { distanceToStateKm, stateByIso } from "../geo/index.ts";
import { normalize } from "../news/text.ts";
import type { AlertRule } from "./schema.ts";

/**
 * The alert rule engine: pure code over the panels' own view models, so an alert says exactly what the page says.
 *
 * Two kinds of rule:
 * - conditions (connectivity level, dollar gap, BCV rate) fire when they START being true, and re-arm once false;
 * - events (a quake, a block, an incident opening, a headline) fire once per event.
 *
 * Honesty rules, enforced here and tested:
 * - no alert on stale data: a condition is judged only while its feed is healthy and its figure within budget, and
 *   an event only if it happened recently (a restart after three days does not announce three-day-old quakes);
 * - a new rule never fires for what is already true or already happened: its first evaluation is a baseline
 *   (the rule shows "se cumple ahora" instead);
 * - every alert carries its source, its link to the evidence, the data's own time and the time it fired.
 */

/* ---------- Inputs: the parts of each panel view the rules read ---------- */

type Level = "normal" | "drop" | "severe" | "no-data";
export interface PlaceIn {
	id: string;
	name: string;
	level: Level;
	headline: string;
	lastBinAt: number | null;
	sourceUrl: string;
	feed: string;
}
export interface ConnectivityIn {
	country: PlaceIn;
	states: PlaceIn[];
}
export interface MoneyIn {
	official: {
		usd: {
			current: {
				vesPerUnit: number;
				validFrom: number;
				fetchedAt: number;
				sourceUrl: string;
				feed: string;
			} | null;
			stale: boolean;
		};
	};
	yadio: {
		feed: string;
		sourceUrl: string;
		stale: boolean;
		figure: {
			vesPerUsd: number;
			observedAt: number;
			gap: { pct: number; officialVesPerUsd: number } | null;
		} | null;
	};
}
interface ReadingIn {
	label: string;
	feed: string;
	mag: number;
	url: string;
}
export interface QuakeIn {
	id: string;
	at: number;
	lat: number;
	lon: number;
	zone: "venezuela" | "near" | "far";
	placeEs: string;
	maxMag: number;
	usgs: ReadingIn | null;
	funvisis: ReadingIn | null;
}
export interface QuakesIn {
	items: QuakeIn[];
}
export interface BlockChangeIn {
	source: "vesinfiltro" | "ooni";
	kind: "blocked" | "unblocked" | "flagged" | "unflagged";
	domain: string;
	isp: string;
	by: number;
	url: string;
}
export interface CensorshipIn {
	timeline: { changes: BlockChangeIn[] };
}
export interface IncidentIn {
	id: string;
	kind: "corte" | "sismo";
	state: string | null;
	stateName: string | null;
	title: { es: string; en: string };
	openedAt: number;
	status: "active" | "ended";
	strength: { es: string; en: string };
	evidence: { feed: string; url: string; at: number }[];
}
export interface IncidentsIn {
	incidents: IncidentIn[];
}
export interface StoryIn {
	id: string;
	title: string;
	url: string;
	firstAt: number;
	states: string[];
	outlets: { id: string; name: string; stance: string; dateMissing: boolean }[];
}
export interface NewsIn {
	stories: Record<string, StoryIn>;
}

export type FeedStateIn = "ok" | "stale" | "degraded" | "failing" | "locked" | "off" | "pending";

export interface Snapshot {
	now: number;
	connectivity?: ConnectivityIn | undefined;
	money?: MoneyIn | undefined;
	quakes?: QuakesIn | undefined;
	censorship?: CensorshipIn | undefined;
	incidents?: IncidentsIn | undefined;
	/** Vigía's news and the user's own ("Mis fuentes"). */
	news?: (NewsIn | undefined)[];
	/** Health state of a feed, or null when unknown. */
	feedState: (id: string) => FeedStateIn | null;
}

/* ---------- Outputs ---------- */

export interface Fired {
	/** Unique: rule id + subject + data time. */
	id: string;
	ruleId: string;
	ruleName: string | null;
	kind: AlertRule["kind"];
	/** When the alert fired (UTC ms). */
	at: number;
	/** When the data behind it is from (the source's own time). */
	observedAt: number;
	title: { es: string; en: string };
	detail: { es: string; en: string };
	/** Who publishes the data ("IODA", "USGS", "VE sin Filtro"…). */
	source: string;
	/** Feed id (the status page's). */
	feed: string;
	/** The evidence: the source's own page for this fact. */
	sourceUrl: string;
	/** The panel on the page that shows it (#id). */
	panel: string;
	state: string | null;
}

export interface RuleStatus {
	/**
	 * "matching": the condition is true now (or events matched in the recent window); "clear": judged, not true;
	 * "stale": the data it needs is stale or missing, so it is not judged; "off": disabled.
	 */
	state: "matching" | "clear" | "stale" | "off";
	matching: number;
	/** Why it is stale, in Spanish/English, when it is. */
	note: { es: string; en: string } | null;
}

export interface RuleMemory {
	/** When the rule was first evaluated (its baseline). */
	armedAt: number;
	/** Condition keys true at the last judged evaluation. */
	active: string[];
	/** Event keys already seen → the event time (pruned after SEEN_TTL_MS). */
	seen: Record<string, number>;
}

export interface Memory {
	v: 1;
	rules: Record<string, RuleMemory>;
}

export const emptyMemory = (): Memory => ({ v: 1, rules: {} });

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Events older than this when first seen are not announced (quakes, incidents, headlines). */
export const EVENT_RECENT_MS = 6 * HOUR;
/** Block lists update daily at best; a change seen by an observation up to this old is still news. */
export const BLOCK_RECENT_MS = 72 * HOUR;
/** Maximum age of a figure judged by a condition rule. */
export const CONNECTIVITY_MAX_AGE_MS = 2 * HOUR;
export const YADIO_MAX_AGE_MS = 6 * HOUR;
const SEEN_TTL_MS = 14 * 24 * HOUR;

const HEALTHY: ReadonlySet<FeedStateIn> = new Set(["ok", "degraded"]);

const nf = (n: number, digits: number, lang: "es" | "en") =>
	n.toLocaleString(lang === "es" ? "es-VE" : "en-US", {
		minimumFractionDigits: digits,
		maximumFractionDigits: digits,
	});

const stateLabel = (iso: string | null): string | null => (iso ? (stateByIso(iso)?.name ?? iso) : null);

interface Match {
	key: string;
	observedAt: number;
	title: { es: string; en: string };
	detail: { es: string; en: string };
	source: string;
	feed: string;
	sourceUrl: string;
	panel: string;
	state: string | null;
}

type Judged = {
	stale: { es: string; en: string } | null;
	matches: Match[];
	event: boolean;
	recentMs: number;
	/** Condition keys that could not be judged this time (a place without fresh data): they keep their last state. */
	unjudged?: (key: string) => boolean;
};

const stale = (es: string, en: string): Judged => ({
	stale: { es, en },
	matches: [],
	event: false,
	recentMs: 0,
});

/* ---------- Per-kind judges ---------- */

function connectivity(rule: Extract<AlertRule, { kind: "connectivity" }>, s: Snapshot): Judged {
	const c = s.connectivity;
	if (!c) return stale("Sin datos de conectividad todavía.", "No connectivity data yet.");
	const feed = c.country.feed;
	if (!HEALTHY.has(s.feedState(feed) ?? "failing"))
		return stale(
			"La fuente de conectividad (IODA) está desactualizada.",
			"The connectivity feed (IODA) is stale.",
		);
	const places =
		rule.place === "VE"
			? [c.country]
			: rule.place === "*"
				? c.states
				: c.states.filter((p) => p.id === rule.place);
	const minRank = rule.level === "severe" ? 2 : 1;
	const rank = (l: Level) => (l === "severe" ? 2 : l === "drop" ? 1 : 0);
	const judgeable = places.filter(
		(p) => p.level !== "no-data" && p.lastBinAt !== null && s.now - p.lastBinAt <= CONNECTIVITY_MAX_AGE_MS,
	);
	if (!judgeable.length)
		return stale("Sin medición reciente para ese lugar.", "No recent measurement for that place.");
	const unjudged = new Set(places.filter((p) => !judgeable.includes(p)).map((p) => p.id));
	const matches = judgeable
		.filter((p) => rank(p.level) >= minRank)
		.map((p): Match => {
			const severe = p.level === "severe";
			return {
				key: `${p.id}:${rule.level}`,
				observedAt: p.lastBinAt as number,
				title: {
					es: `${p.name}: ${severe ? "caída fuerte" : "caída"} de conexión`,
					en: `${p.name}: ${severe ? "severe connectivity drop" : "connectivity drop"}`,
				},
				detail: { es: p.headline, en: p.headline },
				source: "IODA",
				feed: p.feed,
				sourceUrl: p.sourceUrl,
				panel: "conectividad",
				state: p.id.startsWith("VE-") ? p.id : null,
			};
		});
	return {
		stale: null,
		matches,
		event: false,
		recentMs: 0,
		unjudged: (key) => unjudged.has(key.split(":")[0] ?? ""),
	};
}

function gap(rule: Extract<AlertRule, { kind: "gap" }>, s: Snapshot): Judged {
	const y = s.money?.yadio;
	const f = y?.figure;
	if (!y || !f?.gap)
		return stale("Sin cotización o sin tasa oficial para comparar.", "No quote or official rate to compare.");
	if (y.stale || s.money?.official.usd.stale || s.now - f.observedAt > YADIO_MAX_AGE_MS)
		return stale(
			"La cotización o la tasa oficial está desactualizada.",
			"The quote or the official rate is stale.",
		);
	if (!HEALTHY.has(s.feedState(y.feed) ?? "failing"))
		return stale("La fuente de la cotización no está al día.", "The quote's feed is not current.");
	const matches: Match[] =
		f.gap.pct >= rule.minPct
			? [
					{
						key: "gap",
						observedAt: f.observedAt,
						title: {
							es: `Brecha del dólar: ${nf(f.gap.pct, 1, "es")} %`,
							en: `Dollar gap: ${nf(f.gap.pct, 1, "en")}%`,
						},
						detail: {
							es: `Yadio ${nf(f.vesPerUsd, 2, "es")} Bs frente a BCV ${nf(f.gap.officialVesPerUsd, 2, "es")} Bs (tu umbral: ${nf(rule.minPct, 1, "es")} %).`,
							en: `Yadio ${nf(f.vesPerUsd, 2, "en")} Bs vs BCV ${nf(f.gap.officialVesPerUsd, 2, "en")} Bs (your threshold: ${nf(rule.minPct, 1, "en")}%).`,
						},
						source: "Yadio · BCV",
						feed: y.feed,
						sourceUrl: y.sourceUrl,
						panel: "dinero",
						state: null,
					},
				]
			: [];
	return { stale: null, matches, event: false, recentMs: 0 };
}

function rate(rule: Extract<AlertRule, { kind: "rate" }>, s: Snapshot): Judged {
	const usd = s.money?.official.usd;
	const c = usd?.current;
	if (!usd || !c) return stale("Sin tasa oficial todavía.", "No official rate yet.");
	if (usd.stale || !HEALTHY.has(s.feedState(c.feed) ?? "failing"))
		return stale("La tasa oficial está desactualizada.", "The official rate is stale.");
	const matches: Match[] =
		c.vesPerUnit >= rule.minVes
			? [
					{
						key: "rate",
						// When Vigía first saw this rate: its "vigente desde" day can be tomorrow.
						observedAt: c.fetchedAt,
						title: {
							es: `Dólar BCV: ${nf(c.vesPerUnit, 2, "es")} Bs`,
							en: `BCV dollar: ${nf(c.vesPerUnit, 2, "en")} Bs`,
						},
						detail: {
							es: `Tasa oficial vigente; tu umbral: ${nf(rule.minVes, 2, "es")} Bs.`,
							en: `Official rate in force; your threshold: ${nf(rule.minVes, 2, "en")} Bs.`,
						},
						source: "BCV",
						feed: c.feed,
						sourceUrl: c.sourceUrl,
						panel: "dinero",
						state: null,
					},
				]
			: [];
	return { stale: null, matches, event: false, recentMs: 0 };
}

function quake(rule: Extract<AlertRule, { kind: "quake" }>, s: Snapshot): Judged {
	const q = s.quakes;
	if (!q) return stale("Sin datos de sismos todavía.", "No earthquake data yet.");
	const feeds = ["usgs-quakes", "funvisis-quakes"];
	if (!feeds.some((f) => HEALTHY.has(s.feedState(f) ?? "failing")))
		return stale("Las fuentes de sismos no están al día.", "The earthquake feeds are not current.");
	const matches: Match[] = [];
	for (const row of q.items) {
		if (row.maxMag < rule.minMag || row.zone === "far") continue;
		let where: string | null = null;
		if (rule.state !== "*") {
			const km = distanceToStateKm(rule.state, row.lat, row.lon);
			if (km === null || km > rule.radiusKm) continue;
			where = stateLabel(rule.state);
		}
		const reading = row.usgs ?? row.funvisis;
		if (!reading) continue;
		const readings = [row.usgs, row.funvisis].filter((r): r is ReadingIn => r !== null);
		const mags = readings.map((r) => `${r.label} M${nf(r.mag, 1, "es")}`).join(" · ");
		const magsEn = readings.map((r) => `${r.label} M${nf(r.mag, 1, "en")}`).join(" · ");
		matches.push({
			key: row.id,
			observedAt: row.at,
			title: {
				es: `Sismo M${nf(row.maxMag, 1, "es")} · ${row.placeEs}`,
				en: `M${nf(row.maxMag, 1, "en")} earthquake · ${row.placeEs}`,
			},
			detail: {
				es: `${mags}${where ? ` · en ${where} o a ${rule.radiusKm} km o menos` : ""}.`,
				en: `${magsEn}${where ? ` · in ${where} or within ${rule.radiusKm} km` : ""}.`,
			},
			source: reading.label,
			feed: reading.feed,
			sourceUrl: reading.url,
			panel: "sismos",
			state: rule.state === "*" ? null : rule.state,
		});
	}
	return { stale: null, matches, event: true, recentMs: EVENT_RECENT_MS };
}

function blocked(rule: Extract<AlertRule, { kind: "blocked" }>, s: Snapshot): Judged {
	const c = s.censorship;
	if (!c) return stale("Sin datos de bloqueos todavía.", "No blocking data yet.");
	const matches: Match[] = [];
	for (const ch of c.timeline.changes) {
		if (ch.kind !== "blocked" && ch.kind !== "flagged") continue;
		if (rule.domain !== "*" && ch.domain !== rule.domain && !ch.domain.endsWith(`.${rule.domain}`)) continue;
		const vsf = ch.source === "vesinfiltro";
		matches.push({
			key: `${ch.source}:${ch.domain}:${ch.isp}:${ch.by}`,
			observedAt: ch.by,
			title: vsf
				? { es: `Bloqueo: ${ch.domain} en ${ch.isp}`, en: `Blocked: ${ch.domain} on ${ch.isp}` }
				: {
						es: `Posible bloqueo: ${ch.domain} en ${ch.isp}`,
						en: `Possible block: ${ch.domain} on ${ch.isp}`,
					},
			detail: vsf
				? {
						es: "VE sin Filtro lo reporta bloqueado en su última actualización.",
						en: "VE sin Filtro reports it blocked in its latest update.",
					}
				: {
						es: "OONI lo marca como posible bloqueo (ventana de 7 días; puede tardar en reflejarse).",
						en: "OONI flags it as a possible block (7-day window; it can lag).",
					},
			source: vsf ? "VE sin Filtro" : "OONI",
			feed: vsf ? "vesinfiltro-blocks" : "ooni-ve",
			sourceUrl: ch.url,
			panel: "censura",
			state: null,
		});
	}
	return { stale: null, matches, event: true, recentMs: BLOCK_RECENT_MS };
}

function incident(rule: Extract<AlertRule, { kind: "incident" }>, s: Snapshot): Judged {
	const v = s.incidents;
	if (!v) return stale("Sin incidentes calculados todavía.", "No incidents computed yet.");
	const matches: Match[] = [];
	for (const i of v.incidents) {
		if (i.status !== "active") continue;
		if (rule.incident !== "any" && i.kind !== rule.incident) continue;
		if (rule.state !== "*" && i.state !== rule.state) continue;
		const ev = i.evidence[0];
		matches.push({
			key: i.id,
			observedAt: i.openedAt,
			title: i.title,
			detail: i.strength,
			source: "Vigía (incidentes)",
			feed: ev?.feed ?? "incidents",
			sourceUrl: ev?.url ?? "",
			panel: "incidentes",
			state: i.state,
		});
	}
	return { stale: null, matches, event: true, recentMs: EVENT_RECENT_MS };
}

/** Phrases → word lists, accent- and case-free. */
export function phrases(terms: string): string[][] {
	return terms
		.split(",")
		.map((p) => normalize(p).split(" ").filter(Boolean))
		.filter((words) => words.length > 0);
}

function news(rule: Extract<AlertRule, { kind: "news" }>, s: Snapshot): Judged {
	const lists = (s.news ?? []).filter((n): n is NewsIn => n !== undefined);
	if (!lists.length) return stale("Sin noticias todavía.", "No news yet.");
	const wanted = phrases(rule.terms);
	const matches: Match[] = [];
	const seen = new Set<string>();
	for (const list of lists) {
		for (const story of Object.values(list.stories)) {
			if (seen.has(story.url)) continue;
			// Undated items carry only the time Vigía first saw them: never announce them as new.
			if (story.outlets.every((o) => o.dateMissing)) continue;
			if (rule.state !== "*" && !story.states.includes(rule.state)) continue;
			const title = ` ${normalize(story.title)} `;
			if (!wanted.some((words) => words.every((w) => title.includes(` ${w} `)))) continue;
			seen.add(story.url);
			const first = story.outlets[0];
			const mine = first?.stance === "user";
			const name = first?.name ?? "";
			matches.push({
				key: story.url,
				observedAt: story.firstAt,
				title: { es: story.title, en: story.title },
				detail: {
					es: `${name}${mine ? " (añadida por ti)" : ""} · coincide con «${rule.terms}».`,
					en: `${name}${mine ? " (added by you)" : ""} · matches “${rule.terms}”.`,
				},
				source: mine ? `${name} (añadida por ti)` : name,
				feed: first?.id ?? "news",
				sourceUrl: story.url,
				panel: "noticias",
				state: story.states[0] ?? null,
			});
		}
	}
	return { stale: null, matches, event: true, recentMs: EVENT_RECENT_MS };
}

function judge(rule: AlertRule, s: Snapshot): Judged {
	switch (rule.kind) {
		case "connectivity":
			return connectivity(rule, s);
		case "gap":
			return gap(rule, s);
		case "rate":
			return rate(rule, s);
		case "quake":
			return quake(rule, s);
		case "blocked":
			return blocked(rule, s);
		case "incident":
			return incident(rule, s);
		case "news":
			return news(rule, s);
	}
}

/* ---------- Evaluation ---------- */

export interface Evaluation {
	fired: Fired[];
	memory: Memory;
	status: Record<string, RuleStatus>;
}

/** Evaluates every rule against one snapshot. Pure: same inputs, same output. */
export function evaluate(rules: readonly AlertRule[], snapshot: Snapshot, memory: Memory): Evaluation {
	const now = snapshot.now;
	const fired: Fired[] = [];
	const status: Record<string, RuleStatus> = {};
	const next: Memory = { v: 1, rules: {} };
	for (const rule of rules) {
		const prev = memory.rules[rule.id];
		if (!rule.enabled) {
			status[rule.id] = { state: "off", matching: 0, note: null };
			// A disabled rule forgets its state: turned back on, it starts from a new baseline.
			continue;
		}
		const j = judge(rule, snapshot);
		if (j.stale) {
			status[rule.id] = { state: "stale", matching: 0, note: j.stale };
			// Unjudged: keep what it knew (a stale feed must not re-arm a condition that may still be true).
			if (prev) next.rules[rule.id] = prev;
			continue;
		}
		const baseline = prev === undefined;
		const mem: RuleMemory = prev
			? { armedAt: prev.armedAt, active: [], seen: { ...prev.seen } }
			: { armedAt: now, active: [], seen: {} };
		const emit = (m: Match) =>
			fired.push({
				id: `${rule.id}:${m.key}:${m.observedAt}`,
				ruleId: rule.id,
				ruleName: rule.name ?? null,
				kind: rule.kind,
				at: now,
				observedAt: m.observedAt,
				title: m.title,
				detail: m.detail,
				source: m.source,
				feed: m.feed,
				sourceUrl: m.sourceUrl,
				panel: m.panel,
				state: m.state,
			});
		if (j.event) {
			let recent = 0;
			for (const m of j.matches) {
				const isRecent = now - m.observedAt <= j.recentMs && m.observedAt <= now + 15 * MIN;
				if (isRecent) recent++;
				if (m.key in mem.seen) continue;
				mem.seen[m.key] = m.observedAt;
				if (!baseline && isRecent) emit(m);
			}
			for (const [k, at] of Object.entries(mem.seen)) if (now - at > SEEN_TTL_MS) delete mem.seen[k];
			status[rule.id] = { state: recent > 0 ? "matching" : "clear", matching: recent, note: null };
		} else {
			const was = new Set(prev?.active ?? []);
			for (const k of was) if (j.unjudged?.(k)) mem.active.push(k);
			for (const m of j.matches) {
				mem.active.push(m.key);
				if (!baseline && !was.has(m.key)) emit(m);
			}
			status[rule.id] = {
				state: j.matches.length ? "matching" : "clear",
				matching: j.matches.length,
				note: null,
			};
		}
		next.rules[rule.id] = mem;
	}
	return { fired, memory: next, status };
}
