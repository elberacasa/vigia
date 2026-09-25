import { bcbPtax, PTAX_LICENCE, PTAX_PAGE, type PtaxRate } from "../adapters/bcb-ptax/index.ts";
import { FAO_CC_BY, FFPI_PAGE, FFPI_SERIES, type FoodIndex, faoFfpi } from "../adapters/fao-ffpi/index.ts";
import {
	fredMarkets,
	MARKET_SERIES,
	type MarketPrice,
	US_PUBLIC_DOMAIN_VIA_FRED,
} from "../adapters/fred-markets/index.ts";
import { EIA_VIA_FRED, FRED_SERIES, fredOil, type OilPrice } from "../adapters/fred-oil/index.ts";
import {
	imfPortwatch,
	PORTWATCH_HOME,
	PORTWATCH_LICENCE,
	type PortDay,
} from "../adapters/imf-portwatch/index.ts";
import { TRM_LICENCE, TRM_PAGE, type TrmRate, trmColombia } from "../adapters/trm-colombia/index.ts";
import {
	type MonthlyPrice,
	PINK_PAGE,
	PINK_SERIES,
	WORLD_BANK_CC_BY,
	wbPinksheet,
} from "../adapters/wb-pinksheet/index.ts";
import type { Store, StoredObservation } from "../core/store.ts";
import type { Json } from "../core/types.ts";
import { utcDateToMs } from "../formats/time.ts";
import type { Panel } from "../server/panels.ts";

/**
 * "Mercados y carga": world prices and neighbours' currencies that move Venezuela's economy, and ship calls at its
 * ports. Every change is computed here, by stated rules, from the stored series:
 *
 * - Daily series (a value per trading day): "d/d" is the newest value against the one before it when that one is at
 *   most D1_MAX_DAYS calendar days older (a weekend plus a holiday; after a longer gap there is no daily change,
 *   review 4 M11: a gap of weeks was labelled "día"); "7 d" against the
 *   newest value dated at least 7 days earlier (and no more than 13); "1 a" against the newest value dated at least
 *   365 days earlier (and no more than 372). A comparison whose base falls outside those bounds is not shown.
 * - Monthly series: "m/m" against the month before, "1 a" against the same month a year earlier; only exact months.
 * - Ports: the 7 days ending on the newest day against the 7 days before, and against the same 7 days 52 weeks
 *   earlier (364 days: same weekdays). A window missing any day is marked incomplete and not compared.
 */

const DAY = 86_400_000;

export type Point = { date: string; value: number };
export type Change = { abs: number; pct: number; from: string };

function change(latest: Point, base: Point | undefined): Change | null {
	if (!base || base.value === 0) return null;
	return { abs: latest.value - base.value, pct: (latest.value / base.value - 1) * 100, from: base.date };
}

function dayMs(date: string): number {
	return utcDateToMs(date) ?? Number.NaN;
}

/** Newest point dated in [latest − maxDays, latest − minDays]. `points` ascending by date, one per date. */
function baseBack(
	points: readonly Point[],
	latest: Point,
	minDays: number,
	maxDays: number,
): Point | undefined {
	const t = dayMs(latest.date);
	for (let i = points.length - 1; i >= 0; i--) {
		const p = points[i] as Point;
		const back = (t - dayMs(p.date)) / DAY;
		if (back < minDays) continue;
		return back <= maxDays ? p : undefined;
	}
	return undefined;
}

/** The previous trading day is at most this many calendar days back (Friday → Tuesday after a holiday Monday). */
export const D1_MAX_DAYS = 4;

export function dailyChanges(points: readonly Point[]): {
	d1: Change | null;
	w1: Change | null;
	y1: Change | null;
} {
	const latest = points.at(-1);
	if (!latest) return { d1: null, w1: null, y1: null };
	return {
		d1: change(latest, baseBack(points, latest, 1, D1_MAX_DAYS)),
		w1: change(latest, baseBack(points, latest, 7, 13)),
		y1: change(latest, baseBack(points, latest, 365, 372)),
	};
}

function shiftMonth(month: string, by: number): string {
	const y = Number(month.slice(0, 4));
	const m = Number(month.slice(5, 7)) - 1 + by;
	const d = new Date(Date.UTC(y, m, 1));
	return d.toISOString().slice(0, 7);
}

