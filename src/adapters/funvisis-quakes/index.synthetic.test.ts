import { expect, test } from "bun:test";
import type { RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { FUNVISIS_HOME, FUNVISIS_URL, funvisisQuakes } from "./index.ts";

/**
 * Synthetic events in the shape of FUNVISIS's `maravilla.json` (invented quakes, real field quirks: `phone` is
 * the magnitude, `postalCode` the date, `city` the HLV time, `state` the depth). The recorded files stay out of
 * the public repository; these run everywhere.
 */

// 2026-01-15 14:00 UTC = 10:00 HLV.
const FETCHED = Date.UTC(2026, 0, 15, 14, 0);

type Quake = {
	lat: string;
	lon: string;
	mag: string;
	date: string;
	time: string;
	depth: string;
	address: string;
};
function feature(q: Quake, geometry?: [number, number]): Record<string, unknown> {
	return {
		type: "Feature",
		geometry: { type: "Point", coordinates: geometry ?? [Number(q.lon), Number(q.lat)], marcador: "marker" },
		properties: {
			phoneFormatted: q.depth,
			phone: q.mag,
			address: q.address,
			city: q.time,
			country: "Venezuela",
			postalCode: q.date,
			state: q.depth,
			lat: q.lat,
			long: q.lon,
		},
	};
}
const merida: Quake = {
	lat: "8.60",
	lon: "-71.15",
	mag: "2.8",
	date: "15-01-2026",
	time: "09:12",
	depth: "  7.5 km",
	address: "12. km al  sur de Pueblo Ejemplo",
};
const colombia: Quake = {
	...merida,
	lat: "6.26",
	lon: "-73.58",
	mag: "4.0",
	time: "03:40",
	depth: "124.7 km",
};
const late: Quake = { ...merida, date: "14-01-2026", time: "23:05" };

function raw(features: unknown[]): RawResponse {
	return {
		url: FUNVISIS_URL,
		status: 200,
		contentType: "text/plain; charset=UTF-8",
		body: JSON.stringify({ type: "FeatureCollection", features }),
		fetchedAt: FETCHED,
	};
}

test("synthetic file: HLV converted to UTC, address cleaned, epicentre placed by polygon", () => {
	const obs = funvisisQuakes.normalise([raw([feature(merida), feature(colombia), feature(late)])]);
	expect(obs.length).toBe(3);
	const [a, b, c] = obs;
	expect(a).toMatchObject({
		source: "funvisis-quakes",
		series: "funvisis:20260115T1312Z:8.60:-71.15:M2.8",
		sourceUrl: FUNVISIS_HOME,
		fetchedAt: FETCHED,
		observedAt: Date.UTC(2026, 0, 15, 13, 12),
		licence: "funvisis-attribution",
		basis: "official",
		confidence: 0.85,
	});
	expect(a?.value).toMatchObject({
		mag: 2.8,
		depthKm: 7.5,
		addressEs: "12 km al sur de Pueblo Ejemplo",
		localTime: "15-01-2026 09:12 HLV",
		timePrecisionS: 60,
		inVenezuela: true,
		country: null,
	});
	expect(a?.location?.state).toBe("VE-L"); // Mérida
	// The feed says "Venezuela" for every event; the polygon says otherwise.
	expect(b?.value.inVenezuela).toBe(false);
	expect(b?.value.country).toBe("Colombia");
	expect(b?.location?.state).toBeUndefined();
	// 23:05 HLV on the 14th is 03:05 UTC on the 15th.
	expect(c?.observedAt).toBe(Date.UTC(2026, 0, 15, 3, 5));
});

test("the field-shift guard, future stamps and malformed items skip only that event", () => {
	const shifted = feature(merida, [-66, 10]);
	const future = feature({ ...merida, date: "16-01-2026" });
	const bad = feature({ ...merida, mag: "tres" });
	const good = [feature(merida), feature(colombia), feature(late), feature(merida)];
	expect(funvisisQuakes.normalise([raw([...good, shifted, future, bad])]).length).toBe(4);
});

test("a template change that breaks most items fails loudly; broken envelopes throw SchemaError", () => {
	const shifted = [merida, colombia, late].map((q) => feature({ ...q, mag: q.time }));
	expect(() => funvisisQuakes.normalise([raw(shifted)])).toThrow("template");
	expect(() => funvisisQuakes.normalise([{ ...raw([]), body: "<html>Error</html>" }])).toThrow(SchemaError);
	expect(() => funvisisQuakes.normalise([{ ...raw([]), body: '{"type":"Feature"}' }])).toThrow(SchemaError);
	expect(() => funvisisQuakes.normalise([])).toThrow(SchemaError);
	expect(funvisisQuakes.normalise([raw([])])).toEqual([]);
});
