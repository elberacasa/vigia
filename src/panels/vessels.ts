import { AREAS, GFW_MAP, gfwVessels, type VesselDay } from "../adapters/gfw-vessels/index.ts";
import type { Store } from "../core/store.ts";
import type { Panel } from "../server/panels.ts";

/**
 * "¿Cuántos barcos hay en las terminales, y cuántos apagaron el AIS?" Global Fishing Watch's radar (Sentinel-1)
 * vessel detections near the oil terminals, per area and day for the last 30 days, with the detections GFW could not
 * match to any AIS broadcast. Locked until the user adds GFW's free token. Counts only.
 */

const DAY = 86_400_000;
export const WINDOW_DAYS = 30;

export const LABEL =
	"Buques detectados por radar satelital (Sentinel-1) cerca de las terminales, según Global Fishing Watch";
export const CAVEAT =
	"El radar solo ve cada zona los días en que pasa Sentinel-1 (cada pocos días): un día sin imagen no es un día sin buques. «Sin AIS» son detecciones que GFW no pudo emparejar con ninguna señal AIS: puede ser un buque con el AIS apagado, uno pequeño que no está obligado a llevarlo, o un emparejamiento fallido. GFW excluye las plataformas fijas.";

export const SUM_NOTE =
	"Detecciones sumadas de todas las pasadas del radar en 30 días: un mismo buque fondeado cuenta en cada pasada, así que no es un número de buques.";

export type VesselArea = {
	id: string;
	name: string;
	entities: string[];
	/** Days in the window with a radar image that saw at least one vessel, newest first. */
	days: { date: string; detections: number; withoutAis: number }[];
	/** Sums over the window: detections of every pass added up (a ship at anchor counts on each pass), never "ships". */
	detections: number;
	withoutAis: number;
	/** Newest day with detections, or null. */
	lastDate: string | null;
};

export type VesselsView = {
	now: number;
	label: string;
	caveat: string;
	feed: string;
	attribution: string;
	sourceUrl: string;
	windowDays: number;
	sumNote: string;
	lastRunAt: number | null;
	stale: boolean;
	areas: VesselArea[];
};

type Row = { observedAt: number; value: VesselDay };

export function vesselsViewOf(
	rows: readonly Row[],
	now: number,
	lastRunAt: number | null,
): Omit<VesselsView, "feed" | "attribution" | "sourceUrl"> {
	const byAreaDay = new Map<string, Map<string, VesselDay>>();
	for (const r of rows) {
		if (r.observedAt <= now - WINDOW_DAYS * DAY || r.observedAt > now) continue;
		const m = byAreaDay.get(r.value.area) ?? new Map<string, VesselDay>();
		m.set(r.value.date, r.value);
		byAreaDay.set(r.value.area, m);
	}
	return {
		now,
		label: LABEL,
		caveat: CAVEAT,
		windowDays: WINDOW_DAYS,
		sumNote: SUM_NOTE,
		lastRunAt,
		stale: lastRunAt === null || now - lastRunAt > gfwVessels.freshness.fetchMs,
		areas: AREAS.map((a) => {
			const days = [...(byAreaDay.get(a.id)?.values() ?? [])]
				.map((d) => ({ date: d.date, detections: d.detections, withoutAis: d.withoutAis }))
				.sort((x, y) => y.date.localeCompare(x.date));
			return {
				id: a.id,
				name: a.es,
				entities: [...a.entities],
				days,
				detections: days.reduce((s, d) => s + d.detections, 0),
				withoutAis: days.reduce((s, d) => s + d.withoutAis, 0),
				lastDate: days[0]?.date ?? null,
			};
		}),
	};
}

export function vesselsView(store: Store, now: number): VesselsView {
	const rows = AREAS.flatMap((a) =>
		store.history<VesselDay>(gfwVessels.id, `area:${a.id}`, now - (WINDOW_DAYS + 1) * DAY, now, 500),
	);
	return {
		...vesselsViewOf(rows, now, store.lastSuccessAt(gfwVessels.id)),
		feed: gfwVessels.id,
		attribution: gfwVessels.licence.attribution,
		sourceUrl: GFW_MAP,
	};
}

export const vesselsPanel: Panel<VesselsView> = {
	id: "vessels",
	onDemand: true,
	sources: [gfwVessels.id],
	compute: (store, now) => vesselsView(store, now),
};
