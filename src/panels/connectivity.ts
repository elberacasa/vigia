import { ISPS } from "../adapters/ioda-asn/index.ts";
import type { IodaEvent } from "../adapters/ioda-events/index.ts";
import {
	BIN_MS,
	IODA_LICENCE,
	IODA_SIGNALS,
	IODA_SITE,
	type IodaBin,
	type IodaSignal,
	SIGNAL_INFO,
} from "../adapters/ioda-states/ioda.ts";
import { IODA_REGIONS } from "../adapters/ioda-states/regions.ts";
import {
	type ConnectionEvents,
	type ProbeCounts,
	RIPE_ATLAS_LICENCE,
} from "../adapters/ripe-atlas-probes/index.ts";
import { RIPESTAT_LICENCE, type Routing } from "../adapters/ripestat-routing/index.ts";
import type { Store } from "../core/store.ts";
import { stateByIso } from "../geo/index.ts";
import type { Panel } from "../server/panels.ts";

/**
 * "Is the internet (or the power) down in my state?" answered from IODA's measured signals, per state and per
 * ISP, by explicit rules. Pure: everything here is deterministic arithmetic over stored observations.
 *
 * Method (justified with an 8-day capture of IODA signals, 2026-09-24):
 * - Baseline: the median of the same 10-minute slot of the day over the previous 7 days, ignoring missing bins,
 *   and only when at least 4 of the 7 days have data. Active probing has a strong daily cycle (the hourly
 *   medians of ping-slash24 swing 2 % in Zulia but 34 % in Carabobo and 46 % in Guárico), so a flat 7-day median
 *   would flag every evening as a drop; the same-slot baseline halved the spread of the ratio in Guárico (robust
 *   deviation 0.062 against 0.155 with a flat median). Venezuela has no DST, so UTC slots are local slots.
 * - Noise: the robust spread of the signal around its own same-slot medians over the previous 7 days
 *   (σ = 1.4826 × MAD of the ratios). It is ~0 for BGP, 0.01–0.16 for active probing and 0.07–0.6 for the
 *   telescope, depending on the state.
 * - A signal is "drop" when current/baseline < 1 − clamp(3σ, floor, cap) and "severe" when it is below
 *   1 − clamp(5σ, floor, cap). Floors keep quiet signals from alarming on trivial moves; caps keep noisy ones
 *   from never alarming (RULES below). A signal whose baseline is under 5 units (e.g. Amazonas: 3 responding
 *   /24s; the telescope sees under 5 IPs in half the states) is too weak to judge and counts as no data.
 * - A place is "severe" only when two signals agree (one severe and another at least "drop"), or when it has a
 *   single usable signal and that one is severe; "drop" when any signal drops; "no-data" when no signal is
 *   usable. The view model says which signals agree.
 * - Known limit: a cut that happens every day at the same hour (scheduled rationing) becomes part of the
 *   same-slot baseline and reads as normal. `vsWeekPct` (against the plain 7-day median) and IODA's own events
 *   (a different method) are shown beside it for that reason.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const BASELINE_DAYS = 7;
export const MIN_BASELINE_DAYS = 4;
/** A current value older than this is not "current". Newest IODA bins are 15–40 min old when healthy. */
export const MAX_BIN_AGE_MS = 60 * MIN;
export const SPARK_HOURS = 48;

export type Rule = {
	readonly dropFloor: number;
	readonly dropCap: number;
	readonly severeFloor: number;
	readonly severeCap: number;
	readonly minBaseline: number;
};

/**
 * Thresholds on the fraction lost. BGP moves are rare and meaningful (robust σ was 0 in every state; IODA's own
 * alert fires at −1 %), so 5 % is a drop. Active probing wanders ±5–10 % in a normal day, so 15 %. The telescope
 * counts a handful of IPs per state and swings ±30 %, so 25 %.
 */
export const RULES: Record<IodaSignal, Rule> = {
	bgp: { dropFloor: 0.05, dropCap: 0.2, severeFloor: 0.2, severeCap: 0.5, minBaseline: 5 },
	"ping-slash24": { dropFloor: 0.15, dropCap: 0.35, severeFloor: 0.4, severeCap: 0.6, minBaseline: 5 },
	"merit-nt": { dropFloor: 0.25, dropCap: 0.5, severeFloor: 0.5, severeCap: 0.8, minBaseline: 5 },
};

