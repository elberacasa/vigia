import {
	OPEN_METEO_LICENCE,
	OPEN_METEO_PAGE,
	type StateWeather,
	type WeatherHour,
	weatherLabelEs,
} from "../adapters/open-meteo-weather/index.ts";
import type { Store, StoredObservation } from "../core/store.ts";
import type { Panel } from "../server/panels.ts";

/**
 * Weather in every state capital, from a forecast model, plus a "notable" list computed by explicit rules with
 * cited thresholds. Nothing here is a warning from INAMEH (Venezuela's met service); the UI says so.
 */

const FEED = "open-meteo-weather";
const HOUR = 3_600_000;

/** Thresholds and where they come from. The rule ids are stable for the UI. */
export const WEATHER_RULES = {
	storm: {
		codes: [95, 96, 99],
		sourceEs: "Códigos WMO 4677 95–99: tormenta eléctrica (con o sin granizo).",
	},
	heavyRain: {
		mmPerHour: 7.6,
		sourceEs:
			"Lluvia fuerte: 7,6 mm/h o más (la AMS la define como más de 0,30 in/h, 7,6 mm/h; Glosario de Meteorología).",
	},
	gale: {
		gustKmh: 62,
		sourceEs: "Ráfagas de 62 km/h o más: fuerza 8 (temporal) de la escala Beaufort de la OMM.",
	},
	heat: {
		apparentC: 39.4,
		sourceEs:
			"Sensación térmica de 39,4 °C o más: nivel «Peligro» del índice de calor del NWS (103 °F). La sensación térmica del modelo es una aproximación a ese índice.",
	},
} as const;

export type WeatherRuleId = keyof typeof WEATHER_RULES;
/** Order of importance in the notable list. */
const RULE_ORDER: readonly WeatherRuleId[] = ["storm", "heavyRain", "gale", "heat"];

export type CapitalWeather = {
	stateIso: string;
	stateName: string;
	capital: string;
	/** Start of the model's current 15-min slot. */
	observedAt: number;
	fetchedAt: number;
	temperatureC: number;
	apparentC: number;
	humidityPct: number;
	precipitationMmH: number;
	weatherCode: number;
	labelEs: string;
	windKmh: number;
	gustsKmh: number;
	isDay: boolean;
	/** Model grid cell elevation: the capital's weather is the cell's. */
	elevationM: number;
	next24h: {
		hours: number;
		minTempC: number | null;
		maxTempC: number | null;
		maxApparentC: number | null;
		totalPrecipMm: number;
		maxPrecipMmH: number | null;
		maxPrecipProbabilityPct: number | null;
		maxGustsKmh: number | null;
		stormHours: number;
	};
};

export type WeatherNotable = {
	rule: WeatherRuleId;
	stateIso: string;
	stateName: string;
	capital: string;
	/** "now" when the current slot meets the rule, else "next24h". */
	when: "now" | "next24h";
	/** First time the rule is met (current slot start, or hour start). */
	firstAt: number;
	/** Forecast hours that meet the rule, plus one for the current slot if it does. */
	hours: number;
	/** Peak value over the matching period, in `unit`. For storms, the most severe WMO code. */
	peak: number;
	unit: "mm/h" | "km/h" | "°C" | "wmo";
	labelEs: string;
	observedAt: number;
	fetchedAt: number;
};

export type WeatherView = {
	capitals: CapitalWeather[];
	notable: WeatherNotable[];
	rules: { id: WeatherRuleId; threshold: number | number[]; sourceEs: string }[];
	noteEs: string;
	feed: string;
	sourceUrl: string;
	attribution: string;
	licence: string;
	newestObservedAt: number | null;
	newestFetchedAt: number | null;
};

