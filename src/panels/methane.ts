import {
	CARBON_MAPPER_HOME,
	carbonMapper,
	INSTRUMENTS,
	type MethanePlume,
	PLUME_FACILITY_KM,
	SECTORS,
} from "../adapters/carbon-mapper/index.ts";
import { FACILITIES } from "../adapters/firms-flares/facilities.ts";
import type { Store, StoredObservation } from "../core/store.ts";
import { municipalities, stateByIso } from "../geo/index.ts";
import type { Panel } from "../server/panels.ts";

/**
 * "¿Dónde se escapa metano?" Methane plumes Carbon Mapper imaged over Venezuela in the last year: each plume with its
 * place, facility (when within PLUME_FACILITY_KM of one), instrument and Carbon Mapper's emission estimate with its
 * uncertainty; counts per facility and per month. A plume is one sighting on one pass: the absence of plumes means
 * nobody looked, or nothing was seen that day, never that nothing leaks.
 */

const DAY = 86_400_000;
export const WINDOW_MS = 365 * DAY;

export const LABEL =
	"Plumas de metano captadas por espectrómetros (Carbon Mapper: satélite Tanager-1, NASA EMIT y AVIRIS)";
export const CAVEAT =
	"Cada pluma es una observación de un paso: sin plumas no significa sin emisiones (casi nunca hay un satélite mirando). La tasa en kg/h es una estimación de Carbon Mapper con su incertidumbre, para ese momento.";
export const MONTHS_NOTE =
	"Plumas publicadas por mes: dependen de cuántas pasadas hubo (Tanager-1 empezó a observar en 2025), no son una tendencia de las emisiones.";
export const FACILITY_RULE = `Una pluma se asigna a una instalación si está a menos de ${PLUME_FACILITY_KM} km de su contorno (refinerías) o de uno de sus mechurrios (campos, lista del Banco Mundial).`;

export type PlumeItem = {
	plumeId: string;
	sceneAt: string;
	observedAt: number;
	lat: number;
	lon: number;
	state: string;
	stateName: string;
	municipality: string | null;
	municipalityName: string | null;
	facilityId: string | null;
	facilityName: string | null;
	facilityKm: number | null;
	emissionKgH: number | null;
	uncertaintyKgH: number | null;
	sector: string | null;
	sectorEs: string | null;
	instrument: string;
	instrumentEs: string;
	sourceUrl: string;
};

export type MethaneView = {
	now: number;
	label: string;
	caveat: string;
	facilityRule: string;
	feed: string;
	attribution: string;
	sourceUrl: string;
	/** The feed's last successful run (plumes that did not change are not stored again). */
	newestFetchAt: number | null;
	stale: boolean;
	/** Plumes of the last 365 days, newest first. */
	plumes: PlumeItem[];
	/** Per facility: plumes and the largest estimate, most plumes first. */
	facilities: { id: string; name: string; plumes: number; maxKgH: number | null; lastAt: string }[];
	/** Plumes per UTC month (YYYY-MM), oldest first; always shown with `monthsNote`. */
	months: { month: string; plumes: number }[];
	monthsNote: string;
	/** Plumes per state, most first. */
	states: { iso: string; name: string; plumes: number }[];
};

type Row = Pick<StoredObservation<MethanePlume>, "observedAt" | "value" | "location" | "sourceUrl">;

export function methaneViewOf(
	rows: readonly Row[],
	now: number,
	newestFetchAt: number | null,
): Omit<MethaneView, "feed" | "attribution" | "sourceUrl"> {
	const facilityName = new Map(FACILITIES.map((f) => [f.id, f.nameEs]));
	const muniName = new Map(municipalities().map((m) => [m.code, m.name]));
	const plumes: PlumeItem[] = rows
		.filter((r) => r.observedAt > now - WINDOW_MS && r.observedAt <= now && r.location?.state)
		.map((r) => {
			const v = r.value;
			const loc = r.location as { lat: number; lon: number; state: string };
			return {
				plumeId: v.plumeId,
				sceneAt: v.sceneAt,
				observedAt: r.observedAt,
				lat: loc.lat,
				lon: loc.lon,
				state: loc.state,
				stateName: stateByIso(loc.state)?.name ?? loc.state,
				municipality: v.municipality,
				municipalityName: v.municipality ? (muniName.get(v.municipality) ?? null) : null,
				facilityId: v.facilityId,
				facilityName: v.facilityId ? (facilityName.get(v.facilityId) ?? v.facilityId) : null,
				facilityKm: v.facilityKm,
				emissionKgH: v.emissionKgH,
				uncertaintyKgH: v.uncertaintyKgH,
				sector: v.sector,
				sectorEs: v.sector ? (SECTORS[v.sector]?.es ?? null) : null,
				instrument: v.instrument,
				instrumentEs: INSTRUMENTS[v.instrument] ?? v.instrument,
				sourceUrl: r.sourceUrl,
			};
		})
		.sort((a, b) => b.observedAt - a.observedAt || a.plumeId.localeCompare(b.plumeId));
	const fac = new Map<string, { plumes: number; maxKgH: number | null; lastAt: string }>();
	const months = new Map<string, number>();
	const states = new Map<string, number>();
	for (const p of plumes) {
		if (p.facilityId) {
			const f = fac.get(p.facilityId) ?? { plumes: 0, maxKgH: null, lastAt: p.sceneAt };
			f.plumes++;
			if (p.emissionKgH !== null) f.maxKgH = Math.max(f.maxKgH ?? 0, p.emissionKgH);
			if (p.sceneAt > f.lastAt) f.lastAt = p.sceneAt;
			fac.set(p.facilityId, f);
		}
		const m = p.sceneAt.slice(0, 7);
		months.set(m, (months.get(m) ?? 0) + 1);
		states.set(p.state, (states.get(p.state) ?? 0) + 1);
	}
	return {
		now,
		label: LABEL,
		caveat: CAVEAT,
		facilityRule: FACILITY_RULE,
		newestFetchAt,
		stale: newestFetchAt === null || now - newestFetchAt > carbonMapper.freshness.fetchMs,
		plumes,
		facilities: [...fac]
			.map(([id, f]) => ({ id, name: facilityName.get(id) ?? id, ...f }))
			.sort((a, b) => b.plumes - a.plumes || a.id.localeCompare(b.id)),
		monthsNote: MONTHS_NOTE,
		months: [...months]
			.map(([month, n]) => ({ month, plumes: n }))
			.sort((a, b) => a.month.localeCompare(b.month)),
		states: [...states]
			.map(([iso, n]) => ({ iso, name: stateByIso(iso)?.name ?? iso, plumes: n }))
			.sort((a, b) => b.plumes - a.plumes || a.iso.localeCompare(b.iso)),
	};
}

export function methaneView(store: Store, now: number): MethaneView {
	const rows = store.latestPerSeries<MethanePlume>(carbonMapper.id, now - WINDOW_MS, 5_000);
	const newestFetchAt = store.lastSuccessAt(carbonMapper.id);
	return {
		...methaneViewOf(rows, now, newestFetchAt),
		feed: carbonMapper.id,
		attribution: carbonMapper.licence.attribution,
		sourceUrl: CARBON_MAPPER_HOME,
	};
}

export const methanePanel: Panel<MethaneView> = {
	id: "methane",
	onDemand: true,
	sources: [carbonMapper.id],
	compute: (store, now) => methaneView(store, now),
};
