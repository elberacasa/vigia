import {
	DAHITI_LICENCE,
	dahitiGuri,
	GURI_PAGE,
	GURI_SERIES,
	type GuriLevel,
} from "../adapters/dahiti-guri/index.ts";
import type { Store, StoredObservation } from "../core/store.ts";
import type { Panel } from "../server/panels.ts";

/**
 * "¿Hay luz, agua y gas?" The public-services layer, with only what can be measured or officially read:
 * - Electricity: the Guri reservoir's level by satellite altimetry (DAHITI), the slow signal behind rationing, with
 *   deterministic comparisons: the change over ~30 days and ~1 year, and where the level sits against the same
 *   weeks of every earlier year in the record. The fast signals of a cut (night lights, internet by state) live in
 *   their own panels; the UI links to them instead of repeating them.
 * - Everything a Venezuelan also asks (official rationing schedules, water and domestic gas interruptions, fuel
 *   prices) has no source Vigía can read today; `unavailable` says so, with what was checked and when, so the
 *   panel never implies "normal" where it has no data.
 */

const DAY = 86_400_000;
/** Points within this many days of the same calendar date count as "the same weeks" of another year. */
export const SEASON_WINDOW_DAYS = 15;
/** How far from the target date a point may be for the ~30-day and ~1-year comparisons. */
const MATCH_30D_DAYS = 8;
const MATCH_1Y_DAYS = 12;
/** Points shown in the sparkline: the last two years. */
const SPARK_DAYS = 730;

export const GURI_RULE_ES = `Comparaciones calculadas por Vigía con los puntos de DAHITI: el cambio frente al punto más cercano a 30 días antes (±${MATCH_30D_DAYS} d) y a un año antes (±${MATCH_1Y_DAYS} d), y la posición del nivel actual frente a la mediana de cada año anterior en las mismas semanas (±${SEASON_WINDOW_DAYS} días de la misma fecha).`;
export const GURI_RULE_EN = `Comparisons computed by Vigía from DAHITI's points: the change against the point closest to 30 days earlier (±${MATCH_30D_DAYS} d) and one year earlier (±${MATCH_1Y_DAYS} d), and where the current level sits against each earlier year's median over the same weeks (±${SEASON_WINDOW_DAYS} days of the same date).`;

export type GuriPoint = { t: number; m: number };

export type GuriChange = { m: number; fromM: number; fromObservedAt: number };

export type GuriSeason = {
	/** Earlier years with points in the same weeks. */
	years: number;
	/** Of those, years whose median level was below the current level. */
	below: number;
	firstYear: number;
	lastYear: number;
	/** The lowest and highest of those yearly medians, with their years. */
	lowest: { m: number; year: number };
	highest: { m: number; year: number };
};

export type GuriView = {
	feed: string;
	attribution: string;
	licenceUrl: string;
	sourceUrl: string;
	latest: { m: number; uncertaintyM: number; observedAt: number; fetchedAt: number; mission: string } | null;
	change30d: GuriChange | null;
	change1y: GuriChange | null;
	season: GuriSeason | null;
	record: { min: GuriPoint; max: GuriPoint; since: number } | null;
	/** Last two years of points, oldest first. */
	spark: GuriPoint[];
	/** The newest point is older than the feed's data budget. */
	stale: boolean;
	ruleEs: string;
	ruleEn: string;
};

export type Unavailable = {
	id: "corpoelec" | "rationing" | "water" | "gas" | "fuel";
	labelEs: string;
	labelEn: string;
	/** What was checked and what happened (dated). */
	checkedEs: string;
	checkedEn: string;
	/** Where the information does appear, for a person to open. */
	whereEs: string;
	whereEn: string;
	checkedOn: string;
};

