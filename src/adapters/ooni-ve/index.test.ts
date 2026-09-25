import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { categoryEs, domainKey } from "./categories.ts";
import {
	aggregationUrl,
	type OoniDomain,
	type OoniIsp,
	type OoniSummary,
	ooniVe,
	windowOf,
} from "./index.ts";

// Recorded 2026-09-24 23:43 UTC. The domain × ASN file was trimmed to the 235 flagged domains plus 150 others
// (see its `_trimmed` field), so per-ISP totals below cover those domains only.
const raws = loadFixture(join(import.meta.dir, "fixtures", "2026-09-24"));
const [cat, asn, latest] = raws as [RawResponse, RawResponse, RawResponse];

function agg(rows: Record<string, unknown>[]): string {
	return JSON.stringify({ v: 0, dimension_count: 2, result: rows });
}
const row = (domain: string, asnNumber: number, m: number, a: number) => ({
	anomaly_count: a,
	confirmed_count: 0,
	failure_count: 0,
	ok_count: m - a,
	measurement_count: m,
	domain,
	probe_asn: asnNumber,
});

test("normalises the recorded aggregations into flagged domains, ISP totals and a summary", () => {
	const obs = ooniVe.normalise(raws);
	expect(obs.length).toBe(245);
	const domains = obs.filter((o) => o.value.kind === "domain");
	expect(domains.length).toBe(235);
	const dt = obs.find((o) => o.series === "domain:dolartoday.com")?.value as OoniDomain;
	expect(dt.category).toBe("NEWS");
	expect(dt.measurements).toBe(1_902);
	expect(dt.anomalyRate).toBe(0.844);
	expect(dt.isps.find((c) => c.isp === "cantv")).toEqual({
		isp: "cantv",
		measurements: 825,
		anomalies: 823,
		anomalyRate: 0.998,
		flagged: true,
	});
	// Airtek served dolartoday.com in 73 % of its 109 measurements: not flagged there.
	expect(dt.isps.find((c) => c.isp === "airtek")?.flagged).toBe(false);
	// Not in Citizen Lab's lists, so absent from the category aggregation: totals from the ASN rows.
	const unlisted = obs.find((o) => o.series === "domain:demacedoniaconamor.com")?.value as OoniDomain;
	expect(unlisted).toMatchObject({ category: "", measurements: 250, anomalies: 39 });
	const cantv = obs.find((o) => o.series === "isp:cantv")?.value as OoniIsp;
	expect(cantv.domainsFlagged).toBe(158);
	const summary = obs.find((o) => o.series === "country:VE:summary");
	expect(summary?.value).toMatchObject({
		kind: "summary",
		measurements: 430_407,
		anomalies: 54_788,
		confirmed: 0,
		domainsTested: 2_202,
		domainsFlagged: 235,
		newestMeasurementAt: Date.UTC(2026, 8, 24, 23, 43, 21),
		since: "2026-09-17",
		until: "2026-09-25",
	});
	expect(summary?.observedAt).toBe(Date.UTC(2026, 8, 24, 23, 43, 21));
	for (const o of obs) {
		expect(o.source).toBe("ooni-ve");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(o.sourceUrl).toStartWith("https://explorer.ooni.org/");
		expect(o.licence).toBe("cc-by-nc-sa-4.0-ooni");
	}
});

test("flag rule: ≥ 10 measurements and ≥ 50 % anomalies on one ISP; Digitel's ASNs are added", () => {
	const catBody = agg([{ ...row("a.org", 0, 30, 20), category_code: "NEWS" }]);
	const asnBody = agg([
		row("a.org", 8048, 9, 9), // too few on CANTV
		row("www.A.org", 264731, 6, 3),
		row("a.org", 27717, 6, 3), // Digitel: 12 measurements, 6 anomalies = 50 %
		row("b.org", 6306, 40, 19), // 47.5 %: not flagged
		row("c.org", 174, 50, 50), // foreign transit ASN: ignored
	]);
	const obs = ooniVe.normalise([
		{ ...cat, body: catBody },
		{ ...asn, body: asnBody },
	]);
	const a = obs.find((o) => o.series === "domain:a.org")?.value as OoniDomain;
	expect(a.isps).toEqual([
		{ isp: "cantv", measurements: 9, anomalies: 9, anomalyRate: 1, flagged: false },
		{ isp: "digitel", measurements: 12, anomalies: 6, anomalyRate: 0.5, flagged: true },
	]);
	expect(obs.some((o) => o.series === "domain:b.org" || o.series === "domain:c.org")).toBe(false);
	const summary = obs.find((o) => o.series === "country:VE:summary")?.value as OoniSummary;
	expect(summary.newestMeasurementAt).toBeNull();
	expect(summary.domainsFlagged).toBe(1);
});

test("skips malformed rows; throws on a malformed aggregation; survives a missing heartbeat", () => {
	const body = JSON.parse(asn.body);
	body.result.unshift({ domain: 5 }, { ...row("x.org", 8048, 5, 9) });
	const obs = ooniVe.normalise([cat, { ...asn, body: JSON.stringify(body) }, latest]);
	expect(obs.length).toBe(245);
	expect(() => ooniVe.normalise([cat, { ...asn, body: '{"error":"x"}' }])).toThrow("OONI");
	expect(() => ooniVe.normalise([cat])).toThrow("OONI");
	expect(ooniVe.normalise([cat, asn, { ...latest, body: '{"results":[]}' }]).length).toBe(245);
	// An empty 7-day answer is an OONI failure, never "every domain unblocked" (review 2, H6).
	const empty = '{"v":0,"dimension_count":2,"result":[]}';
	expect(() => ooniVe.normalise([cat, { ...asn, body: empty }, latest])).toThrow("0 mediciones");
	expect(() => ooniVe.normalise([{ ...cat, body: empty }, asn, latest])).toThrow("0 mediciones");
});

test("window, URLs, categories and domain keys", () => {
	expect(windowOf(Date.UTC(2026, 8, 24, 23))).toEqual({ since: "2026-09-17", until: "2026-09-25" });
	const url = new URL(aggregationUrl(Date.UTC(2026, 8, 24), "probe_asn"));
	expect(url.searchParams.get("axis_x")).toBe("domain");
	expect(url.searchParams.get("axis_y")).toBe("probe_asn");
	expect(url.searchParams.get("test_name")).toBe("web_connectivity");
	expect(categoryEs("NEWS")).toBe("Noticias");
	expect(categoryEs("ZZZ")).toBe("ZZZ");
	expect(domainKey(" WWW.Example.com")).toBe("example.com");
});
