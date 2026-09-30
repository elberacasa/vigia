import { expect, test } from "bun:test";
import type { RawResponse } from "../../core/types.ts";
import {
	type AdsbFlights,
	adsbFlights,
	CIRCLES,
	classify,
	distanceToRouteKm,
	type Flight,
	pointUrl,
	routeCrossesVenezuela,
	routeUrl,
	type Snapshot,
} from "./index.ts";

// Invented aircraft and routes in adsb.lol's and VRS's formats (hex codes and callsigns made up).
const now = Date.UTC(2026, 8, 29, 15, 0);
const snap = (lat: number, lon: number, ac: unknown[]): RawResponse => ({
	url: pointUrl(lat, lon),
	status: 200,
	contentType: "application/json",
	body: JSON.stringify({ ac, msg: "No error", now, total: ac.length, ctime: now, ptime: 0 }),
	fetchedAt: now + 2_000,
});
const empty = (i: number) => snap(CIRCLES[i]?.[0] ?? 0, CIRCLES[i]?.[1] ?? 0, []);
const airport = (icao: string, lat: number, lon: number) => ({
	icao,
	lat,
	lon,
	name: icao,
	countryiso2: "XX",
});
const AP = {
	SVMI: airport("SVMI", 10.6031, -66.9906),
	SVMC: airport("SVMC", 10.5582, -71.7279),
	MPTO: airport("MPTO", 9.0714, -79.3835),
	KMIA: airport("KMIA", 25.7932, -80.2906),
	SBGR: airport("SBGR", -23.4356, -46.4731),
	SKBO: airport("SKBO", 4.7016, -74.1469),
	TNCC: airport("TNCC", 12.1889, -68.9598),
	TTPP: airport("TTPP", 10.5954, -61.3372),
};
const route = (callsign: string, airports: (typeof AP)[keyof typeof AP][]): RawResponse => ({
	url: routeUrl(callsign),
	status: 200,
	contentType: "application/json",
	body: JSON.stringify({
		callsign,
		number: callsign.slice(3),
		airline_code: callsign.slice(0, 3),
		airport_codes: airports.map((a) => a.icao).join("-"),
		_airports: airports,
	}),
	fetchedAt: now - 3_600_000,
});
const missing = (callsign: string): RawResponse => ({
	url: routeUrl(callsign),
	status: 404,
	contentType: "text/html",
	body: "<html>not found</html>",
	fetchedAt: now,
});
const ac = (
	hex: string,
	flight: string | undefined,
	lat: number,
	lon: number,
	extra: Record<string, unknown> = {},
) => ({
	hex,
	type: "adsb_icao",
	...(flight ? { flight: `${flight}  ` } : {}),
	lat,
	lon,
	alt_baro: 35000,
	...extra,
});

test("classes: international by route, domestic, overflight by route geometry, nearby; others only counted", () => {
	const raws = [
		snap(10.0, -66.8, [
			ac("aaa001", "CMP180", 10.4, -68.5), // PTY → CCS: arrival
			ac("aaa002", "VCV300", 10.6, -69.0), // CCS → MAR: domestic
			ac("aaa003", "AAL929", 10.1, -63.6), // MIA → GRU, crosses Venezuela: overflight
			ac("aaa004", "KLM701", 11.9, -68.5), // CUR → POS: nearby (does not cross)
			ac("aaa005", "N123AB", 10.5, -66.9), // a registration: other, never listed
			ac("aaa006", undefined, 10.2, -67.0), // no callsign: other
			ac("aaa007", "ABC123", 9.9, -66.0, { dbFlags: 1 }), // military flag: counted, never listed
			ac("aaa008", "AVA999", 9.5, -65.0), // listed airline, route unknown (404)
			ac("aaa009", "CMP999", 3.0, -60.0), // route PTY-CCS but seen 900 km away: doubtful
			// Operator codes that are not listed airlines are only counted: US Air Mobility Command, a government VIP
			// flight, a business-jet operator; and a listed airline's aircraft whose owner asked not to be shown (LADD).
			ac("aaa010", "RCH871", 11.0, -67.0),
			ac("aaa011", "SAM44", 11.0, -66.0),
			ac("aaa012", "EJA123", 10.8, -66.5),
			ac("aaa013", "CMP777", 10.9, -66.5, { dbFlags: 8 }),
		]),
		// The same aircraft heard in a second circle is one aircraft.
		snap(9.0, -62.8, [ac("aaa003", "AAL929", 10.1, -63.6)]),
		empty(0),
		route("CMP180", [AP.MPTO, AP.SVMI]),
		route("VCV300", [AP.SVMI, AP.SVMC]),
		route("AAL929", [AP.KMIA, AP.SBGR]),
		route("KLM701", [AP.TNCC, AP.TTPP]),
		missing("AVA999"),
		route("CMP999", [AP.MPTO, AP.SVMI]),
	];
	const obs = adsbFlights.normalise(raws);
	const flights = obs.filter((o) => o.value.kind === "flight").map((o) => o.value as Flight);
	expect(Object.fromEntries(flights.map((f) => [f.callsign, f.class]))).toEqual({
		CMP180: "arrival",
		VCV300: "domestic",
		AAL929: "overflight",
		KLM701: "nearby",
		AVA999: "no-route",
		CMP999: "no-route",
	});
	const cmp = flights.find((f) => f.callsign === "CMP180");
	expect(cmp).toMatchObject({
		date: "2026-09-29",
		airline: "CMP",
		airlineName: "Copa Airlines",
		route: ["MPTO", "SVMI"],
		veAirports: ["SVMI"],
		routePlausible: true,
	});
	expect(flights.find((f) => f.callsign === "CMP999")?.routePlausible).toBe(false);
	const snapshot = obs.find((o) => o.series === "snapshot")?.value as Snapshot;
	expect(snapshot).toEqual({
		kind: "snapshot",
		aircraft: 13,
		airline: 6,
		military: 1,
		other: 6,
		overVenezuela: snapshot.overVenezuela,
		circles: 3,
		circlesAnswered: 3,
	});
	// Nothing that locates or identifies an aircraft is stored.
	const text = JSON.stringify(obs.map((o) => o.value));
	for (const bad of [
		"aaa0",
		"N123AB",
		"ABC123",
		"RCH871",
		"SAM44",
		"EJA123",
		"CMP777",
		"10.4",
		"-68.5",
		"hex",
		"lat",
	])
		expect(text).not.toContain(bad);
	for (const o of obs) {
		expect(o.location).toBeUndefined();
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
	}
	// One row per flight and Venezuelan day: kept first, later sightings ignored by the store.
	const f = obs.find((o) => o.series === "flight:2026-09-29:CMP180");
	expect(f?.keepFirst).toBe(true);
});

