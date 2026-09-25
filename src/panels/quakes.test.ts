import { expect, test } from "bun:test";
import { join } from "node:path";
import { funvisisQuakes } from "../adapters/funvisis-quakes/index.ts";
import { usgsQuakes } from "../adapters/usgs-quakes/index.ts";
import { hasFixture, loadFixture } from "../core/fixtures.ts";
import { Store } from "../core/store.ts";
import type { Observation } from "../core/types.ts";
import { distanceToVenezuelaKm } from "../geo/distance.ts";
import { describe as describePlace, locate } from "../geo/index.ts";
import { MATCH_RULE, quakesView } from "./quakes.ts";

const NOW = Date.UTC(2026, 8, 24, 23, 0);
const MIN = 60_000;
const DAY = 86_400_000;

function place(lat: number, lon: number) {
	const where = locate(lat, lon);
	return {
		inVenezuela: where.inVenezuela,
		country: where.country ?? null,
		borderKm: Math.round(distanceToVenezuelaKm(lat, lon) * 10) / 10,
		placeEs: describePlace(lat, lon),
		location: where.state ? { lat, lon, state: where.state.iso } : { lat, lon },
	};
}

function usgs(
	id: string,
	at: number,
	mag: number,
	lat: number,
	lon: number,
	felt: number | null = null,
): Observation {
	const { location, ...p } = place(lat, lon);
	return {
		source: "usgs-quakes",
		series: `quake:${id}`,
		sourceUrl: `https://earthquake.usgs.gov/earthquakes/eventpage/${id}`,
		fetchedAt: NOW - MIN,
		observedAt: at,
		licence: "usgs-public-domain",
		value: {
			mag,
			magType: "mb",
			placeText: "x",
			depthKm: 10,
			status: "reviewed",
			felt,
			cdi: null,
			mmi: null,
			alert: null,
			tsunami: false,
			updated: at,
			...p,
		},
		location,
		confidence: 1,
		basis: "measurement",
	};
}

function fun(at: number, mag: number, lat: number, lon: number, fetchedAt = NOW - 2 * MIN): Observation {
	const { location, ...p } = place(lat, lon);
	return {
		source: "funvisis-quakes",
		series: `funvisis:${at}:${lat}:${lon}:M${mag}`,
		sourceUrl: "http://www.funvisis.gob.ve/",
		fetchedAt,
		observedAt: at,
		licence: "funvisis-attribution",
		value: {
			mag,
			depthKm: 5,
			addressEs: "a",
			localTime: "x",
			timePrecisionS: 60,
			...p,
		},
		location,
		confidence: 0.85,
		basis: "official",
	};
}

function storeWith(...obs: Observation[]): Store {
	const store = new Store(":memory:");
	store.insert(obs);
	return store;
}

// Near Morón (Carabobo), inside Venezuela.
const LAT = 10.49;
const LON = -68.2;

test("the same quake from both sources is one row with both magnitudes, each attributed", () => {
	const t = NOW - 3 * 3_600_000 + 41_000; // USGS at hh:mm:41
	const store = storeWith(usgs("us1", t, 4.5, LAT, LON), fun(t - 41_000, 4.1, LAT + 0.1, LON + 0.05));
	const view = quakesView(store, NOW);
	expect(view.items.length).toBe(1);
	const row = view.items[0];
	expect(row?.usgs?.mag).toBe(4.5);
	expect(row?.usgs?.label).toBe("USGS");
	expect(row?.funvisis?.mag).toBe(4.1);
	expect(row?.funvisis?.label).toBe("FUNVISIS");
	expect(row?.primary).toBe("usgs-quakes");
	expect(row?.match?.dtS).toBe(41);
	expect(row?.match?.magDiff).toBe(0.4);
	expect(row?.match?.distanceKm).toBeGreaterThan(10);
	expect(row?.match?.distanceKm).toBeLessThan(13);
	expect(row?.maxMag).toBe(4.5);
	expect(row?.zone).toBe("venezuela");
	expect(row?.stateName).toBe("Carabobo");
	expect(view.counts.day).toBe(1);
	expect(row?.feltReportUrl).toBe("https://earthquake.usgs.gov/earthquakes/eventpage/us1/tellus");
});

