import { OUTLETS } from "../adapters/rss/outlets.ts";
import type { Store } from "../core/store.ts";
import { states } from "../geo/index.ts";
import { archive, archivedIncidents, INCIDENTS_SOURCE } from "../intel/archive.ts";
import {
	correlate,
	corroborationLabel,
	type Incident,
	isActive,
	type LateCorroboration,
	RULES,
	rulesText,
} from "../intel/incidents.ts";
import {
	corteSignals,
	OUTAGE_EXAMPLES,
	SIGNAL_RULES,
	type SignalInputs,
	sismoSignals,
	stateNameOf,
	tagHeadlines,
} from "../intel/signals.ts";
import type { Panel, PanelReader } from "../server/panels.ts";
import { connectivityView } from "./connectivity.ts";
import { hazardsView } from "./hazards.ts";
import { nightlightsView } from "./nightlights.ts";
import { quakesView } from "./quakes.ts";

/**
 * The incidents panel: signals from the other panels' tested computations, fused by the correlator, archived,
 * and listed with ended incidents of the last 48 h. Computing it also archives it; the server calls it on a
 * timer so incidents are recorded even when nobody is looking.
 */

const HOUR = 3_600_000;
/** Ended incidents stay listed this long after their last evidence. */
export const SHOW_ENDED_MS = 48 * HOUR;
/** Without the panel cache, recomputing reads every panel's inputs (~0.3 s on a week of data): at most this often per store. */
const MIN_RECOMPUTE_MS = 30_000;

export type IncidentItem = Incident & {
	status: "active" | "ended";
	/** The last evidence time, once ended; null while active. */
	endedAt: number | null;
	stateName: string | null;
	strength: { es: string; en: string };
	/** "corroborado después por luces nocturnas (dato publicado 38 h después)", one per late datum. */
	lateNotes: { es: string; en: string }[];
};

export type IncidentsView = {
	asOf: number;
	/** Incidents (two or more independent families, or press from two outlets, labelled). */
	incidents: IncidentItem[];
	/** Active "señal sin corroborar" items: one measured family alone, never counted as incidents. */
	watches: IncidentItem[];
	counts: { active: number; corroborated: number; reportsOnly: number; ended: number; watches: number };
	rules: { es: string[]; en: string[] };
	/** Without new evidence for this long, an incident has ended (RULES.activeMs). */
	activeMs: number;
	/** Feeds the incidents are built from (the panel's freshness uses the first). */
	feeds: string[];
	archive: { source: string; api: string };
};

export function signalRulesText(): { es: string[]; en: string[] } {
	return {
		es: [
			`Señales que se usan: ${SIGNAL_RULES.iodaLevels.includes("drop") ? "caída" : "caída fuerte (dos señales coinciden, o la única disponible cae fuerte)"} de IODA por estado (la regla del panel de conectividad) y sus eventos de caída; RIPE Atlas cuando dos sondas o más del estado perdieron la conexión en la última hora y siguen sin ella; luces nocturnas de NASA cuando una noche comparable (despejada o parcialmente despejada) cae ` +
				`${Math.abs(SIGNAL_RULES.nightDropPct)} % o más bajo la mediana del estado; titulares que reportan un corte (${OUTAGE_EXAMPLES.es.join(", ")}…; no basta nombrar a ${OUTAGE_EXAMPLES.notEnough.join(" o a ")}) y que nombran el estado. Los titulares sin fecha en su feed no cuentan.`,
			`Sismos: M${SIGNAL_RULES.quakeMinMag} o más, en Venezuela o a menos de 100 km; cuentan USGS y FUNVISIS por separado, los titulares sobre sismos de las ${SIGNAL_RULES.quakeNewsMs / HOUR} h siguientes (que nombren el estado, si lo hay) y los eventos de caída de IODA en ese estado que empiezan en las ${SIGNAL_RULES.quakeOutageMs / HOUR} h siguientes.`,
		],
		en: [
			`Signals used: IODA's per-state ${SIGNAL_RULES.iodaLevels.includes("drop") ? "drop" : "severe drop (two signals agree, or the only usable one falls hard)"} (the connectivity panel's rule) and its outage events; RIPE Atlas when two or more probes in the state lost their link in the last hour and are still without it; NASA night lights when a comparable night (clear or partly clear) falls ` +
				`${Math.abs(SIGNAL_RULES.nightDropPct)} % or more below the state's median; headlines that report a cut (${OUTAGE_EXAMPLES.en.join(", ")}…; naming ${OUTAGE_EXAMPLES.notEnough.join(" or ")} is not enough) and name the state. Headlines with no date in their feed do not count.`,
			`Earthquakes: M${SIGNAL_RULES.quakeMinMag} or more, in Venezuela or within 100 km; USGS and FUNVISIS count separately, plus quake headlines of the next ${SIGNAL_RULES.quakeNewsMs / HOUR} h (naming the state, when there is one) and IODA outage events in that state starting within ${SIGNAL_RULES.quakeOutageMs / HOUR} h.`,
		],
	};
}

/**
 * Reads every input the correlator needs through the other panels' computations: from the panel cache when one is
 * given (nothing is computed twice), else computed here.
 */