/** `points` dated "YYYY-MM". */
export function monthlyChanges(points: readonly Point[]): { m1: Change | null; y1: Change | null } {
	const latest = points.at(-1);
	if (!latest) return { m1: null, y1: null };
	const find = (month: string) => points.find((p) => p.date === month);
	return {
		m1: change(latest, find(shiftMonth(latest.date, -1))),
		y1: change(latest, find(shiftMonth(latest.date, -12))),
	};
}

/**
 * One value per period: the latest stored revision wins (a source re-publishing a corrected figure is a new row,
 * same period, later fetch). Returns the rows ascending by `observedAt`.
 */
export function latestRevisions<V extends Json>(
	rows: readonly StoredObservation<V>[],
	period: (o: StoredObservation<V>) => string,
): StoredObservation<V>[] {
	const by = new Map<string, StoredObservation<V>>();
	for (const o of rows) {
		const key = period(o);
		const prev = by.get(key);
		if (!prev || o.fetchedAt > prev.fetchedAt || (o.fetchedAt === prev.fetchedAt && o.id > prev.id))
			by.set(key, o);
	}
	return [...by.values()].sort((a, b) => a.observedAt - b.observedAt);
}

export type Cadence = "daily" | "weekly-release" | "monthly";

export type MarketTile = {
	id: string;
	labelEs: string;
	labelEn: string;
	unit: string;
	/** How often the source publishes a value: the UI labels monthly data as monthly averages. */
	cadence: Cadence;
	/** Decimals to show. */
	digits: number;
	feed: string;
	provider: string;
	sourceUrl: string;
	latest: { value: number; date: string; observedAt: number } | null;
	/** Daily/weekly-release series. */
	d1: Change | null;
	w1: Change | null;
	/** Monthly series. */
	m1: Change | null;
	y1: Change | null;
	/** The line: last 90 days for daily series, last 24 months for monthly. */
	spark: number[];
	sparkFrom: string | null;
	/** The newest value is older than this series' own budget. */
	stale: boolean;
	/** TRM: the next day's rate, already published (in force from `date`). */
	next: { value: number; date: string } | null;
};

export type MarketGroup = { id: string; titleEs: string; titleEn: string; tiles: MarketTile[] };

export type PortWindow = {
	from: string;
	to: string;
	days: number;
	calls: number;
	tankerCalls: number;
	importT: number;
	exportT: number;
};

export type MarketsView = {
	groups: MarketGroup[];
	ports: {
		newestDate: string | null;
		observedAt: number | null;
		week: PortWindow | null;
		prevWeek: PortWindow | null;
		yearAgo: PortWindow | null;
		callsChangePct: number | null;
		callsYoYPct: number | null;
		/** Weekly totals (7-day windows ending on the newest day, going back), oldest first, up to 26. */
		weekly: { to: string; calls: number; tankerCalls: number; complete: boolean }[];
		/** Ports with at least one call in the newest 7 days, most calls first. */
		byPort: {
			id: string;
			name: string;
			calls: number;
			tankerCalls: number;
			importT: number;
			exportT: number;
		}[];
		portCount: number;
		stale: boolean;
		caveatEs: string;
		caveatEn: string;
		sourceUrl: string;
	};
	rules: { es: string; en: string };
	attributions: { feed: string; text: string; licenceUrl: string }[];
};

const DAILY_WINDOW = 400 * DAY;
const MONTHLY_WINDOW = 1_900 * DAY;

type SeriesSpec = {
	id: string;
	labelEs: string;
	labelEn: string;
	unit: string;
	cadence: Cadence;
	digits: number;
	feed: string;
	provider: string;
	sourceUrl: string;
	/** Stale when the newest value is older than this. */
	budgetMs: number;
};

