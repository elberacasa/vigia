import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { queryUrl, usgsQuakes } from "./index.ts";

/** Live 30-day query, recorded 2026-09-24 with the production bbox. */
const month = loadFixture(join(import.meta.dir, "fixtures", "2026-09-24-bbox"));
/** One year of M≥4 in the same box (research fixture, 2026-09-24): includes the 2026-06-24 doublet. */
const year = loadFixture(join(import.meta.dir, "fixtures", "1y-m4"));

const withBody = (raw: RawResponse | undefined, body: string): RawResponse => ({
	...(raw as RawResponse),
	body,
});

test("normalises the recorded 30-day response", () => {
	const obs = usgsQuakes.normalise(month);
	expect(obs.length).toBe(9);
	const first = obs[0];
	expect(first?.series).toBe("quake:us7000thrm");
	expect(first?.value.mag).toBe(4.5);
	expect(first?.value.placeText).toBe("45 km NNW of Duaca, Venezuela");
	expect(first?.value.inVenezuela).toBe(true);
	expect(first?.value.country).toBeNull();
	expect(first?.value.borderKm).toBe(0);
	expect(first?.location).toMatchObject({ lat: 10.6842, lon: -69.2782, state: "VE-K" });
	expect(first?.value.placeEs).toMatch(/^a \d+ km al [NSEO]{1,3} de .+ \(.+\)$/);
	expect(first?.basis).toBe("measurement");
	for (const o of obs) {
		expect(o.source).toBe("usgs-quakes");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(o.sourceUrl).toStartWith("https://earthquake.usgs.gov/earthquakes/eventpage/");
		expect(o.location?.place).toBe(o.value.placeEs);
	}
});

test("tags Colombian events by polygon, not by USGS's place text", () => {
	const obs = usgsQuakes.normalise(month);
	const piedecuesta = obs.find((o) => o.series === "quake:us7000th7k");
	expect(piedecuesta?.value.inVenezuela).toBe(false);
	expect(piedecuesta?.value.country).toBe("Colombia");
	expect(piedecuesta?.location?.state).toBeUndefined();
	expect(piedecuesta?.value.placeEs).toStartWith("Colombia, ");
	expect(piedecuesta?.value.borderKm).toBeGreaterThan(50);
	expect(piedecuesta?.value.felt).toBe(1);
	expect(piedecuesta?.value.cdi).toBe(2);
});

test("the 2026-06-24 doublet: offshore M7.5 and onshore M7.2, both PAGER red", () => {
	const obs = usgsQuakes.normalise(year);
	expect(obs.length).toBe(111);
	const m75 = obs.find((o) => o.series === "quake:us6000t7zp");
	const m72 = obs.find((o) => o.series === "quake:us6000t7zc");
	expect(m75?.observedAt).toBe(Date.UTC(2026, 5, 24, 22, 5, 4, 53));
	expect(m75?.value).toMatchObject({ mag: 7.5, magType: "mww", alert: "red", felt: 971, cdi: 8.9 });
	// Epicentre in the sea off La Guaira: not inside Venezuela, but 5 km from it.
	expect(m75?.value.inVenezuela).toBe(false);
	expect(m75?.value.country).toBeNull();
	expect(m75?.value.borderKm).toBeLessThan(10);
	expect(m75?.value.placeEs).toStartWith("En el mar, ");
	expect(m72?.location?.state).toBe("VE-U"); // Yaracuy
	// The 2025 Mene Grande pair carried the tsunami flag.
	expect(obs.find((o) => o.series === "quake:us6000rcnw")?.value.tsunami).toBe(true);
});

test("skips malformed features but keeps the rest", () => {
	const body = JSON.parse(month[0]?.body ?? "{}");
	body.features[0].geometry = null;
	expect(usgsQuakes.normalise([withBody(month[0], JSON.stringify(body))]).length).toBe(8);
});

test("skips events with no magnitude yet", () => {
	const body = JSON.parse(month[0]?.body ?? "{}");
	body.features[0].properties.mag = null;
	expect(usgsQuakes.normalise([withBody(month[0], JSON.stringify(body))]).length).toBe(8);
});

test("skips an event dated after the fetch (review 2, M7: it kept the feed looking fresh)", () => {
	const body = JSON.parse(month[0]?.body ?? "{}");
	body.features[0].properties.time = (month[0]?.fetchedAt ?? 0) + 365 * 86_400_000;
	const obs = usgsQuakes.normalise([withBody(month[0], JSON.stringify(body))]);
	expect(obs.length).toBe(8);
	expect(obs.every((o) => o.observedAt <= (month[0]?.fetchedAt ?? 0))).toBe(true);
});

test("an empty catalogue is valid (quiet weeks are normal)", () => {
	const body = JSON.parse(month[0]?.body ?? "{}");
	body.features = [];
	expect(usgsQuakes.normalise([withBody(month[0], JSON.stringify(body))])).toEqual([]);
});

test("rejects a response that is not a FeatureCollection", () => {
	expect(() => usgsQuakes.normalise([withBody(month[0], '{"type":"Feature"}')])).toThrow("USGS");
});

test("query covers the research bbox and the last 30 days", () => {
	const url = new URL(queryUrl(Date.UTC(2026, 8, 24)));
	expect(url.searchParams.get("starttime")).toBe("2026-08-25T00:00:00");
	expect(url.searchParams.get("minlatitude")).toBe("0.5");
	expect(url.searchParams.get("maxlatitude")).toBe("13");
	expect(url.searchParams.get("minlongitude")).toBe("-73.5");
	expect(url.searchParams.get("maxlongitude")).toBe("-59.5");
});

test("a schema change that breaks most events fails the run instead of showing 'no quakes'", () => {
	const body = JSON.parse(month[0]?.body ?? "{}");
	for (const f of body.features) f.properties.time = "2026-09-24";
	expect(() =>
		usgsQuakes.normalise([{ ...(month[0] as (typeof month)[number]), body: JSON.stringify(body) }]),
	).toThrow("esquema");
});