export type Level = "normal" | "drop" | "severe" | "no-data";
export type NoDataReason = "missing" | "stale" | "no-baseline" | "weak";

const REASON_ES: Record<NoDataReason, string> = {
	missing: "IODA no publica esta señal aquí",
	stale: "sin datos recientes (más de 60 min)",
	"no-baseline": "menos de 4 días de historia a esta hora",
	weak: "señal demasiado débil para juzgar",
};

/** Bin start (ms) → value. */
export type Bins = ReadonlyMap<number, number>;

// ——— pure arithmetic ———

export function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	// A typed-array sort is numeric and several times faster than a comparator sort (the history replay calls this
	// hundreds of thousands of times); the result is the same for finite values.
	const s = Float64Array.from(values).sort();
	const mid = Math.floor(s.length / 2);
	return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

export function clamp(x: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, x));
}

/** Median of the same slot on each of the previous `days` days, ignoring missing bins. */
export function sameSlotBaseline(
	bins: Bins,
	t: number,
	days = BASELINE_DAYS,
): { value: number; days: number } | null {
	const values: number[] = [];
	for (let k = 1; k <= days; k++) {
		const v = bins.get(t - k * DAY);
		if (v !== undefined) values.push(v);
	}
	const m = median(values);
	return m === null ? null : { value: m, days: values.length };
}

/**
 * Robust spread (1.4826 × MAD) of value / same-slot median over the `days` before `t`. Each slot's median is
 * taken over that window (needs ≥ 3 values). Null when fewer than 24 ratios exist.
 */
export function ratioNoise(bins: Bins, t: number, days = BASELINE_DAYS): number | null {
	const start = t - days * DAY;
	const bySlot = new Map<number, number[]>();
	for (const [time, v] of bins) {
		if (time < start || time >= t) continue;
		const slot = ((time % DAY) + DAY) % DAY;
		const list = bySlot.get(slot);
		if (list) list.push(v);
		else bySlot.set(slot, [v]);
	}
	const ratios: number[] = [];
	for (const values of bySlot.values()) {
		if (values.length < 3) continue;
		const m = median(values);
		if (m === null || m <= 0) continue;
		for (const v of values) ratios.push(v / m);
	}
	if (ratios.length < 24) return null;
	const centre = median(ratios) as number;
	return 1.4826 * (median(ratios.map((r) => Math.abs(r - centre))) as number);
}

/** Ratio below which a signal is a drop / a severe drop. */
export function cutoffs(rule: Rule, noise: number): { drop: number; severe: number } {
	return {
		drop: 1 - clamp(3 * noise, rule.dropFloor, rule.dropCap),
		severe: 1 - clamp(5 * noise, rule.severeFloor, rule.severeCap),
	};
}

export function newestBin(bins: Bins): number | null {
	let t: number | null = null;
	for (const time of bins.keys()) if (t === null || time > t) t = time;
	return t;
}

const round = (x: number, digits: number) => {
	const f = 10 ** digits;
	return Math.round(x * f) / f;
};

// ——— view model ———

export type SignalReading = {
	signal: IodaSignal;
	level: Level;
	/** Why the signal cannot be judged, in Spanish; null when it can. */
	noData: string | null;
	current: number | null;
	/** Start of the bin `current` belongs to (UTC ms); bins are 10 minutes. */
	observedAt: number | null;
	fetchedAt: number | null;
	baseline: number | null;
	/** How many of the previous 7 days had this slot. */
	baselineDays: number;
	/** current / baseline × 100, one decimal. */
	pctOfBaseline: number | null;
	/** (current − baseline) / baseline × 100, one decimal. */
	changePct: number | null;
	/** current / plain median of the previous 7 days × 100: reveals cuts that repeat at the same hour daily. */
	vsWeekPct: number | null;
	/** Robust σ of the ratio, 3 decimals. */
	noise: number | null;
	/** Ratio thresholds applied (e.g. 0.85 = "below 85 % of normal is a drop"). */
	dropBelow: number | null;
	severeBelow: number | null;
};

