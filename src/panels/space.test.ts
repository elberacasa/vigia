import { expect, test } from "bun:test";
import { join } from "node:path";
import type { Flight, Snapshot } from "../adapters/adsb-flights/index.ts";
import { carbonMapper } from "../adapters/carbon-mapper/index.ts";
import { cloudflareRadar } from "../adapters/cloudflare-radar/index.ts";
import { gfwAlerts } from "../adapters/gfw-alerts/index.ts";
import { gfwVessels, type VesselDay } from "../adapters/gfw-vessels/index.ts";
import { modisFloods } from "../adapters/modis-floods/index.ts";
import { hasFixture, loadFixture } from "../core/fixtures.ts";
import { Store } from "../core/store.ts";
import type { Observation } from "../core/types.ts";
import { corteSignals } from "../intel/signals.ts";
import { PANELS, SPACE_PANELS } from "../server/panel-registry.ts";
import { flightsViewOf } from "./flights.ts";
import { floodsView } from "./floods.ts";
import { forestView } from "./forest.ts";
import { methaneView } from "./methane.ts";
import { outageStates, radarInputs, radarView, trafficVsUsual } from "./radar.ts";
import { vesselsView, vesselsViewOf } from "./vessels.ts";

const fixture = (id: string) => join(import.meta.dir, "..", "adapters", id, "fixtures", "2026-09-29");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

test("the space views are on demand and served (the client lists them in ON_DEMAND)", () => {
	const served = new Set(PANELS.map((p) => p.id));
	expect(SPACE_PANELS.map((p) => p.id)).toEqual([
		"floods",
		"forest",
		"methane",
		"vessels",
		"radar",
		"flights",
	]);
	for (const p of SPACE_PANELS) {
		expect(p.onDemand).toBe(true);
		expect(served.has(p.id)).toBe(true);
	}
});

test.skipIf(!hasFixture(fixture("modis-floods")))("floods view from the recorded day", () => {
	const store = new Store(":memory:");
	store.insert(modisFloods.normalise(loadFixture(fixture("modis-floods"))));
	const now = Date.UTC(2026, 8, 29, 6);
	const v = floodsView(store, now);
	expect(v.day?.date).toBe("2026-09-27");
	expect(v.day?.stale).toBe(false);
	expect(v.day?.venezuela.floodKm2).toBe(202.6);
	expect(v.day?.venezuela.cloudPct).toBe(80.5);
	expect(v.day?.states.length).toBe(25);
	// Most flood first; every municipality named and placed in its state.
	const s = v.day?.states ?? [];
	for (let i = 1; i < s.length; i++) expect((s[i - 1]?.floodKm2 ?? 0) >= (s[i]?.floodKm2 ?? 0)).toBe(true);
	for (const m of v.day?.municipalities ?? []) {
		expect(m.name).not.toBe(m.code);
		expect(m.state).toMatch(/^VE-[A-Z]$/);
	}
	expect(v.series).toEqual([
		{ date: "2026-09-27", floodKm2: 202.6, recurringKm2: 183.1, cloudPct: 80.5, unseenPct: 80.5 },
	]);
	expect(floodsView(store, now + 6 * DAY).day?.stale).toBe(true);
	expect(floodsView(new Store(":memory:"), now).day).toBeNull();
});

