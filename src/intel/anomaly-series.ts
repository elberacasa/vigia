/**
 * Which series the anomaly engine judges, and how each is read from the archive: every metric is a row of
 * `METRICS` (label, unit, class, the feeds it comes from, how old its newest point may be) and a reader that turns
 * stored observations into the points its class needs, seeing only what was observed up to `now` (so a replay at a
 * past moment sees what the archive held for that moment). The arithmetic is in anomaly.ts.
 *
 * Series judged (entity ids from the ontology):
 *   connectivity    every state, ISP and the country                      (the connectivity panel's reading)
 *   nightlights     every state                                           (NASA VIIRS, clear nights)
 *   bcv.usd/eur     official rates, inst.bcv                              (bcv-official, bcv-history)
 *   bcv.reserves, bcv.m2, bcv.inpc                                        (BCV, inst.bcv)
 *   yadio.usd, binance.usdt  quotes of named third parties, the country   (daily close, Caracas time)
 *   oil.brent/wti   world prices, the country                             (FRED)
 *   tor.relay/bridge  Tor users from Venezuela, the country               (Tor Metrics)
 *   wiki.*          Wikipedia page views, the entity each article is about
 *   fires           heat detections per state per day                     (NASA FIRMS)
 *   gdelt           GDELT events per state per day
 *   headlines       headlines naming a state, an institution or a facility per day (the link index)
 *   lightning       GLM flashes per state per hour
 *
 * Not judged, with the reason: weather (a 7-day history is not a climate normal), quakes (single events: the
 * incidents and the quakes panel handle them), RIPE Atlas probes (single digits per state; the incidents use their
 * disconnections), OONI (rolling 7-day aggregates, not a series), port calls (weekly-lagged single-digit counts).
 */
import type { LightningWindow } from "../adapters/goes-glm/index.ts";
import { BIN_MS as IODA_BIN_MS } from "../adapters/ioda-states/ioda.ts";
import { OUTLETS } from "../adapters/rss/outlets.ts";
import type { Store } from "../core/store.ts";
import type { Json } from "../core/types.ts";
import { states } from "../geo/index.ts";
import { stateId } from "../ontology/registry.ts";
import { type ConnectivityView, type PlaceStatus, sameSlotBaseline } from "../panels/connectivity.ts";
import { quality, regionView } from "../panels/nightlights.ts";
import {
	ANOMALY_RULES,
	type AnomalyClass,
	type ChangeSpec,
	caracasDay,
	caracasDayStart,
	DAY,
	type Evaluation,
	evaluateChange,
	evaluateCount,
	evaluateLevel,
	evaluateNight,
	type Gate,
	HOUR,
	hourStart,
	type LevelSpec,
	lastWeekdayOfMonth,
	MIN,
	median,
	revertedStep,
} from "./anomaly.ts";

type Bilingual = { readonly es: string; readonly en: string };

export type MetricSpec = {
	readonly id: string;
	readonly label: Bilingual;
	readonly unit: Bilingual | null;
	readonly cls: AnomalyClass;
	/** What an incident can explain (anomaly.ts `explains`): "connectivity", "night", "headlines", "gdelt"… */
	readonly family: string;
	readonly feeds: readonly string[];
	/** The newest point may be at most this old for the series to be judged. */
	readonly maxAgeMs: number;
	/** The baseline window in words ("los 60 cambios diarios anteriores"). */
	readonly window: Bilingual;
};

/** One series judged at one moment. */
export type Judged = {
	readonly metric: MetricSpec;
	readonly entity: string;
	readonly feed: string;
	readonly sourceUrl: string;
	/** The newest point's time (when the source says it is true). */
	readonly observedAt: number;
	readonly fetchedAt: number | null;
	readonly result: Evaluation | Gate;
	/** The baseline window's bounds (the oldest and newest point it used). */
	readonly from: number | null;
	readonly to: number | null;
	/** Per-series figures that explain the reading (the IODA signals that agree, Tor's range). */
	readonly detail: Record<string, number | string | boolean | null>;
};

const days = (n: number) => n * DAY;
const w = (es: string, en: string): Bilingual => ({ es, en });

const change = (
	id: string,
	label: Bilingual,
	unit: Bilingual,
	feeds: string[],
	maxAgeMs: number,
	step: "daily" | "weekly" | "monthly",
): MetricSpec => {
	const { window } = ANOMALY_RULES.change[step];
	const stepEs = { daily: "diarios", weekly: "semanales", monthly: "mensuales" }[step];
	const stepEn = { daily: "daily", weekly: "weekly", monthly: "monthly" }[step];
	return {
		id,
		label,
		unit,
		cls: "change",
		family: "rates",
		feeds,
		maxAgeMs,
		window: w(`los ${window} cambios ${stepEs} anteriores`, `the previous ${window} ${stepEn} changes`),
	};
};

const LEVEL_WINDOW = w(
	`los ${ANOMALY_RULES.level.window} días anteriores`,
	`the previous ${ANOMALY_RULES.level.window} days`,
);
const COUNT_WINDOW = w(
	`los ${ANOMALY_RULES.count.window} días anteriores con datos`,
	`the previous ${ANOMALY_RULES.count.window} days with data`,
);