export type Spark = {
	signal: IodaSignal;
	/** Start of the first hour (UTC ms). */
	startAt: number;
	stepMs: number;
	/** Hourly mean of (value / same-slot baseline) × 100, one decimal; null where there is no data. */
	values: (number | null)[];
};

export type PlaceStatus = {
	/** ISO 3166-2 for states, ISP id for ISPs, "VE" for the country. */
	id: string;
	name: string;
	kind: "state" | "isp" | "country";
	/** ASNs for ISPs, IODA region id for states. */
	codes: string[];
	level: Level;
	/** Short Spanish line, e.g. "Caída de señal: sondeo activo y telescopio coinciden". */
	headline: string;
	/** Signals at drop or severe. */
	agreeing: IodaSignal[];
	usableSignals: number;
	signals: SignalReading[];
	/** Newest bin used among this place's signals. */
	lastBinAt: number | null;
	spark: Spark | null;
	/** IODA events touching this place in the last 7 days. */
	events7d: number;
	/** RIPE Atlas probes in this place (states and country only); null when there are none. Never positions. */
	probes: ProbeSummary | null;
	lat: number | null;
	lon: number | null;
	/** A caveat specific to this place (e.g. a signal covers only one of an ISP's ASNs); null when none. */
	note: string | null;
	/** Feed id the figures come from. */
	feed: string;
	/** IODA page for this place (a person can check the curves there). */
	sourceUrl: string;
};

/** RIPE Atlas: an independent signal (probes lose their link when power or uplink fails). Shown, not blended. */
export type ProbeSummary = {
	connected: number;
	disconnected: number;
	/** connected + disconnected (abandoned probes are not counted). */
	active: number;
	/** Disconnected probes whose drop happened in the hour before the probe list was read. */
	droppedLastHour: number;
	/** Disconnect events in the current and the previous 2 clock hours / the last 24 clock hours. */
	disconnects3h: number;
	disconnects24h: number;
	/** When the probe list was read (UTC ms). */
	observedAt: number;
	feed: string;
	sourceUrl: string;
};

/**
 * RIPEstat routing, derived figures only: RIPEstat's terms forbid redistributing its data, so the panel carries
 * changes against the 7-day median, never the counts.
 */
export type RoutingSummary = {
	/** Start of the newest hour (UTC ms). */
	observedAt: number;
	fetchedAt: number;
	/** % change of routed IPv4 prefixes / IPv6 prefixes / ASNs vs the median hour of the previous 7 days. */
	v4ChangePct: number | null;
	v6ChangePct: number | null;
	asnsChangePct: number | null;
	/** IPv4 prefixes or ASNs down 5 % or more. */
	drop: boolean;
	feed: string;
	sourceUrl: string;
	attribution: string;
	licence: string;
	note: string;
};

export type OutageEventItem = {
	id: string;
	kind: "state" | "isp" | "country";
	/** ISO code, ISP id or "VE". */
	key: string;
	name: string;
	signal: string;
	startAt: number;
	endAt: number;
	durationMin: number;
	/** IODA's severity score (unitless, larger = deeper and longer). */
	score: number;
	/** The event reached IODA's newest data when last fetched (may still be going on). */
	openAtFetch: boolean;
	url: string;
};

export type ConnectivityView = {
	/** Newest bin used anywhere in the panel (UTC ms). */
	asOf: number | null;
	summary: {
		states: { normal: number; drop: number; severe: number; noData: number };
		isps: { normal: number; drop: number; severe: number; noData: number };
		/** "3 estados con caída de señal (1 fuerte)". */
		text: string;
		/** Names of states with a drop, worst first. */
		affected: string[];
		/** No state has a drop and at least ALL_CLEAR_MIN_STATES have fresh data. */
		allClear: boolean;
	};
	country: PlaceStatus;
	states: PlaceStatus[];
	isps: PlaceStatus[];
	events: OutageEventItem[];
	/** When the events were last fetched (UTC ms). */
	eventsFetchedAt: number | null;
	/** Country-level routing from RIPEstat (derived only); null when there is no hour newer than 6 h. */
	routing: RoutingSummary | null;
	atlas: {
		/** Probe list read time (UTC ms); null when the feed has no recent data. */
		observedAt: number | null;
		attribution: string;
		licence: string;
		caveat: string;
	};
	method: {
		baseline: string;
		rules: {
			signal: IodaSignal;
			label: string;
			unit: string;
			what: string;
			dropFloorPct: number;
			severeFloorPct: number;
			minBaseline: number;
		}[];
		caveats: string[];
	};
	attribution: string;
	licence: string;
	feeds: string[];
};

