/**
 * The anomaly engine's arithmetic ("lo inusual ahora"): pure, deterministic functions that say whether the newest
 * point of one numeric series is unusual against a baseline suited to the series' rhythm. No model, no probability
 * beyond an exact Poisson tail for counts; every threshold is a constant in ANOMALY_RULES, stated in words by
 * `anomalyRulesText`, and chosen before the replay on the archive (2026-09-28).
 *
 * Classes (one per rhythm):
 *   connectivity  IODA per state, ISP and country: the connectivity panel's own reading (same 10-minute slot over the
 *                 previous 7 days, its calibrated floors); unusual only at the level the incidents use ("caída
 *                 fuerte"). Score: the drop in thirds of the panel's drop threshold (−3 = exactly "caída").
 *   night         night lights per state: the night-lights panel's comparison (median of up to 14 previous clear
 *                 nights) and the incidents' drop rule (−30 %). Score: robust z against those nights.
 *   change        levels with a trend (exchange rates, reserves, money supply, the price index, oil): the newest
 *                 step's log change against the median and MAD of the previous steps' changes.
 *   level         daily levels without a trend (Tor users, Wikipedia page views): the log of the newest day against
 *                 the median and MAD of the previous days.
 *   count         daily event counts (fires, GDELT events, headlines naming a place): the newest day's count against
 *                 the median of the previous days, with a robust z, a ratio and an exact Poisson tail.
 *   hourly        lightning flashes per state per hour: the same hour of the day over the previous 14 days (lightning
 *                 has a daily cycle and no weekly one), with the count rules.
 *
 * Robust z = (x − median) / σ, σ = 1.4826 × MAD (the standard deviation for normal data, unmoved by outliers),
 * floored per series so a series that never moves cannot turn a trivial move into a huge score.
 */

import { SIGNAL_RULES } from "./signals.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export type AnomalyClass = "connectivity" | "night" | "change" | "level" | "count" | "hourly";
export type Direction = "up" | "down" | "both";

export const ANOMALY_RULES = {
	/** Bump when a rule or threshold changes. */
	version: 2,
	/** |robust z| at or beyond which a point is unusual (every class but connectivity and night, which use theirs). */
	minScore: 4,
	/** 1.4826 × MAD estimates σ for normal data. */
	madScale: 1.4826,
	change: {
		daily: { window: 60, minPoints: 30 },
		weekly: { window: 52, minPoints: 26 },
		monthly: { window: 36, minPoints: 24 },
		/**
		 * Series with a month-end step (the BCV's reserves revalue at the close of each month, found by the replay of
		 * 2026-09-28): a change dated the last weekday of a month is judged against the previous month-ends, and the
		 * other days against the other days.
		 */
		monthEnd: { window: 12, minPoints: 6 },
	},
	level: { window: 28, minPoints: 14 },
	/** Daily counts: previous days, days with coverage needed, the Poisson tail and the ratio to the median. */
	count: { window: 28, minDays: 14, maxTail: 1e-4, minRatio: 3 },
	/** Hourly counts (lightning): previous days at the same hour, days needed, tail and ratio. */
	hourly: { days: 14, minDays: 10, maxTail: 1e-4, minRatio: 5 },
	/** Connectivity: the connectivity panel's place levels that count (the incidents' calibrated choice). */
	connectivityLevels: SIGNAL_RULES.iodaLevels,
	/** Night lights: the incidents' night-drop rule, in % against the state's median of clear nights. */
	nightMaxPct: SIGNAL_RULES.nightDropPct,
	/** Night lights: σ floor, as a fraction of the baseline (a state whose nights never vary). */
	nightSigmaFloor: 0.05,
	/**
	 * Which incident kinds explain which anomalies in the same state: an anomaly already explained by an open incident
	 * (or one that ended within its activity window) points to it instead of standing alone.
	 */
	explains: {
		corte: ["connectivity", "night", "headlines", "gdelt"],
		sismo: ["connectivity", "headlines", "gdelt"],
	} as Readonly<Record<string, readonly string[]>>,
	/** An ended incident still explains an anomaly observed up to this long after its last evidence. */
	explainAfterMs: 3 * HOUR,
	/**
	 * Regional drops (2026-09-29): states whose connectivity drops began within `windowMs` of
	 * each other (chained: each within the window of the one before) are one regional item listing every state with
	 * its own figure, never a blended one. A drop's start is the first 10-minute bin of its current run below the
	 * connectivity panel's drop threshold, looking back at most `lookbackMs`.
	 */
	region: { windowMs: 30 * MIN, lookbackMs: 6 * HOUR, minStates: 2 },
	/**
	 * Reverted moves (2026-09-29), for series that declare it (the BCV's reserves): an unusual
	 * step is "reverted" when, within `maxSteps` published points after it, the level comes back to within
	 * `tolerance` × the step's size of where it stood before the step. The pair is one item about the earlier step,
	 * labelled with the fact, ranked after every other item; nothing is hidden.
	 */
	revert: { maxSteps: 5, tolerance: 0.25 },
	/** The list keeps at most this many items (the highest scores). */
	maxItems: 100,
} as const;

