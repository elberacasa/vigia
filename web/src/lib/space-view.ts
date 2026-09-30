/**
 * Words for the space and movement views (src/panels/{floods,forest,methane,vessels,radar,flights}.ts), pure and
 * tested (space-view.test.ts). Nothing is computed here but words and the week's sum of a series the server sent:
 * every area, hectare, plume and count is the server's. A flood area is always said with the share the satellite
 * could not see; a plume never sums into a total; a sum of radar detections is never "ships"; flights are "vistos".
 */
import type { FlightsView } from "../../../src/panels/flights.ts";
import type { FloodRegion, FloodsView } from "../../../src/panels/floods.ts";
import type { ForestView, Hectares } from "../../../src/panels/forest.ts";
import type { MethaneView, PlumeItem } from "../../../src/panels/methane.ts";
import type { RadarView } from "../../../src/panels/radar.ts";
import type { VesselsView } from "../../../src/panels/vessels.ts";
import { int, type Lang, num } from "./format.ts";

export type {
	FlightsView,
	FloodRegion,
	FloodsView,
	ForestView,
	Hectares,
	MethaneView,
	PlumeItem,
	RadarView,
	VesselsView,
};

const tr = (l: Lang, es: string, en: string) => (l === "es" ? es : en);

/** "202,6 km²", "0,4 km²", "1.234 km²". */
export function km2(v: number, l: Lang): string {
	return `${v >= 100 ? int(Math.round(v), l) : num(v, 1, l)} km²`;
}

/** "7.870 ha", "58 ha", "0,4 ha". */
export function ha(v: number, l: Lang): string {
	return `${v >= 10 ? int(Math.round(v), l) : num(v, 1, l)} ha`;
}

/** "81 % sin ver": always next to a flood area (cloud plus no product). */
export function unseenWord(pct: number, l: Lang): string {
	return tr(l, `${Math.round(pct)} % sin ver`, `${Math.round(pct)} % unseen`);
}

/** "58,3 km² de inundación vista por satélite · 41 % sin ver". */
export function floodLine(r: FloodRegion, l: Lang): string {
	return tr(
		l,
		`${km2(r.floodKm2, l)} de inundación vista por satélite · ${unseenWord(r.unseenPct, l)}`,
		`${km2(r.floodKm2, l)} of flood seen by satellite · ${unseenWord(r.unseenPct, l)}`,
	);
}

/** Natural forest first, "alta o máxima" confidence first: the lead figure of a place or a week. */
export function forestLead(h: Hectares, l: Lang): string {
	const strong = h.high + h.highest;
	return tr(
		l,
		`${ha(strong, l)} en bosque natural, confianza alta o máxima`,
		`${ha(strong, l)} in natural forest, high or highest confidence`,
	);
}

/** "3.574,7 ± 126,1 kg/h" or "sin estimación publicada": one plume's own estimate, never summed. */
export function plumeRate(p: Pick<PlumeItem, "emissionKgH" | "uncertaintyKgH">, l: Lang): string {
	if (p.emissionKgH === null) return tr(l, "sin estimación publicada", "no published estimate");
	const u = p.uncertaintyKgH !== null ? ` ± ${int(Math.round(p.uncertaintyKgH), l)}` : "";
	return `${int(Math.round(p.emissionKgH), l)}${u} kg/h`;
}

/**
 * Today's airline flights seen over and near Venezuela, and the last 7 complete days. All of them, not only the ones
 * routed to a Venezuelan airport: with no receiver in the country those are almost never heard, so an "international
 * flights" headline of 0 would read as a closure when it is missing coverage (measured 2026-09-29).
 */
export function flightsHeadline(
	v: Pick<FlightsView, "days">,
	l: Lang,
): { today: number | null; toVenezuela: number | null; week: number; weekDays: number; text: string } {
	const today = v.days.at(-1);
	// Only days the feed read count: a day it never ran has no figure, never 0 (whole-release review, M9).
	const complete = v.days.filter((d) => !d.partial && d.covered).slice(-7);
	const week = complete.reduce((a, d) => a + d.total, 0);
	if (!today?.covered)
		return {
			today: null,
			toVenezuela: null,
			week,
			weekDays: complete.length,
			text: tr(
				l,
				"sin datos de hoy: Vigía no ha leído la fuente",
				"no data today: Vigía has not read the source",
			),
		};
	const n = today.total;
	const ve = today.internationalAll;
	return {
		today: n,
		toVenezuela: ve,
		week,
		weekDays: complete.length,
		text: tr(
			l,
			`${int(n, l)} ${n === 1 ? "vuelo de aerolínea visto" : "vuelos de aerolínea vistos"} hoy sobre o cerca de Venezuela (${int(ve, l)} con ruta publicada a un aeropuerto venezolano)`,
			`${int(n, l)} airline ${n === 1 ? "flight" : "flights"} seen today over or near Venezuela (${int(ve, l)} with a published route to a Venezuelan airport)`,
		),
	};
}

/** "62 % de lo habitual a esta hora" or why it cannot be said. An index, never a volume. */
export function trafficWord(t: NonNullable<RadarView["traffic"]>, l: Lang): string {
	if (t.pctOfUsual === null)
		return tr(
			l,
			`sin 3 días comparables (hay ${t.usualDays})`,
			`no 3 comparable days (there are ${t.usualDays})`,
		);
	return tr(
		l,
		`ahora al ${num(t.pctOfUsual, 0, l)} % de lo habitual a esta hora (${t.usualDays} días)`,
		`now at ${num(t.pctOfUsual, 0, l)} % of usual for this hour (${t.usualDays} days)`,
	);
}

/** A radar area's window, in the words the contract asks: detections, never ships. */
export function vesselLine(
	a: Pick<VesselsView["areas"][number], "detections" | "withoutAis">,
	days: number,
	l: Lang,
): string {
	if (!a.detections) return tr(l, `ninguna detección en ${days} días`, `no detection in ${days} days`);
	return tr(
		l,
		`${int(a.detections, l)} detecciones por radar en ${days} días, ${int(a.withoutAis, l)} sin AIS emparejado`,
		`${int(a.detections, l)} radar detections in ${days} days, ${int(a.withoutAis, l)} without matched AIS`,
	);
}

/** Bar heights for a series: linear, 0–1 of its own maximum (a non-zero value keeps a sliver; 0 stays 0). */
export function barScale(values: readonly number[]): number[] {
	const max = Math.max(0, ...values);
	return values.map((v) => (max > 0 && v > 0 ? Math.max(0.03, v / max) : 0));
}