const max = (xs: readonly (number | null)[]): number | null => {
	const v = xs.filter((x): x is number => x !== null);
	return v.length ? Math.max(...v) : null;
};
const min = (xs: readonly (number | null)[]): number | null => {
	const v = xs.filter((x): x is number => x !== null);
	return v.length ? Math.min(...v) : null;
};
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Value of the rule's quantity in one hour (or the current slot), or null when it does not apply. */
function measure(rule: WeatherRuleId, h: WeatherHour): number | null {
	switch (rule) {
		case "storm":
			return h.weatherCode !== null &&
				(WEATHER_RULES.storm.codes as readonly number[]).includes(h.weatherCode)
				? h.weatherCode
				: null;
		case "heavyRain":
			return h.precipitationMm !== null && h.precipitationMm >= WEATHER_RULES.heavyRain.mmPerHour
				? h.precipitationMm
				: null;
		case "gale":
			return h.gustsKmh !== null && h.gustsKmh >= WEATHER_RULES.gale.gustKmh ? h.gustsKmh : null;
		case "heat":
			return h.apparentC !== null && h.apparentC >= WEATHER_RULES.heat.apparentC ? h.apparentC : null;
	}
}

const UNIT: Record<WeatherRuleId, WeatherNotable["unit"]> = {
	storm: "wmo",
	heavyRain: "mm/h",
	gale: "km/h",
	heat: "°C",
};

function labelFor(rule: WeatherRuleId, peak: number): string {
	switch (rule) {
		case "storm":
			return weatherLabelEs(peak);
		case "heavyRain":
			return `Lluvia fuerte (hasta ${r1(peak)} mm/h)`;
		case "gale":
			return `Ráfagas de hasta ${Math.round(peak)} km/h`;
		case "heat":
			return `Sensación térmica de hasta ${r1(peak)} °C`;
	}
}

/** Applies every rule to one capital: the current slot first, then the forecast hours not yet past. */
export function notablesFor(o: StoredObservation<StateWeather>, now: number): WeatherNotable[] {
	const v = o.value;
	const c = v.current;
	const currentAsHour: WeatherHour = {
		at: c.at,
		temperatureC: c.temperatureC,
		apparentC: c.apparentC,
		precipitationMm: c.precipitationMmH,
		precipitationProbabilityPct: null,
		weatherCode: c.weatherCode,
		gustsKmh: c.gustsKmh,
	};
	const future = v.next24h.filter((h) => h.at > now && h.at > c.at);
	const out: WeatherNotable[] = [];
	for (const rule of RULE_ORDER) {
		const nowValue = measure(rule, currentAsHour);
		const hits = future.flatMap((h) => {
			const m = measure(rule, h);
			return m === null ? [] : [{ at: h.at, m }];
		});
		if (nowValue === null && hits.length === 0) continue;
		const values = [...(nowValue === null ? [] : [nowValue]), ...hits.map((x) => x.m)];
		const peak = Math.max(...values);
		out.push({
			rule,
			stateIso: v.stateIso,
			stateName: v.stateName,
			capital: v.capital,
			when: nowValue !== null ? "now" : "next24h",
			firstAt: nowValue !== null ? c.at : (hits[0]?.at ?? c.at),
			hours: values.length,
			peak,
			unit: UNIT[rule],
			labelEs: labelFor(rule, peak),
			observedAt: o.observedAt,
			fetchedAt: o.fetchedAt,
		});
	}
	return out;
}

function capitalRow(o: StoredObservation<StateWeather>, now: number): CapitalWeather {
	const v = o.value;
	const c = v.current;
	const hours = v.next24h.filter((h) => h.at > now);
	return {
		stateIso: v.stateIso,
		stateName: v.stateName,
		capital: v.capital,
		observedAt: o.observedAt,
		fetchedAt: o.fetchedAt,
		temperatureC: c.temperatureC,
		apparentC: c.apparentC,
		humidityPct: c.humidityPct,
		precipitationMmH: c.precipitationMmH,
		weatherCode: c.weatherCode,
		labelEs: c.labelEs,
		windKmh: c.windKmh,
		gustsKmh: c.gustsKmh,
		isDay: c.isDay,
		elevationM: v.grid.elevationM,
		next24h: {
			hours: hours.length,
			minTempC: min(hours.map((h) => h.temperatureC)),
			maxTempC: max(hours.map((h) => h.temperatureC)),
			maxApparentC: max(hours.map((h) => h.apparentC)),
			totalPrecipMm: r1(hours.reduce((sum, h) => sum + (h.precipitationMm ?? 0), 0)),
			maxPrecipMmH: max(hours.map((h) => h.precipitationMm)),
			maxPrecipProbabilityPct: max(hours.map((h) => h.precipitationProbabilityPct)),
			maxGustsKmh: max(hours.map((h) => h.gustsKmh)),
			stormHours: hours.filter((h) => measure("storm", h) !== null).length,
		},
	};
}

