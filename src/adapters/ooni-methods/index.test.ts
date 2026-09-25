import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { BACKFILL_DAYS, type DaySummary, type DomainDay, daysToFetch, dayUrl, ooniMethods } from "./index.ts";

// Recorded 2026-09-25 01:58 UTC: four days (24, 23, 22, 21 Sept), trimmed to 85 domains each (see `_trimmed`).
const raws = loadFixture(join(import.meta.dir, "fixtures", "2026-09-24"));
const raw = raws[0] as RawResponse;
const DAY = 86_400_000;
const body = (results: unknown[]) => JSON.stringify({ dimension_count: 2, results });
const row = (domain: string, asn: number, count: number, dns: number, tls = 0, outcome = "dns.nxdomain") => ({
	count,
	domain,
	probe_asn: asn,
	probe_cc: "VE",
	loni: {
		dns_blocked: dns,
		tcp_blocked: 0,
		tls_blocked: tls,
		blocked_max: Math.max(dns, tls),
		blocked_max_outcome: Math.max(dns, tls) > 0 ? outcome : "none",
	},
});

test("normalises four recorded days into domain-days and day summaries", () => {
	const obs = ooniMethods.normalise(raws);
	const days = obs.filter((o) => o.series === "day").map((o) => o.value as DaySummary);
	expect(days.map((d) => [d.day, d.domainsMeasured, d.domainsLikely, d.final])).toEqual([
		["2026-09-24", 85, 54, false],
		["2026-09-23", 85, 54, false],
		["2026-09-22", 85, 56, true],
		["2026-09-21", 85, 57, true],
	]);
	expect(obs.filter((o) => o.series === "day-final").length).toBe(2);
	expect(obs.length).toBe(227);
	for (const o of obs) {
		expect(o.source).toBe("ooni-methods");
		expect(o.licence).toBe("cc-by-nc-sa-4.0-ooni");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(new Date(o.observedAt).toISOString().slice(11)).toBe("00:00:00.000Z");
	}
});

test("infobae.com on 24 Sept: DNS NXDOMAIN on CANTV, not on Inter; www. folded in", () => {
	const obs = ooniMethods.normalise(raws);
	const d = obs.find((o) => o.series === "domain:infobae.com" && o.observedAt === Date.UTC(2026, 8, 24))
		?.value as DomainDay;
	const cantv = d.cells.find((c) => c.isp === "cantv");
	const inter = d.cells.find((c) => c.isp === "inter");
	expect(cantv).toEqual({ isp: "cantv", n: 102, dns: 0.882, tcp: 0, tls: 0, outcome: "dns.nxdomain" });
	expect(inter?.dns).toBeLessThan(0.5);
	expect(d.cells.map((c) => c.isp)).toEqual([
		"cantv",
		"movistar",
		"digitel",
		"inter",
		"airtek",
		"netuno",
		"thundernet",
	]);
});

test("adds Digitel's two ASNs, weights by count, ignores foreign ASNs, empty domains and bad rows", () => {
	const obs = ooniMethods.normalise([
		{
			...raw,
			body: body([
				row("www.example.org", 264731, 3, 0.9),
				row("example.org", 27717, 1, 0.1),
				row("example.org", 174, 50, 0.9),
				row("", 8048, 5, 0.9),
				{ count: "x", domain: "example.org", probe_asn: 8048 },
				row("clean.org", 8048, 20, 0),
			]),
		},
	]);
	const d = obs.find((o) => o.series === "domain:example.org")?.value as DomainDay;
	expect(d.cells).toEqual([{ isp: "digitel", n: 4, dns: 0.7, tcp: 0, tls: 0, outcome: "dns.nxdomain" }]);
	expect(obs.some((o) => o.series === "domain:clean.org")).toBe(false);
	const day = obs.find((o) => o.series === "day")?.value as DaySummary;
	expect(day).toMatchObject({ domainsMeasured: 2, domainsLikely: 1, measurements: 24 });
});

test("the most frequent likely outcome wins, ties broken by name; none below 0.5", () => {
	const obs = ooniMethods.normalise([
		{
			...raw,
			body: body([
				row("x.org", 8048, 2, 0, 0.8, "tls.connection_reset"),
				row("x.org", 8048, 2, 0.9, 0, "dns.nxdomain"),
				row("x.org", 8048, 2, 0.7, 0, "dns.dns_no_answer"),
				row("x.org", 8048, 1, 0.4, 0, "dns.generic_timeout_error"),
			]),
		},
	]);
	const d = obs.find((o) => o.series === "domain:x.org")?.value as DomainDay;
	// Three outcomes tie at 2 measurements: the alphabetical first wins; the 0.4 row's outcome never counts.
	expect(d.cells[0]?.outcome).toBe("dns.dns_no_answer");
	expect(d.cells[0]).toMatchObject({ n: 7, dns: 0.514, tls: 0.229 });
});

test("a malformed envelope or non-JSON fails the run; no responses fails too", () => {
	expect(() => ooniMethods.normalise([{ ...raw, body: "<html>" }])).toThrow("JSON");
	expect(() => ooniMethods.normalise([{ ...raw, body: '{"error":"x"}' }])).toThrow("OONI");
	expect(() => ooniMethods.normalise([{ ...raw, url: "https://api.ooni.io/x" }])).toThrow("día");
	expect(() => ooniMethods.normalise([])).toThrow("sin respuestas");
});

test("fetch plan: yesterday always, older days until final, at most four requests", () => {
	const now = Date.UTC(2026, 8, 25, 2);
	expect(daysToFetch(now, () => false)).toEqual(["2026-09-24", "2026-09-23", "2026-09-22", "2026-09-21"]);
	expect(daysToFetch(now, () => true)).toEqual(["2026-09-24"]);
	const finalBefore = Date.UTC(2026, 8, 22);
	expect(daysToFetch(now, (t) => t <= finalBefore)).toEqual(["2026-09-24", "2026-09-23"]);
	const oldest = Date.UTC(2026, 8, 25) - BACKFILL_DAYS * DAY;
	expect(daysToFetch(now, (t) => t !== oldest)).toEqual(["2026-09-24", "2026-09-11"]);
	const url = new URL(dayUrl("2026-09-24"));
	expect(url.host).toBe("api.ooni.io");
	expect(url.searchParams.get("until")).toBe("2026-09-25");
	expect(url.searchParams.get("axis_y")).toBe("probe_asn");
});
