import { z } from "zod";
import type { Adapter, Licence, Observation } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import statesMeta from "../../geo/data/states-meta.json" with { type: "json" };

/**
 * Open-Meteo forecast API: current conditions and the next 24 hours for the capital of every state, in one
 * batched request (comma-separated coordinates return one JSON array, in order).
 *
 * This is a numerical weather model, not a station reading: each point snaps to a model grid cell (Caracas →
 * 10.51, −66.93 at 894 m), so values are the model's for that cell. `current` is a 15-minute slot.
 *
 * Budget (terms, https://open-meteo.com/en/terms): free for non-commercial use, < 10,000 calls/day, 5,000/hour,
 * 600/minute; a request counts as one call per location per 10 variables. 14 variables × 24 capitals ≈ 34
 * calls per fetch; every 30 min that is ≈ 1,600 calls/day. Measured 2026-09-24: 200 in 0.64 s, 44 KB.
 * Dependencias Federales has no capital, so it has no row (24 of 25 first-level units).
 */

export const OPEN_METEO_LICENCE: Licence = {
	id: "cc-by-4.0-open-meteo",
	name: "CC BY 4.0 (Open-Meteo)",
	url: "https://open-meteo.com/en/licence",
	attribution: "Weather data by Open-Meteo.com",
	commercial: false,
};

export const OPEN_METEO_PAGE = "https://open-meteo.com/";

export type Capital = {
	readonly stateIso: string;
	readonly stateName: string;
	readonly name: string;
	readonly lat: number;
	readonly lon: number;
};

/** Every state capital, in states-meta order (Dependencias Federales has none). */
export const CAPITALS: readonly Capital[] = (
	statesMeta as unknown as {
		states: { iso3166_2: string; name: string; capital: { name: string; lat: number; lon: number } | null }[];
	}
).states.flatMap((s) =>
	s.capital
		? [
				{
					stateIso: s.iso3166_2,
					stateName: s.name,
					name: s.capital.name,
					lat: s.capital.lat,
					lon: s.capital.lon,
				},
			]
		: [],
);

const CURRENT = [
	"temperature_2m",
	"apparent_temperature",
	"relative_humidity_2m",
	"precipitation",
	"weather_code",
	"wind_speed_10m",
	"wind_gusts_10m",
	"is_day",
] as const;
const HOURLY = [
	"temperature_2m",
	"apparent_temperature",
	"precipitation",
	"precipitation_probability",
	"weather_code",
	"wind_gusts_10m",
] as const;

export function forecastUrl(capitals: readonly Capital[] = CAPITALS): string {
	const p = new URLSearchParams({
		latitude: capitals.map((c) => c.lat).join(","),
		longitude: capitals.map((c) => c.lon).join(","),
		current: CURRENT.join(","),
		hourly: HOURLY.join(","),
		forecast_hours: "24",
		timeformat: "unixtime",
		timezone: "GMT",
		wind_speed_unit: "kmh",
		precipitation_unit: "mm",
	});
	return `https://api.open-meteo.com/v1/forecast?${p}`;
}

/** WMO 4677 weather codes as Open-Meteo uses them, in Spanish. */
export const WEATHER_CODE_ES: Readonly<Record<number, string>> = {
	0: "Despejado",
	1: "Mayormente despejado",
	2: "Parcialmente nublado",
	3: "Nublado",
	45: "Niebla",
	48: "Niebla con escarcha",
	51: "Llovizna ligera",
	53: "Llovizna moderada",
	55: "Llovizna intensa",
	56: "Llovizna helada ligera",
	57: "Llovizna helada intensa",
	61: "Lluvia ligera",
	63: "Lluvia moderada",
	65: "Lluvia intensa",
	66: "Lluvia helada ligera",
	67: "Lluvia helada intensa",
	71: "Nevada ligera",
	73: "Nevada moderada",
	75: "Nevada intensa",
	77: "Granos de nieve",
	80: "Chubascos ligeros",
	81: "Chubascos moderados",
	82: "Chubascos violentos",
	85: "Chubascos de nieve ligeros",
	86: "Chubascos de nieve intensos",
	95: "Tormenta eléctrica",
	96: "Tormenta eléctrica con granizo ligero",
	99: "Tormenta eléctrica con granizo fuerte",
};

export function weatherLabelEs(code: number): string {
	return WEATHER_CODE_ES[code] ?? `Código WMO ${code}`;
}

const nums = z.array(z.number().nullable());

const Location = z.object({
	latitude: z.number(),
	longitude: z.number(),
	elevation: z.number(),
	utc_offset_seconds: z.literal(0),
	current: z.object({
		time: z.number(),
		interval: z.number().positive(),
		temperature_2m: z.number(),
		apparent_temperature: z.number(),
		relative_humidity_2m: z.number(),
		precipitation: z.number(),
		weather_code: z.number().int(),
		wind_speed_10m: z.number(),
		wind_gusts_10m: z.number(),
		is_day: z.number(),
	}),
	hourly: z.object({
		time: z.array(z.number()),
		temperature_2m: nums,
		apparent_temperature: nums,
		precipitation: nums,
		precipitation_probability: nums,
		weather_code: nums,
		wind_gusts_10m: nums,
	}),
});