/**
 * Chains items by start time: sorted by `onsetAt`, an item joins the running group when it began within `windowMs`
 * of the previous item. Returns groups in start order (a group of one is a lone reading).
 */
export function chainByOnset<T extends { onsetAt: number }>(items: readonly T[], windowMs: number): T[][] {
	const sorted = [...items].sort((a, b) => a.onsetAt - b.onsetAt);
	const out: T[][] = [];
	for (const it of sorted) {
		const cur = out.at(-1);
		const prev = cur?.at(-1);
		if (cur && prev && it.onsetAt - prev.onsetAt <= windowMs) cur.push(it);
		else out.push([it]);
	}
	return out;
}

/**
 * The step a newest point reverts, if any: an earlier step k (at most `maxSteps` points back) that was unusual and
 * after which the newest level is back within `tolerance` × |step k| of the level before it, with no point between
 * having reverted it already. `unusualAt(k)` judges step k with the data up to k. Returns the most recent such step.
 */
export function revertedStep(
	levels: readonly number[],
	unusualAt: (k: number) => boolean,
	rules: { readonly maxSteps: number; readonly tolerance: number } = ANOMALY_RULES.revert,
): { step: number; afterSteps: number } | null {
	const n = levels.length - 1;
	const back = (j: number, k: number) =>
		Math.abs(Math.log((levels[j] as number) / (levels[k - 1] as number))) <=
		rules.tolerance * Math.abs(Math.log((levels[k] as number) / (levels[k - 1] as number)));
	for (let k = n - 1; k >= Math.max(1, n - rules.maxSteps); k--) {
		if (!((levels[k - 1] as number) > 0) || levels[k] === levels[k - 1]) continue;
		if (!back(n, k)) continue;
		// Reverted earlier already: that pair was told when it happened.
		let before = false;
		for (let j = k + 1; j < n; j++) if (back(j, k)) before = true;
		if (before || !unusualAt(k)) continue;
		return { step: k, afterSteps: n - k };
	}
	return null;
}

// ——— robust statistics ———

export function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const s = Float64Array.from(values).sort();
	const mid = Math.floor(s.length / 2);
	return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** 1.4826 × the median absolute deviation from `centre`. */
export function robustSigma(values: readonly number[], centre: number): number {
	return ANOMALY_RULES.madScale * (median(values.map((v) => Math.abs(v - centre))) ?? 0);
}

