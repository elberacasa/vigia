import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { CAPITALS, forecastUrl, openMeteoWeather, weatherLabelEs } from "./index.ts";

const live = loadFixture(join(import.meta.dir, "fixtures", "2026-09-24"));
const withBody = (body: string): RawResponse => ({ ...(live[0] as RawResponse), body });

test("24 capitals (Dependencias Federales has none), one batched URL", () => {
	expect(CAPITALS.length).toBe(24);
	expect(CAPITALS.find((c) => c.stateIso === "VE-V")?.name).toBe("Maracaibo");
	const url = new URL(forecastUrl());
	expect(url.searchParams.get("latitude")?.split(",").length).toBe(24);
	expect(url.searchParams.get("timeformat")).toBe("unixtime");
	expect(url.searchParams.get("forecast_hours")).toBe("24");
	// Call weight: variables per location (Open-Meteo counts 10 variables as one call).
	const vars =
		(url.searchParams.get("current")?.split(",").length ?? 0) +
		(url.searchParams.get("hourly")?.split(",").length ?? 0);
	expect(vars).toBe(14);
});

test("normalises the live response: one observation per capital, UTC times, model grid kept", () => {
	const obs = openMeteoWeather.normalise(live);
	expect(obs.length).toBe(24);
	const caracas = obs.find((o) => o.series === "weather:VE-A");
	expect(caracas?.value.capital).toBe("Caracas");
	expect(caracas?.value.grid.elevationM).toBe(894);
	expect(caracas?.observedAt).toBe(1790292600000); // 2026-09-24T23:30Z slot
	expect(caracas?.value.current).toMatchObject({ intervalS: 900, temperatureC: 22.9, weatherCode: 0 });
	expect(caracas?.value.current.labelEs).toBe("Despejado");
	expect(caracas?.value.next24h.length).toBe(24);
	expect(caracas?.location).toMatchObject({ state: "VE-A", place: "Caracas" });
	for (const o of obs) {
		expect(o.source).toBe("open-meteo-weather");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(o.basis).toBe("quote");
		expect(o.confidence).toBeLessThan(1);
		expect(o.value.next24h[0]?.at).toBeLessThanOrEqual(o.fetchedAt);
	}
});

test("current precipitation over a 15-min slot becomes an hourly rate", () => {
	const body = JSON.parse(live[0]?.body ?? "[]");
	body[0].current.precipitation = 2.5;
	expect(
		openMeteoWeather.normalise([withBody(JSON.stringify(body))])[0]?.value.current.precipitationMmH,
	).toBe(10);
});

test("one malformed location is skipped; most malformed fails", () => {
	const body = JSON.parse(live[0]?.body ?? "[]");
	body[3].current = null;
	expect(openMeteoWeather.normalise([withBody(JSON.stringify(body))]).length).toBe(23);
	for (const loc of body) loc.hourly = null;
	expect(() => openMeteoWeather.normalise([withBody(JSON.stringify(body))])).toThrow("validated");
});

test("an API error object or a wrong count throws with the reason", () => {
	expect(() =>
		openMeteoWeather.normalise([withBody('{"error":true,"reason":"Parameter count mismatch"}')]),
	).toThrow("Parameter count mismatch");
	expect(() => openMeteoWeather.normalise([withBody("not json")])).toThrow("not JSON");
});

test("Spanish labels for WMO codes, with a fallback", () => {
	expect(weatherLabelEs(95)).toBe("Tormenta eléctrica");
	expect(weatherLabelEs(61)).toBe("Lluvia ligera");
	expect(weatherLabelEs(42)).toBe("Código WMO 42");
});