test.skipIf(!hasFixture(fixture("gfw-alerts")))(
	"forest view: four complete weeks summed, tops by natural forest",
	() => {
		const store = new Store(":memory:");
		store.insert(gfwAlerts.normalise(loadFixture(fixture("gfw-alerts"))));
		const v = forestView(store, Date.UTC(2026, 8, 29, 6));
		expect(v.version).toBe("v20260929");
		expect(v.weeks.length).toBe(7);
		expect(v.recent).toEqual({ from: "2026-08-31", to: "2026-09-21", weeks: 4 });
		const sum = v.weeks.slice(-4).reduce((a, w) => a + w.forest.total, 0);
		expect(Math.abs(v.venezuela.forest.total - sum)).toBeLessThan(1);
		expect(v.states[0]?.forest.total).toBeGreaterThanOrEqual(v.states[1]?.forest.total ?? 0);
		expect(v.municipalities.length).toBe(25);
		expect(v.protectedAreas.length).toBe(25);
		// WDPA's two records of the Río Pedregal basin are one row, with both ids.
		const pedregal = v.protectedAreas.filter((p) =>
			p.name.startsWith("Cuenca Hidrográfica del Río Pedregal"),
		);
		expect(pedregal.length).toBe(1);
		expect(pedregal[0]?.wdpaIds).toEqual(["101161", "20092"]);
		for (const m of v.municipalities) if (m.code) expect(m.code).toMatch(/^VE\d{4}$/);
	},
);

test.skipIf(!hasFixture(fixture("carbon-mapper")))(
	"methane view: the last year of plumes, by facility and month",
	() => {
		const store = new Store(":memory:");
		store.insert(carbonMapper.normalise(loadFixture(fixture("carbon-mapper"))));
		const now = Date.UTC(2026, 8, 29, 6);
		store.recordRun({
			source: carbonMapper.id,
			startedAt: now - 60_000,
			finishedAt: now - 59_000,
			ok: true,
			error: null,
			bytes: 1,
			received: 1,
			inserted: 1,
		});
		const v = methaneView(store, now);
		expect(v.plumes.length).toBeGreaterThan(200);
		expect((v.plumes[0]?.sceneAt ?? "") >= (v.plumes[1]?.sceneAt ?? "")).toBe(true);
		expect(v.stale).toBe(false);
		expect(v.facilities[0]?.plumes).toBeGreaterThanOrEqual(v.facilities[1]?.plumes ?? 0);
		expect(v.months.reduce((s, m) => s + m.plumes, 0)).toBe(v.plumes.length);
		expect(v.facilities.find((f) => f.id === "faja-carabobo")?.name).toContain("Carabobo");
		expect(methaneView(new Store(":memory:"), now).stale).toBe(true);
	},
);

test("vessels view: per area, newest revision per day, sums over 30 days", () => {
	const now = Date.UTC(2026, 8, 29);
	const row = (date: string, detections: number, withoutAis: number) => ({
		observedAt: Date.parse(`${date}T00:00:00Z`),
		value: { area: "jose", date, detections, withoutAis } satisfies VesselDay,
	});
	const v = vesselsViewOf(
		[row("2026-09-20", 5, 1), row("2026-09-20", 6, 2), row("2026-09-26", 3, 0), row("2026-07-01", 9, 9)],
		now,
		now - HOUR,
	);
	const jose = v.areas.find((a) => a.id === "jose");
	expect(jose?.days).toEqual([
		{ date: "2026-09-26", detections: 3, withoutAis: 0 },
		{ date: "2026-09-20", detections: 6, withoutAis: 2 },
	]);
	expect(jose?.detections).toBe(9);
	expect(jose?.withoutAis).toBe(2);
	expect(v.areas.length).toBe(5);
	expect(v.stale).toBe(false);
	// Locked (no token): every area empty and the view stale, never an error.
	const empty = vesselsView(new Store(":memory:"), now);
	expect(empty.stale).toBe(true);
	expect(empty.areas.every((a) => a.days.length === 0)).toBe(true);
	expect(empty.feed).toBe(gfwVessels.id);
});

test("radar: the newest hour against the median of the same hour on the 6 days before", () => {
	const t0 = Date.UTC(2026, 8, 22, 0);
	const points: [number, number][] = [];
	for (let h = 0; h <= 7 * 24; h++) points.push([t0 + h * HOUR, h === 7 * 24 ? 0.3 : 0.6]);
	expect(trafficVsUsual(points)).toEqual({ pct: 50, days: 6 });
	expect(trafficVsUsual(points.slice(-49))).toEqual({ pct: null, days: 2 });
	expect(trafficVsUsual([])).toEqual({ pct: null, days: 0 });
});