export const METRICS = {
	connectivity: {
		id: "connectivity",
		label: w("Conectividad a internet (IODA)", "Internet connectivity (IODA)"),
		unit: null,
		cls: "connectivity",
		family: "connectivity",
		feeds: ["ioda-states", "ioda-asn"],
		maxAgeMs: 60 * MIN,
		window: w(
			"la misma franja de 10 minutos de los 7 días anteriores",
			"the same 10-minute slot of the previous 7 days",
		),
	},
	nightlights: {
		id: "nightlights",
		label: w("Luces nocturnas (NASA VIIRS)", "Night lights (NASA VIIRS)"),
		unit: w("índice de radiancia", "radiance index"),
		cls: "night",
		family: "night",
		feeds: ["gibs-nightlights"],
		// NASA publishes a night 36–43 h after the overpass; one missed night more makes it stale.
		maxAgeMs: 72 * HOUR,
		window: w("hasta 14 noches despejadas anteriores", "up to 14 previous clear nights"),
	},
	bcvUsd: change(
		"bcv.usd",
		w("Tasa oficial del dólar (BCV)", "Official US dollar rate (BCV)"),
		w("Bs. por dólar", "Bs. per US dollar"),
		["bcv-official", "bcv-history"],
		days(5),
		"daily",
	),
	bcvEur: change(
		"bcv.eur",
		w("Tasa oficial del euro (BCV)", "Official euro rate (BCV)"),
		w("Bs. por euro", "Bs. per euro"),
		["bcv-official"],
		days(5),
		"daily",
	),
	reserves: change(
		"bcv.reserves",
		w("Reservas internacionales (BCV)", "International reserves (BCV)"),
		w("millones de US$", "US$ million"),
		["bcv-reserves"],
		days(10),
		"daily",
	),
	m2: change(
		"bcv.m2",
		w("Liquidez monetaria M2 (BCV)", "Money supply M2 (BCV)"),
		w("bolívares", "bolívares"),
		["bcv-liquidity"],
		days(21),
		"weekly",
	),
	inpc: change(
		"bcv.inpc",
		w("Índice de precios al consumidor (BCV)", "Consumer price index (BCV)"),
		w("índice", "index"),
		["bcv-inpc"],
		days(75),
		"monthly",
	),
	yadio: change(
		"yadio.usd",
		w("Cotización del dólar en Yadio", "US dollar quote on Yadio"),
		w("Bs. por dólar (cierre del día, hora de Venezuela)", "Bs. per US dollar (day close, Venezuelan time)"),
		["yadio"],
		36 * HOUR,
		"daily",
	),
	binance: change(
		"binance.usdt",
		w("Cotización de USDT en Binance P2P", "USDT quote on Binance P2P"),
		w("Bs. por USDT (mediana, cierre del día)", "Bs. per USDT (median, day close)"),
		["binance-p2p"],
		36 * HOUR,
		"daily",
	),
	brent: change(
		"oil.brent",
		w("Petróleo Brent (FRED)", "Brent crude (FRED)"),
		w("US$ por barril", "US$ per barrel"),
		["fred-oil"],
		days(7),
		"daily",
	),
	wti: change(
		"oil.wti",
		w("Petróleo WTI (FRED)", "WTI crude (FRED)"),
		w("US$ por barril", "US$ per barrel"),
		["fred-oil"],
		days(7),
		"daily",
	),
	torRelay: {
		id: "tor.relay",
		label: w("Usuarios de Tor desde Venezuela, directos", "Tor users from Venezuela, direct"),
		unit: w("usuarios al día (estimación de Tor Metrics)", "users a day (Tor Metrics estimate)"),
		cls: "level",
		family: "censorship",
		feeds: ["tor-metrics"],
		maxAgeMs: days(5),
		window: LEVEL_WINDOW,
	},
	torBridge: {
		id: "tor.bridge",
		label: w("Usuarios de Tor desde Venezuela, por puentes", "Tor users from Venezuela, via bridges"),
		unit: w("usuarios al día (estimación de Tor Metrics)", "users a day (Tor Metrics estimate)"),
		cls: "level",
		family: "censorship",
		feeds: ["tor-metrics"],
		maxAgeMs: days(5),
		window: LEVEL_WINDOW,
	},
	wiki: {
		id: "wiki",
		label: w("Visitas a Wikipedia", "Wikipedia page views"),
		unit: w("visitas al día", "views a day"),
		cls: "level",
		family: "attention",
		feeds: ["wiki-attention"],
		maxAgeMs: days(3),
		window: LEVEL_WINDOW,
	},
	fires: {
		id: "fires",
		label: w("Focos de calor (NASA FIRMS, VIIRS)", "Heat detections (NASA FIRMS, VIIRS)"),
		unit: w("detecciones en el día", "detections in the day"),
		cls: "count",
		family: "fires",
		feeds: ["firms-fires"],
		maxAgeMs: 12 * HOUR,
		window: COUNT_WINDOW,
	},
	gdelt: {
		id: "gdelt",
		label: w("Eventos codificados por GDELT", "Events coded by GDELT"),
		unit: w("eventos en el día (codificación automática)", "events in the day (automatic coding)"),
		cls: "count",
		family: "gdelt",
		feeds: ["gdelt-ve"],
		maxAgeMs: 2 * HOUR,
		window: COUNT_WINDOW,
	},
	headlines: {
		id: "headlines",
		label: w("Titulares que lo nombran", "Headlines naming it"),
		unit: w(
			"titulares en el día (ubicación por palabra clave)",
			"headlines in the day (location by keyword)",
		),
		cls: "count",
		family: "headlines",
		feeds: OUTLETS.map((o) => o.id),
		maxAgeMs: 2 * HOUR,
		window: COUNT_WINDOW,
	},
	lightning: {
		id: "lightning",
		label: w("Rayos detectados (GOES-19 GLM)", "Lightning detected (GOES-19 GLM)"),
		unit: w("destellos en la hora", "flashes in the hour"),
		cls: "hourly",
		family: "lightning",
		feeds: ["goes-glm"],
		maxAgeMs: 90 * MIN,
		window: w(
			`la misma hora de los ${ANOMALY_RULES.hourly.days} días anteriores`,
			`the same hour of the previous ${ANOMALY_RULES.hourly.days} days`,
		),
	},
} as const satisfies Record<string, MetricSpec>;