function dailyTile(
	spec: SeriesSpec,
	points: Point[],
	newestObservedAt: number | null,
	now: number,
): MarketTile {
	const latest = points.at(-1);
	const since = latest ? dayMs(latest.date) - 90 * DAY : 0;
	const line = points.filter((p) => dayMs(p.date) >= since);
	const c = dailyChanges(points);
	return {
		id: spec.id,
		labelEs: spec.labelEs,
		labelEn: spec.labelEn,
		unit: spec.unit,
		cadence: spec.cadence,
		digits: spec.digits,
		feed: spec.feed,
		provider: spec.provider,
		sourceUrl: spec.sourceUrl,
		latest:
			latest && newestObservedAt !== null
				? { value: latest.value, date: latest.date, observedAt: newestObservedAt }
				: null,
		d1: c.d1,
		w1: c.w1,
		m1: null,
		y1: c.y1,
		spark: line.map((p) => p.value),
		sparkFrom: line[0]?.date ?? null,
		stale: newestObservedAt === null || now - newestObservedAt > spec.budgetMs,
		next: null,
	};
}

function monthlyTile(
	spec: SeriesSpec,
	points: Point[],
	newestObservedAt: number | null,
	now: number,
): MarketTile {
	const latest = points.at(-1);
	const line = points.slice(-24);
	const c = monthlyChanges(points);
	return {
		id: spec.id,
		labelEs: spec.labelEs,
		labelEn: spec.labelEn,
		unit: spec.unit,
		cadence: "monthly",
		digits: spec.digits,
		feed: spec.feed,
		provider: spec.provider,
		sourceUrl: spec.sourceUrl,
		latest:
			latest && newestObservedAt !== null
				? { value: latest.value, date: latest.date, observedAt: newestObservedAt }
				: null,
		d1: null,
		w1: null,
		m1: c.m1,
		y1: c.y1,
		spark: line.map((p) => p.value),
		sparkFrom: line[0]?.date ?? null,
		stale: newestObservedAt === null || now - newestObservedAt > spec.budgetMs,
		next: null,
	};
}

function oilTiles(store: Store, now: number): MarketTile[] {
	return FRED_SERIES.map((s) => {
		const rows = latestRevisions(
			store.history<OilPrice>("fred-oil", s.series, now - DAILY_WINDOW, now),
			(o) => o.value.date,
		);
		return dailyTile(
			{
				id: s.series,
				labelEs: s.series === "brent" ? "Petróleo Brent" : "Petróleo WTI",
				labelEn: s.series === "brent" ? "Brent crude" : "WTI crude",
				unit: "US$/bbl",
				cadence: "daily",
				digits: 2,
				feed: "fred-oil",
				provider: "EIA vía FRED",
				sourceUrl: `https://fred.stlouisfed.org/series/${s.fredId}`,
				budgetMs: fredOil.freshness.dataMs ?? 6 * DAY,
			},
			rows.map((o) => ({ date: o.value.date, value: o.value.usdPerBarrel })),
			rows.at(-1)?.observedAt ?? null,
			now,
		);
	});
}

function fredTiles(store: Store, now: number, ids: readonly string[]): MarketTile[] {
	return MARKET_SERIES.filter((s) => ids.includes(s.series)).map((s) => {
		const rows = latestRevisions(
			store.history<MarketPrice>("fred-markets", s.series, now - DAILY_WINDOW, now),
			(o) => o.value.date,
		);
		const weekly = s.author === "Fed";
		return dailyTile(
			{
				id: s.series,
				labelEs: s.labelEs,
				labelEn: s.labelEn,
				unit: s.unit,
				cadence: weekly ? "weekly-release" : "daily",
				digits: s.series === "usd-broad" ? 1 : s.unit === "US$/gal" ? 3 : 2,
				feed: "fred-markets",
				provider: weekly ? "Reserva Federal vía FRED" : "EIA vía FRED",
				sourceUrl: `https://fred.stlouisfed.org/series/${s.fredId}`,
				// EIA daily: 6 days like Brent. Fed H.10 is released weekly with ~10 days' lag: 12 days.
				budgetMs: weekly ? (fredMarkets.freshness.dataMs ?? 12 * DAY) : 6 * DAY,
			},
			rows.map((o) => ({ date: o.value.date, value: o.value.value })),
			rows.at(-1)?.observedAt ?? null,
			now,
		);
	});
}