/** ln Γ(x) for x > 0 (Lanczos, g = 7, 9 terms: ~15 significant digits). */
export function logGamma(x: number): number {
	const c = [
		0.9999999999998099, 676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406,
		12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7,
	];
	if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - logGamma(1 - x);
	const z = x - 1;
	let a = c[0] as number;
	const t = z + 7.5;
	for (let i = 1; i < 9; i++) a += (c[i] as number) / (z + i);
	return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** P(X ≥ k) for X ~ Poisson(mu), exact to double precision (summed in log space). */
export function poissonTail(k: number, mu: number): number {
	if (k <= 0) return 1;
	if (!(mu > 0)) return 0;
	const logPmf = (n: number) => -mu + n * Math.log(mu) - logGamma(n + 1);
	if (k <= mu) {
		// The lower side is the smaller sum: 1 − P(X ≤ k − 1).
		let cdf = 0;
		for (let n = 0; n < k; n++) cdf += Math.exp(logPmf(n));
		return Math.max(0, Math.min(1, 1 - cdf));
	}
	// Terms fall by mu / (n + 1) < 1 from k on: sum until they stop mattering.
	let sum = 0;
	for (let n = k; n < k + 10_000; n++) {
		const term = Math.exp(logPmf(n));
		sum += term;
		if (term < sum * 1e-16) break;
	}
	return Math.min(1, sum);
}

// ——— evaluations ———

/** Why a series was not judged (no anomaly can come from it). */
export type Gate = "thin" | "stale" | "weak";

export type Evaluation = {
	unusual: boolean;
	direction: "up" | "down";
	/** The newest value, and the value the baseline expects (same unit). */
	value: number;
	baseline: number;
	/** (value − baseline) / baseline × 100; null when the baseline is 0. */
	changePct: number | null;
	/** Robust z, signed. */
	score: number;
	/** Poisson P(X ≥ value | baseline), counts only. */
	tail: number | null;
	/** Points (or days) the baseline was taken over. */
	points: number;
};

const round = (x: number, digits: number) => {
	const f = 10 ** digits;
	return Math.round(x * f) / f;
};

const pct = (value: number, baseline: number) =>
	baseline === 0 ? null : round(((value - baseline) / baseline) * 100, 1);

const allowed = (direction: Direction, z: number) =>
	direction === "both" || (direction === "up" ? z > 0 : z < 0);

export type ChangeSpec = {
	readonly step: "daily" | "weekly" | "monthly";
	readonly direction: Direction;
	/** The step's log change must also differ from the median change by at least this much (0.01 ≈ 1 %). */
	readonly minLogChange: number;
	/** σ floor for the log changes. */
	readonly sigmaFloor: number;
	/** Month-end changes form their own series (needs the points' dates): see ANOMALY_RULES.change.monthEnd. */
	readonly monthEnd?: true;
	/** Reverted moves are told as one item about the earlier step (ANOMALY_RULES.revert). */
	readonly revert?: true;
};

/** Whether a "YYYY-MM-DD" date is the last weekday (Monday to Friday) of its month. */
export function lastWeekdayOfMonth(date: string): boolean {
	const t = Date.parse(`${date}T12:00:00Z`);
	if (!Number.isFinite(t)) return false;
	const month = new Date(t).getUTCMonth();
	for (let d = 1; d <= 3; d++) {
		const next = new Date(t + d * DAY);
		if (next.getUTCDay() === 0 || next.getUTCDay() === 6) continue;
		return next.getUTCMonth() !== month;
	}
	return true;
}

/**
 * Change class: `levels` oldest first, one per step (a published day, week or month), all > 0. The newest step's
 * log change against the previous steps' changes (at most the window, at least minPoints). With `spec.monthEnd`,
 * `dates` (one per level) split month-end changes from the others, each judged against its own kind.
 */
export function evaluateChange(
	levels: readonly number[],
	spec: ChangeSpec,
	dates?: readonly string[],
	/** How many usual steps the newest step spans (1 = a normal step). */
	span = 1,
): Evaluation | Gate {
	if (levels.some((v) => !(v > 0))) return "weak";
	// A past point closes its month when the next published point is in another month (bank holidays included); the
	// newest point, whose successor is unknown, when it is the month's last weekday.
	const closes = (i: number): boolean => {
		if (spec.monthEnd !== true || dates === undefined) return false;
		const d = dates[i] ?? "";
		const next = dates[i + 1];
		return next === undefined ? lastWeekdayOfMonth(d) : next.slice(0, 7) !== d.slice(0, 7);
	};
	const changes: { r: number; monthEnd: boolean }[] = [];
	for (let i = 1; i < levels.length; i++)
		changes.push({ r: Math.log((levels[i] as number) / (levels[i - 1] as number)), monthEnd: closes(i) });
	const last = changes.at(-1);
	if (!last) return "thin";
	const { window, minPoints } = last.monthEnd
		? ANOMALY_RULES.change.monthEnd
		: ANOMALY_RULES.change[spec.step];
	const current = last.r;
	const prior = changes
		.slice(0, -1)
		.filter((c) => c.monthEnd === last.monthEnd)
		.slice(-window)
		.map((c) => c.r);
	if (prior.length < minPoints) return "thin";
	// A newest step that spans several usual steps (the feed or Vigía was down) is judged as that many steps: the
	// expected change grows with the span and its noise with its square root.
	const k = Math.max(1, span);
	const m = median(prior) as number;
	const sigma = Math.max(robustSigma(prior, m), spec.sigmaFloor) * Math.sqrt(k);
	const z = (current - m * k) / sigma;
	const previous = levels.at(-2) as number;
	const value = levels.at(-1) as number;
	const expected = previous * Math.exp(m * k);
	return {
		unusual:
			Math.abs(z) >= ANOMALY_RULES.minScore &&
			Math.abs(current - m * k) >= spec.minLogChange &&
			allowed(spec.direction, z),
		direction: z >= 0 ? "up" : "down",
		value,
		baseline: expected,
		changePct: pct(value, expected),
		score: round(z, 1),
		tail: null,
		points: prior.length,
	};
}

export type LevelSpec = {
	readonly direction: Direction;
	/** The value must be at least this many times the baseline (up) or at most 1/this (down). */
	readonly minRatio: number;
	/** Values below this are too small to judge (a page seen 12 times a day). */
	readonly minValue: number;
	/** σ floor for the log values. */
	readonly sigmaFloor: number;
};

/** Level class: daily values oldest first (≥ 0); the newest against the previous days, on a log scale. */
export function evaluateLevel(values: readonly number[], spec: LevelSpec): Evaluation | Gate {
	const { window, minPoints } = ANOMALY_RULES.level;
	const current = values.at(-1);
	const prior = values.slice(-1 - window, -1);
	if (current === undefined || prior.length < minPoints) return "thin";
	const logs = prior.map((v) => Math.log(v + 1));
	const m = median(logs) as number;
	const sigma = Math.max(robustSigma(logs, m), spec.sigmaFloor);
	const z = (Math.log(current + 1) - m) / sigma;
	const baseline = Math.exp(m) - 1;
	const ratio = (current + 1) / (baseline + 1);
	const big = z > 0 ? ratio >= spec.minRatio : ratio <= 1 / spec.minRatio;
	return {
		unusual:
			Math.abs(z) >= ANOMALY_RULES.minScore &&
			big &&
			Math.max(current, baseline) >= spec.minValue &&
			allowed(spec.direction, z),
		direction: z >= 0 ? "up" : "down",
		value: current,
		baseline: round(baseline, 2),
		changePct: pct(current, baseline),
		score: round(z, 1),
		tail: null,
		points: prior.length,
	};
}

export type CountSpec = {
	/** Fewer events than this are never unusual (one fire, three headlines). */
	readonly minCount: number;
};

/**
 * Count rule (upward only): the newest count against the previous counts. Unusual when all hold: robust z ≥ minScore
 * (σ never below √median, the Poisson noise), at least `minRatio` × the median (1 when it is 0), a Poisson tail
 * P(X ≥ count | median) ≤ `maxTail` (the median floored at 0.5), and at least `minCount` events.
 */
export function evaluateCount(
	current: number,
	prior: readonly number[],
	spec: CountSpec,
	rules: { readonly minRatio: number; readonly maxTail: number; readonly minPrior: number },
): Evaluation | Gate {
	if (prior.length < rules.minPrior) return "thin";
	const m = median(prior) as number;
	const sigma = Math.max(robustSigma(prior, m), Math.sqrt(Math.max(m, 1)));
	const z = (current - m) / sigma;
	const tail = poissonTail(current, Math.max(m, 0.5));
	return {
		unusual:
			current >= spec.minCount &&
			z >= ANOMALY_RULES.minScore &&
			current >= rules.minRatio * Math.max(m, 1) &&
			tail <= rules.maxTail,
		direction: z >= 0 ? "up" : "down",
		value: current,
		baseline: m,
		changePct: pct(current, m),
		score: round(z, 1),
		tail: tail < 1e-12 ? 0 : Number(tail.toPrecision(3)),
		points: prior.length,
	};
}

/** Night class: this night's radiance against previous clear nights (the night-lights panel's baseline). */
export function evaluateNight(
	radiance: number,
	clearNights: readonly number[],
	pctChange: number,
): Evaluation {
	const m = median(clearNights) as number;
	const sigma = Math.max(robustSigma(clearNights, m), ANOMALY_RULES.nightSigmaFloor * m);
	const z = sigma > 0 ? (radiance - m) / sigma : 0;
	return {
		unusual: pctChange <= ANOMALY_RULES.nightMaxPct,
		direction: "down",
		value: radiance,
		baseline: m,
		changePct: round(pctChange, 1),
		score: round(z, 1),
		tail: null,
		points: clearNights.length,
	};
}

// ——— time helpers ———

/** Venezuela is UTC−4 all year (no DST): a Caracas calendar day, as a day number. */
export const VET_OFFSET_MS = -4 * HOUR;
export const caracasDay = (t: number) => Math.floor((t + VET_OFFSET_MS) / DAY);
export const caracasDayStart = (day: number) => day * DAY - VET_OFFSET_MS;
export const hourStart = (t: number) => Math.floor(t / HOUR) * HOUR;

// ——— the rules in words ———

const n = (x: number) => new Intl.NumberFormat("es-VE").format(x);

export function anomalyRulesText(): { es: string[]; en: string[] } {
	const R = ANOMALY_RULES;
	return {
		es: [
			"«Lo inusual ahora» compara el dato más reciente de cada serie con su propia historia, con reglas fijas y sin modelos. Cada cifra es calculada por Vigía a partir de la fuente citada.",
			`La puntuación es una z robusta: cuántas desviaciones típicas robustas (1,4826 × la mediana de las desviaciones absolutas) se aleja el dato de la mediana de su ventana. Inusual desde ${R.minScore} en valor absoluto, además de los mínimos de cada clase.`,
			`Tipos de cambio, reservas, liquidez, INPC y petróleo: el cambio del último paso publicado (día, semana o mes, en logaritmo) contra la mediana de los ${R.change.daily.window} cambios diarios, ${R.change.weekly.window} semanales o ${R.change.monthly.window} mensuales anteriores (al menos ${R.change.daily.minPoints}, ${R.change.weekly.minPoints} o ${R.change.monthly.minPoints}), y más que un mínimo por serie. Un paso que cubre varios pasos habituales (la fuente o Vigía estuvo caída) se juzga como esos varios pasos. Las reservas se revalorizan al cierre de cada mes: un cierre se compara con los ${R.change.monthEnd.window} cierres anteriores (al menos ${R.change.monthEnd.minPoints}).`,
			`Usuarios de Tor y visitas a Wikipedia: el último día contra la mediana de los ${R.level.window} datos diarios anteriores (al menos ${R.level.minPoints}), en escala logarítmica, con una razón mínima por serie; las visitas a Wikipedia solo hacia arriba. Los usuarios directos de Tor además deben quedar fuera del rango esperado de Tor Metrics, cuando lo publica.`,
			`Conteos diarios (focos de calor, eventos de GDELT, titulares que nombran un lugar): el día de hoy (hora de Venezuela) contra la mediana de los ${R.count.window} días anteriores con datos (al menos ${R.count.minDays}); inusual solo hacia arriba, con z ≥ ${R.minScore}, al menos ${R.count.minRatio} veces la mediana, una probabilidad de Poisson de ver tantos o más de ${n(R.count.maxTail)} o menos, y un mínimo de eventos por serie.`,
			`Rayos (GOES-19 GLM): destellos por estado y hora contra la misma hora de los ${R.hourly.days} días anteriores (al menos ${R.hourly.minDays} con datos completos): los rayos tienen ciclo diario, no semanal. Mismas reglas de conteo, con al menos ${R.hourly.minRatio} veces la mediana.`,
			`Conectividad (IODA): la lectura del panel de conectividad (la misma franja de 10 minutos de los 7 días anteriores); inusual solo en ${R.connectivityLevels.includes("drop") ? "«caída» o «caída fuerte»" : "«caída fuerte»"}, el nivel que usan los incidentes. Luces nocturnas: una noche comparable al menos ${Math.abs(R.nightMaxPct)} % bajo la mediana de las noches despejadas del estado (la regla de los incidentes).`,
			`Sin historia suficiente o con el dato viejo no hay anomalía: la serie se cuenta como «poca historia» o «sin datos recientes». Si un incidente (o una señal sin corroborar) del mismo estado, activo o terminado hace menos de ${R.explainAfterMs / 3_600_000} h y empezado antes o poco después de la lectura, ya la explica (un corte, un sismo), la anomalía apunta a él y dice de qué tipo es.`,
			`Caídas regionales: dos o más estados cuyas caídas fuertes de conectividad empezaron a menos de ${R.region.windowMs / MIN} min una de otra (en cadena; el inicio es el primer intervalo de 10 minutos de la racha bajo el umbral de caída, hasta ${R.region.lookbackMs / HOUR} h atrás) son un solo hecho regional que nombra cada estado con su propia cifra, nunca una cifra combinada; la lectura de cada estado sigue en su página.`,
			`Movimientos revertidos (reservas del BCV): si en los ${R.revert.maxSteps} datos publicados siguientes el nivel vuelve a menos de ${Math.round(R.revert.tolerance * 100)} % del salto respecto de donde estaba, el salto se muestra una sola vez como «revertido por el BCV a los N días hábiles», con los dos datos, después de todo lo demás. Es un hecho de la serie publicada, no una explicación.`,
			"Una anomalía dice que algo es raro frente a su propia historia; no dice por qué ni que sea grave.",
		],
		en: [
			'"Unusual now" compares each series\' newest datum with its own history, by fixed rules and no model. Every figure is computed by Vigía from the cited source.',
			`The score is a robust z: how many robust standard deviations (1.4826 × the median absolute deviation) the datum lies from its window's median. Unusual from ${R.minScore} in absolute value, plus each class's minimums.`,
			`Exchange rates, reserves, money supply, the price index and oil: the newest published step's log change (day, week or month) against the median of the previous ${R.change.daily.window} daily, ${R.change.weekly.window} weekly or ${R.change.monthly.window} monthly changes (at least ${R.change.daily.minPoints}, ${R.change.weekly.minPoints} or ${R.change.monthly.minPoints}), and more than a per-series minimum. A step that covers several usual steps (the source or Vigía was down) is judged as that many steps. Reserves revalue at each month's close: a close is compared with the previous ${R.change.monthEnd.window} closes (at least ${R.change.monthEnd.minPoints}).`,
			`Tor users and Wikipedia page views: the newest day against the median of the previous ${R.level.window} daily data points (at least ${R.level.minPoints}), on a log scale, with a per-series minimum ratio; Wikipedia page views only upwards. Direct Tor users must also fall outside Tor Metrics' expected range, when it publishes one.`,
			`Daily counts (heat detections, GDELT events, headlines naming a place): today (Venezuelan time) against the median of the previous ${R.count.window} days with data (at least ${R.count.minDays}); unusual only upwards, with z ≥ ${R.minScore}, at least ${R.count.minRatio} times the median, a Poisson probability of that many or more of ${R.count.maxTail} or less, and a per-series minimum count.`,
			`Lightning (GOES-19 GLM): flashes per state and hour against the same hour of the previous ${R.hourly.days} days (at least ${R.hourly.minDays} with complete data): lightning has a daily cycle, not a weekly one. Same count rules, with at least ${R.hourly.minRatio} times the median.`,
			`Connectivity (IODA): the connectivity panel's reading (the same 10-minute slot over the previous 7 days); unusual only at ${R.connectivityLevels.includes("drop") ? '"drop" or "severe drop"' : '"severe drop"'}, the level the incidents use. Night lights: a comparable night at least ${Math.abs(R.nightMaxPct)} % below the median of the state's clear nights (the incidents' rule).`,
			`Without enough history, or with an old datum, there is no anomaly: the series is counted as "thin history" or "no recent data". When an incident (or a lone signal) in the same state, active or ended less than ${R.explainAfterMs / 3_600_000} h before and begun before or shortly after the reading, already explains it (an outage, a quake), the anomaly points to it and says which kind it is.`,
			`Regional drops: two or more states whose severe connectivity drops began within ${R.region.windowMs / MIN} min of each other (chained; a drop begins at the first 10-minute bin of its run below the drop threshold, at most ${R.region.lookbackMs / HOUR} h back) are one regional item naming each state with its own figure, never a combined one; each state's reading stays on its page.`,
			`Reverted moves (BCV reserves): when within the next ${R.revert.maxSteps} published figures the level comes back to within ${Math.round(R.revert.tolerance * 100)} % of the jump from where it stood, the jump is shown once as "reverted by the BCV N business days later", with both figures, after everything else. A fact about the published series, not an explanation.`,
			"An anomaly says something is rare against its own history; it does not say why, or that it is serious.",
		],
	};
}

export { DAY, HOUR, MIN };
