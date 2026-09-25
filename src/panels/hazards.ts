import { GDACS_LICENCE, type GdacsEvent } from "../adapters/gdacs-events/index.ts";
import { NHC_LICENCE, THREAT_RULE, type TropicalStorm } from "../adapters/nhc-storms/index.ts";
import type { Store } from "../core/store.ts";
import { stateByIso } from "../geo/index.ts";
import type { Panel } from "../server/panels.ts";

/**
 * Hazards: GDACS alerts that affect Venezuela and active Atlantic tropical cyclones, with the distance of each
 * storm to Venezuela and our explicit threat rule. "Nothing" is an answer too, stated with the time we last checked.
 */

const GDACS = "gdacs-events";
const NHC = "nhc-storms";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Window of GDACS events shown: those whose end date falls in the last 30 days (or later). */
export const GDACS_WINDOW_DAYS = 30;
/** A storm is "active" while its last advisory is younger than this: advisories come every 6 h, plus slack. */
export const STORM_ACTIVE_HOURS = 9;

const LEVEL_RANK = { red: 0, orange: 1, green: 2 } as const;

export type HazardEvent = {
	id: string;
	eventType: string;
	typeEs: string;
	name: string;
	alertLevel: "green" | "orange" | "red";
	fromAt: number;
	toAt: number;
	modifiedAt: number;
	severityText: string | null;
	upstream: string | null;
	countries: string[];
	/** State of the point GDACS maps the event at, when it is inside Venezuela. */
	stateName: string | null;
	fetchedAt: number;
	url: string;
};

export type HazardStorm = {
	id: string;
	name: string;
	classificationEs: string;
	windKmh: number;
	windKt: number;
	category: number | null;
	pressureMb: number | null;
	lat: number;
	lon: number;
	movementDirDeg: number | null;
	movementKmh: number | null;
	distanceKm: number;
	directionFromVenezuelaEs: string;
	headingTowardVenezuela: boolean | null;
	threat: boolean;
	reasonEs: string;
	advisoryAt: number;
	fetchedAt: number;
	url: string;
};

export type HazardsView = {
	gdacs: {
		events: HazardEvent[];
		counts: { red: number; orange: number; green: number };
		windowDays: number;
		checkedAt: number | null;
		attribution: string;
		noteEs: string;
	};
	storms: {
		active: HazardStorm[];
		threats: number;
		checkedAt: number | null;
		statusEs: string;
		rule: { threatKm: number; watchKm: number; headingDeg: number; noteEs: string };
		attribution: string;
	};
};

export function hazardsView(store: Store, now: number): HazardsView {
	const events: HazardEvent[] = store
		.latestPerSeries<GdacsEvent>(GDACS, now - 400 * DAY, 500)
		.filter((o) => o.value.toAt >= now - GDACS_WINDOW_DAYS * DAY && o.value.fromAt <= now)
		.map((o) => ({
			id: o.series,
			eventType: o.value.eventType,
			typeEs: o.value.typeEs,
			name: o.value.name,
			alertLevel: o.value.alertLevel,
			fromAt: o.value.fromAt,
			toAt: o.value.toAt,
			modifiedAt: o.value.modifiedAt,
			severityText: o.value.severityText,
			upstream: o.value.upstream,
			countries: o.value.countries,
			stateName: o.location?.state ? (stateByIso(o.location.state)?.name ?? null) : null,
			fetchedAt: o.fetchedAt,
			url: o.sourceUrl,
		}))
		.sort((a, b) => LEVEL_RANK[a.alertLevel] - LEVEL_RANK[b.alertLevel] || b.toAt - a.toAt);

	const active: HazardStorm[] = store
		.latestPerSeries<TropicalStorm>(NHC, now - STORM_ACTIVE_HOURS * HOUR, 50)
		.filter((o) => o.observedAt <= now)
		.map((o) => ({
			id: o.value.id,
			name: o.value.name,
			classificationEs: o.value.classificationEs,
			windKmh: o.value.windKmh,
			windKt: o.value.windKt,
			category: o.value.category,
			pressureMb: o.value.pressureMb,
			lat: o.location?.lat ?? 0,
			lon: o.location?.lon ?? 0,
			movementDirDeg: o.value.movementDirDeg,
			movementKmh: o.value.movementKmh,
			distanceKm: o.value.distanceKm,
			directionFromVenezuelaEs: o.value.directionFromVenezuelaEs,
			headingTowardVenezuela: o.value.headingTowardVenezuela,
			threat: o.value.threat,
			reasonEs: o.value.reasonEs,
			advisoryAt: o.observedAt,
			fetchedAt: o.fetchedAt,
			url: o.sourceUrl,
		}))
		.sort((a, b) => a.distanceKm - b.distanceKm);
	const threats = active.filter((s) => s.threat).length;
	const stormsCheckedAt = store.lastSuccessAt(NHC);
	const statusEs =
		stormsCheckedAt === null && active.length === 0
			? "Todavía no se ha consultado el NHC."
			: active.length === 0
				? "Sin ciclones tropicales activos en el Atlántico."
				: threats === 0
					? `${active.length} ${active.length === 1 ? "ciclón activo" : "ciclones activos"} en el Atlántico; ninguno cumple la regla de amenaza para Venezuela.`
					: `${threats} ${threats === 1 ? "ciclón cumple" : "ciclones cumplen"} la regla de amenaza para Venezuela. Consulte los avisos del NHC y del INAMEH.`;

	return {
		gdacs: {
			events,
			counts: {
				red: events.filter((e) => e.alertLevel === "red").length,
				orange: events.filter((e) => e.alertLevel === "orange").length,
				green: events.filter((e) => e.alertLevel === "green").length,
			},
			windowDays: GDACS_WINDOW_DAYS,
			checkedAt: store.lastSuccessAt(GDACS),
			attribution: GDACS_LICENCE.attribution,
			noteEs:
				"Nivel de alerta de GDACS: estimación de impacto humanitario por modelos (verde, naranja, rojo), no un aviso oficial venezolano.",
		},
		storms: {
			active,
			threats,
			checkedAt: stormsCheckedAt,
			statusEs,
			rule: {
				...THREAT_RULE,
				noteEs: `Regla de Vigía, no del NHC: amenaza si el centro está a ≤${THREAT_RULE.threatKm} km de Venezuela, o a ≤${THREAT_RULE.watchKm} km con rumbo hacia Venezuela (±${THREAT_RULE.headingDeg}°).`,
			},
			attribution: NHC_LICENCE.attribution,
		},
	};
}

export const hazardsPanel: Panel<HazardsView> = {
	id: "hazards",
	sources: [GDACS, NHC],
	compute: (store: Store, now: number) => hazardsView(store, now),
};