function copTile(store: Store, now: number): MarketTile {
	// Rows up to 5 days ahead: the next business day's TRM is published the afternoon before.
	const all = latestRevisions(
		store.history<TrmRate>("trm-colombia", "usd-cop", now - DAILY_WINDOW, now + 6 * DAY),
		(o) => o.value.validFrom,
	);
	const current = all.filter((o) => o.observedAt <= now);
	const upcoming = all.find((o) => o.observedAt > now);
	const tile = dailyTile(
		{
			id: "usd-cop",
			labelEs: "Peso colombiano (TRM)",
			labelEn: "Colombian peso (TRM)",
			unit: "COP por US$",
			cadence: "daily",
			digits: 2,
			feed: "trm-colombia",
			provider: "Superfinanciera (datos.gov.co)",
			sourceUrl: TRM_PAGE,
			budgetMs: trmColombia.freshness.dataMs ?? 5 * DAY,
		},
		current.map((o) => ({ date: o.value.validFrom, value: o.value.copPerUsd })),
		current.at(-1)?.observedAt ?? null,
		now,
	);
	return upcoming
		? { ...tile, next: { value: upcoming.value.copPerUsd, date: upcoming.value.validFrom } }
		: tile;
}

function brlTile(store: Store, now: number): MarketTile {
	const rows = latestRevisions(
		store.history<PtaxRate>("bcb-ptax", "usd-brl", now - DAILY_WINDOW, now),
		(o) => o.value.date,
	);
	return dailyTile(
		{
			id: "usd-brl",
			labelEs: "Real brasileño (PTAX)",
			labelEn: "Brazilian real (PTAX)",
			unit: "BRL por US$",
			cadence: "daily",
			digits: 4,
			feed: "bcb-ptax",
			provider: "Banco Central do Brasil",
			sourceUrl: PTAX_PAGE,
			budgetMs: bcbPtax.freshness.dataMs ?? 5 * DAY,
		},
		rows.map((o) => ({ date: o.value.date, value: o.value.brlPerUsd })),
		rows.at(-1)?.observedAt ?? null,
		now,
	);
}

function pinkTiles(store: Store, now: number, ids: readonly string[]): MarketTile[] {
	return PINK_SERIES.filter((s) => ids.includes(s.series)).map((s) => {
		const rows = latestRevisions(
			store.history<MonthlyPrice>("wb-pinksheet", s.series, now - MONTHLY_WINDOW, now),
			(o) => o.value.month,
		);
		const big = rows.at(-1) && (rows.at(-1)?.value.value ?? 0) >= 100;
		return monthlyTile(
			{
				id: `pink-${s.series}`,
				labelEs: s.labelEs,
				labelEn: s.labelEn,
				unit: s.unit,
				cadence: "monthly",
				digits: big ? 0 : 2,
				feed: "wb-pinksheet",
				provider: "Banco Mundial (Pink Sheet)",
				sourceUrl: PINK_PAGE,
				budgetMs: wbPinksheet.freshness.dataMs ?? 75 * DAY,
			},
			rows.map((o) => ({ date: o.value.month, value: o.value.value })),
			rows.at(-1)?.observedAt ?? null,
			now,
		);
	});
}

function faoTiles(store: Store, now: number): MarketTile[] {
	return FFPI_SERIES.map((s) => {
		const rows = latestRevisions(
			store.history<FoodIndex>("fao-ffpi", s.series, now - MONTHLY_WINDOW, now),
			(o) => o.value.month,
		);
		return monthlyTile(
			{
				id: `fao-${s.series}`,
				labelEs: s.labelEs,
				labelEn: s.labelEn,
				unit: "2014-16 = 100",
				cadence: "monthly",
				digits: 1,
				feed: "fao-ffpi",
				provider: "FAO",
				sourceUrl: FFPI_PAGE,
				budgetMs: faoFfpi.freshness.dataMs ?? 75 * DAY,
			},
			rows.map((o) => ({ date: o.value.month, value: o.value.index })),
			rows.at(-1)?.observedAt ?? null,
			now,
		);
	});
}

type DayRow = { date: string; portCalls: number; tankerCalls: number; importT: number; exportT: number };

