/**
 * Incidents are archived like any other observation (history from day one): source "vigia-incidents", one series
 * per incident, one row per change. `observedAt` is the incident's newest evidence time, which never moves back,
 * so "latest" is always the newest revision; an unchanged incident inserts nothing (the store ignores identical
 * rows). Being observations, incidents are also covered by the daily hash chain.
 */

import type { Store } from "../core/store.ts";
import type { Json, Observation } from "../core/types.ts";
import type { Incident } from "./incidents.ts";

export const INCIDENTS_SOURCE = "vigia-incidents";
export const INCIDENTS_LICENCE = "vigia-derived";

const DAY = 86_400_000;

/** Every incident whose newest evidence is at most `days` old, newest revision each. */
export function archivedIncidents(store: Store, now: number, days = 8): Incident[] {
	return store
		.latestPerSeries<Json>(INCIDENTS_SOURCE, now - days * DAY, 2_000)
		.map((o) => o.value as unknown as Incident)
		.filter((i) => typeof i === "object" && i !== null && typeof i.id === "string");
}

export function incidentObservation(incident: Incident, now: number): Observation {
	return {
		source: INCIDENTS_SOURCE,
		series: `incident:${incident.id}`,
		sourceUrl: `/api/incidents?id=${encodeURIComponent(incident.id)}`,
		fetchedAt: now,
		observedAt: incident.lastEvidenceAt,
		licence: INCIDENTS_LICENCE,
		value: incident as unknown as Json,
		confidence: 1,
		basis: "derived",
	};
}

/** Stores the incidents touched now; returns how many rows were new. */
export function archive(store: Store, incidents: readonly Incident[], now: number): number {
	return incidents.length ? store.insert(incidents.map((i) => incidentObservation(i, now))) : 0;
}

/** Every revision of one incident, oldest first (its timeline). */
export function incidentHistory(store: Store, id: string, now: number): Incident[] {
	return store
		.history<Json>(INCIDENTS_SOURCE, `incident:${id}`, 0, now + DAY, 500)
		.map((o) => o.value as unknown as Incident);
}