test("radar: outage notes placed by the states they name, nationwide ones everywhere, unplaceable ones dropped", () => {
	expect(outageStates({ scope: "Zulia", description: null, outageType: "REGIONAL" })).toEqual(["VE-V"]);
	expect(
		outageStates({ scope: null, description: "Power outage in Zulia and Falcón", outageType: "REGIONAL" }),
	).toEqual(["VE-I", "VE-V"]);
	expect(outageStates({ scope: null, description: null, outageType: "NATIONWIDE" })).toBe("all");
	// One network's outage that names no state concerns no state (the ISP may be regional).
	expect(outageStates({ scope: null, description: "CANTV outage", outageType: "NETWORK" })).toBeNull();
	expect(outageStates({ scope: "Unknown region", description: null, outageType: "REGIONAL" })).toBeNull();
});

const now = Date.UTC(2026, 8, 29, 12);
const radarObs = (): Observation[] =>
	cloudflareRadar.normalise([
		{
			url: "https://api.cloudflare.com/client/v4/radar/annotations/outages?location=VE",
			status: 200,
			contentType: "application/json",
			fetchedAt: now,
			body: JSON.stringify({
				success: true,
				result: {
					annotations: [
						{
							id: "1",
							startDate: "2026-09-29T09:00:00Z",
							endDate: null,
							description: "Power outage",
							scope: "Zulia",
							outage: { outageCause: "POWER_OUTAGE", outageType: "REGIONAL" },
							asnsDetails: [{ asn: "8048", name: "CANTV" }],
							locations: ["VE"],
							linkedUrl: null,
						},
					],
				},
			}),
		},
		{
			url: "https://api.cloudflare.com/client/v4/radar/traffic_anomalies?location=VE",
			status: 200,
			contentType: "application/json",
			fetchedAt: now,
			body: JSON.stringify({
				success: true,
				result: {
					trafficAnomalies: [
						{
							uuid: "u1",
							status: "UNVERIFIED",
							type: "LOCATION",
							startDate: "2026-09-29T09:00:00Z",
							endDate: null,
							asnDetails: null,
							locationDetails: { code: "VE", name: "Venezuela" },
						},
						{
							uuid: "u2",
							status: "VERIFIED",
							type: "AS",
							startDate: "2026-09-29T09:00:00Z",
							endDate: null,
							asnDetails: { asn: "21826", name: "Corporación Telemic", location: null },
							locationDetails: null,
						},
					],
				},
			}),
		},
	]);

test("radar: placed notes become join-only evidence; unverified and single-network anomalies never do", () => {
	const store = new Store(":memory:");
	store.insert(radarObs());
	const rows = store.latestPerSeries(cloudflareRadar.id, 0, 100) as Parameters<typeof radarInputs>[0];
	const inputs = radarInputs(rows, now);
	expect(inputs.map((i) => [i.series, i.states])).toEqual([["outage:1", ["VE-V"]]]);
	expect(inputs[0]?.speaks).toBe("power");
	expect(inputs[0]?.es).toContain("Zulia");
	const signals = corteSignals(
		{
			connectivity: { states: [], events: [], eventsFetchedAt: null },
			nights: { date: null, observedAt: null, fetchedAt: null, sourceUrl: null, states: [] },
			headlines: [],
			quakes: [],
			hazards: [],
			radar: inputs,
		},
		now,
	);
	expect(signals.map((s) => [s.key, s.evidence.family])).toEqual([["VE-V", "cloudflare"]]);
	const v = radarView(store, now);
	expect(v.outages[0]?.states).toEqual(["VE-V"]);
	expect(v.outages[0]?.causeEs).toBe("corte eléctrico");
	expect(v.anomalies.map((a) => a.status).sort()).toEqual(["UNVERIFIED", "VERIFIED"]);
	expect(v.traffic).toBeNull();
});