/** Sums the days in [to − 6, to]; `days` counts the days present. */
export function portWindow(byDate: ReadonlyMap<string, DayRow>, to: string): PortWindow {
	const end = dayMs(to);
	const w: PortWindow = { from: "", to, days: 0, calls: 0, tankerCalls: 0, importT: 0, exportT: 0 };
	for (let i = 6; i >= 0; i--) {
		const date = new Date(end - i * DAY).toISOString().slice(0, 10);
		if (i === 6) w.from = date;
		const row = byDate.get(date);
		if (!row) continue;
		w.days++;
		w.calls += row.portCalls;
		w.tankerCalls += row.tankerCalls;
		w.importT += row.importT;
		w.exportT += row.exportT;
	}
	return w;
}

function pctChange(now: PortWindow | null, base: PortWindow | null): number | null {
	if (!now || !base || now.days < 7 || base.days < 7 || base.calls === 0) return null;
	return (now.calls / base.calls - 1) * 100;
}

const PORT_CAVEAT_ES =
	"Buques que entraron a 18 puertos y terminales venezolanos según sus señales AIS, procesadas por el FMI. Un buque con el AIS apagado no se cuenta: para Venezuela, donde hay tanqueros que navegan sin AIS, es un mínimo, no el total. Las toneladas son una estimación del FMI por el calado.";
const PORT_CAVEAT_EN =
	"Ships entering 18 Venezuelan ports and terminals according to their AIS signals, processed by the IMF. A ship with AIS off is not counted: for Venezuela, where some tankers sail without AIS, this is a floor, not the total. Tonnes are an IMF estimate from draught.";

export function portsView(store: Store, now: number): MarketsView["ports"] {
	const national = latestRevisions(
		store.history<PortDay>("imf-portwatch", "ve", now - 400 * DAY, now),
		(o) => o.value.date,
	);
	const byDate = new Map<string, DayRow>(national.map((o) => [o.value.date, o.value]));
	const newest = national.at(-1);
	const empty = {
		newestDate: null,
		observedAt: null,
		week: null,
		prevWeek: null,
		yearAgo: null,
		callsChangePct: null,
		callsYoYPct: null,
		weekly: [],
		byPort: [],
		portCount: 0,
		stale: true,
		caveatEs: PORT_CAVEAT_ES,
		caveatEn: PORT_CAVEAT_EN,
		sourceUrl: PORTWATCH_HOME,
	};
	if (!newest) return empty;
	const to = newest.value.date;
	const back = (days: number) => new Date(dayMs(to) - days * DAY).toISOString().slice(0, 10);
	const week = portWindow(byDate, to);
	const prevWeek = portWindow(byDate, back(7));
	const yearAgoRaw = portWindow(byDate, back(364));
	const yearAgo = yearAgoRaw.days > 0 ? yearAgoRaw : null;
	const weekly: MarketsView["ports"]["weekly"] = [];
	for (let k = 25; k >= 0; k--) {
		const w = portWindow(byDate, back(7 * k));
		if (w.days === 0) continue;
		weekly.push({ to: w.to, calls: w.calls, tankerCalls: w.tankerCalls, complete: w.days === 7 });
	}
	// Per port: the newest 7 days, from the per-port rows (latest revision per port and day).
	const portSeries = store
		.latestPerSeries<PortDay>("imf-portwatch", now - 400 * DAY)
		.map((o) => o.series)
		.filter((s) => s.startsWith("port:"));
	const byPort: MarketsView["ports"]["byPort"] = [];
	for (const series of portSeries) {
		const days = latestRevisions(
			store.history<PortDay>("imf-portwatch", series, dayMs(week.from), dayMs(to)),
			(o) => o.value.date,
		);
		const first = days[0];
		if (!first) continue;
		const row = {
			id: series.slice(5),
			name: first.value.name ?? series.slice(5),
			calls: 0,
			tankerCalls: 0,
			importT: 0,
			exportT: 0,
		};
		for (const o of days) {
			row.calls += o.value.portCalls;
			row.tankerCalls += o.value.tankerCalls;
			row.importT += o.value.importT;
			row.exportT += o.value.exportT;
		}
		byPort.push(row);
	}
	return {
		newestDate: to,
		observedAt: newest.observedAt,
		week,
		prevWeek: prevWeek.days ? prevWeek : null,
		yearAgo,
		callsChangePct: pctChange(week, prevWeek),
		callsYoYPct: pctChange(week, yearAgo),
		weekly,
		byPort: byPort
			.filter((p) => p.calls > 0)
			.sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)),
		portCount: portSeries.length,
		stale: now - newest.observedAt > (imfPortwatch.freshness.dataMs ?? 16 * DAY),
		caveatEs: PORT_CAVEAT_ES,
		caveatEn: PORT_CAVEAT_EN,
		sourceUrl: PORTWATCH_HOME,
	};
}