const finite = (x: unknown): boolean => typeof x === "number" && Number.isFinite(x);

/** Shape check on read: the fields the rules and rows use, with the right types. */
export function isStateWeather(v: unknown): v is StateWeather {
	if (!v || typeof v !== "object") return false;
	const w = v as Record<string, unknown>;
	const c = w.current as Record<string, unknown> | null | undefined;
	const g = w.grid as Record<string, unknown> | null | undefined;
	return (
		typeof w.stateIso === "string" &&
		typeof w.stateName === "string" &&
		typeof w.capital === "string" &&
		!!g &&
		typeof g === "object" &&
		!!c &&
		typeof c === "object" &&
		finite(c.at) &&
		finite(c.temperatureC) &&
		finite(c.apparentC) &&
		finite(c.weatherCode) &&
		finite(c.gustsKmh) &&
		finite(c.precipitationMmH) &&
		Array.isArray(w.next24h) &&
		w.next24h.every((h) => h && typeof h === "object" && finite((h as Record<string, unknown>).at))
	);
}

export function weatherView(store: Store, now: number): WeatherView {
	// Latest run per capital; anything older than a day is not "the weather" any more.
	// One malformed stored row (an old schema, a bad write) drops that capital, never the panel.
	const rows: { o: StoredObservation<StateWeather>; capital: CapitalWeather; notables: WeatherNotable[] }[] =
		[];
	for (const o of store.latestPerSeries<StateWeather>(FEED, now - 24 * HOUR, 100)) {
		if (!isStateWeather(o.value)) continue;
		try {
			rows.push({ o, capital: capitalRow(o, now), notables: notablesFor(o, now) });
		} catch {
			// skipped: counted below
		}
	}
	rows.sort((a, b) => a.o.value.stateName.localeCompare(b.o.value.stateName, "es"));
	const latest = rows.map((r) => r.o);
	const notable = rows
		.flatMap((r) => r.notables)
		.sort(
			(a, b) =>
				RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule) ||
				(a.when === b.when ? 0 : a.when === "now" ? -1 : 1) ||
				a.firstAt - b.firstAt ||
				a.stateName.localeCompare(b.stateName, "es"),
		);
	return {
		capitals: rows.map((r) => r.capital),
		notable,
		rules: [
			{ id: "storm", threshold: [...WEATHER_RULES.storm.codes], sourceEs: WEATHER_RULES.storm.sourceEs },
			{
				id: "heavyRain",
				threshold: WEATHER_RULES.heavyRain.mmPerHour,
				sourceEs: WEATHER_RULES.heavyRain.sourceEs,
			},
			{ id: "gale", threshold: WEATHER_RULES.gale.gustKmh, sourceEs: WEATHER_RULES.gale.sourceEs },
			{ id: "heat", threshold: WEATHER_RULES.heat.apparentC, sourceEs: WEATHER_RULES.heat.sourceEs },
		],
		noteEs:
			"Pronóstico de un modelo numérico (Open-Meteo) para la celda de cada capital; no es una medición de estación ni un aviso oficial del INAMEH.",
		feed: FEED,
		sourceUrl: OPEN_METEO_PAGE,
		attribution: OPEN_METEO_LICENCE.attribution,
		licence: OPEN_METEO_LICENCE.id,
		newestObservedAt: latest.length ? Math.max(...latest.map((o) => o.observedAt)) : null,
		newestFetchedAt: latest.length ? Math.max(...latest.map((o) => o.fetchedAt)) : null,
	};
}

export const weatherPanel: Panel<WeatherView> = {
	id: "weather",
	sources: [FEED],
	compute: (store: Store, now: number) => weatherView(store, now),
};
