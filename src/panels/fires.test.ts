import { expect, test } from "bun:test";
import { join } from "node:path";
import { firmsFires } from "../adapters/firms-fires/index.ts";
import { loadFixture } from "../core/fixtures.ts";
import { Store } from "../core/store.ts";
import type { RawResponse } from "../core/types.ts";
import { firesView, persistentSourceFor } from "./fires.ts";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 24, 20, 0);
const HEADER =
	"latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight";

function row(lat: number, lon: number, at: number, conf = "nominal", frp = 5): string {
	const d = new Date(at).toISOString();
	return `${lat},${lon},330,0.4,0.4,${d.slice(0, 10)},${d.slice(11, 13)}${d.slice(14, 16)},N20,${conf},2.0NRT,290,${frp},D`;
}

function storeFrom(rows: string[]): Store {
	const raw: RawResponse = {
		url: "https://firms.modaps.eosdis.nasa.gov/x.csv",
		status: 200,
		contentType: "text/csv",
		body: [HEADER, ...rows].join("\n"),
		fetchedAt: NOW,
	};
	const store = new Store(":memory:");
	store.insert(firmsFires.normalise([raw]));
	return store;
}

test("persistent sources: the Monagas flare cluster is matched, a savanna fire is not", () => {
	expect(persistentSourceFor(9.6472, -63.5669)).toBe("ps001");
	expect(persistentSourceFor(9.6472 + 0.018, -63.5669)).toBe("ps001"); // 2 km off: radius 1.33 + 1 km
	expect(persistentSourceFor(7.66, -63.15)).toBeNull(); // Bolívar savanna
});

test("24 h / 48 h per state, persistent and low-confidence counted apart, ranking by likely fires", () => {
	const store = storeFrom([
		row(7.66, -63.15, NOW - 2 * HOUR, "nominal", 22.4), // Bolívar
		row(7.7, -63.2, NOW - 3 * HOUR, "low", 1.1), // Bolívar, low confidence
		row(7.8, -63.3, NOW - 30 * HOUR), // Bolívar, 30 h ago
		row(9.6472, -63.5669, NOW - 5 * HOUR), // Monagas flare
		row(9.6475, -63.567, NOW - 6 * HOUR), // same flare
		row(10.64, -71.6, NOW - 1 * HOUR, "nominal", 3), // Maracaibo
		row(7.3, -72.6, NOW - 1 * HOUR), // Colombia, ~20 km from Táchira
		row(7.8, -63.3, NOW - 50 * HOUR), // older than 48 h
	]);
	const view = firesView(store, NOW);
	expect(view.venezuela).toEqual({ last24h: 5, last48h: 6, persistent24h: 2, lowConfidence24h: 1 });
	expect(view.topStates.map((s) => [s.stateIso, s.likelyFires24h])).toEqual([
		["VE-F", 2],
		["VE-V", 1],
	]);
	const monagas = view.byState.find((s) => s.stateIso === "VE-N");
	expect(monagas).toMatchObject({ last24h: 2, persistent24h: 2, likelyFires24h: 0 });
	expect(view.byState.length).toBe(25);
	expect(view.nearBorder).toEqual([{ country: "Colombia", last24h: 1, last48h: 1 }]);
	expect(view.strongest[0]).toMatchObject({ stateIso: "VE-F", frpMW: 22.4 });
	expect(view.strongest.every((p) => p.persistentSource === null)).toBe(true);
	expect(view.newestDetectionAt).toBe(NOW - 1 * HOUR);
	expect(view.file?.spanHours).toBe(49);
});

test("empty store", () => {
	const view = firesView(new Store(":memory:"), NOW);
	expect(view.venezuela.last24h).toBe(0);
	expect(view.topStates).toEqual([]);
	expect(view.file).toBeNull();
	expect(view.persistent.count).toBeGreaterThan(30);
});

test("the live fixture: flares dominate Anzoátegui and Monagas and are set apart", () => {
	const raws = loadFixture(join(import.meta.dir, "..", "adapters", "firms-fires", "fixtures", "2026-09-24"));
	const store = new Store(":memory:");
	store.insert(firmsFires.normalise(raws));
	const view = firesView(store, raws[0]?.fetchedAt ?? NOW);
	expect(view.venezuela.last48h).toBe(672);
	expect(view.byState.find((s) => s.stateIso === "VE-B")).toMatchObject({
		persistent24h: 21,
		likelyFires24h: 0,
	});
	expect(view.topStates[0]?.stateName).toBe("Bolívar");
	expect(view.file?.spanHours).toBe(39.8);
});