type SignalInput = { bins: Bins; fetchedAt: ReadonlyMap<number, number> };

/** Classifies one signal at `now`. */
export function readSignal(signal: IodaSignal, input: SignalInput | null, now: number): SignalReading {
	const base: SignalReading = {
		signal,
		level: "no-data",
		noData: REASON_ES.missing,
		current: null,
		observedAt: null,
		fetchedAt: null,
		baseline: null,
		baselineDays: 0,
		pctOfBaseline: null,
		changePct: null,
		vsWeekPct: null,
		noise: null,
		dropBelow: null,
		severeBelow: null,
	};
	if (!input || input.bins.size === 0) return base;
	const t = newestBin(input.bins) as number;
	const current = input.bins.get(t) as number;
	const reading: SignalReading = {
		...base,
		noData: null,
		current,
		observedAt: t,
		fetchedAt: input.fetchedAt.get(t) ?? null,
	};
	if (now - t > MAX_BIN_AGE_MS) return { ...reading, noData: REASON_ES.stale };

	const baseline = sameSlotBaseline(input.bins, t);
	if (!baseline || baseline.days < MIN_BASELINE_DAYS) {
		return { ...reading, baselineDays: baseline?.days ?? 0, noData: REASON_ES["no-baseline"] };
	}
	reading.baseline = round(baseline.value, 2);
	reading.baselineDays = baseline.days;
	const rule = RULES[signal];
	if (baseline.value < rule.minBaseline) return { ...reading, noData: REASON_ES.weak };

	const ratio = current / baseline.value;
	const noise = ratioNoise(input.bins, t) ?? 0;
	const cut = cutoffs(rule, noise);
	const level: Level = ratio < cut.severe ? "severe" : ratio < cut.drop ? "drop" : "normal";
	const weekValues: number[] = [];
	for (const [time, v] of input.bins) if (time >= t - BASELINE_DAYS * DAY && time < t) weekValues.push(v);
	const week = median(weekValues);
	return {
		...reading,
		level,
		pctOfBaseline: round(ratio * 100, 1),
		changePct: round((ratio - 1) * 100, 1),
		vsWeekPct: week !== null && week > 0 ? round((current / week) * 100, 1) : null,
		noise: round(noise, 3),
		dropBelow: round(cut.drop, 3),
		severeBelow: round(cut.severe, 3),
	};
}

/** Combines a place's signals by the agreement rule. */
export function combine(readings: readonly SignalReading[]): {
	level: Level;
	agreeing: IodaSignal[];
	usable: number;
} {
	const usable = readings.filter((r) => r.level !== "no-data");
	const agreeing = usable.filter((r) => r.level === "drop" || r.level === "severe").map((r) => r.signal);
	const severe = usable.filter((r) => r.level === "severe").length;
	let level: Level = "normal";
	if (usable.length === 0) level = "no-data";
	else if (severe >= 1 && (agreeing.length >= 2 || usable.length === 1)) level = "severe";
	else if (agreeing.length >= 1) level = "drop";
	return { level, agreeing, usable: usable.length };
}

function joinEs(items: readonly string[]): string {
	if (items.length <= 1) return items.join("");
	return `${items.slice(0, -1).join(", ")} y ${items.at(-1)}`;
}

export function headline(level: Level, agreeing: readonly IodaSignal[], usable: number): string {
	const names = agreeing.map((s) => SIGNAL_INFO[s].es.toLowerCase());
	switch (level) {
		case "no-data":
			return "Sin datos suficientes para juzgar";
		case "normal":
			return "Señal normal para esta hora";
		case "severe":
			return agreeing.length >= 2
				? `Caída fuerte de señal: ${joinEs(names)} coinciden`
				: `Caída fuerte de señal en ${names[0]} (única señal disponible)`;
		case "drop":
			return agreeing.length >= 2
				? `Caída de señal: ${joinEs(names)} coinciden`
				: `Caída de señal en ${names[0]}${usable > 1 ? " (las otras señales no la confirman)" : ""}`;
	}
}

