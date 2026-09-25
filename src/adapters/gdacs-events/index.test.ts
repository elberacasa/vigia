import { expect, test } from "bun:test";
import { join } from "node:path";
import { hasFixture, loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { gdacsEvents, gdacsTime, searchUrl } from "./index.ts";

// GDACS publishes no explicit licence, so its recorded responses are absent from the public repository (see
// hasFixture); index.synthetic.test.ts covers the adapter there.
const LIVE = join(import.meta.dir, "fixtures", "2026-09-24");
const YEAR = join(import.meta.dir, "fixtures", "1y-all");
const recorded = hasFixture(LIVE) && hasFixture(YEAR);
const live = recorded ? loadFixture(LIVE) : [];
/** A year of all alert levels (research, 2026-09-24): includes Slovenia and a European drought. */
const year = recorded ? loadFixture(YEAR) : [];
const base: RawResponse = live[0] ?? {
	url: "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?country=VEN",
	status: 200,
	contentType: "application/json; charset=utf-8",
	body: "",
	fetchedAt: 1_790_293_727_734,
};
const withBody = (body: string, status = 200): RawResponse => ({ ...base, body, status });

test.skipIf(!recorded)("live 30-day window: the ongoing drought and two quakes, UTC times", () => {
	const obs = gdacsEvents.normalise(live);
	expect(obs.map((o) => o.series)).toEqual(["gdacs:DR:1023877", "gdacs:EQ:1566450", "gdacs:EQ:1564232"]);
	const drought = obs[0];
	expect(drought?.value).toMatchObject({
		alertLevel: "green",
		typeEs: "Sequía",
		upstream: "GDO",
		inVenezuela: true,
	});
	expect(drought?.value.fromAt).toBe(Date.UTC(2026, 1, 21));
	expect(drought?.location?.state).toBe("VE-C"); // centroid in Apure
	const quake = obs[1];
	expect(quake?.value.fromAt).toBe(Date.UTC(2026, 8, 16, 1, 37, 17)); // same as USGS us7000thrm, to the second
	expect(quake?.observedAt).toBe(Date.UTC(2026, 8, 16, 2, 23, 23)); // datemodified
	expect(quake?.value.severityText).toBe("Magnitude 4.5M, Depth:10km");
	for (const o of obs) {
		expect(o.source).toBe("gdacs-events");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(o.sourceUrl).toStartWith("https://www.gdacs.org/report.aspx?");
		expect(o.basis).toBe("quote");
	}
});

test.skipIf(!recorded)("the substring bug: Slovenia and Europe are dropped, Venezuela's events kept", () => {
	const obs = gdacsEvents.normalise(year);
	const body = JSON.parse(year[0]?.body ?? "{}");
	expect(body.features.length).toBe(95);
	expect(obs.every((o) => o.value.countries.includes("VEN"))).toBe(true);
	expect(obs.some((o) => o.value.name.includes("Slovenia"))).toBe(false);
	expect(obs.length).toBe(89);
	const red = obs.filter((o) => o.value.alertLevel === "red").map((o) => o.value.eventId);
	expect(red.sort()).toEqual([1548377, 1548473]); // the 2026-06-24 doublet
});

test("204 with an empty body means no events", () => {
	expect(gdacsEvents.normalise([withBody("", 204)])).toEqual([]);
});

test.skipIf(!recorded)("one malformed event is skipped; a wrong envelope throws", () => {
	const body = JSON.parse(live[0]?.body ?? "{}");
	body.features[1].properties.alertlevel = "Purple";
	expect(gdacsEvents.normalise([withBody(JSON.stringify(body))]).length).toBe(2);
	expect(() => gdacsEvents.normalise([withBody('{"type":"Feature"}')])).toThrow("GDACS");
	expect(() => gdacsEvents.normalise([withBody("<html>")])).toThrow("not JSON");
});

test("time parsing and query", () => {
	expect(gdacsTime("2026-09-16T02:23:23")).toBe(Date.UTC(2026, 8, 16, 2, 23, 23));
	expect(gdacsTime("2026-09-16T02:23:23Z")).toBeNull();
	const url = searchUrl(Date.UTC(2026, 8, 24, 23));
	expect(url).toContain("alertlevel=green;orange;red");
	expect(url).toContain("eventlist=EQ;TC;FL;VO;DR;WF");
	expect(url).toContain("fromdate=2026-08-25&todate=2026-09-25");
});