export function signalInputs(store: Store, now: number, read?: PanelReader): SignalInputs {
	const view = <T>(id: string, compute: () => T): T => (read?.(id) as T | undefined) ?? compute();
	const conn = view("connectivity", () => connectivityView(store, now));
	const night = view("nightlights", () => nightlightsView(store, now));
	const quakes = view("quakes", () => quakesView(store, now));
	const hazards = view("hazards", () => hazardsView(store, now));
	const isoByName = new Map(
		[...new Set(hazards.gdacs.events.map((e) => e.stateName))]
			.filter((n): n is string => n !== null)
			.map((n) => [n, findIso(n)]),
	);
	return {
		connectivity: { states: conn.states, events: conn.events, eventsFetchedAt: conn.eventsFetchedAt },
		nights: night,
		headlines: tagHeadlines(store, now),
		quakes: quakes.items.filter((q) => q.at >= now - 48 * HOUR),
		hazards: hazards.gdacs.events.map((e) => ({
			...e,
			state: e.stateName ? (isoByName.get(e.stateName) ?? null) : null,
		})),
	};
}

function findIso(stateName: string): string | null {
	return states().find((s) => s.name === stateName)?.iso ?? null;
}

const ORDER = (a: IncidentItem, b: IncidentItem) =>
	Number(b.status === "active") - Number(a.status === "active") ||
	Number(a.reportsOnly) - Number(b.reportsOnly) ||
	b.corroboration - a.corroboration ||
	b.lastEvidenceAt - a.lastEvidenceAt ||
	a.id.localeCompare(b.id);

/** The listing: incidents touched now, over archived ones; ended ones for 48 h. Pure. */
export function listIncidents(
	current: readonly Incident[],
	previous: readonly Incident[],
	now: number,
): IncidentItem[] {
	const byId = new Map<string, Incident>();
	for (const p of previous) byId.set(p.id, p);
	for (const c of current) byId.set(c.id, c);
	return [...byId.values()]
		.filter((i) => i.lastEvidenceAt >= now - SHOW_ENDED_MS)
		.map((raw) => {
			// Archived before watch items existed: an incident, with nothing late.
			const i: Incident = {
				...raw,
				tier: raw.tier ?? "incident",
				late: raw.late ?? [],
				watchSince: raw.watchSince ?? null,
			};
			const active = isActive(i, now);
			return {
				...i,
				status: active ? ("active" as const) : ("ended" as const),
				endedAt: active ? null : i.lastEvidenceAt,
				stateName: i.state ? stateNameOf(i.state) : null,
				strength: corroborationLabel(i),
				lateNotes: i.late.map((l) => lateNote(l)),
			};
		})
		.sort(ORDER);
}

export function lateNote(l: LateCorroboration): { es: string; en: string } {
	const h = Math.round(l.delayMs / HOUR);
	const what =
		l.family === "viirs" ? { es: "luces nocturnas", en: "night lights" } : { es: l.family, en: l.family };
	return {
		es: `corroborado después por ${what.es} (dato publicado ${h} h después)`,
		en: `corroborated later by ${what.en} (published ${h} h after)`,
	};
}

export function incidentsView(store: Store, now: number, read?: PanelReader): IncidentsView {
	const input = signalInputs(store, now, read);
	const signals = [...corteSignals(input, now), ...sismoSignals(input, now)];
	const previous = archivedIncidents(store, now);
	const current = correlate(signals, previous, now, stateNameOf);
	archive(store, current, now);
	const listed = listIncidents(current, previous, now);
	const incidents = listed.filter((i) => i.tier === "incident");
	const watches = listed.filter((i) => i.tier === "watch" && i.status === "active");
	const text = rulesText();
	const signalText = signalRulesText();
	const active = incidents.filter((i) => i.status === "active");
	return {
		asOf: now,
		incidents,
		watches,
		counts: {
			active: active.length,
			corroborated: active.filter((i) => !i.reportsOnly).length,
			reportsOnly: active.filter((i) => i.reportsOnly).length,
			ended: incidents.length - active.length,
			watches: watches.length,
		},
		rules: { es: [...text.es, ...signalText.es], en: [...text.en, ...signalText.en] },
		activeMs: RULES.activeMs,
		// One feed per provider (the panel band names providers): IODA, RIPE Atlas, NASA, USGS, FUNVISIS.
		feeds: ["ioda-states", "ripe-atlas-probes", "gibs-nightlights", "usgs-quakes", "funvisis-quakes"],
		archive: { source: INCIDENTS_SOURCE, api: "/api/incidents" },
	};
}

const memo = new WeakMap<Store, { at: number; view: IncidentsView }>();

export const incidentsPanel: Panel<IncidentsView> = {
	id: "incidents",
	sources: [
		"ioda-states",
		"ioda-events",
		"ripe-atlas-probes",
		"gibs-nightlights",
		"usgs-quakes",
		"funvisis-quakes",
		"gdacs-events",
		...OUTLETS.map((o) => o.id),
	],
	compute: (store: Store, now: number, read?: PanelReader) => {
		const hit = memo.get(store);
		if (hit && now >= hit.at && now - hit.at < MIN_RECOMPUTE_MS) return hit.view;
		const view = incidentsView(store, now, read);
		memo.set(store, { at: now, view });
		return view;
	},
};