export function marketsView(store: Store, now: number): MarketsView {
	return {
		groups: [
			{
				id: "energy",
				titleEs: "Energía (diario)",
				titleEn: "Energy (daily)",
				tiles: [
					...oilTiles(store, now),
					...fredTiles(store, now, ["gasoline-usgc", "diesel-usgc", "henry-hub"]),
				],
			},
			{
				id: "fx",
				titleEs: "Monedas vecinas y dólar (diario)",
				titleEn: "Neighbours' currencies and the dollar (daily)",
				tiles: [copTile(store, now), brlTile(store, now), ...fredTiles(store, now, ["usd-broad"])],
			},
			{
				id: "exports",
				titleEs: "Metales y cultivos que Venezuela produce (promedio mensual)",
				titleEn: "Metals and crops Venezuela produces (monthly average)",
				tiles: pinkTiles(store, now, ["gold", "iron-ore", "aluminium", "urea", "cocoa", "coffee-arabica"]),
			},
			{
				id: "food",
				titleEs: "Alimentos en el mercado mundial (promedio mensual)",
				titleEn: "Food on world markets (monthly average)",
				tiles: [
					...faoTiles(store, now).slice(0, 1),
					...pinkTiles(store, now, ["wheat", "maize", "rice", "sugar", "soybean-oil"]),
				],
			},
		],
		ports: portsView(store, now),
		rules: {
			es: "Cambios calculados por Vigía con reglas fijas. Series diarias: «día» frente al valor anterior; «7 d» frente al último valor de 7 a 13 días antes; «1 año» frente al último de 365 a 372 días antes. Series mensuales (promedios del mes): «mes» frente al mes anterior y «1 año» frente al mismo mes del año anterior. Puertos: los 7 días que terminan en el último día publicado, frente a los 7 anteriores y a los mismos 7 días de hace 52 semanas; una semana incompleta no se compara.",
			en: 'Changes computed by Vigía with fixed rules. Daily series: "day" against the previous value; "7 d" against the last value 7 to 13 days earlier; "1 year" against the last value 365 to 372 days earlier. Monthly series (monthly averages): "month" against the previous month and "1 year" against the same month a year earlier. Ports: the 7 days ending on the newest published day, against the 7 before and the same 7 days 52 weeks earlier; an incomplete week is not compared.',
		},
		attributions: [
			{ feed: "fred-oil", text: EIA_VIA_FRED.attribution, licenceUrl: EIA_VIA_FRED.url },
			{
				feed: "fred-markets",
				text: US_PUBLIC_DOMAIN_VIA_FRED.attribution,
				licenceUrl: US_PUBLIC_DOMAIN_VIA_FRED.url,
			},
			{ feed: "trm-colombia", text: TRM_LICENCE.attribution, licenceUrl: TRM_LICENCE.url },
			{ feed: "bcb-ptax", text: PTAX_LICENCE.attribution, licenceUrl: PTAX_LICENCE.url },
			{ feed: "wb-pinksheet", text: WORLD_BANK_CC_BY.attribution, licenceUrl: WORLD_BANK_CC_BY.url },
			{ feed: "fao-ffpi", text: FAO_CC_BY.attribution, licenceUrl: FAO_CC_BY.url },
			{ feed: "imf-portwatch", text: PORTWATCH_LICENCE.attribution, licenceUrl: PORTWATCH_LICENCE.url },
		],
	};
}

export const marketsPanel: Panel<MarketsView> = {
	id: "markets",
	sources: [
		"fred-oil",
		"fred-markets",
		"trm-colombia",
		"bcb-ptax",
		"wb-pinksheet",
		"fao-ffpi",
		"imf-portwatch",
	],
	compute: (store: Store, now: number) => marketsView(store, now),
};