/** Per-series parameters (stated with the other thresholds before the replay on the archive). */
export const CHANGE_SPECS: Readonly<Record<string, ChangeSpec>> = {
	"bcv.usd": { step: "daily", direction: "both", minLogChange: 0.01, sigmaFloor: 0.001 },
	"bcv.eur": { step: "daily", direction: "both", minLogChange: 0.01, sigmaFloor: 0.001 },
	// The BCV revalues its reserves at each month's close: month-end changes are judged against month-ends.
	// The BCV revalues its reserves at each month's close: month-end changes are judged against month-ends; a move the
	// published series takes back within a few points is told as one "revertido" item.
	"bcv.reserves": {
		step: "daily",
		direction: "both",
		minLogChange: 0.01,
		sigmaFloor: 0.001,
		monthEnd: true,
		revert: true,
	},
	"bcv.m2": { step: "weekly", direction: "both", minLogChange: 0.03, sigmaFloor: 0.005 },
	"bcv.inpc": { step: "monthly", direction: "both", minLogChange: 0.02, sigmaFloor: 0.003 },
	"yadio.usd": { step: "daily", direction: "both", minLogChange: 0.02, sigmaFloor: 0.002 },
	"binance.usdt": { step: "daily", direction: "both", minLogChange: 0.02, sigmaFloor: 0.002 },
	"oil.brent": { step: "daily", direction: "both", minLogChange: 0.03, sigmaFloor: 0.003 },
	"oil.wti": { step: "daily", direction: "both", minLogChange: 0.03, sigmaFloor: 0.003 },
};

export const LEVEL_SPECS: Readonly<Record<string, LevelSpec>> = {
	tor: { direction: "both", minRatio: 1.25, minValue: 50, sigmaFloor: 0.05 },
	wiki: { direction: "up", minRatio: 3, minValue: 100, sigmaFloor: 0.1 },
};

/** Minimum events for a count to be unusual. */
export const MIN_COUNTS: Readonly<Record<string, number>> = {
	fires: 10,
	gdelt: 20,
	headlines: 10,
	lightning: 300,
};

/** Wikipedia topics (wiki-attention) to the entity each article is about. */
export const WIKI_ENTITIES: Readonly<Record<string, string>> = {
	venezuela: "ve",
	crisis: "ve",
	bolivar: "ve",
	blackouts: "ve",
	caracas: "ve.distrito-capital",
	presidency: "inst.presidencia",
	pdvsa: "inst.pdvsa",
	bcv: "inst.bcv",
	cantv: "inst.cantv",
};

// ——— reading the archive ———

type Row<V> = { observedAt: number; fetchedAt: number; sourceUrl: string; value: V; series: string };

/** Rows of a source (optionally one series) observed in [from, to], oldest first, parsed. */
function rows<V extends Json>(
	store: Store,
	source: string,
	from: number,
	to: number,
	series?: string,
): Row<V>[] {
	const sql = series
		? "SELECT series, observed_at, fetched_at, source_url, value FROM obs WHERE source = ? AND series = ? AND observed_at BETWEEN ? AND ? ORDER BY observed_at, id"
		: "SELECT series, observed_at, fetched_at, source_url, value FROM obs WHERE source = ? AND observed_at BETWEEN ? AND ? ORDER BY observed_at, id";
	const params = series ? [source, series, from, to] : [source, from, to];
	return store.db
		.query<
			{ series: string; observed_at: number; fetched_at: number; source_url: string; value: string },
			(string | number)[]
		>(sql)
		.all(...params)
		.map((r) => ({
			series: r.series,
			observedAt: r.observed_at,
			fetchedAt: r.fetched_at,
			sourceUrl: r.source_url,
			value: JSON.parse(r.value) as V,
		}));
}

type Point = {
	key: string;
	v: number;
	observedAt: number;
	fetchedAt: number;
	sourceUrl: string;
	feed: string;
};

