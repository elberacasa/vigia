/**
 * Signals for the incident correlator, read from the tested panel computations (connectivity, night lights,
 * quakes, hazards) and from the stored headlines. Pure over their inputs: each rule that turns a figure into a
 * signal is a named constant here and is stated in the UI.
 */

import { SIGNAL_INFO } from "../adapters/ioda-states/ioda.ts";
import type { NewsItem } from "../adapters/rss/factory.ts";
import { OUTLETS } from "../adapters/rss/outlets.ts";
import type { Store } from "../core/store.ts";
import { stateByIso } from "../geo/index.ts";
import { tagPlaces } from "../news/places.ts";
import { publisherOf } from "../news/publishers.ts";
import { normalize, stripDateline } from "../news/text.ts";
import { type Topic, topics } from "../news/topics.ts";
import type { OutageEventItem, PlaceStatus, ProbeSummary, SignalReading } from "../panels/connectivity.ts";
import type { HazardEvent } from "../panels/hazards.ts";
import type { NightRegionView } from "../panels/nightlights.ts";
import type { QuakeReading, QuakeRow } from "../panels/quakes.ts";
import { type Evidence, RULES, type Signal } from "./incidents.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * What makes a headline a report of a cut, on the normalised headline: narrower than the news topics on purpose.
 * Company names (Corpoelec, CANTV, Movistar), "conectividad" or "sistema eléctrico" appear in business and policy
 * news; they are not reports of an outage.
 */
export const OUTAGE_WORDS = {
	power: [
		"apagon(es)?",
		"sin luz",
		"sin (servicio )?electric(o|idad)",
		"cortes? (de luz|electricos?|de energia|del servicio electrico)",
		"fallas? electricas?",
		"bajones? de (luz|voltaje)",
		"racionamientos? (electricos?|de luz|de energia)",
		"interrupcion(es)? (del servicio )?electric(a|as|o)",
		"se fue la luz",
		"se va la (luz|electricidad)",
	],
	internet: [
		"sin internet",
		"(caida|caidas|falla|fallas) (del|de) internet",
		"sin (servicio de )?(telefonia|senal|conexion)",
		"(caida|falla) (de|en) (la )?(red|conexion|telefonia)",
	],
} as const;

/**
 * The examples the rule text quotes, in Spanish as they appear in headlines (tested: each one is a cut by
 * `outageOf`, each non-example is not), so the published rule and the matcher cannot drift apart.
 */
export const OUTAGE_EXAMPLES = {
	es: ["apagón", "sin luz", "cortes eléctricos", "fallas eléctricas", "sin internet", "caída de internet"],
	en: ["blackout", "no power", "power cuts", "electrical failures", "no internet", "internet outage"],
	/** Names that alone never make a report of a cut. */
	notEnough: ["Corpoelec", "CANTV"],
} as const;

const outageRe = (words: readonly string[]) => new RegExp(`(^| )(${words.join("|")})( |$)`);
const POWER_RE = outageRe(OUTAGE_WORDS.power);
const INTERNET_RE = outageRe(OUTAGE_WORDS.internet);

/** "power", "internet" or null: whether a headline itself reports a cut. */
export function outageOf(title: string): "power" | "internet" | null {
	const n = normalize(title);
	return POWER_RE.test(n) ? "power" : INTERNET_RE.test(n) ? "internet" : null;
}

export const SIGNAL_RULES = {
	/**
	 * IODA place levels that count as evidence. Calibrated 2026-09-25 (replay of 21 labelled blackouts and 21 quiet
	 * windows): counting the plain one-signal "drop" too gave 5 false incidents in the quiet windows, "caída
	 * fuerte" only gave 2, for one detected blackout fewer (7 → 6 blackout-state pairs, 5 → 4 events).
	 */
	iodaLevels: ["severe"] as readonly string[],
	/** Night lights: a comparable night (clear or partly clear, with a baseline) this far below the state's median. */
	nightDropPct: -30,
	/** RIPE Atlas: probes of the state that must have dropped in the last hour. */
	atlasMinProbes: 2,
	/** Quakes: felt-size (the quakes panel's rule) inside Venezuela or within 100 km of it. */
	quakeMinMag: 3.5,
	/** News about a quake: published from the origin time to this long after. */
	quakeNewsMs: 24 * HOUR,
	/** An IODA outage in the quake's state counts when it starts within this window after the origin time. */
	quakeOutageMs: 2 * HOUR,
	/** Mentions below this confidence do not tie a headline to a state (the news panel's rule). */
	stateMinConfidence: 0.7,
	/** GDACS alerts used as context: only orange and red (green is routine). */
	gdacsLevels: ["orange", "red"] as readonly string[],
} as const;

