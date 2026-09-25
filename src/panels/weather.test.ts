import { expect, test } from "bun:test";
import { join } from "node:path";
import {
	openMeteoWeather,
	type StateWeather,
	type WeatherHour,
} from "../adapters/open-meteo-weather/index.ts";
import { loadFixture } from "../core/fixtures.ts";
import { Store } from "../core/store.ts";
import type { Observation } from "../core/types.ts";
import { WEATHER_RULES, weatherView } from "./weather.ts";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 24, 12, 7);
const SLOT = Date.UTC(2026, 8, 24, 12, 0);

function hour(k: number, over: Partial<WeatherHour> = {}): WeatherHour {
	return {
		at: SLOT + k * HOUR,
		temperatureC: 28,
		apparentC: 31,
		precipitationMm: 0,
		precipitationProbabilityPct: 10,
		weatherCode: 1,
		gustsKmh: 20,
		...over,
	};
}

function obs(
	iso: string,
	name: string,
	current: Partial<StateWeather["current"]>,
	hours: WeatherHour[],
): Observation {
	const value: StateWeather = {
		stateIso: iso,
		stateName: name,
		capital: `Capital de ${name}`,
		grid: { lat: 10, lon: -67, elevationM: 100 },
		current: {
			at: SLOT,
			intervalS: 900,
			temperatureC: 28,
			apparentC: 31,
			humidityPct: 70,
			precipitationMm: 0,
			precipitationMmH: 0,
			weatherCode: 1,
			labelEs: "Mayormente despejado",
			windKmh: 10,
			gustsKmh: 20,
			isDay: true,
			...current,
		},
		next24h: hours,
	};
	return {
		source: "open-meteo-weather",
		series: `weather:${iso}`,
		sourceUrl: "https://open-meteo.com/",
		fetchedAt: NOW - 2 * 60_000,
		observedAt: SLOT,
		licence: "cc-by-4.0-open-meteo",
		value,
		location: { lat: 10, lon: -67, state: iso },
		confidence: 0.7,
		basis: "quote",
	};
}

const calm = Array.from({ length: 24 }, (_, k) => hour(k));

test("each rule fires at its cited threshold and not below", () => {
	const store = new Store(":memory:");
	store.insert([
		obs("VE-V", "Zulia", { apparentC: WEATHER_RULES.heat.apparentC }, calm), // heat now, at threshold
		obs(
			"VE-L",
			"Mérida",
			{},
			calm.map((h, k) => (k === 5 ? { ...h, weatherCode: 95 } : h)),
		), // storm later
		obs(
			"VE-S",
			"Táchira",
			{},
			calm.map((h, k) =>
				k === 3 ? { ...h, precipitationMm: 7.6 } : k === 4 ? { ...h, precipitationMm: 12.2 } : h,
			),
		),
		obs(
			"VE-I",
			"Falcón",
			{ gustsKmh: 61.9 },
			calm.map((h, k) => (k === 8 ? { ...h, gustsKmh: 64.4 } : h)),
		),
		obs("VE-A", "Distrito Capital", { apparentC: 39.3, precipitationMmH: 7.5 }, calm), // just below: nothing
	]);
	const view = weatherView(store, NOW);
	expect(view.capitals.length).toBe(5);
	expect(view.notable.map((n) => `${n.rule}:${n.stateIso}:${n.when}`)).toEqual([
		"storm:VE-L:next24h",
		"heavyRain:VE-S:next24h",
		"gale:VE-I:next24h",
		"heat:VE-V:now",
	]);
	const rain = view.notable.find((n) => n.rule === "heavyRain");
	expect(rain).toMatchObject({ hours: 2, peak: 12.2, unit: "mm/h", firstAt: SLOT + 3 * HOUR });
	expect(rain?.labelEs).toBe("Lluvia fuerte (hasta 12.2 mm/h)");
	expect(view.notable.find((n) => n.rule === "storm")?.labelEs).toBe("Tormenta eléctrica");
	expect(view.notable.find((n) => n.rule === "heat")).toMatchObject({ firstAt: SLOT, hours: 1, peak: 39.4 });
});

test("forecast hours already past are ignored", () => {
	const store = new Store(":memory:");
	// The storm hour is SLOT+0 (not after now), so it must not be listed.
	store.insert([
		obs(
			"VE-L",
			"Mérida",
			{},
			calm.map((h, k) => (k === 0 ? { ...h, weatherCode: 95 } : h)),
		),
	]);
	expect(weatherView(store, NOW).notable).toEqual([]);
});

test("next-24 h summaries per capital", () => {
	const store = new Store(":memory:");
	store.insert([
		obs(
			"VE-L",
			"Mérida",
			{},
			calm.map((h, k) => ({
				...h,
				temperatureC: 15 + k,
				precipitationMm: k === 2 ? 3.3 : k === 7 ? 1.2 : 0,
			})),
		),
	]);
	const row = weatherView(store, NOW).capitals[0];
	expect(row?.next24h).toMatchObject({
		hours: 23,
		minTempC: 16,
		maxTempC: 38,
		totalPrecipMm: 4.5,
		maxPrecipMmH: 3.3,
		stormHours: 0,
	});
});

test("readings older than a day are dropped; empty store is clean", () => {
	const store = new Store(":memory:");
	const old = obs("VE-A", "Distrito Capital", {}, calm);
	store.insert([{ ...old, observedAt: NOW - 25 * HOUR }]);
	const view = weatherView(store, NOW);
	expect(view.capitals).toEqual([]);
	expect(view.newestObservedAt).toBeNull();
	expect(view.attribution).toBe("Weather data by Open-Meteo.com");
});

test("the live fixture: 24 capitals, sorted by state, notable list computed", () => {
	const raws = loadFixture(
		join(import.meta.dir, "..", "adapters", "open-meteo-weather", "fixtures", "2026-09-24"),
	);
	const store = new Store(":memory:");
	store.insert(openMeteoWeather.normalise(raws));
	const now = raws[0]?.fetchedAt ?? NOW;
	const view = weatherView(store, now);
	expect(view.capitals.length).toBe(24);
	expect(view.capitals[0]?.stateName).toBe("Amazonas");
	expect(view.newestFetchedAt).toBe(now);
	for (const n of view.notable) expect(n.firstAt).toBeGreaterThanOrEqual(n.observedAt);
	expect(view.rules.map((r) => r.id)).toEqual(["storm", "heavyRain", "gale", "heat"]);
});

test("one malformed stored row drops that capital, never the panel (review 2, M7)", () => {
	const store = new Store(":memory:");
	const bad = obs("VE-X", "Roto", {}, calm);
	store.insert([
		obs("VE-V", "Zulia", {}, calm),
		{ ...bad, value: { stateIso: "VE-X", current: null, next24h: "x" } },
		{
			...obs("VE-Y", "Sin nombre", {}, calm),
			series: "weather:VE-Y",
			value: { ...(bad.value as object), stateName: 5 },
		},
	]);
	const view = weatherView(store, NOW);
	expect(view.capitals.map((c) => c.stateName)).toEqual(["Zulia"]);
});
