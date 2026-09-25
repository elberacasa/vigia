import { expect, test } from "bun:test";
import { join } from "node:path";
import { hasFixture, loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { cleanAddress, funvisisQuakes, hlvToUtc, seriesId } from "./index.ts";

// FUNVISIS publishes no licence, so its recorded files are absent from the public repository (see hasFixture);
// index.synthetic.test.ts covers the adapter there.
const dir = (name: string) => join(import.meta.dir, "fixtures", name);
const recorded = ["2026-09-24", "rewritten-24dot", "wayback-2024-09-18"].every((d) => hasFixture(dir(d)));
const load = (name: string) => (recorded ? loadFixture(dir(name)) : []);
/** Live, 2026-09-24. */
const live = load("2026-09-24");
/** The same 20 events after the server rewrote the file with "24. km" style addresses (research, 23:16 UTC). */
const rewritten = load("rewritten-24dot");
/** Wayback Machine copy of 2024-09-18: padded depth strings ("  5.0 km"). */
const wayback = load("wayback-2024-09-18");
/** Request metadata for tests that replace the body entirely. */
const base: RawResponse = live[0] ?? {
	url: "http://www.funvisis.gob.ve/maravilla.json",
	status: 200,
	contentType: "text/plain; charset=UTF-8",
	body: "",
	fetchedAt: 1_790_292_783_646,
};

const withBody = (raw: RawResponse | undefined, body: string): RawResponse => ({
	...(raw as RawResponse),
	body,
});

test.skipIf(!recorded)("normalises the live file: 20 events, HLV converted to UTC", () => {
	const obs = funvisisQuakes.normalise(live);
	expect(obs.length).toBe(20);
	const first = obs[0];
	// 24-09-2026 13:31 HLV = 17:31 UTC.
	expect(first?.observedAt).toBe(Date.UTC(2026, 8, 24, 17, 31));
	expect(first?.series).toBe("funvisis:20260924T1731Z:9.48:-70.16:M3.0");
	expect(first?.value).toMatchObject({
		mag: 3,
		depthKm: 5,
		addressEs: "24 km al noroeste de Biscucuy",
		localTime: "24-09-2026 13:31 HLV",
		inVenezuela: true,
		country: null,
		borderKm: 0,
	});
	expect(first?.location?.state).toBe("VE-T"); // Trujillo
	expect(first?.basis).toBe("official");
	for (const o of obs) {
		expect(o.source).toBe("funvisis-quakes");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(o.sourceUrl).toBe("http://www.funvisis.gob.ve/");
		expect(o.confidence).toBeLessThan(1);
	}
});

test.skipIf(!recorded)("Colombian epicentres are located by polygon although the feed says Venezuela", () => {
	const obs = funvisisQuakes.normalise(live);
	const bucaramanga = obs.find((o) => o.value.addressEs === "107 km al suroeste de Bucaramanga");
	expect(bucaramanga?.value.inVenezuela).toBe(false);
	expect(bucaramanga?.value.country).toBe("Colombia");
	expect(bucaramanga?.value.depthKm).toBe(124.7);
	expect(bucaramanga?.location?.state).toBeUndefined();
	const offshore = obs.find((o) => o.value.addressEs === "47 km al norte de Isla la Tortuga");
	expect(offshore?.value.inVenezuela).toBe(false);
	expect(offshore?.value.country).toBeNull();
	expect(offshore?.value.placeEs).toStartWith("En el mar, ");
});

test.skipIf(!recorded)("a rewritten file with no new event yields the same series ids", () => {
	const a = funvisisQuakes.normalise(live).map((o) => o.series);
	const b = funvisisQuakes.normalise(rewritten).map((o) => o.series);
	expect(b).toEqual(a);
	expect(rewritten[0]?.body).toContain('"24. km al noroeste de Biscucuy"');
	expect(funvisisQuakes.normalise(rewritten)[0]?.value.addressEs).toBe("24 km al noroeste de Biscucuy");
});

test.skipIf(!recorded)("older template with padded strings still parses", () => {
	const obs = funvisisQuakes.normalise(wayback);
	expect(obs.length).toBe(20);
	expect(obs[0]?.observedAt).toBe(Date.UTC(2024, 8, 18, 5, 10)); // 18-09-2024 01:10 HLV
	expect(obs[0]?.value.depthKm).toBe(5);
});

test("the date rolls over correctly when HLV evening is the next UTC day", () => {
	// 23-09-2026 23:05 HLV = 24-09-2026 03:05 UTC.
	expect(hlvToUtc("23-09-2026", "23:05")).toBe(Date.UTC(2026, 8, 24, 3, 5));
	expect(hlvToUtc("31-12-2026", "22:00")).toBe(Date.UTC(2027, 0, 1, 2, 0));
	expect(hlvToUtc("31-02-2026", "10:00")).toBeNull();
	expect(hlvToUtc("24-13-2026", "10:00")).toBeNull();
	expect(hlvToUtc("24-09-2026", "24:10")).toBeNull();
});

test("address cleaning and series id", () => {
	expect(cleanAddress("35. km al sur      de Bucaramanga")).toBe("35 km al sur de Bucaramanga");
	expect(cleanAddress(" 6 km al sureste  de Guanoco ")).toBe("6 km al sureste de Guanoco");
	expect(seriesId(Date.UTC(2026, 8, 24, 3, 5), 10.16, -68.93, 1.9)).toBe(
		"funvisis:20260924T0305Z:10.16:-68.93:M1.9",
	);
});

test.skipIf(!recorded)("one malformed event is skipped", () => {
	const body = JSON.parse(live[0]?.body ?? "{}");
	body.features[0].properties.phone = "tres";
	expect(funvisisQuakes.normalise([withBody(live[0], JSON.stringify(body))]).length).toBe(19);
});

test.skipIf(!recorded)(
	"geometry that disagrees with the lat/long strings is rejected (field-shift guard)",
	() => {
		const body = JSON.parse(live[0]?.body ?? "{}");
		body.features[0].geometry.coordinates = [-66, 10];
		expect(funvisisQuakes.normalise([withBody(live[0], JSON.stringify(body))]).length).toBe(19);
	},
);

test.skipIf(!recorded)("an event stamped in the future is skipped", () => {
	const body = JSON.parse(live[0]?.body ?? "{}");
	body.features[0].properties.postalCode = "25-09-2026";
	expect(funvisisQuakes.normalise([withBody(live[0], JSON.stringify(body))]).length).toBe(19);
});

test.skipIf(!recorded)("a template change that breaks most items fails the run loudly", () => {
	const body = JSON.parse(live[0]?.body ?? "{}");
	for (const f of body.features) {
		f.properties.phone = f.properties.city; // magnitude field now holds a time
	}
	expect(() => funvisisQuakes.normalise([withBody(live[0], JSON.stringify(body))])).toThrow("template");
});

test("non-JSON (an HTML error page) and a wrong envelope throw", () => {
	expect(() => funvisisQuakes.normalise([withBody(base, "<html>Error</html>")])).toThrow("not JSON");
	expect(() => funvisisQuakes.normalise([withBody(base, '{"type":"Feature"}')])).toThrow("FUNVISIS");
});

test("an empty list is valid", () => {
	expect(funvisisQuakes.normalise([withBody(base, '{"type":"FeatureCollection","features":[]}')])).toEqual(
		[],
	);
});