/** Checked by hand on 2026-09-24 from outside Venezuela. */
export const UNAVAILABLE: readonly Unavailable[] = [
	{
		id: "corpoelec",
		labelEs: "Nivel oficial de Guri y estado de la red (Corpoelec, OPSIS)",
		labelEn: "Official Guri level and grid status (Corpoelec, OPSIS)",
		checkedEs:
			"corpoelec.gob.ve respondió 403 (bloqueo del servidor) y el dominio de OPSIS no existe; no hay datos abiertos.",
		checkedEn:
			"corpoelec.gob.ve answered 403 (server block) and OPSIS's domain does not resolve; there is no open data.",
		whereEs: "Corpoelec informa por sus redes sociales; las noticias recogen esos anuncios.",
		whereEn: "Corpoelec announces on its social accounts; news outlets carry those announcements.",
		checkedOn: "2026-09-24",
	},
	{
		id: "rationing",
		labelEs: "Horarios de racionamiento eléctrico",
		labelEn: "Power-rationing schedules",
		checkedEs:
			"No hay un horario oficial publicado en formato legible por máquina. En 2026 circularon horarios falsos por WhatsApp (desmentidos por verificadores).",
		checkedEn:
			"No official schedule is published in a machine-readable form. Fake schedules circulated on WhatsApp in 2026 (debunked by fact-checkers).",
		whereEs:
			"Solo cuenta un anuncio oficial con enlace; el panel de Noticias muestra los titulares sobre cortes.",
		whereEn: "Only an official announcement with a link counts; the News panel shows headlines about cuts.",
		checkedOn: "2026-09-24",
	},
	{
		id: "water",
		labelEs: "Cortes de agua (Hidrocapital, Hidrolago, Hidroven…)",
		labelEn: "Water cuts (Hidrocapital, Hidrolago, Hidroven…)",
		checkedEs:
			"Sus sitios no respondieron desde fuera de Venezuela (Hidrocapital sin DNS, Hidrolago e Hidroven con TLS roto) y no publican canales de datos.",
		checkedEn:
			"Their sites did not answer from outside Venezuela (Hidrocapital no DNS, Hidrolago and Hidroven broken TLS) and publish no data feeds.",
		whereEs: "Los avisos llegan por redes sociales y prensa; el panel de Noticias los recoge.",
		whereEn: "Notices arrive via social media and the press; the News panel carries them.",
		checkedOn: "2026-09-24",
	},
	{
		id: "gas",
		labelEs: "Gas doméstico (bombonas, distribución)",
		labelEn: "Household gas (cylinders, distribution)",
		checkedEs: "No hay fuente oficial abierta de distribución ni de precios de bombonas.",
		checkedEn: "There is no open official source for distribution or cylinder prices.",
		whereEs: "El panel de Noticias recoge los reportes de escasez.",
		whereEn: "The News panel carries shortage reports.",
		checkedOn: "2026-09-24",
	},
	{
		id: "fuel",
		labelEs: "Precio oficial de la gasolina y el diésel",
		labelEn: "Official petrol and diesel prices",
		checkedEs:
			"pdvsa.com no resuelve y el Ministerio de Petróleo no responde; una búsqueda de «gasolina» en el índice de la Gaceta Oficial no encontró una resolución de precios. Vigía no muestra un precio sin fuente oficial.",
		checkedEn:
			"pdvsa.com does not resolve and the Oil Ministry does not answer; a search for “gasolina” in the Official Gazette index found no pricing resolution. Vigía shows no price without an official source.",
		whereEs:
			"Los medios publican el cronograma de surtido por terminal de placa; no es un dato oficial abierto.",
		whereEn: "Outlets publish the plate-number refuelling schedule; it is not open official data.",
		checkedOn: "2026-09-24",
	},
];

export type ServicesView = {
	guri: GuriView;
	unavailable: Unavailable[];
};

