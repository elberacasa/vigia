import { expect, test } from "bun:test";
import { join } from "node:path";
import { hasFixture, loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { eventsUrl, iodaEvents } from "./index.ts";

// Recorded IODA responses are not redistributable, so they are absent from the public repository (see hasFixture).
const FIXTURE = join(import.meta.dir, "fixtures", "2026-09-24");
const recorded = hasFixture(FIXTURE);
const raws = recorded ? loadFixture(FIXTURE) : [];
const first: RawResponse = raws[0] ?? {
	url: "https://api.ioda.inetintel.cc.gatech.edu/v2/outages/events?entityType=country&entityCode=VE&format=codf",
	status: 200,
	contentType: "application/json",
	body: "",
	fetchedAt: 1_790_292_727_429,
};

test.skipIf(!recorded)("normalises the recorded events for the country, the states and the ISPs", () => {
	const obs = iodaEvents.normalise(raws);
	expect(obs.length).toBe(113);
	const kinds = new Set(obs.map((o) => o.value.entityType));
	expect([...kinds].sort()).toEqual(["asn", "country", "region"]);
	const country = obs[0];
	expect(country?.series).toBe("event:country/VE:bgp:1789704900");
	expect(country?.observedAt).toBe(1_789_704_900_000);
	expect(country?.value).toEqual({
		entityType: "country",
		entityCode: "VE",
		entityName: "Venezuela",
		key: "VE",
		datasource: "bgp",
		startS: 1_789_704_900,
		durationS: 6_600,
		score: 676.9762147735302,
		method: "median",
	});
	expect(country?.basis).toBe("quote");
	const guarico = obs.find((o) => o.series === "event:region/4501:ping-slash24:1790256000");
	expect(guarico?.value.entityName).toBe("Guárico");
	expect(guarico?.value.key).toBe("VE-J");
	expect(guarico?.location?.state).toBe("VE-J");
	const cantv = obs.find((o) => o.value.entityCode === "8048");
	expect(cantv?.value.entityName).toBe("CANTV (AS8048)");
	expect(cantv?.value.key).toBe("cantv");
	for (const o of obs) {
		expect(o.source).toBe("ioda-events");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(o.sourceUrl).toStartWith("https://ioda.inetintel.cc.gatech.edu/");
	}
});

test("skips a malformed event and unknown places; throws on a broken envelope or an API error", () => {
	const body = JSON.stringify({
		type: "outages.events",
		error: null,
		data: [
			{ location: "region/4501", start: "x" },
			{ location: "region/4881", start: 1, duration: 60, method: "median", datasource: "bgp", score: 1 },
			{ location: "asn/174", start: 1, duration: 60, method: "median", datasource: "bgp", score: 1 },
			{ location: "region/4501", start: 1, duration: 60, method: "median", datasource: "bgp", score: 1 },
		],
	});
	const obs = iodaEvents.normalise([{ ...first, body }]);
	expect(obs.map((o) => o.value.key)).toEqual(["VE-J"]);
	expect(() => iodaEvents.normalise([{ ...first, body: '{"type":"signals"}' }])).toThrow("IODA events");
	expect(() =>
		iodaEvents.normalise([
			{ ...first, body: JSON.stringify({ type: "outages.events", error: "boom", data: null }) },
		]),
	).toThrow("boom");
});

test("asks for the last 7 days in IODA's codf format", () => {
	const url = new URL(eventsUrl("region", ["4482", "4483"], Date.UTC(2026, 8, 24)));
	expect(url.searchParams.get("entityCode")).toBe("4482,4483");
	expect(url.searchParams.get("format")).toBe("codf");
	expect(Number(url.searchParams.get("until")) - Number(url.searchParams.get("from"))).toBe(7 * 86_400);
});