test("the doublet case: 32 s apart but 148 km apart stays two events", () => {
	const t = NOW - DAY / 2;
	const store = storeWith(usgs("us72", t, 7.2, 10.3713, -68.5564), fun(t + 32_000, 7.5, 10.5955, -67.2205));
	expect(quakesView(store, NOW).items.length).toBe(2);
});

test("time, distance and magnitude limits are each enforced", () => {
	const t = NOW - DAY / 2;
	const tooLate = storeWith(
		usgs("a", t, 4.2, LAT, LON),
		fun(t - (MATCH_RULE.maxSeconds + 1) * 1000, 4.2, LAT, LON),
	);
	expect(quakesView(tooLate, NOW).items.length).toBe(2);
	const tooFar = storeWith(usgs("a", t, 4.2, LAT, LON), fun(t, 4.2, LAT + 0.6, LON)); // ~67 km
	expect(quakesView(tooFar, NOW).items.length).toBe(2);
	const otherMag = storeWith(usgs("a", t, 4.2, LAT, LON), fun(t, 3.1, LAT, LON));
	expect(quakesView(otherMag, NOW).items.length).toBe(2);
	const edge = storeWith(usgs("a", t, 4.2, LAT, LON), fun(t - MATCH_RULE.maxSeconds * 1000, 3.2, LAT, LON));
	expect(quakesView(edge, NOW).items.length).toBe(1);
});

test("pairs are one-to-one: the closer FUNVISIS event wins, the other stays its own row", () => {
	const t = NOW - DAY / 2;
	const store = storeWith(
		usgs("a", t, 4.4, LAT, LON),
		fun(t - 30_000, 4.0, LAT + 0.3, LON), // ~33 km
		fun(t - 20_000, 4.2, LAT + 0.02, LON), // ~2 km: the match
	);
	const view = quakesView(store, NOW);
	expect(view.items.length).toBe(2);
	const merged = view.items.find((r) => r.usgs !== null);
	expect(merged?.funvisis?.mag).toBe(4.2);
	expect(view.items.find((r) => r.usgs === null)?.funvisis?.mag).toBe(4);
});

test("a FUNVISIS revision (same minute, new magnitude) is folded, newest fetch kept", () => {
	const t = NOW - 5 * 3_600_000;
	const store = storeWith(
		fun(t, 2.9, LAT, LON, NOW - 60 * MIN),
		fun(t, 3.1, LAT + 0.01, LON, NOW - 10 * MIN),
	);
	const view = quakesView(store, NOW);
	expect(view.items.length).toBe(1);
	expect(view.items[0]?.funvisis?.mag).toBe(3.1);
});

test("windows count events by zone, felt-size and the doublet's sequence region", () => {
	const store = storeWith(
		fun(NOW - 2 * 3_600_000, 2.1, LAT, LON), // Venezuela, small, in sequence region (≈71 km)
		fun(NOW - 3 * DAY, 3.6, 11.34, -65.4), // at sea ~50 km north of the coast: near, felt-size
		usgs("co", NOW - 2 * DAY, 4.6, 6.26, -73.58), // Colombia, >100 km: far
		usgs("felt", NOW - 10 * DAY, 3.0, 8.6, -71.15, 12), // Mérida, felt reports
		usgs("old", NOW - 40 * DAY, 5.0, LAT, LON), // outside 30 days
	);
	const view = quakesView(store, NOW);
	expect(view.items.map((r) => r.zone)).toEqual(["venezuela", "far", "near", "venezuela"]);
	expect(view.windows.day).toMatchObject({ venezuela: 1, near: 0, feltSize: 0, inSequenceRegion: 1 });
	expect(view.windows.week).toMatchObject({ venezuela: 1, near: 1, feltSize: 1 });
	expect(view.windows.month).toMatchObject({ venezuela: 2, near: 1, feltSize: 2 });
	expect(view.counts).toEqual({ day: 1, week: 2, month: 3 });
	// Strongest in 7 days ignores the far Colombian M4.6.
	expect(view.strongestWeek?.funvisis?.mag).toBe(3.6);
	expect(view.items.find((r) => r.usgs?.series === "quake:felt")?.feltSize).toBe(true);
});