/** Hourly % of baseline over the last 48 h, from the 10-minute bins. */
export function sparkline(signal: IodaSignal, bins: Bins, now: number): Spark {
	const endHour = Math.floor(now / HOUR) * HOUR;
	const startAt = endHour - (SPARK_HOURS - 1) * HOUR;
	const values: (number | null)[] = [];
	for (let h = 0; h < SPARK_HOURS; h++) {
		const from = startAt + h * HOUR;
		const ratios: number[] = [];
		for (let t = from; t < from + HOUR; t += BIN_MS) {
			const v = bins.get(t);
			if (v === undefined) continue;
			const b = sameSlotBaseline(bins, t);
			if (!b || b.days < MIN_BASELINE_DAYS || b.value <= 0) continue;
			ratios.push(v / b.value);
		}
		values.push(ratios.length ? round((ratios.reduce((a, b) => a + b, 0) / ratios.length) * 100, 1) : null);
	}
	return { signal, startAt, stepMs: HOUR, values };
}

/** Adds several series bin by bin; a bin counts only when every series has it (Digitel's two ASNs). */
export function sumBins(parts: readonly Bins[]): Map<number, number> {
	const out = new Map<number, number>();
	const [first, ...rest] = parts;
	if (!first) return out;
	for (const [t, v] of first) {
		let total = v;
		let complete = true;
		for (const p of rest) {
			const x = p.get(t);
			if (x === undefined) {
				complete = false;
				break;
			}
			total += x;
		}
		if (complete) out.set(t, total);
	}
	return out;
}

// ——— reading the store ———

function loadBins(
	store: Store,
	source: string,
	series: string,
	from: number,
	to: number,
): SignalInput | null {
	const rows = store.history<IodaBin>(source, series, from, to, 20_000);
	if (rows.length === 0) return null;
	const bins = new Map<number, number>();
	const fetchedAt = new Map<number, number>();
	// Oldest first, revisions in insertion order: the last write for a bin wins.
	for (const r of rows) {
		bins.set(r.observedAt, r.value.value);
		fetchedAt.set(r.observedAt, r.fetchedAt);
	}
	return { bins, fetchedAt };
}

export const ROUTING_MAX_AGE_MS = 6 * HOUR;
/** A fall of this fraction in routed IPv4 prefixes or ASNs marks a routing drop. */
export const ROUTING_DROP = 0.05;

/** Newest RIPEstat hour against the median hour of the 7 days before it; percentages only. */
export function routingSummary(store: Store, now: number): RoutingSummary | null {
	const rows = store.history<Routing>("ripestat-routing", "country:VE:routing", now - 9 * DAY, now, 20_000);
	const byHour = new Map<number, { value: Routing; fetchedAt: number; sourceUrl: string }>();
	for (const r of rows)
		byHour.set(r.observedAt, { value: r.value, fetchedAt: r.fetchedAt, sourceUrl: r.sourceUrl });
	if (byHour.size === 0) return null;
	const t = Math.max(...byHour.keys());
	if (now - t > ROUTING_MAX_AGE_MS) return null;
	const latest = byHour.get(t);
	if (!latest) return null;
	const change = (pick: (r: Routing) => number | null): number | null => {
		const current = pick(latest.value);
		const past: number[] = [];
		for (const [time, r] of byHour) {
			const v = pick(r.value);
			if (time >= t - BASELINE_DAYS * DAY && time < t && v !== null) past.push(v);
		}
		const m = median(past);
		return current === null || m === null || m <= 0 || past.length < 24
			? null
			: round(((current - m) / m) * 100, 1);
	};
	const v4 = change((r) => r.v4Prefixes);
	const asns = change((r) => r.asns);
	return {
		observedAt: t,
		fetchedAt: latest.fetchedAt,
		v4ChangePct: v4,
		v6ChangePct: change((r) => r.v6Prefixes),
		asnsChangePct: asns,
		drop: (v4 !== null && v4 <= -ROUTING_DROP * 100) || (asns !== null && asns <= -ROUTING_DROP * 100),
		feed: "ripestat-routing",
		sourceUrl: latest.sourceUrl,
		attribution: RIPESTAT_LICENCE.attribution,
		licence: RIPESTAT_LICENCE.id,
		note: "Solo se muestra el cambio (%) frente a la mediana de 7 días: los términos de RIPEstat no permiten redistribuir sus datos.",
	};
}