export type WeatherHour = {
	/**
	 * The hour's timestamp (UTC ms). Temperatures and weather code are for that instant; precipitation is the
	 * model's total for the preceding hour (so mm/h) and gusts the maximum of the preceding hour (Open-Meteo docs).
	 */
	at: number;
	temperatureC: number | null;
	apparentC: number | null;
	precipitationMm: number | null;
	precipitationProbabilityPct: number | null;
	weatherCode: number | null;
	gustsKmh: number | null;
};

export type StateWeather = {
	stateIso: string;
	stateName: string;
	capital: string;
	/** The model grid cell the capital snapped to. */
	grid: { lat: number; lon: number; elevationM: number };
	current: {
		/** Start of the 15-minute slot the values describe (UTC ms). */
		at: number;
		intervalS: number;
		temperatureC: number;
		apparentC: number;
		humidityPct: number;
		/** Model precipitation over the slot, and the same as an hourly rate. */
		precipitationMm: number;
		precipitationMmH: number;
		weatherCode: number;
		labelEs: string;
		windKmh: number;
		gustsKmh: number;
		isDay: boolean;
	};
	next24h: WeatherHour[];
};

const at = (list: readonly (number | null)[], i: number): number | null => list[i] ?? null;

export const openMeteoWeather: Adapter<StateWeather> = {
	id: "open-meteo-weather",
	layer: "earth",
	name: { es: "Tiempo en las capitales (modelo)", en: "Weather in state capitals (model)" },
	provider: "Open-Meteo",
	homepage: OPEN_METEO_PAGE,
	licence: OPEN_METEO_LICENCE,
	keys: [],
	// Current values are 15-minute model slots and the models refresh hourly; 30 min keeps "now" under 45 min old
	// at ~1,600 of the 10,000 free daily calls.
	intervalMs: 30 * 60_000,
	freshness: { fetchMs: 2 * 3_600_000, dataMs: 2 * 3_600_000 },

	async fetch(ctx) {
		const raw = await ctx.http.request(forecastUrl(), {
			headers: { accept: "application/json" },
			hostGapMs: 2_000,
			maxBytes: 2 * 1024 * 1024,
			signal: ctx.signal,
		});
		return [raw];
	},

	normalise(raws) {
		const raw = raws[0];
		if (!raw) throw new SchemaError("no response");
		let json: unknown;
		try {
			json = JSON.parse(raw.body);
		} catch {
			throw new SchemaError("Open-Meteo: the response is not JSON");
		}
		// One location returns an object, several an array; an error returns {error: true, reason}.
		const list = Array.isArray(json) ? json : [json];
		if (list.length !== CAPITALS.length) {
			const reason = (json as { reason?: unknown } | null)?.reason;
			throw new SchemaError(
				`Open-Meteo: expected ${CAPITALS.length} locations, got ${list.length}${typeof reason === "string" ? ` (${reason})` : ""}`,
			);
		}
		const out: Observation<StateWeather>[] = [];
		list.forEach((item, i) => {
			const capital = CAPITALS[i];
			const parsed = Location.safeParse(item);
			if (!capital || !parsed.success) return;
			const d = parsed.data;
			const c = d.current;
			const observedAt = c.time * 1000;
			const h = d.hourly;
			const next24h: WeatherHour[] = h.time.slice(0, 24).map((t, k) => ({
				at: t * 1000,
				temperatureC: at(h.temperature_2m, k),
				apparentC: at(h.apparent_temperature, k),
				precipitationMm: at(h.precipitation, k),
				precipitationProbabilityPct: at(h.precipitation_probability, k),
				weatherCode: at(h.weather_code, k),
				gustsKmh: at(h.wind_gusts_10m, k),
			}));
			out.push({
				source: "open-meteo-weather",
				series: `weather:${capital.stateIso}`,
				sourceUrl: OPEN_METEO_PAGE,
				fetchedAt: raw.fetchedAt,
				observedAt,
				licence: OPEN_METEO_LICENCE.id,
				value: {
					stateIso: capital.stateIso,
					stateName: capital.stateName,
					capital: capital.name,
					grid: { lat: d.latitude, lon: d.longitude, elevationM: d.elevation },
					current: {
						at: observedAt,
						intervalS: c.interval,
						temperatureC: c.temperature_2m,
						apparentC: c.apparent_temperature,
						humidityPct: c.relative_humidity_2m,
						precipitationMm: c.precipitation,
						precipitationMmH: Math.round(c.precipitation * (3600 / c.interval) * 10) / 10,
						weatherCode: c.weather_code,
						labelEs: weatherLabelEs(c.weather_code),
						windKmh: c.wind_speed_10m,
						gustsKmh: c.wind_gusts_10m,
						isDay: c.is_day === 1,
					},
					next24h,
				},
				location: { lat: capital.lat, lon: capital.lon, state: capital.stateIso, place: capital.name },
				// A model estimate: useful and consistent, not a measurement at the capital.
				confidence: 0.7,
				basis: "quote",
			});
		});
		if (out.length * 2 < CAPITALS.length) {
			throw new SchemaError(`Open-Meteo: only ${out.length} of ${CAPITALS.length} locations validated`);
		}
		return out;
	},
};