test("flights view: one count per flight and Venezuelan day, international airlines and airports, coverage", () => {
	const now = Date.UTC(2026, 8, 29, 18); // 14:00 in Venezuela
	const flight = (
		date: string,
		callsign: string,
		cls: Flight["class"],
		route: string[],
		name: string | null,
	) => ({
		observedAt: Date.parse(`${date}T14:00:00Z`),
		value: {
			kind: "flight",
			date,
			callsign,
			airline: callsign.slice(0, 3),
			airlineName: name,
			route,
			class: cls,
			veAirports: route.filter((c) => c.startsWith("SV")),
			overVenezuela: true,
			routePlausible: true,
		} satisfies Flight,
	});
	const v = flightsViewOf(
		[
			flight("2026-09-29", "CMP180", "arrival", ["MPTO", "SVMI"], "Copa Airlines"),
			flight("2026-09-29", "VCV300", "domestic", ["SVMI", "SVMC"], "Conviasa"),
			flight("2026-09-28", "CMP181", "departure", ["SVMI", "MPTO"], "Copa Airlines"),
			flight("2026-09-28", "IBE6673", "arrival", ["LEMD", "SVMI"], "Iberia"),
			flight("2026-09-28", "AAL929", "overflight", ["KMIA", "SBGR"], "American Airlines"),
			flight("2026-09-01", "OLD1", "arrival", ["MPTO", "SVMI"], null),
		],
		[
			{ observedAt: now - 30 * 60_000, value: snapshot(12, 9, 1) },
			{ observedAt: now - 25 * 60_000, value: snapshot(14, 10, 0) },
			{ observedAt: now - 2 * DAY, value: snapshot(99, 99, 9) },
		],
		now,
	);
	expect(v.days.length).toBe(14);
	const today = v.days.at(-1);
	expect(today).toMatchObject({
		date: "2026-09-29",
		partial: true,
		arrival: 1,
		domestic: 1,
		internationalAll: 1,
		total: 2,
	});
	expect(v.days.at(-2)).toMatchObject({ date: "2026-09-28", internationalAll: 2, overflight: 1, total: 3 });
	expect(v.airlinesToday).toEqual([{ airline: "CMP", name: "Copa Airlines", flights: 1 }]);
	expect(v.airlines7d).toEqual([
		{ airline: "CMP", name: "Copa Airlines", flights: 1 },
		{ airline: "IBE", name: "Iberia", flights: 1 },
	]);
	expect(v.airports7d).toEqual([{ icao: "SVMI", flights: 2 }]);
	expect(v.coverage24h).toEqual([
		{ hourStart: Date.UTC(2026, 8, 29, 17), snapshots: 2, maxAircraft: 14, maxAirline: 10, maxMilitary: 1 },
	]);
	expect(v.stale).toBe(false);
	expect(flightsViewOf([], [], now).stale).toBe(true);
	// Coverage per Venezuelan day (review M9): today read twice, two days ago once, every other day never: no figure.
	expect(today).toMatchObject({ snapshots: 2, covered: true });
	expect(v.days.at(-3)).toMatchObject({ covered: true, snapshots: 1 });
	// Yesterday has no snapshot kept but three flights recorded: read. The first of the month is outside the 14 days.
	expect(v.days.at(-2)).toMatchObject({ covered: true, snapshots: 0 });
	expect(v.days.filter((d) => d.covered).length).toBe(3);
	expect(v.days.at(-4)).toMatchObject({ covered: false, total: 0 });
});

const snapshot = (aircraft: number, airline: number, military: number): Snapshot => ({
	kind: "snapshot",
	aircraft,
	airline,
	military,
	other: aircraft - airline - military,
	overVenezuela: 0,
	circles: 5,
	circlesAnswered: 5,
});
