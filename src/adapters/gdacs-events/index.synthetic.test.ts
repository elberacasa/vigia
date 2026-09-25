import { expect, test } from "bun:test";
import type { RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { gdacsEvents, searchUrl } from "./index.ts";

/**
 * Synthetic events in the shape of GDACS's event-list GeoJSON (invented ids, names and figures). The recorded
 * responses stay out of the public repository; these run everywhere.
 */

const FETCHED = Date.UTC(2026, 0, 15, 12, 0);

type Over = Partial<{
	eventtype: string;
	eventid: number;
	name: string;
	alertlevel: string;
	fromdate: string;
	todate: string;
	datemodified: string;
	countries: string[];
	coords: [number, number] | null;
}>;
function feature(o: Over = {}): Record<string, unknown> {
	const id = o.eventid ?? 9_000_001;
	return {
		type: "Feature",
		geometry: o.coords === null ? null : { type: "Point", coordinates: o.coords ?? [-68.5, 7.5] },
		properties: {
			eventtype: o.eventtype ?? "EQ",
			eventid: id,
			episodeid: 1,
			name: o.name ?? "Earthquake in  Example Region",
			alertlevel: o.alertlevel ?? "Green",
			alertscore: 1,
			fromdate: o.fromdate ?? "2026-01-14T08:00:00",
			todate: o.todate ?? "2026-01-14T08:00:00",
			datemodified: o.datemodified ?? "2026-01-14T09:30:00",
			source: "NEIC",
			severitydata: { severity: 4.6, severitytext: " Magnitude 4.6M, Depth:12km ", severityunit: "M" },
			affectedcountries: (o.countries ?? ["VEN"]).map((iso3) => ({ iso3, countryname: iso3 })),
			url: { report: `https://www.gdacs.org/report.aspx?eventid=${id}&eventtype=${o.eventtype ?? "EQ"}` },
		},
	};
}
function raw(features: unknown[], status = 200): RawResponse {
	return {
		url: searchUrl(FETCHED),
		status,
		contentType: "application/json; charset=utf-8",
		body: JSON.stringify({ type: "FeatureCollection", features }),
		fetchedAt: FETCHED,
	};
}

test("synthetic list: one quote per Venezuelan event, UTC times, placed by polygon", () => {
	const obs = gdacsEvents.normalise([raw([feature()])]);
	expect(obs.length).toBe(1);
	expect(obs[0]).toMatchObject({
		source: "gdacs-events",
		series: "gdacs:EQ:9000001",
		sourceUrl: "https://www.gdacs.org/report.aspx?eventid=9000001&eventtype=EQ",
		fetchedAt: FETCHED,
		observedAt: Date.UTC(2026, 0, 14, 9, 30),
		licence: "gdacs-terms",
		basis: "quote",
		confidence: 0.8,
	});
	expect(obs[0]?.value).toMatchObject({
		eventType: "EQ",
		typeEs: "Sismo",
		name: "Earthquake in Example Region",
		alertLevel: "green",
		fromAt: Date.UTC(2026, 0, 14, 8),
		severityText: "Magnitude 4.6M, Depth:12km",
		upstream: "NEIC",
		countries: ["VEN"],
		inVenezuela: true,
	});
	expect(obs[0]?.location?.state).toBe("VE-C"); // Apure
});

test("the substring bug: only events whose affected countries include VEN are kept", () => {
	const obs = gdacsEvents.normalise([
		raw([
			feature({ eventid: 1, name: "Flood in Slovenia", countries: ["SVN"] }),
			feature({ eventid: 2, eventtype: "DR", alertlevel: "Red", countries: ["COL", "VEN"], coords: null }),
		]),
	]);
	expect(obs.map((o) => o.series)).toEqual(["gdacs:DR:2"]);
	expect(obs[0]?.value.alertLevel).toBe("red");
	expect(obs[0]?.value.inVenezuela).toBe(false);
	expect(obs[0]?.location).toBeUndefined();
});

test("a modification stamped after the fetch is capped at the fetch time", () => {
	const obs = gdacsEvents.normalise([raw([feature({ datemodified: "2026-01-15T13:00:00" })])]);
	expect(obs[0]?.observedAt).toBe(FETCHED);
});

test("204 is no events; malformed events are skipped; a wrong envelope or non-JSON throws", () => {
	expect(gdacsEvents.normalise([{ ...raw([]), body: "", status: 204 }])).toEqual([]);
	const bad = [feature({ alertlevel: "Purple" }), feature({ fromdate: "2026-01-14T08:00:00Z" }), feature()];
	expect(gdacsEvents.normalise([raw(bad)]).length).toBe(1);
	expect(() => gdacsEvents.normalise([{ ...raw([]), body: '{"type":"Feature"}' }])).toThrow(SchemaError);
	expect(() => gdacsEvents.normalise([{ ...raw([]), body: "<html>" }])).toThrow("not JSON");
	expect(() => gdacsEvents.normalise([])).toThrow(SchemaError);
});