const fmt1 = (n: number) =>
	new Intl.NumberFormat("es-VE", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n);
const fmt1En = (n: number) =>
	new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n);

/** Signed with a real minus sign, as the rest of the UI. */
const signed = (n: number, en = false) => `${n < 0 ? "−" : "+"}${(en ? fmt1En : fmt1)(Math.abs(n))}`;

const name = (iso: string) => stateByIso(iso)?.name ?? iso;

// ——— connectivity (IODA, RIPE Atlas) ———

export type ConnState = Pick<PlaceStatus, "id" | "level" | "headline" | "lastBinAt" | "sourceUrl"> & {
	signals: Pick<SignalReading, "signal" | "level" | "pctOfBaseline" | "observedAt" | "fetchedAt">[];
	probes: Pick<
		ProbeSummary,
		"droppedLastHour" | "disconnected" | "active" | "observedAt" | "sourceUrl"
	> | null;
};
export type ConnInput = {
	states: readonly ConnState[];
	events: readonly Pick<
		OutageEventItem,
		"id" | "kind" | "key" | "signal" | "startAt" | "endAt" | "durationMin" | "openAtFetch" | "url"
	>[];
	eventsFetchedAt: number | null;
};

const signalName = (s: string) => SIGNAL_INFO[s as keyof typeof SIGNAL_INFO]?.es.toLowerCase() ?? s;
const signalNameEn: Record<string, string> = {
	bgp: "BGP",
	"ping-slash24": "active probing",
	"merit-nt": "telescope",
};

/** IODA's current per-state drop (the connectivity panel's rule, fresh bins only). */
export function iodaDropEvidence(s: ConnState): Evidence | null {
	if (!SIGNAL_RULES.iodaLevels.includes(s.level) || s.lastBinAt === null) return null;
	const agreeing = s.signals.filter((r) => r.level === "drop" || r.level === "severe");
	const parts = agreeing
		.filter((r) => r.pctOfBaseline !== null)
		.map((r) => ({
			es: `${signalName(r.signal)} al ${fmt1(r.pctOfBaseline as number)} %`,
			en: `${signalNameEn[r.signal] ?? r.signal} at ${fmt1En(r.pctOfBaseline as number)} %`,
		}));
	const fetchedAt = Math.max(...agreeing.map((r) => r.fetchedAt ?? 0));
	return {
		id: `ioda:drop:${s.id}`,
		family: "ioda",
		role: "signal",
		speaks: "connectivity",
		feed: "ioda-states",
		es: `IODA: ${s.level === "severe" ? "caída fuerte" : "caída"} de señal, ${parts.map((p) => p.es).join(", ")} de lo normal a esta hora`,
		en: `IODA: ${s.level === "severe" ? "severe drop" : "drop"} in signal, ${parts.map((p) => p.en).join(", ")} of normal for this hour`,
		at: s.lastBinAt,
		lastAt: s.lastBinAt,
		fetchedAt: fetchedAt > 0 ? fetchedAt : null,
		url: s.sourceUrl,
		outlet: null,
		refs: agreeing
			.filter((r) => r.observedAt !== null)
			.map((r) => ({ source: "ioda-states", series: `state:${s.id}:${r.signal}`, observedAt: r.observedAt })),
	};
}

/** IODA's own outage events for a state (a different detector, same probes: same family). */
export function iodaEventEvidence(
	e: ConnInput["events"][number],
	fetchedAt: number | null,
	now: number,
): Evidence {
	const end = Math.min(e.endAt, now);
	const open = e.openAtFetch;
	return {
		id: `ioda:event:${e.id}`,
		family: "ioda",
		role: "signal",
		speaks: "connectivity",
		feed: "ioda-events",
		es: `IODA detectó una caída en ${signalName(e.signal)} de ${e.durationMin} min${open ? ", seguía abierta al consultar" : ""}`,
		en: `IODA detected a ${e.durationMin}-min drop in ${signalNameEn[e.signal] ?? e.signal}${open ? ", still open when checked" : ""}`,
		at: e.startAt,
		lastAt: end,
		fetchedAt,
		url: e.url,
		outlet: null,
		refs: [{ source: "ioda-events", series: e.id, observedAt: null }],
	};
}

