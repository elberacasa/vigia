import { expect, test } from "bun:test";
import { join } from "node:path";
import { gdacsEvents } from "../adapters/gdacs-events/index.ts";
import { nhcStorms } from "../adapters/nhc-storms/index.ts";
import { hasFixture, loadFixture } from "../core/fixtures.ts";
import { Store } from "../core/store.ts";
import type { RawResponse } from "../core/types.ts";
import { hazardsView } from "./hazards.ts";

const adapters = join(import.meta.dir, "..", "adapters");
const HOUR = 3_600_000;

function run(store: Store, source: string, at: number): void {
	store.recordRun({
		source,
		startedAt: at - 1000,
		finishedAt: at,
		ok: true,
		error: null,
		bytes: 1,
		received: 1,
		inserted: 1,
	});
}

// GDACS recordings are not in the public repository (see hasFixture); index.synthetic.test.ts covers the adapter.
const gdacsRecorded = ["2026-09-24", "1y-all"].every((d) =>
	hasFixture(join(adapters, "gdacs-events", "fixtures", d)),
);

test.skipIf(!gdacsRecorded)("live fixtures: three GDACS events (green), Fay active and not a threat", () => {
	const g = loadFixture(join(adapters, "gdacs-events", "fixtures", "2026-09-24"));
	const n = loadFixture(join(adapters, "nhc-storms", "fixtures", "2026-09-24"));
	const store = new Store(":memory:");
	store.insert(gdacsEvents.normalise(g));
	store.insert(nhcStorms.normalise(n));
	const now = n[0]?.fetchedAt ?? 0;
	run(store, "nhc-storms", now);
	const view = hazardsView(store, now);
	expect(view.gdacs.events.map((e) => e.eventType)).toEqual(["DR", "EQ", "EQ"]);
	expect(view.gdacs.counts).toEqual({ red: 0, orange: 0, green: 3 });
	expect(view.gdacs.events[0]?.stateName).toBe("Apure");
	expect(view.storms.active.map((s) => s.name)).toEqual(["Fay"]);
	expect(view.storms.threats).toBe(0);
	expect(view.storms.statusEs).toContain("ninguno cumple la regla");
	expect(view.storms.checkedAt).toBe(now);
});

test.skipIf(!gdacsRecorded)("red before green; events that ended over 30 days ago drop out", () => {
	const year = loadFixture(join(adapters, "gdacs-events", "fixtures", "1y-all"));
	const store = new Store(":memory:");
	store.insert(gdacsEvents.normalise(year));
	// Seen from 2026-07-01: the doublet (red, June 24) is inside the window and first.
	const july = hazardsView(store, Date.UTC(2026, 6, 1));
	expect(july.gdacs.events[0]?.alertLevel).toBe("red");
	expect(july.gdacs.counts.red).toBe(2);
	expect(
		july.gdacs.events.every((e) => e.toAt >= Date.UTC(2026, 5, 1) && e.fromAt <= Date.UTC(2026, 6, 1)),
	).toBe(true);
	// Seen from 2026-09-24 the doublet is past the window.
	expect(hazardsView(store, Date.UTC(2026, 8, 24, 23)).gdacs.counts.red).toBe(0);
});

test("storms: advisories older than 9 h are no longer active; honest status when never checked", () => {
	const n = loadFixture(join(adapters, "nhc-storms", "fixtures", "2026-09-24"));
	const store = new Store(":memory:");
	store.insert(nhcStorms.normalise(n));
	const advisory = Date.UTC(2026, 8, 24, 21);
	expect(hazardsView(store, advisory + 8 * HOUR).storms.active.length).toBe(1);
	expect(hazardsView(store, advisory + 10 * HOUR).storms.active.length).toBe(0);
	const empty = new Store(":memory:");
	expect(hazardsView(empty, advisory).storms.statusEs).toBe("Todavía no se ha consultado el NHC.");
	run(empty, "nhc-storms", advisory);
	expect(hazardsView(empty, advisory).storms.statusEs).toBe(
		"Sin ciclones tropicales activos en el Atlántico.",
	);
});

test("a storm that meets the threat rule is counted and sorted first", () => {
	const raw: RawResponse = {
		url: "https://www.nhc.noaa.gov/CurrentStorms.json",
		status: 200,
		contentType: "application/json",
		fetchedAt: Date.UTC(2026, 8, 24, 22),
		body: JSON.stringify({
			activeStorms: [
				{
					id: "al102026",
					name: "Lejos",
					classification: "TS",
					intensity: "40",
					latitudeNumeric: 30,
					longitudeNumeric: -50,
					movementDir: 0,
					movementSpeed: 10,
					lastUpdate: "2026-09-24T21:00:00Z",
				},
				{
					id: "al112026",
					name: "Cerca",
					classification: "HU",
					intensity: "90",
					latitudeNumeric: 12.5,
					longitudeNumeric: -63,
					movementDir: 270,
					movementSpeed: 12,
					lastUpdate: "2026-09-24T21:00:00Z",
				},
			],
		}),
	};
	const store = new Store(":memory:");
	store.insert(nhcStorms.normalise([raw]));
	run(store, "nhc-storms", raw.fetchedAt);
	const view = hazardsView(store, raw.fetchedAt);
	expect(view.storms.active.map((s) => [s.name, s.threat, s.category])).toEqual([
		["Cerca", true, 2],
		["Lejos", false, null],
	]);
	expect(view.storms.threats).toBe(1);
	expect(view.storms.statusEs).toStartWith("1 ciclón cumple la regla");
});

test("synthetic GDACS list: red before green, events that ended over 30 days ago drop out", () => {
	const event = (id: number, alertlevel: string, from: string, to: string) => ({
		type: "Feature",
		geometry: { type: "Point", coordinates: [-68.5, 7.5] },
		properties: {
			eventtype: "EQ",
			eventid: id,
			episodeid: 1,
			name: `Evento de ejemplo ${id}`,
			alertlevel,
			fromdate: from,
			todate: to,
			datemodified: to,
			affectedcountries: [{ iso3: "VEN" }],
			url: { report: `https://www.gdacs.org/report.aspx?eventid=${id}&eventtype=EQ` },
		},
	});
	const store = new Store(":memory:");
	store.insert(
		gdacsEvents.normalise([
			{
				url: "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?country=VEN",
				status: 200,
				contentType: "application/json",
				fetchedAt: Date.UTC(2026, 0, 20),
				body: JSON.stringify({
					type: "FeatureCollection",
					features: [
						event(1, "Green", "2026-01-10T00:00:00", "2026-01-10T00:00:00"),
						event(2, "Red", "2026-01-05T00:00:00", "2026-01-05T00:00:00"),
						event(3, "Orange", "2025-11-01T00:00:00", "2025-11-02T00:00:00"),
					],
				}),
			},
		]),
	);
	const view = hazardsView(store, Date.UTC(2026, 0, 20));
	expect(view.gdacs.events.map((e) => [e.name, e.alertLevel])).toEqual([
		["Evento de ejemplo 2", "red"],
		["Evento de ejemplo 1", "green"],
	]);
	expect(view.gdacs.counts).toEqual({ red: 1, orange: 0, green: 1 });
	expect(view.gdacs.events[0]?.stateName).toBe("Apure");
});
