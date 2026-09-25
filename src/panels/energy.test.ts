import { expect, test } from "bun:test";
import { join } from "node:path";
import { firmsFlares } from "../adapters/firms-flares/index.ts";
import { loadFixture } from "../core/fixtures.ts";
import { Store } from "../core/store.ts";
import type { Observation } from "../core/types.ts";
import { coveredNights, energyView, type FlareWindow, statusOf } from "./energy.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 25, 2, 0);

function fixtureStore(): Store {
	const store = new Store(":memory:");
	store.insert(
		firmsFlares.normalise(loadFixture(join(import.meta.dir, "../adapters/firms-flares/fixtures/2026-09-25"))),
	);
	return store;
}

const w = (p: Partial<FlareWindow>): FlareWindow => ({
	nights: 7,
	nightsWithData: 7,
	activeNights: 7,
	detections: 7,
	frpSumMW: 70,
	meanNightFrpMW: 10,
	...p,
});

test("covered nights: a file must span the night's 04:00–08:00 UTC", () => {
	const t = (s: string) => Date.parse(s);
	expect([
		...coveredNights([{ oldestAcqAt: t("2026-09-17T03:53Z"), newestAcqAt: t("2026-09-24T17:28Z") }]),
	]).toEqual([
		"2026-09-17",
		"2026-09-18",
		"2026-09-19",
		"2026-09-20",
		"2026-09-21",
		"2026-09-22",
		"2026-09-23",
		"2026-09-24",
	]);
	// Starts after the night pass, ends before the next one: no night.
	expect(
		coveredNights([{ oldestAcqAt: t("2026-09-24T09:00Z"), newestAcqAt: t("2026-09-25T07:00Z") }]).size,
	).toBe(0);
});

test("from the recorded 7-day file: eight nights, no baseline yet, Santa Bárbara first", () => {
	const view = energyView(fixtureStore(), NOW);
	expect(view.latestNight).toBe("2026-09-24");
	expect(view.firstNight).toBe("2026-09-17");
	expect(view.nightsWithData90).toBe(8);
	const top = view.facilities[0];
	expect(top?.id).toBe("santa-barbara");
	expect(top?.d7).toMatchObject({ nights: 7, nightsWithData: 7, activeNights: 7 });
	expect(top?.status).toBe("no-baseline");
	expect(top?.nights30.length).toBe(30);
	expect(top?.nights30.filter((n) => n.frpMW === null).length).toBe(22);
	const palito = view.facilities.find((f) => f.id === "el-palito");
	expect(palito?.d7.activeNights).toBe(1);
	// Every refinery is listed, lit or not.
	for (const id of ["amuay", "cardon", "el-palito", "puerto-la-cruz", "jose"]) {
		expect(view.facilities.some((f) => f.id === id)).toBe(true);
	}
	expect(view.venezuela.status).toBe("no-baseline");
});

test("the mean is per night WITH data: a night without a file is not a zero", () => {
	const store = fixtureStore();
	// Only the 7d file's nights are covered; its 30-day window has 8 nights with data, not 30.
	const view = energyView(store, NOW);
	const cardon = view.facilities.find((f) => f.id === "cardon");
	expect(cardon?.d30.nightsWithData).toBe(8);
	expect(cardon?.d30.meanNightFrpMW).toBeCloseTo((cardon?.d30.frpSumMW ?? 0) / 8, 2);
});

test("status rule", () => {
	const base = w({ nights: 83, nightsWithData: 60, activeNights: 50, frpSumMW: 600, meanNightFrpMW: 10 });
	expect(statusOf(w({ nightsWithData: 3 }), base).status).toBe("no-data");
	expect(statusOf(w({}), w({ nightsWithData: 13 })).status).toBe("no-baseline");
	expect(statusOf(w({ meanNightFrpMW: 10 }), base)).toEqual({ status: "usual", ratio: 1 });
	expect(statusOf(w({ meanNightFrpMW: 20 }), base)).toEqual({ status: "up", ratio: 2 });
	expect(statusOf(w({ meanNightFrpMW: 5 }), base)).toEqual({ status: "down", ratio: 0.5 });
	expect(statusOf(w({ activeNights: 0, detections: 0, meanNightFrpMW: 0 }), base).status).toBe("dark");
	const never = w({ nights: 83, nightsWithData: 60, activeNights: 0, frpSumMW: 0, meanNightFrpMW: 0 });
	expect(statusOf(w({ activeNights: 2 }), never).status).toBe("new");
	expect(statusOf(w({ activeNights: 0, meanNightFrpMW: 0 }), never).status).toBe("quiet");
});

test("a baseline built from stored history drives the comparison, and duplicates across feeds count once", () => {
	const store = new Store(":memory:");
	const obs: Observation[] = [];
	const start = Date.parse("2026-07-01T00:00:00Z");
	// 86 nights of one detection of 10 MW at Cardón, then 7 nights of 30 MW.
	for (let i = 0; i < 93; i++) {
		const at = start + i * DAY + 6 * 3_600_000;
		const date = new Date(at).toISOString().slice(0, 10);
		const frp = i >= 86 ? 30 : 10;
		obs.push({
			source: "firms-flares",
			series: `fire:N20:${date}T0600Z:11.63000:-70.22600`,
			sourceUrl: "https://firms.modaps.eosdis.nasa.gov/map/",
			fetchedAt: at + DAY,
			observedAt: at,
			licence: "nasa-firms-open",
			value: {
				kind: "detection",
				facilityId: "cardon",
				facilityKm: 0,
				satellite: "N20",
				confidenceClass: "nominal",
				frpMW: frp,
				brightnessK: 330,
				daynight: "night",
				acqDate: date,
			},
			location: { lat: 11.63, lon: -70.226, state: "VE-I" },
			confidence: 0.8,
			basis: "measurement",
		});
	}
	obs.push({
		source: "firms-flares",
		series: "flares:file",
		sourceUrl: "https://firms.modaps.eosdis.nasa.gov/active_fire/",
		fetchedAt: start + 94 * DAY,
		observedAt: start + 93 * DAY,
		licence: "nasa-firms-open",
		value: {
			kind: "file",
			product: "test",
			rows: 93,
			invalidRows: 0,
			kept: 93,
			oldestAcqAt: start,
			newestAcqAt: start + 93 * DAY - 1,
		},
		confidence: 1,
		basis: "measurement",
	});
	store.insert(obs);
	// The hourly feed saw the newest night's pixel too: same series id, counted once.
	const last = obs[92] as Observation;
	store.insert([
		{
			...last,
			source: "firms-fires",
			value: {
				kind: "detection",
				satellite: "N20",
				instrument: "VIIRS",
				confidenceClass: "nominal",
				frpMW: 30,
				brightnessK: 330,
				scanKm: 0.4,
				trackKm: 0.4,
				daynight: "night",
				inVenezuela: true,
				country: null,
				borderKm: 0,
				placeEs: "Falcón",
			},
		},
	]);
	const now = start + 93 * DAY;
	const cardon = energyView(store, now).facilities.find((f) => f.id === "cardon");
	expect(cardon?.d7.meanNightFrpMW).toBe(30);
	expect(cardon?.baseline.nightsWithData).toBe(83);
	expect(cardon?.baseline.meanNightFrpMW).toBe(10);
	expect(cardon?.status).toBe("up");
	expect(cardon?.ratio).toBe(3);
});