test("a flight whose route has not been looked up yet is counted but not listed until it is", () => {
	const obs = adsbFlights.normalise([snap(10, -66.8, [ac("aaa001", "CMP180", 10.4, -68.5)])]);
	expect(obs.map((o) => o.series)).toEqual(["snapshot"]);
	expect((obs[0]?.value as Snapshot | undefined)?.airline).toBe(1);
});

test("the Venezuelan day is UTC−4", () => {
	const late: RawResponse = {
		...snap(10, -66.8, [ac("aaa001", "CMP180", 10.4, -68.5)]),
		body: JSON.stringify({ ac: [ac("aaa001", "CMP180", 10.4, -68.5)], now: Date.UTC(2026, 8, 30, 2, 0) }),
		fetchedAt: Date.UTC(2026, 8, 30, 2, 1),
	};
	const obs = adsbFlights.normalise([late, route("CMP180", [AP.MPTO, AP.SVMI])]);
	expect(obs.find((o) => o.value.kind === "flight")?.series).toBe("flight:2026-09-29:CMP180");
});

test("bad answers: no snapshot or a broken one fails the run; bad aircraft are skipped", () => {
	expect(() => adsbFlights.normalise([])).toThrow("sin respuestas");
	expect(() => adsbFlights.normalise([{ ...empty(0), body: "<html>429</html>" }])).toThrow("no es JSON");
	expect(() => adsbFlights.normalise([{ ...empty(0), body: "{}" }])).toThrow("«ac»");
	const obs = adsbFlights.normalise([snap(10, -66.8, [{ hex: 5 }, ac("aaa1", "CMP180", Number.NaN, 1)])]);
	expect((obs[0]?.value as Snapshot | undefined)?.aircraft).toBe(0);
});

test("route geometry: distance to a route and crossing Venezuela", () => {
	expect(distanceToRouteKm(10.6, -67, [AP.MPTO, AP.SVMI])).toBeLessThan(10);
	expect(distanceToRouteKm(3, -60, [AP.MPTO, AP.SVMI])).toBeGreaterThan(800);
	expect(routeCrossesVenezuela([AP.KMIA, AP.SBGR])).toBe(true);
	expect(routeCrossesVenezuela([AP.TNCC, AP.TTPP])).toBe(false);
	expect(routeCrossesVenezuela([AP.SKBO, AP.KMIA])).toBe(false);
	expect(classify([], true)).toBe("no-route");
	expect(classify(["SVMI", "KMIA"], false)).toBe("departure");
	expect(classify(["KMIA", "SVMI", "SVMC"], false)).toBe("arrival");
	expect(classify(["SVMI", "KMIA", "SVMC"], false)).toBe("international");
});

test("the typed value is JSON", () => {
	const v: AdsbFlights = {
		kind: "snapshot",
		aircraft: 0,
		airline: 0,
		military: 0,
		other: 0,
		overVenezuela: 0,
		circles: 5,
		circlesAnswered: 5,
	};
	expect(JSON.parse(JSON.stringify(v))).toEqual(v);
});