/** One point per key (a date, a week), the newest revision winning, sorted by key. */
function byKey(points: readonly Point[]): Point[] {
	const m = new Map<string, Point>();
	for (const p of points) m.set(p.key, p);
	return [...m.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

function judgedFrom(
	metric: MetricSpec,
	entity: string,
	points: readonly Point[],
	now: number,
	evaluate: (values: number[]) => Evaluation | Gate,
	detail: Judged["detail"] = {},
): Judged | null {
	const last = points.at(-1);
	if (!last) return null;
	const stale = now - last.observedAt > metric.maxAgeMs;
	const first = points.at(0);
	return {
		metric,
		entity,
		feed: last.feed,
		sourceUrl: last.sourceUrl,
		observedAt: last.observedAt,
		fetchedAt: last.fetchedAt,
		result: stale ? "stale" : evaluate(points.map((p) => p.v)),
		from: first?.observedAt ?? null,
		to: points.at(-2)?.observedAt ?? null,
		detail,
	};
}

/**
 * How many usual steps the newest step spans: its time gap over the median gap of the previous steps (a quote whose
 * feed was down for five days has one step of six). Only a gap longer than every gap of the window counts, by more
 * than half a day: weekends and holidays in a business-day series are its rhythm. 1 when there is too little to say.
 */
export function spanOf(points: readonly { observedAt: number }[], window: number): number {
	if (points.length < 3) return 1;
	const times = points.slice(-window - 2).map((p) => p.observedAt);
	const gaps: number[] = [];
	for (let i = 1; i < times.length; i++) gaps.push((times[i] as number) - (times[i - 1] as number));
	const last = gaps.pop() as number;
	const usual = Math.max(1, median(gaps) ?? 0);
	return last > Math.max(...gaps) + DAY / 2 ? last / usual : 1;
}

/**
 * Rows up to `now`; official rates are published for the next business day the afternoon before, so their value
 * date may lie up to a day ahead.
 */
const AHEAD_MS = DAY;

function judgeChanges(store: Store, now: number): Judged[] {
	const out: (Judged | null)[] = [];
	const since = (step: "daily" | "weekly" | "monthly" | "monthEnd") =>
		now - { daily: days(150), weekly: days(420), monthly: days(1_200), monthEnd: days(430) }[step];
	const point = (key: string, v: number | null, r: Row<Json>, feed: string): Point[] =>
		v !== null && v > 0
			? [{ key, v, observedAt: r.observedAt, fetchedAt: r.fetchedAt, sourceUrl: r.sourceUrl, feed }]
			: [];
	const judge = (metric: MetricSpec, entity: string, points: Point[]) => {
		const spec = CHANGE_SPECS[metric.id];
		const dates = points.map((p) => p.key);
		const monthEnd = spec?.monthEnd === true && lastWeekdayOfMonth(dates.at(-1) ?? "");
		const span = spanOf(points, 60);
		const detail: Judged["detail"] = {
			...(monthEnd ? { monthEnd: true } : {}),
			...(span > 1 ? { stepsSpanned: Math.round(span * 10) / 10 } : {}),
		};
		if (!spec) return;
		const judged = judgedFrom(
			metric,
			entity,
			points,
			now,
			(v) => evaluateChange(v, spec, dates, span),
			detail,
		);
		const values = points.map((p) => p.v);
		const unusualAt = (k: number) => {
			const e = evaluateChange(values.slice(0, k + 1), spec, dates.slice(0, k + 1));
			return typeof e !== "string" && e.unusual;
		};
		const rev =
			spec.revert && judged && typeof judged.result !== "string" ? revertedStep(values, unusualAt) : null;
		const at = rev ? points[rev.step] : undefined;
		const newest = points.at(-1);
		if (!rev || !at || !newest || !judged) {
			out.push(judged);
			return;
		}
		// The newest point takes back an earlier unusual step: one item about that step, labelled with the fact.
		const k = rev.step;
		const e = evaluateChange(values.slice(0, k + 1), spec, dates.slice(0, k + 1));
		out.push({
			...judged,
			observedAt: at.observedAt,
			fetchedAt: at.fetchedAt,
			sourceUrl: at.sourceUrl,
			result: e,
			to: points[k - 1]?.observedAt ?? null,
			detail: {
				...(lastWeekdayOfMonth(dates[k] ?? "") && spec.monthEnd ? { monthEnd: true } : {}),
				reverted: true,
				revertedAfterSteps: rev.afterSteps,
				revertedDate: newest.key,
				revertedAt: newest.observedAt,
				revertedValue: newest.v,
				stepDate: at.key,
			},
		});
	};

	// Official rates: the BCV's own history (USD since 2016) and its daily page, by value date (same publication).
	const official = (currency: string, withHistory: boolean) => {
		const pts: Point[] = [];
		if (withHistory)
			for (const r of rows<Json>(store, "bcv-history", since("daily"), now + AHEAD_MS, `${currency}-ves`)) {
				const v = r.value as { valueDate?: string; vesPerUsd?: number };
				pts.push(...point(v.valueDate ?? "", num(v.vesPerUsd), r, "bcv-history"));
			}
		for (const r of rows<Json>(store, "bcv-official", since("daily"), now + AHEAD_MS, `${currency}-ves`)) {
			const v = r.value as { valueDate?: string; vesPerUnit?: number };
			pts.push(...point(v.valueDate ?? "", num(v.vesPerUnit), r, "bcv-official"));
		}
		return byKey(pts.filter((p) => p.key));
	};
	judge(METRICS.bcvUsd, "inst.bcv", official("usd", true));
	judge(METRICS.bcvEur, "inst.bcv", official("eur", false));

	const dated = (
		source: string,
		series: string,
		step: "daily" | "weekly" | "monthly" | "monthEnd",
		key: string,
		val: string,
	) =>
		byKey(
			rows<Json>(store, source, since(step), now, series).flatMap((r) => {
				const v = r.value as Record<string, Json>;
				return point(String(v[key] ?? ""), num(v[val]), r, source);
			}),
		).filter((p) => p.key);
	judge(METRICS.reserves, "inst.bcv", dated("bcv-reserves", "reserves", "monthEnd", "date", "totalMusd"));
	judge(METRICS.m2, "inst.bcv", dated("bcv-liquidity", "m2", "weekly", "weekEnding", "m2Ves"));
	judge(METRICS.inpc, "inst.bcv", dated("bcv-inpc", "inpc", "monthly", "period", "index"));
	judge(METRICS.brent, "ve", dated("fred-oil", "brent", "daily", "date", "usdPerBarrel"));
	judge(METRICS.wti, "ve", dated("fred-oil", "wti", "daily", "date", "usdPerBarrel"));

	// Quotes polled through the day: the day's close (the last quote of each Caracas day; today's so far), picked in
	// SQL so a quote polled every few minutes is not parsed thousands of times.
	const close = (source: string, series: string, val: (v: Record<string, Json>) => number | null) =>
		store.db
			.query<
				{ d: number; observed_at: number; fetched_at: number; source_url: string; value: string },
				[string, string, number, number]
			>(
				`SELECT d, observed_at, fetched_at, source_url, value FROM (
					SELECT CAST((observed_at - ${4 * HOUR}) / ${DAY} AS INTEGER) AS d, observed_at, fetched_at, source_url, value,
					       ROW_NUMBER() OVER (PARTITION BY CAST((observed_at - ${4 * HOUR}) / ${DAY} AS INTEGER)
					                          ORDER BY observed_at DESC, id DESC) AS rn
					FROM obs WHERE source = ? AND series = ? AND observed_at BETWEEN ? AND ?
				) WHERE rn = 1 ORDER BY d`,
			)
			.all(source, series, since("daily"), now)
			.flatMap((r) =>
				point(
					String(r.d).padStart(8, "0"),
					val(JSON.parse(r.value) as Record<string, Json>),
					{
						series,
						observedAt: r.observed_at,
						fetchedAt: r.fetched_at,
						sourceUrl: r.source_url,
						value: null,
					},
					source,
				),
			);
	judge(
		METRICS.yadio,
		"ve",
		close("yadio", "usd-ves", (v) => num(v.vesPerUsd)),
	);
	judge(
		METRICS.binance,
		"ve",
		close("binance-p2p", "usdt-ves", (v) => num(v.midVesPerUsdt)),
	);
	return out.filter((j): j is Judged => j !== null);
}

function judgeLevels(store: Store, now: number): Judged[] {
	const out: (Judged | null)[] = [];
	const from = now - days(60);
	for (const [metric, kind] of [
		[METRICS.torRelay, "relay"],
		[METRICS.torBridge, "bridge"],
	] as const) {
		const pts = byKey(
			rows<Json>(store, "tor-metrics", from, now, `country:VE:tor-${kind}`).flatMap((r) => {
				const v = r.value as { users?: number };
				const users = num(v.users);
				return users === null
					? []
					: [
							{
								key: String(r.observedAt).padStart(14, "0"),
								v: users,
								observedAt: r.observedAt,
								fetchedAt: r.fetchedAt,
								sourceUrl: r.sourceUrl,
								feed: "tor-metrics",
							},
						];
			}),
		);
		const newest = rows<Json>(store, "tor-metrics", from, now, `country:VE:tor-${kind}`).at(-1)?.value as
			| { lower?: number | null; upper?: number | null }
			| undefined;
		const lower = num(newest?.lower);
		const upper = num(newest?.upper);
		const spec = LEVEL_SPECS.tor as LevelSpec;
		out.push(
			judgedFrom(
				metric,
				"ve",
				pts,
				now,
				(values) => {
					const e = evaluateLevel(values, spec);
					if (typeof e === "string" || kind !== "relay") return e;
					// Direct users: never contradict the detector Tor publishes (outside its expected range, when given).
					const v = values.at(-1) as number;
					const outside = lower === null || upper === null || v < lower || v > upper;
					return { ...e, unusual: e.unusual && outside };
				},
				kind === "relay" ? { torLower: lower, torUpper: upper } : {},
			),
		);
	}
	// Wikipedia: one series per article, on the entity its topic is about.
	const bySeries = new Map<string, Row<Json>[]>();
	for (const r of rows<Json>(store, "wiki-attention", from, now)) {
		const list = bySeries.get(r.series);
		if (list) list.push(r);
		else bySeries.set(r.series, [r]);
	}
	for (const [series, list] of bySeries) {
		const first = list[0]?.value as { topic?: string; project?: string; title?: string } | undefined;
		const entity = WIKI_ENTITIES[first?.topic ?? ""] ?? "ve";
		const pts = byKey(
			list.flatMap((r) => {
				const v = r.value as { date?: string; views?: number };
				const views = num(v.views);
				return views === null || !v.date
					? []
					: [
							{
								key: v.date,
								v: views,
								observedAt: r.observedAt,
								fetchedAt: r.fetchedAt,
								sourceUrl: r.sourceUrl,
								feed: "wiki-attention",
							},
						];
			}),
		);
		const metric: MetricSpec = {
			...METRICS.wiki,
			id: `wiki.${series.replace(/^pv:/, "")}`,
			label: w(
				`Visitas a Wikipedia: ${(first?.title ?? "").replaceAll("_", " ")} (${first?.project ?? ""})`,
				`Wikipedia page views: ${(first?.title ?? "").replaceAll("_", " ")} (${first?.project ?? ""})`,
			),
		};
		out.push(judgedFrom(metric, entity, pts, now, (v) => evaluateLevel(v, LEVEL_SPECS.wiki as LevelSpec)));
	}
	return out.filter((j): j is Judged => j !== null);
}

function judgeNights(store: Store, now: number): Judged[] {
	const source = "gibs-nightlights";
	const from = now - days(30);
	const series = store.db
		.query<{ series: string }, [string, number, number]>(
			"SELECT DISTINCT series FROM obs WHERE source = ? AND observed_at BETWEEN ? AND ? AND series LIKE 'state:%'",
		)
		.all(source, from, now)
		.map((r) => r.series);
	const out: Judged[] = [];
	for (const s of series) {
		type Light = Parameters<typeof regionView>[0];
		const byDate = new Map<string, Row<Light>>();
		for (const r of rows<Json>(store, source, from, now, s))
			byDate.set((r.value as { date: string }).date, r as unknown as Row<Light>);
		const dates = [...byDate.keys()].sort();
		const latest = byDate.get(dates.at(-1) ?? "");
		if (!latest) continue;
		const previous = dates
			.slice(0, -1)
			.slice(-14)
			.map((d) => (byDate.get(d) as Row<Light>).value);
		const view = regionView(latest.value, previous);
		const iso = latest.value.iso;
		const entity = stateEntity(iso);
		if (!entity) continue;
		const clear = previous
			.filter((p) => {
				const q = quality(p.clearFraction);
				return q === "clear" || q === "partly";
			})
			.map((p) => p.radiance)
			.filter((r): r is number => r !== null);
		const stale = now - latest.observedAt > METRICS.nightlights.maxAgeMs;
		const result: Evaluation | Gate = stale
			? "stale"
			: !view.comparable || view.pctChange === null || view.radianceIndex === null
				? view.baselineNights < 7
					? "thin"
					: "weak"
				: evaluateNight(view.radianceIndex, clear, view.pctChange);
		out.push({
			metric: METRICS.nightlights,
			entity,
			feed: source,
			sourceUrl: latest.sourceUrl,
			observedAt: latest.observedAt,
			fetchedAt: latest.fetchedAt,
			result,
			from: from,
			to: latest.observedAt - DAY,
			detail: { quality: view.quality, clearFraction: view.clearFraction },
		});
	}
	return out;
}

/** The state entity id of an ISO code ("VE-V" → "ve.zulia"). */
export function stateEntity(iso: string): string | null {
	return stateId(iso);
}

// ——— counts ———

type DayCounts = Map<number, number>;

/**
 * Count rule over days: today's count (so far) against the previous `window` days that have coverage (days with no
 * data from the feed are left out, never read as zeros).
 */
function judgeDaily(
	metric: MetricSpec,
	entity: string,
	counts: DayCounts,
	covered: ReadonlySet<number>,
	now: number,
	newest: { at: number; fetchedAt: number | null; url: string; feed: string } | null,
	/** When the feed was last read successfully, when that differs from its newest datum (fires); else the datum. */
	checkedAt: number | null = newest?.at ?? null,
): Judged {
	const today = caracasDay(now);
	const prior: number[] = [];
	let first: number | null = null;
	for (let d = today - ANOMALY_RULES.count.window; d < today; d++) {
		if (!covered.has(d)) continue;
		prior.push(counts.get(d) ?? 0);
		first ??= d;
	}
	const fresh = checkedAt !== null && now - checkedAt <= metric.maxAgeMs && covered.has(today);
	return {
		metric,
		entity,
		feed: newest?.feed ?? metric.feeds[0] ?? "",
		sourceUrl: newest?.url ?? "",
		observedAt: newest?.at ?? caracasDayStart(today),
		fetchedAt: newest?.fetchedAt ?? null,
		result: fresh
			? evaluateCount(
					counts.get(today) ?? 0,
					prior,
					{ minCount: MIN_COUNTS[metric.id] ?? 1 },
					{
						minRatio: ANOMALY_RULES.count.minRatio,
						maxTail: ANOMALY_RULES.count.maxTail,
						minPrior: ANOMALY_RULES.count.minDays,
					},
				)
			: "stale",
		from: first === null ? null : caracasDayStart(first),
		to: caracasDayStart(today),
		detail: {},
	};
}

/** The Caracas day of `observed_at` in SQL (caracasDay). */
const DAY_SQL = `CAST((observed_at - ${4 * HOUR}) / ${DAY} AS INTEGER)`;

/** Days (Caracas) with at least `min` successful runs of a feed. */
function runDays(store: Store, source: string, from: number, to: number, min = 1): Set<number> {
	return new Set(
		store.db
			.query<{ d: number; n: number }, [string, number, number]>(
				`SELECT CAST((started_at - ${4 * HOUR}) / ${DAY} AS INTEGER) AS d, COUNT(*) AS n FROM runs
				 WHERE source = ? AND ok = 1 AND started_at BETWEEN ? AND ? GROUP BY d`,
			)
			.all(source, from, to)
			.filter((r) => r.n >= min)
			.map((r) => r.d),
	);
}

function judgeFires(store: Store, now: number): Judged[] {
	const from = caracasDayStart(caracasDay(now) - ANOMALY_RULES.count.window);
	const byState = new Map<string, DayCounts>();
	for (const r of store.db
		.query<{ state: string; d: number; n: number }, [number, number]>(
			`SELECT state, ${DAY_SQL} AS d, COUNT(DISTINCT series) AS n FROM obs
			 WHERE source = 'firms-fires' AND observed_at BETWEEN ? AND ? AND state IS NOT NULL AND series LIKE 'fire:%'
			 GROUP BY state, d`,
		)
		.all(from, now)) {
		const m = byState.get(r.state) ?? new Map<number, number>();
		m.set(r.d, r.n);
		byState.set(r.state, m);
	}
	// Coverage: days on which the feed ran; replayed archives without run records fall back to days with a file row.
	let covered = runDays(store, "firms-fires", from, now);
	if (covered.size === 0)
		covered = new Set(
			store.db
				.query<{ d: number }, [number, number]>(
					`SELECT DISTINCT ${DAY_SQL} AS d FROM obs WHERE source = 'firms-fires' AND series = 'firms:file' AND observed_at BETWEEN ? AND ?`,
				)
				.all(from, now)
				.map((r) => r.d),
		);
	const last = store.db
		.query<{ t: number | null; f: number | null }, [number]>(
			"SELECT MAX(observed_at) AS t, MAX(fetched_at) AS f FROM obs WHERE source = 'firms-fires' AND observed_at <= ?",
		)
		.get(now);
	const newest = last?.t
		? { at: last.t, fetchedAt: last.f, url: "https://firms.modaps.eosdis.nasa.gov/map/", feed: "firms-fires" }
		: null;
	// Hours without a detection are normal: freshness is the feed's last good read (a run, or a file row in a replay).
	const checked =
		store.db
			.query<{ t: number | null }, [number]>(
				"SELECT MAX(finished_at) AS t FROM runs WHERE source = 'firms-fires' AND ok = 1 AND finished_at <= ?",
			)
			.get(now)?.t ??
		store.db
			.query<{ t: number | null }, [number]>(
				"SELECT MAX(observed_at) AS t FROM obs WHERE source = 'firms-fires' AND series = 'firms:file' AND observed_at <= ?",
			)
			.get(now)?.t ??
		null;
	const out: Judged[] = [];
	for (const s of stateIsoCodes()) {
		const entity = stateEntity(s);
		if (entity)
			out.push(judgeDaily(METRICS.fires, entity, byState.get(s) ?? new Map(), covered, now, newest, checked));
	}
	return out;
}

function judgeGdelt(store: Store, now: number): Judged[] {
	const from = caracasDayStart(caracasDay(now) - ANOMALY_RULES.count.window);
	const byState = new Map<string, DayCounts>();
	const batches = new Map<number, number>();
	let newest: { at: number; fetchedAt: number | null; url: string; feed: string } | null = null;
	for (const r of [
		...rows<Json>(store, "gdelt-ve", from, now, "gdelt:batch:en"),
		...rows<Json>(store, "gdelt-ve", from, now, "gdelt:batch:tr"),
	]) {
		const v = r.value as { missing?: boolean; byState?: Record<string, number> };
		const d = caracasDay(r.observedAt);
		if (v.missing) continue;
		batches.set(d, (batches.get(d) ?? 0) + 1);
		for (const [iso, n] of Object.entries(v.byState ?? {})) {
			const m = byState.get(iso) ?? new Map<number, number>();
			m.set(d, (m.get(d) ?? 0) + n);
			byState.set(iso, m);
		}
		if (!newest || r.observedAt >= newest.at)
			newest = { at: r.observedAt, fetchedAt: r.fetchedAt, url: r.sourceUrl, feed: "gdelt-ve" };
	}
	// A day counts when GDELT's batches for at least half of it (both streams: 192 a day) were read.
	const today = caracasDay(now);
	const covered = new Set(
		[...batches]
			.filter(
				([d, n]) =>
					n >= 96 ||
					(d === today && n >= Math.min(96, Math.floor((now - caracasDayStart(today)) / (15 * MIN)))),
			)
			.map(([d]) => d),
	);
	const out: Judged[] = [];
	for (const s of stateIsoCodes()) {
		const entity = stateEntity(s);
		if (entity)
			out.push(judgeDaily(METRICS.gdelt, entity, byState.get(s) ?? new Map(), covered, now, newest));
	}
	return out;
}

/**
 * The link index is catching up (a restart, a new rules version relinking the archive) when this many observations
 * wait to be linked; below it, the few newest rows not linked yet only delay today's count by seconds.
 */
export const HEADLINE_BACKLOG_MAX = 20_000;

/** Headlines naming an entity per day, from the link index (the entity API's table); none while it catches up. */
function judgeHeadlines(store: Store, now: number, linkBacklog: number): Judged[] {
	const exists = store.db
		.query<{ n: number }, []>(
			"SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'entity_links'",
		)
		.get();
	if (!exists?.n || linkBacklog > HEADLINE_BACKLOG_MAX) return [];
	const from = caracasDayStart(caracasDay(now) - ANOMALY_RULES.count.window);
	const feeds = METRICS.headlines.feeds;
	const marks = feeds.map(() => "?").join(",");
	const per = new Map<string, DayCounts>();
	for (const r of store.db
		.query<{ entity: string; d: number; n: number }, (string | number)[]>(
			`SELECT l.entity AS entity, CAST((l.observed_at - ${4 * HOUR}) / ${DAY} AS INTEGER) AS d, COUNT(*) AS n
			 FROM entity_links l JOIN obs o ON o.id = l.obs_id
			 WHERE l.observed_at BETWEEN ? AND ? AND l.rule IN ('text-place', 'text-name') AND o.source IN (${marks})
			   AND (l.entity LIKE 'inst.%' OR l.entity LIKE 'infra.%' OR (l.entity LIKE 've.%' AND l.entity NOT LIKE 've.%.%'))
			 GROUP BY l.entity, d`,
		)
		.all(from, now, ...feeds)) {
		const m = per.get(r.entity) ?? new Map<number, number>();
		m.set(r.d, r.n);
		per.set(r.entity, m);
	}
	// A day counts when the outlets were being read: at least 200 headlines stored that day.
	const totals = store.db
		.query<{ d: number; n: number }, (string | number)[]>(
			`SELECT ${DAY_SQL} AS d, COUNT(*) AS n FROM obs WHERE observed_at BETWEEN ? AND ? AND source IN (${marks}) GROUP BY d`,
		)
		.all(from, now, ...feeds);
	const today = caracasDay(now);
	const covered = new Set(totals.filter((t) => t.n >= 200 || (t.d === today && t.n >= 20)).map((t) => t.d));
	const last = store.db
		.query<{ t: number | null; f: number | null }, (string | number)[]>(
			`SELECT MAX(observed_at) AS t, MAX(fetched_at) AS f FROM obs WHERE observed_at BETWEEN ? AND ? AND source IN (${marks})`,
		)
		.get(now - 6 * HOUR, now, ...feeds);
	const newest = last?.t ? { at: last.t, fetchedAt: last.f, url: "", feed: "" } : null;
	return [...per].map(([entity, counts]) =>
		judgeDaily(METRICS.headlines, entity, counts, covered, now, newest),
	);
}

function judgeLightning(store: Store, now: number): Judged[] {
	const { days: window, minDays, minRatio, maxTail } = ANOMALY_RULES.hourly;
	const hour = hourStart(now) - HOUR; // the last complete hour
	const from = hour - window * DAY;
	const perHour = new Map<number, { windows: number; byState: Record<string, number> }>();
	let newest: Row<Json> | null = null;
	const seen = new Map<number, Row<Json>>();
	for (const r of rows<Json>(store, "goes-glm", from, hour + HOUR - 1, "window")) seen.set(r.observedAt, r);
	for (const r of seen.values()) {
		const v = r.value as unknown as LightningWindow;
		if (!v.complete) continue;
		const h = hourStart(r.observedAt);
		const e = perHour.get(h) ?? { windows: 0, byState: {} };
		e.windows++;
		for (const [iso, n] of Object.entries(v.byState ?? {})) e.byState[iso] = (e.byState[iso] ?? 0) + n;
		perHour.set(h, e);
		if (!newest || r.observedAt > newest.observedAt) newest = r;
	}
	const complete = (h: number) => (perHour.get(h)?.windows ?? 0) >= 3;
	const out: Judged[] = [];
	for (const iso of stateIsoCodes()) {
		const entity = stateEntity(iso);
		if (!entity) continue;
		const prior: number[] = [];
		for (let k = 1; k <= window; k++) {
			const h = hour - k * DAY;
			if (complete(h)) prior.push(perHour.get(h)?.byState[iso] ?? 0);
		}
		const fresh =
			newest !== null && now - (newest.observedAt + 15 * MIN) <= METRICS.lightning.maxAgeMs && complete(hour);
		out.push({
			metric: METRICS.lightning,
			entity,
			feed: "goes-glm",
			sourceUrl: newest?.sourceUrl ?? "https://registry.opendata.aws/noaa-goes/",
			observedAt: hour,
			fetchedAt: newest?.fetchedAt ?? null,
			result: fresh
				? evaluateCount(
						perHour.get(hour)?.byState[iso] ?? 0,
						prior,
						{ minCount: MIN_COUNTS.lightning ?? 1 },
						{ minRatio, maxTail, minPrior: minDays },
					)
				: "stale",
			from,
			to: hour,
			detail: {},
		});
	}
	return out;
}

let isoCache: string[] | null = null;
function stateIsoCodes(): string[] {
	isoCache ??= states().map((x) => x.iso);
	return isoCache;
}

// ——— connectivity: the panel's own reading ———

function placeEntity(p: PlaceStatus): string | null {
	if (p.kind === "country") return "ve";
	if (p.kind === "isp") return `net.${p.id}`;
	return stateEntity(p.id);
}

/**
 * When a state's current drop began: the first 10-minute bin of the run, going back from the newest bin while the
 * signal stays below `dropBelow` of its same-slot baseline (missing bins do not end the run: a blackout can empty
 * IODA's series), at most ANOMALY_RULES.region.lookbackMs back. Null without the bins.
 */
export function dropOnset(
	store: Store,
	iso: string,
	signal: string,
	newestBin: number,
	dropBelow: number,
): number | null {
	const { lookbackMs } = ANOMALY_RULES.region;
	const bins = new Map<number, number>();
	for (const r of rows<Json>(
		store,
		"ioda-states",
		newestBin - lookbackMs - 8 * DAY,
		newestBin,
		`state:${iso}:${signal}`,
	)) {
		const v = num((r.value as { value?: unknown }).value);
		if (v !== null) bins.set(r.observedAt, v);
	}
	if (!bins.has(newestBin)) return null;
	let onset = newestBin;
	for (let t = newestBin; t >= newestBin - lookbackMs; t -= IODA_BIN_MS) {
		const v = bins.get(t);
		if (v === undefined) continue;
		const base = sameSlotBaseline(bins, t);
		if (!base || base.value <= 0 || v / base.value >= dropBelow) break;
		onset = t;
	}
	return onset;
}

/** The connectivity panel's places, judged by its own level ("caída fuerte" is unusual). */
export function judgeConnectivity(view: ConnectivityView, now: number, store?: Store): Judged[] {
	const out: Judged[] = [];
	for (const p of [view.country, ...view.states, ...view.isps]) {
		const entity = placeEntity(p);
		if (!entity) continue;
		const usable = p.signals.filter((s) => s.level !== "no-data");
		let result: Evaluation | Gate;
		if (usable.length === 0) {
			const reasons = p.signals.map((s) => s.noData ?? "");
			result = reasons.some((r) => r.startsWith("sin datos recientes"))
				? "stale"
				: reasons.some((r) => r.startsWith("menos de"))
					? "thin"
					: "weak";
		} else {
			// Score: each signal's drop in thirds of its own drop threshold (−3 is exactly the panel's "caída").
			const scored = usable.map((s) => {
				const ratio = (s.pctOfBaseline ?? 100) / 100;
				const unit = (1 - (s.dropBelow ?? 0.85)) / 3;
				return { s, z: unit > 0 ? (ratio - 1) / unit : 0 };
			});
			const worst = scored.reduce((a, b) => (b.z < a.z ? b : a));
			result = {
				unusual: (ANOMALY_RULES.connectivityLevels as readonly string[]).includes(p.level),
				direction: "down",
				value: worst.s.current ?? 0,
				baseline: worst.s.baseline ?? 0,
				changePct: worst.s.changePct,
				score: Math.round(worst.z * 10) / 10,
				tail: null,
				points: worst.s.baselineDays,
			};
		}
		const at = p.lastBinAt ?? now;
		const detail: Judged["detail"] = { level: p.level, agreeing: p.agreeing.join(" ") || null };
		// The start of an unusual state drop, from its worst signal (the regional grouping needs it).
		if (store && p.kind === "state" && typeof result !== "string" && result.unusual) {
			const worst = p.signals
				.filter((s) => s.level === "drop" || s.level === "severe")
				.reduce<(typeof p.signals)[number] | null>(
					(a, b) => (!a || (b.pctOfBaseline ?? 100) < (a.pctOfBaseline ?? 100) ? b : a),
					null,
				);
			const onset =
				worst?.observedAt != null && worst.dropBelow != null
					? dropOnset(store, p.id, worst.signal, worst.observedAt, worst.dropBelow)
					: null;
			detail.onsetAt = onset ?? at;
		}
		for (const s of p.signals) detail[`${s.signal}PctOfBaseline`] = s.pctOfBaseline;
		out.push({
			metric: METRICS.connectivity,
			entity,
			feed: p.feed,
			sourceUrl: p.sourceUrl,
			observedAt: at,
			fetchedAt: p.signals.reduce<number | null>(
				(m, s) => (s.fetchedAt !== null ? Math.max(m ?? 0, s.fetchedAt) : m),
				null,
			),
			result,
			from: at - 7 * DAY,
			to: at - DAY,
			detail,
		});
	}
	return out;
}

// ——— everything ———

export type JudgeOptions = {
	/** The connectivity panel's view at `now` (read from the panel cache, or computed for a replay). */
	readonly connectivity: ConnectivityView | null;
	/** Archived observations the link index has not linked yet (headline counts wait for it). */
	readonly linkBacklog: number;
	/** Only these classes (a replay of the daily series skips the rest); all when absent. */
	readonly classes?: ReadonlySet<AnomalyClass>;
};

/** Every series the engine judges, at `now`. */
export function judgeAll(store: Store, now: number, options: JudgeOptions): Judged[] {
	const on = (c: AnomalyClass) => !options.classes || options.classes.has(c);
	return [
		...(options.connectivity && on("connectivity")
			? judgeConnectivity(options.connectivity, now, store)
			: []),
		...(on("night") ? judgeNights(store, now) : []),
		...(on("change") ? judgeChanges(store, now) : []),
		...(on("level") ? judgeLevels(store, now) : []),
		...(on("count")
			? [
					...judgeFires(store, now),
					...judgeGdelt(store, now),
					...judgeHeadlines(store, now, options.linkBacklog),
				]
			: []),
		...(on("hourly") ? judgeLightning(store, now) : []),
	];
}