const median = (xs: readonly number[]): number => {
	const s = [...xs].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

/** One value per instant (a later revision of the same pass wins), oldest first. */
export function points(rows: readonly StoredObservation<GuriLevel>[]): StoredObservation<GuriLevel>[] {
	const by = new Map<number, StoredObservation<GuriLevel>>();
	for (const r of rows) {
		const prev = by.get(r.observedAt);
		if (!prev || r.fetchedAt > prev.fetchedAt || (r.fetchedAt === prev.fetchedAt && r.id > prev.id))
			by.set(r.observedAt, r);
	}
	return [...by.values()].sort((a, b) => a.observedAt - b.observedAt);
}

/** The point closest to `target`, within `maxDays`, or null. */
export function nearest(
	pts: readonly StoredObservation<GuriLevel>[],
	target: number,
	maxDays: number,
): StoredObservation<GuriLevel> | null {
	let best: StoredObservation<GuriLevel> | null = null;
	for (const p of pts) {
		const d = Math.abs(p.observedAt - target);
		if (d > maxDays * DAY) continue;
		if (!best || d < Math.abs(best.observedAt - target)) best = p;
	}
	return best;
}

/**
 * The current level against the same weeks of each earlier year: for each year Y, the median of the points within
 * ±SEASON_WINDOW_DAYS of the latest point's month and day in Y (a window can straddle New Year), and how many of
 * those yearly medians are below the current level. Only years before the latest point's year count.
 */
export function seasonal(
	pts: readonly StoredObservation<GuriLevel>[],
	latest: StoredObservation<GuriLevel>,
): GuriSeason | null {
	const ref = new Date(latest.observedAt);
	const year = ref.getUTCFullYear();
	const anchor = (y: number) =>
		Date.UTC(y, ref.getUTCMonth(), ref.getUTCDate(), ref.getUTCHours(), ref.getUTCMinutes());
	const perYear = new Map<number, number[]>();
	for (const p of pts) {
		const py = new Date(p.observedAt).getUTCFullYear();
		for (const y of [py - 1, py, py + 1]) {
			if (y >= year || Math.abs(p.observedAt - anchor(y)) > SEASON_WINDOW_DAYS * DAY) continue;
			const list = perYear.get(y) ?? [];
			list.push(p.value.wseM);
			perYear.set(y, list);
		}
	}
	const years = [...perYear.entries()]
		.map(([y, ms]) => ({ year: y, m: median(ms) }))
		.sort((a, b) => a.year - b.year);
	const first = years[0];
	const last = years.at(-1);
	if (!first || !last) return null;
	let lowest = first;
	let highest = first;
	for (const y of years) {
		if (y.m < lowest.m) lowest = y;
		if (y.m > highest.m) highest = y;
	}
	return {
		years: years.length,
		below: years.filter((y) => y.m < latest.value.wseM).length,
		firstYear: first.year,
		lastYear: last.year,
		lowest: { m: lowest.m, year: lowest.year },
		highest: { m: highest.m, year: highest.year },
	};
}

function change(
	latest: StoredObservation<GuriLevel>,
	then: StoredObservation<GuriLevel> | null,
): GuriChange | null {
	return then && then !== latest
		? { m: latest.value.wseM - then.value.wseM, fromM: then.value.wseM, fromObservedAt: then.observedAt }
		: null;
}

export function guriView(store: Store, now: number): GuriView {
	const pts = points(store.history<GuriLevel>(dahitiGuri.id, GURI_SERIES, 0, now, 20_000));
	const latest = pts.at(-1) ?? null;
	let record: GuriView["record"] = null;
	if (pts.length) {
		let min = pts[0] as StoredObservation<GuriLevel>;
		let max = min;
		for (const p of pts) {
			if (p.value.wseM < min.value.wseM) min = p;
			if (p.value.wseM > max.value.wseM) max = p;
		}
		record = {
			min: { t: min.observedAt, m: min.value.wseM },
			max: { t: max.observedAt, m: max.value.wseM },
			since: (pts[0] as StoredObservation<GuriLevel>).observedAt,
		};
	}
	return {
		feed: dahitiGuri.id,
		attribution: DAHITI_LICENCE.attribution,
		licenceUrl: DAHITI_LICENCE.url,
		sourceUrl: GURI_PAGE,
		latest: latest
			? {
					m: latest.value.wseM,
					uncertaintyM: latest.value.uncertaintyM,
					observedAt: latest.observedAt,
					fetchedAt: latest.fetchedAt,
					mission: latest.value.mission,
				}
			: null,
		change30d: latest ? change(latest, nearest(pts, latest.observedAt - 30 * DAY, MATCH_30D_DAYS)) : null,
		change1y: latest ? change(latest, nearest(pts, latest.observedAt - 365 * DAY, MATCH_1Y_DAYS)) : null,
		season: latest ? seasonal(pts, latest) : null,
		record,
		spark: latest
			? pts
					.filter((p) => p.observedAt >= latest.observedAt - SPARK_DAYS * DAY)
					.map((p) => ({ t: p.observedAt, m: p.value.wseM }))
			: [],
		stale: !latest || now - latest.observedAt > (dahitiGuri.freshness.dataMs ?? 75 * DAY),
		ruleEs: GURI_RULE_ES,
		ruleEn: GURI_RULE_EN,
	};
}

export const servicesPanel: Panel<ServicesView> = {
	id: "services",
	sources: [dahitiGuri.id],
	compute: (store: Store, now: number) => ({ guri: guriView(store, now), unavailable: [...UNAVAILABLE] }),
};