/** RIPE Atlas: two or more probes in the state lost their link in the last hour and are still without it. */
export function atlasEvidence(iso: string, p: NonNullable<ConnState["probes"]>): Evidence | null {
	// One probe is one household's router; two dropping in the same hour is a signal.
	if (p.droppedLastHour < SIGNAL_RULES.atlasMinProbes) return null;
	return {
		id: `atlas:${iso}:${Math.floor(p.observedAt / HOUR)}`,
		family: "ripe-atlas",
		role: "signal",
		speaks: "connectivity",
		feed: "ripe-atlas-probes",
		es: `RIPE Atlas: ${p.droppedLastHour} de ${p.active} sondas del estado perdieron la conexión en la última hora`,
		en: `RIPE Atlas: ${p.droppedLastHour} of ${p.active} probes in the state lost their link in the last hour`,
		at: p.observedAt,
		lastAt: p.observedAt,
		fetchedAt: null,
		url: p.sourceUrl,
		outlet: null,
		refs: [{ source: "ripe-atlas-probes", series: `state:${iso}:probes`, observedAt: p.observedAt }],
	};
}

// ——— night lights ———

export type NightInput = {
	date: string | null;
	observedAt: number | null;
	fetchedAt: number | null;
	sourceUrl: string | null;
	states: readonly Pick<NightRegionView, "iso" | "pctChange" | "comparable" | "baselineNights">[];
};

export function nightEvidence(night: NightInput): { iso: string; evidence: Evidence }[] {
	if (night.observedAt === null || night.date === null) return [];
	const out: { iso: string; evidence: Evidence }[] = [];
	for (const s of night.states) {
		if (!s.comparable || s.pctChange === null || s.pctChange > SIGNAL_RULES.nightDropPct) continue;
		out.push({
			iso: s.iso,
			evidence: {
				id: `viirs:${s.iso}:${night.date}`,
				family: "viirs",
				role: "signal",
				speaks: "power",
				feed: "gibs-nightlights",
				es: `NASA VIIRS: luces nocturnas ${signed(s.pctChange)} % frente a la mediana de ${s.baselineNights} noches (noche del ${night.date})`,
				en: `NASA VIIRS: night lights ${signed(s.pctChange, true)} % against the median of ${s.baselineNights} nights (night of ${night.date})`,
				at: night.observedAt,
				lastAt: night.observedAt,
				fetchedAt: night.fetchedAt,
				url: night.sourceUrl ?? "https://worldview.earthdata.nasa.gov/",
				outlet: null,
				refs: [{ source: "gibs-nightlights", series: `state:${s.iso}`, observedAt: night.observedAt }],
			},
		});
	}
	return out;
}

// ——— news ———

export type TaggedHeadline = {
	outlet: string;
	outletName: string;
	series: string;
	title: string;
	url: string;
	at: number;
	fetchedAt: number;
	dateMissing: boolean;
	/** Topics of the headline alone (not the summary). */
	topics: Topic[];
	/** Whether the headline itself reports a cut (OUTAGE_WORDS). */
	outage: "power" | "internet" | null;
	/** States named with confidence ≥ stateMinConfidence. */
	states: string[];
};

/**
 * Headlines of the last `windowMs`, tagged with the same keyword rules as the news panel (headline first, the
 * summary only when the headline names no state). One item per link.
 */
