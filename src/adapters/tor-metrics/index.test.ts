import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { bridgeUrl, parseCsv, relayUrl, type TorDay, torMetrics } from "./index.ts";

// Recorded 2026-09-25 01:56 UTC: 118 days of relay users (with Tor Metrics' expected range) and bridge users.
const raws = loadFixture(join(import.meta.dir, "fixtures", "2026-09-24"));
const [relay, bridge] = raws as [RawResponse, RawResponse];
const at = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

test("normalises both recorded CSVs into daily observations", () => {
	const obs = torMetrics.normalise(raws);
	const relayObs = obs.filter((o) => o.series === "country:VE:tor-relay");
	const bridgeObs = obs.filter((o) => o.series === "country:VE:tor-bridge");
	expect(relayObs.length).toBe(118);
	expect(bridgeObs.length).toBe(118);
	expect(relayObs.at(-1)?.observedAt).toBe(at("2026-09-22"));
	expect(relayObs.at(-1)?.value).toEqual({ kind: "relay", users: 9705, lower: 5871, upper: 14392, frac: 53 });
	expect(bridgeObs.at(-1)?.value).toEqual({ kind: "bridge", users: 71, lower: null, upper: null, frac: 85 });
	for (const o of obs) {
		expect(o.source).toBe("tor-metrics");
		expect(o.licence).toBe("cc0-tor-metrics");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(new URL(o.sourceUrl).host).toBe("metrics.torproject.org");
	}
});

test("keeps the real late-June 2026 spike above Tor Metrics' own range", () => {
	const obs = torMetrics.normalise(raws);
	const d = obs.find((o) => o.series === "country:VE:tor-relay" && o.observedAt === at("2026-06-26"))
		?.value as TorDay;
	expect(d.users).toBe(28_311);
	expect(d.upper).toBe(13_280);
	expect(d.users > (d.upper ?? Number.POSITIVE_INFINITY)).toBe(true);
});

test("empty or inverted ranges become null; bad rows and other countries are skipped", () => {
	const body = [
		"#",
		"# The Tor Project",
		"date,country,users,lower,upper,frac",
		"2026-09-20,ve,100,,,40",
		"2026-09-21,ve,110,200,100,40",
		"2026-09-22,ve,x,1,2,40",
		"2026-09-22,co,500,1,2,40",
		"not-a-date,ve,5,1,2,40",
		"2026-09-23,ve,120,90,150,",
	].join("\n");
	const obs = torMetrics.normalise([
		{ ...relay, body },
		{ ...bridge, body: "date,country,users,frac\n2026-09-23,ve,70,80\n" },
	]);
	expect(obs.map((o) => [new Date(o.observedAt).toISOString().slice(0, 10), o.value])).toEqual([
		["2026-09-20", { kind: "relay", users: 100, lower: null, upper: null, frac: 40 }],
		["2026-09-21", { kind: "relay", users: 110, lower: null, upper: null, frac: 40 }],
		["2026-09-23", { kind: "relay", users: 120, lower: 90, upper: 150, frac: null }],
		["2026-09-23", { kind: "bridge", users: 70, lower: null, upper: null, frac: 80 }],
	]);
});

test("a day after the fetch time is dropped (clock skew)", () => {
	const body = "date,country,users,lower,upper,frac\n2099-01-01,ve,1,1,1,1\n2026-09-20,ve,1,1,1,1\n";
	const obs = torMetrics.normalise([{ ...relay, body }, bridge]);
	expect(obs.filter((o) => o.value.kind === "relay").length).toBe(1);
});

test("an HTML page, a missing header or no Venezuelan rows fail the run loudly", () => {
	expect(() =>
		torMetrics.normalise([{ ...relay, contentType: "text/html", body: "<html>" }, bridge]),
	).toThrow("HTML");
	expect(() => parseCsv("a,b\n1,2", "x")).toThrow("cabecera");
	expect(() =>
		torMetrics.normalise([
			{ ...relay, body: "date,country,users,lower,upper,frac\n" },
			{ ...bridge, body: "date,country,users,frac\n" },
		]),
	).toThrow("ninguna fila");
	expect(() => torMetrics.normalise([relay])).toThrow("bridge");
});

test("URLs ask Venezuela, 120 days, and the relay series with Tor's event bounds", () => {
	const now = Date.UTC(2026, 8, 24, 12);
	const r = new URL(relayUrl(now));
	expect(r.searchParams.get("country")).toBe("ve");
	expect(r.searchParams.get("events")).toBe("on");
	expect(r.searchParams.get("start")).toBe("2026-05-27");
	expect(r.searchParams.get("end")).toBe("2026-09-24");
	expect(new URL(bridgeUrl(now)).pathname).toBe("/userstats-bridge-country.csv");
});