/** Probe list older than this is not shown as current. */
export const ATLAS_MAX_AGE_MS = 30 * MIN;

/** Latest RIPE Atlas counts per state (ISO) and for "VE", with disconnects over the last 3 and 24 clock hours. */
export function atlasSummaries(
	store: Store,
	now: number,
): { observedAt: number | null; byPlace: Map<string, ProbeSummary> } {
	const source = "ripe-atlas-probes";
	const byPlace = new Map<string, ProbeSummary>();
	const national = store.latest<ProbeCounts>(source, "country:VE:probes");
	if (!national || now - national.observedAt > ATLAS_MAX_AGE_MS) return { observedAt: null, byPlace };
	const hourNow = Math.floor(now / HOUR) * HOUR;
	const disconnects = (prefix: string, hours: number) =>
		eventTotal(store, source, `${prefix}:connection-events`, hourNow - (hours - 1) * HOUR, now);
	const rows = store
		.latestPerSeries<ProbeCounts>(source, national.observedAt - ATLAS_MAX_AGE_MS, 500)
		.filter((o) => o.series.endsWith(":probes") && o.observedAt === national.observedAt);
	for (const o of rows) {
		const prefix = o.series.slice(0, -":probes".length);
		const key = prefix === "country:VE" ? "VE" : prefix.slice("state:".length);
		byPlace.set(key, {
			connected: o.value.connected,
			disconnected: o.value.disconnected,
			active: o.value.connected + o.value.disconnected,
			droppedLastHour: o.value.droppedLastHour,
			disconnects3h: disconnects(prefix, 3),
			disconnects24h: disconnects(prefix, 24),
			observedAt: o.observedAt,
			feed: source,
			sourceUrl: o.sourceUrl,
		});
	}
	return { observedAt: national.observedAt, byPlace };
}

/** Sum of disconnects over hourly rows (latest revision of each hour). */
function eventTotal(store: Store, source: string, series: string, from: number, to: number): number {
	const latest = new Map<number, number>();
	for (const o of store.history<ConnectionEvents>(source, series, from, to))
		latest.set(o.observedAt, o.value.disconnects);
	let total = 0;
	for (const v of latest.values()) total += v;
	return total;
}

const LEVEL_ORDER: Record<Level, number> = { severe: 0, drop: 1, normal: 2, "no-data": 3 };

function place(
	id: string,
	name: string,
	kind: PlaceStatus["kind"],
	codes: string[],
	inputs: Partial<Record<IodaSignal, SignalInput | null>>,
	now: number,
	events7d: number,
	links: { feed: string; sourceUrl: string; note: string | null },
	point: { lat: number; lon: number } | null,
): PlaceStatus {
	const signals = IODA_SIGNALS.map((s) => readSignal(s, inputs[s] ?? null, now));
	const { level, agreeing, usable } = combine(signals);
	let lastBinAt: number | null = null;
	for (const s of signals)
		if (s.observedAt !== null && (lastBinAt === null || s.observedAt > lastBinAt)) lastBinAt = s.observedAt;
	// Sparkline from the most informative usable signal: active probing reacts first to power cuts.
	const sparkSignal = (["ping-slash24", "bgp", "merit-nt"] as const).find(
		(s) => signals.find((r) => r.signal === s)?.level !== "no-data",
	);
	const sparkInput = sparkSignal ? inputs[sparkSignal] : null;
	return {
		id,
		name,
		kind,
		codes,
		level,
		headline: headline(level, agreeing, usable),
		agreeing,
		usableSignals: usable,
		signals,
		lastBinAt,
		spark: sparkSignal && sparkInput ? sparkline(sparkSignal, sparkInput.bins, now) : null,
		events7d,
		probes: null,
		lat: point?.lat ?? null,
		lon: point?.lon ?? null,
		note: links.note,
		feed: links.feed,
		sourceUrl: links.sourceUrl,
	};
}

function counts(places: readonly PlaceStatus[]) {
	return {
		normal: places.filter((p) => p.level === "normal").length,
		drop: places.filter((p) => p.level === "drop").length,
		severe: places.filter((p) => p.level === "severe").length,
		noData: places.filter((p) => p.level === "no-data").length,
	};
}