export function tagHeadlines(store: Store, now: number, windowMs = 24 * HOUR): TaggedHeadline[] {
	const out: TaggedHeadline[] = [];
	const seen = new Set<string>();
	for (const outlet of OUTLETS) {
		for (const o of store.latestPerSeries<NewsItem>(outlet.id, now - windowMs, 400)) {
			if (o.observedAt > now + RULES.futureSlackMs) continue;
			const item = o.value;
			if (seen.has(item.link)) continue;
			seen.add(item.link);
			const text = `${item.title}. ${stripDateline(item.summary)}`;
			const options = {
				venezuelanOutlet: outlet.region !== "international",
				...(outlet.region.startsWith("VE-") ? { homeState: outlet.region } : {}),
			};
			const fromTitle = tagPlaces(item.title, options);
			const tags = fromTitle.primaryState ? fromTitle : tagPlaces(text, options);
			out.push({
				outlet: outlet.id,
				outletName: outlet.name,
				series: o.series,
				title: item.title,
				url: item.link,
				at: o.observedAt,
				fetchedAt: o.fetchedAt,
				dateMissing: item.dateMissing,
				// The topic must be in the headline itself: summaries drift ("conectividad aérea" is not the internet).
				topics: topics(item.title),
				outage: outageOf(item.title),
				states: [
					...new Set(
						tags.mentions.filter((m) => m.confidence >= SIGNAL_RULES.stateMinConfidence).map((m) => m.state),
					),
				],
			});
		}
	}
	return out;
}

export function headlineEvidence(h: TaggedHeadline, speaks: Evidence["speaks"]): Evidence {
	const undated = h.dateMissing ? " (sin fecha en el feed: hora en que Vigía lo vio)" : "";
	const undatedEn = h.dateMissing ? " (no date in the feed: time Vigía saw it)" : "";
	return {
		id: `news:${h.outlet}:${h.series}`,
		family: "prensa",
		role: "signal",
		speaks,
		feed: h.outlet,
		es: `${h.outletName}: «${h.title}»${undated}`,
		en: `${h.outletName}: "${h.title}"${undatedEn}`,
		at: h.at,
		lastAt: h.at,
		fetchedAt: h.fetchedAt,
		url: h.url,
		// The "two different outlets" rule counts publishers: one outlet's article and its video are one voice.
		outlet: publisherOf(h.outlet).id,
		refs: [{ source: h.outlet, series: h.series, observedAt: h.at }],
	};
}

// ——— quakes and hazards ———

export type QuakeInput = Pick<
	QuakeRow,
	"id" | "at" | "zone" | "state" | "maxMag" | "placeEs" | "usgs" | "funvisis" | "lat" | "lon"
>;

function quakeReadingEvidence(r: QuakeReading, role: Evidence["role"]): Evidence {
	const family = r.label === "USGS" ? "usgs" : "funvisis";
	const depth = r.depthKm !== null ? `, ${Math.round(r.depthKm)} km de profundidad` : "";
	const depthEn = r.depthKm !== null ? `, ${Math.round(r.depthKm)} km deep` : "";
	const status = r.status === "reviewed" ? ", revisado" : r.status === "automatic" ? ", automático" : "";
	const statusEn = r.status === "reviewed" ? ", reviewed" : r.status === "automatic" ? ", automatic" : "";
	return {
		id: `${family}:${r.series}`,
		family,
		role,
		speaks: "quake",
		feed: r.feed,
		es: `${r.label}: M${fmt1(r.mag)}${r.magType ? ` (${r.magType})` : ""}${depth}${status}`,
		en: `${r.label}: M${fmt1En(r.mag)}${r.magType ? ` (${r.magType})` : ""}${depthEn}${statusEn}`,
		at: r.at,
		lastAt: r.at,
		fetchedAt: r.fetchedAt,
		url: r.url,
		outlet: null,
		refs: [{ source: r.feed, series: r.series, observedAt: null }],
	};
}

export function isFeltQuake(q: QuakeInput): boolean {
	return q.zone !== "far" && q.maxMag >= SIGNAL_RULES.quakeMinMag;
}

export function gdacsEvidence(
	e: Pick<HazardEvent, "id" | "typeEs" | "name" | "alertLevel" | "fromAt" | "toAt" | "fetchedAt" | "url">,
): Evidence {
	const level = { red: "roja", orange: "naranja", green: "verde" }[e.alertLevel];
	return {
		id: `gdacs:${e.id}`,
		family: "gdacs",
		role: "context",
		speaks: "hazard",
		feed: "gdacs-events",
		es: `GDACS: alerta ${level}, ${e.typeEs}${e.name ? ` (${e.name})` : ""}`,
		en: `GDACS: ${e.alertLevel} alert, ${e.typeEs}${e.name ? ` (${e.name})` : ""}`,
		at: e.fromAt,
		lastAt: e.toAt,
		fetchedAt: e.fetchedAt,
		url: e.url,
		outlet: null,
		refs: [{ source: "gdacs-events", series: e.id, observedAt: null }],
	};
}

