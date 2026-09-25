import { expect, test } from "bun:test";
import type { RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { iodaEvents } from "./index.ts";

/**
 * Synthetic IODA outage events (invented starts, durations and scores). IODA's recorded responses are not
 * redistributable and stay out of the public repository; these run everywhere.
 */

const FETCHED = Date.UTC(2026, 0, 15, 12);
const START = Date.UTC(2026, 0, 15, 6) / 1_000;

function raw(data: unknown[]): RawResponse {
	return {
		url: "https://api.ioda.inetintel.cc.gatech.edu/v2/outages/events?entityType=region&format=codf",
		status: 200,
		contentType: "application/json",
		body: JSON.stringify({ type: "outages.events", error: null, data }),
		fetchedAt: FETCHED,
	};
}
const event = (location: string, over: Record<string, unknown> = {}) => ({
	location,
	start: START,
	duration: 3_600,
	method: "median",
	datasource: "ping-slash24",
	score: 123.5,
	...over,
});

test("country, state and ISP events become IODA's labelled quotes, with names from our tables", () => {
	const obs = iodaEvents.normalise([raw([event("country/VE"), event("region/4501"), event("asn/8048")])]);
	expect(obs.map((o) => [o.value.key, o.value.entityName])).toEqual([
		["VE", "Venezuela"],
		["VE-J", "Guárico"],
		["cantv", "CANTV (AS8048)"],
	]);
	const state = obs[1];
	expect(state).toMatchObject({
		source: "ioda-events",
		series: `event:region/4501:ping-slash24:${START}`,
		sourceUrl: `https://ioda.inetintel.cc.gatech.edu/region/4501?from=${START - 3_600}&until=${START + 3_600 + 3_600}`,
		fetchedAt: FETCHED,
		observedAt: START * 1_000,
		licence: "ioda-all-rights-reserved",
		basis: "quote",
		confidence: 0.8,
		value: {
			entityType: "region",
			entityCode: "4501",
			datasource: "ping-slash24",
			startS: START,
			durationS: 3_600,
			score: 123.5,
			method: "median",
		},
	});
	expect(state?.location?.state).toBe("VE-J");
	expect(obs[0]?.location).toBeUndefined();
	expect(obs[2]?.location).toBeUndefined();
});

test("unknown places, malformed and future events are skipped; broken envelopes throw", () => {
	const obs = iodaEvents.normalise([
		raw([
			event("region/4881"),
			event("asn/174"),
			event("country/CO"),
			event("region/4501", { start: "x" }),
			event("region/4501", { start: FETCHED / 1_000 + 60 }),
		]),
	]);
	expect(obs).toEqual([]);
	expect(() => iodaEvents.normalise([{ ...raw([]), body: '{"type":"signals"}' }])).toThrow(SchemaError);
	expect(() =>
		iodaEvents.normalise([
			{ ...raw([]), body: JSON.stringify({ type: "outages.events", error: "boom", data: null }) },
		]),
	).toThrow("boom");
	expect(() => iodaEvents.normalise([])).toThrow(SchemaError);
});