/**
 * "No drops anywhere" is only claimed when fresh data covers at least this many of the 24 states (23 states and the
 * Capital District); below it, silence means missing data, not a working network.
 */
export const ALL_CLEAR_MIN_STATES = 20;

/** True only when no state shows a drop and enough states have fresh data to say so. */
export function allClear(c: { normal: number; drop: number; severe: number }): boolean {
	return c.drop + c.severe === 0 && c.normal >= ALL_CLEAR_MIN_STATES;
}

export function summaryText(c: { normal: number; drop: number; severe: number; noData: number }): string {
	const affected = c.drop + c.severe;
	const withData = c.normal + affected;
	if (withData === 0) return "Sin datos suficientes de IODA en este momento";
	if (affected === 0 && !allClear(c))
		return `Sin caídas en los ${withData} estados con datos; faltan datos de ${c.noData}`;
	if (affected === 0) return `Sin caídas de señal en los ${withData} estados con datos`;
	const noun = affected === 1 ? "estado con caída de señal" : "estados con caída de señal";
	const strong = c.severe > 0 ? ` (${c.severe} ${c.severe === 1 ? "fuerte" : "fuertes"})` : "";
	return `${affected} ${noun}${strong}`;
}

export function connectivityView(store: Store, now: number): ConnectivityView {
	const from = now - (BASELINE_DAYS + 2) * DAY;
	const eventRows = store.latestPerSeries<IodaEvent>("ioda-events", now - 30 * DAY, 2_000);
	const events: OutageEventItem[] = eventRows
		.map((o) => {
			const e = o.value;
			const startAt = e.startS * 1_000;
			const endAt = (e.startS + e.durationS) * 1_000;
			const kind: OutageEventItem["kind"] =
				e.entityType === "region" ? "state" : e.entityType === "asn" ? "isp" : "country";
			return {
				id: o.series,
				kind,
				key: e.key,
				name: e.entityName,
				signal: e.datasource,
				startAt,
				endAt,
				durationMin: Math.round(e.durationS / 60),
				score: Math.round(e.score),
				openAtFetch: endAt >= o.fetchedAt - 40 * MIN,
				url: o.sourceUrl,
			};
		})
		.filter((e) => e.endAt >= now - 7 * DAY && e.startAt <= now)
		.sort((a, b) => b.startAt - a.startAt)
		.slice(0, 100);
	let eventsFetchedAt: number | null = null;
	for (const o of eventRows)
		if (eventsFetchedAt === null || o.fetchedAt > eventsFetchedAt) eventsFetchedAt = o.fetchedAt;
	const eventCount = (key: string) => events.filter((e) => e.key === key).length;
	const atlas = atlasSummaries(store, now);

	const states = IODA_REGIONS.map((r) => {
		const info = stateByIso(r.iso);
		const inputs: Partial<Record<IodaSignal, SignalInput | null>> = {};
		for (const s of IODA_SIGNALS)
			inputs[s] = loadBins(store, "ioda-states", `state:${r.iso}:${s}`, from, now);
		return place(
			r.iso,
			info?.name ?? r.iodaName,
			"state",
			[r.id],
			inputs,
			now,
			eventCount(r.iso),
			{ feed: "ioda-states", sourceUrl: `${IODA_SITE}/region/${r.id}`, note: null },
			info ? info.label : null,
		);
	})
		.map((p) => ({ ...p, probes: atlas.byPlace.get(p.id) ?? null }))
		.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.name.localeCompare(b.name, "es"));

	const isps = ISPS.map((isp) => {
		const inputs: Partial<Record<IodaSignal, SignalInput | null>> = {};
		const notes: string[] = [];
		for (const s of IODA_SIGNALS) {
			// An ASN with no series at all for a signal (IODA does not publish it) is left out of the sum, and said.
			const present: { asn: string; input: SignalInput }[] = [];
			for (const asn of isp.asns) {
				const input = loadBins(store, "ioda-asn", `asn:${asn}:${s}`, from, now);
				if (input) present.push({ asn, input });
			}
			const [first] = present;
			if (!first) {
				inputs[s] = null;
				continue;
			}
			if (isp.asns.length > 1 && present.length < isp.asns.length) {
				notes.push(`${SIGNAL_INFO[s].es}: solo ${present.map((p) => `AS${p.asn}`).join(", ")}`);
			}
			inputs[s] =
				present.length === 1
					? first.input
					: { bins: sumBins(present.map((p) => p.input.bins)), fetchedAt: first.input.fetchedAt };
		}
		return place(
			isp.id,
			isp.name,
			"isp",
			[...isp.asns],
			inputs,
			now,
			eventCount(isp.id),
			{
				feed: "ioda-asn",
				sourceUrl: `${IODA_SITE}/asn/${isp.asns[0]}`,
				note: notes.length
					? `Suma de ${isp.asns.map((a) => `AS${a}`).join(" + ")}; ${notes.join("; ")}`
					: isp.asns.length > 1
						? `Suma de ${isp.asns.map((a) => `AS${a}`).join(" + ")}`
						: null,
			},
			null,
		);
	}).sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.name.localeCompare(b.name, "es"));

	const countryInputs: Partial<Record<IodaSignal, SignalInput | null>> = {};
	for (const s of IODA_SIGNALS)
		countryInputs[s] = loadBins(store, "ioda-states", `country:VE:${s}`, from, now);
	const countryPlace = place(
		"VE",
		"Venezuela",
		"country",
		["VE"],
		countryInputs,
		now,
		eventCount("VE"),
		{ feed: "ioda-states", sourceUrl: `${IODA_SITE}/country/VE`, note: null },
		null,
	);
	const country: PlaceStatus = { ...countryPlace, probes: atlas.byPlace.get("VE") ?? null };

	const stateCounts = counts(states);
	let asOf: number | null = null;
	for (const p of [country, ...states, ...isps])
		if (p.lastBinAt !== null && (asOf === null || p.lastBinAt > asOf)) asOf = p.lastBinAt;

	return {
		asOf,
		summary: {
			states: stateCounts,
			isps: counts(isps),
			text: summaryText(stateCounts),
			affected: states.filter((s) => s.level === "drop" || s.level === "severe").map((s) => s.name),
			allClear: allClear(stateCounts),
		},
		country,
		states,
		isps,
		events,
		eventsFetchedAt,
		routing: routingSummary(store, now),
		atlas: {
			observedAt: atlas.observedAt,
			attribution: RIPE_ATLAS_LICENCE.attribution,
			licence: RIPE_ATLAS_LICENCE.id,
			caveat:
				"Pocas sondas, casi todas en proveedores privados; ninguna en CANTV ni Movilnet. Se muestran conteos por estado, nunca ubicaciones.",
		},
		method: {
			baseline:
				"Cada señal se compara con la mediana de la misma franja de 10 minutos en los 7 días anteriores (hora de Venezuela, sin horario de verano).",
			rules: IODA_SIGNALS.map((s) => ({
				signal: s,
				label: SIGNAL_INFO[s].es,
				unit: SIGNAL_INFO[s].unit,
				what: SIGNAL_INFO[s].what,
				dropFloorPct: Math.round(RULES[s].dropFloor * 100),
				severeFloorPct: Math.round(RULES[s].severeFloor * 100),
				minBaseline: RULES[s].minBaseline,
			})),
			caveats: [
				"Caída de señal no es lo mismo que apagón: puede ser un corte eléctrico, una falla de red o de un proveedor.",
				"IODA ubica las direcciones IP por geolocalización (NetAcuity); las redes nacionales se concentran en el Distrito Capital.",
				"Un corte que se repite cada día a la misma hora (racionamiento programado) entra en la línea base y se ve normal; compare «vs. semana» y los eventos de IODA.",
				"Una caída fuerte exige que dos señales coincidan, salvo que solo haya una señal utilizable.",
			],
		},
		attribution: IODA_LICENCE.attribution,
		licence: IODA_LICENCE.id,
		feeds: ["ioda-states", "ioda-asn", "ioda-events", "ripe-atlas-probes", "ripestat-routing"],
	};
}

export const connectivityPanel: Panel<ConnectivityView> = {
	id: "connectivity",
	sources: ["ioda-states", "ioda-asn", "ioda-events", "ripe-atlas-probes", "ripestat-routing"],
	compute: (store: Store, now: number) => connectivityView(store, now),
};