test("FUNVISIS history coverage marks windows it cannot fill", () => {
	const store = storeWith(fun(NOW - 36 * 3_600_000, 2.0, LAT, LON, NOW - 60 * MIN));
	const view = quakesView(store, NOW);
	expect(view.coverage.funvisisHistoryFrom).toBe(NOW - 36 * 3_600_000);
	expect(view.windows.day.funvisisComplete).toBe(true);
	expect(view.windows.week.funvisisComplete).toBe(false);
	expect(quakesView(new Store(":memory:"), NOW).windows.day.funvisisComplete).toBe(false);
});

test("empty store: no rows, the fixed doublet reference and the coverage notes are still there", () => {
	const view = quakesView(new Store(":memory:"), NOW);
	expect(view.items).toEqual([]);
	expect(view.strongestWeek).toBeNull();
	expect(view.reference.events.map((e) => e.id)).toEqual(["us6000t7zc", "us6000t7zp"]);
	expect(view.reference.events[1]?.url).toBe("https://earthquake.usgs.gov/earthquakes/eventpage/us6000t7zp");
	expect(view.reference.daysSince).toBe(92); // 2026-06-24 22:04 UTC → 2026-09-24 23:00 UTC
	expect(view.coverage.usgsCompletenessMag).toBe(4);
	expect(view.sources.map((s) => s.newestFetchedAt)).toEqual([null, null]);
});

// FUNVISIS's recorded file is not in the public repository (see hasFixture).
const funvisisRecorded = hasFixture(
	join(import.meta.dir, "..", "adapters", "funvisis-quakes", "fixtures", "2026-09-24"),
);

test.skipIf(!funvisisRecorded)("real fixtures: USGS 30 days and the live FUNVISIS file together", () => {
	const store = new Store(":memory:");
	const u = loadFixture(
		join(import.meta.dir, "..", "adapters", "usgs-quakes", "fixtures", "2026-09-24-bbox"),
	);
	const f = loadFixture(join(import.meta.dir, "..", "adapters", "funvisis-quakes", "fixtures", "2026-09-24"));
	store.insert(usgsQuakes.normalise(u));
	store.insert(funvisisQuakes.normalise(f));
	const now = f[0]?.fetchedAt ?? NOW;
	const view = quakesView(store, now);
	// No overlap in time between the two samples (USGS newest is 2026-09-16), so nothing merges.
	expect(view.items.length).toBe(29);
	expect(view.items.filter((r) => r.usgs && r.funvisis).length).toBe(0);
	expect(view.items[0]?.funvisis?.sourcePlace).toBe("24 km al noroeste de Biscucuy");
	expect(view.windows.day.venezuela + view.windows.day.near).toBeGreaterThan(0);
	expect(view.sources[1]?.newestFetchedAt).toBe(now);
});

test("FUNVISIS completeness resets after Vigía was off longer than the file can bridge", async () => {
	const { funvisisHistoryFrom, FUNVISIS_MAX_GAP_MS } = await import("./quakes.ts");
	const store = new Store(":memory:");
	const T = Date.UTC(2026, 8, 1);
	store.insert([
		{
			source: "funvisis-quakes",
			series: "q1",
			sourceUrl: "x",
			fetchedAt: T,
			observedAt: T - 86_400_000,
			licence: "l",
			value: 1,
			confidence: 1,
			basis: "official",
		},
	]);
	const run = (at: number) =>
		store.recordRun({
			source: "funvisis-quakes",
			startedAt: at,
			finishedAt: at,
			ok: true,
			error: null,
			bytes: 1,
			received: 1,
			inserted: 0,
		});
	run(T);
	run(T + 600_000);
	expect(funvisisHistoryFrom(store)).toBe(T - 86_400_000);
	const back = T + 600_000 + FUNVISIS_MAX_GAP_MS + 1;
	run(back);
	expect(funvisisHistoryFrom(store)).toBe(back);
});