// ——— the two kinds ———

export type SignalInputs = {
	connectivity: ConnInput;
	nights: NightInput;
	headlines: readonly TaggedHeadline[];
	quakes: readonly QuakeInput[];
	/** GDACS events with the state they map to (ISO), when inside Venezuela. */
	hazards: readonly (Parameters<typeof gdacsEvidence>[0] & { state: string | null })[];
};

/** "Corte": power or internet cuts per state. */
export function corteSignals(input: SignalInputs, now: number): Signal[] {
	const out: Signal[] = [];
	const push = (iso: string, evidence: Evidence) =>
		out.push({ kind: "corte", key: iso, state: iso, anchorAt: null, title: null, evidence });
	for (const s of input.connectivity.states) {
		if (!stateByIso(s.id)) continue;
		const drop = iodaDropEvidence(s);
		if (drop) push(s.id, drop);
		const atlas = s.probes ? atlasEvidence(s.id, s.probes) : null;
		if (atlas) push(s.id, atlas);
	}
	for (const e of input.connectivity.events) {
		if (e.kind !== "state" || !stateByIso(e.key) || e.startAt > now) continue;
		push(e.key, iodaEventEvidence(e, input.connectivity.eventsFetchedAt, now));
	}
	for (const { iso, evidence } of nightEvidence(input.nights)) push(iso, evidence);
	for (const h of input.headlines) {
		// Only a headline that itself reports a cut (OUTAGE_WORDS), and only with its own date: an undated item's
		// time is when Vigía saw it, which cannot place it next to a measurement.
		if (h.outage === null || h.dateMissing) continue;
		for (const iso of h.states) push(iso, headlineEvidence(h, h.outage));
	}
	// Context: a felt quake in the state, an orange or red GDACS alert mapped to the state.
	for (const q of input.quakes) {
		if (!isFeltQuake(q) || !q.state) continue;
		const r = q.usgs ?? q.funvisis;
		if (r) push(q.state, quakeReadingEvidence(r, "context"));
	}
	for (const h of input.hazards) {
		if (h.state && SIGNAL_RULES.gdacsLevels.includes(h.alertLevel)) push(h.state, gdacsEvidence(h));
	}
	return out;
}

/** "Sismo": a felt-size quake in or near Venezuela, with each network's reading, the press and IODA in its state. */
export function sismoSignals(input: SignalInputs, now: number): Signal[] {
	const out: Signal[] = [];
	for (const q of input.quakes) {
		if (!isFeltQuake(q) || q.at > now) continue;
		const key = q.usgs?.series ?? q.funvisis?.series ?? q.id;
		const title = {
			es: `Sismo M${fmt1(q.maxMag)} ${q.placeEs}`,
			en: `M${fmt1En(q.maxMag)} earthquake, ${q.placeEs}`,
		};
		const push = (evidence: Evidence) =>
			out.push({ kind: "sismo", key, state: q.state, anchorAt: q.at, title, evidence });
		if (q.usgs) push(quakeReadingEvidence(q.usgs, "signal"));
		if (q.funvisis) push(quakeReadingEvidence(q.funvisis, "signal"));
		for (const h of input.headlines) {
			if (!h.topics.includes("sismo") || h.dateMissing) continue;
			if (h.at < q.at || h.at > q.at + SIGNAL_RULES.quakeNewsMs) continue;
			if (q.state && !h.states.includes(q.state)) continue;
			push(headlineEvidence(h, "quake"));
		}
		if (q.state) {
			for (const e of input.connectivity.events) {
				if (e.kind !== "state" || e.key !== q.state) continue;
				if (e.startAt < q.at - 10 * MIN || e.startAt > q.at + SIGNAL_RULES.quakeOutageMs) continue;
				push(iodaEventEvidence(e, input.connectivity.eventsFetchedAt, now));
			}
		}
	}
	return out;
}

export function stateNameOf(iso: string): string {
	return name(iso);
}
