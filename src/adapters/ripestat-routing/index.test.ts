import { expect, test } from "bun:test";
import { join } from "node:path";
import { hasFixture, loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { parseUtc, ripestatRouting, statsUrl } from "./index.ts";

// RIPEstat's terms forbid redistributing its data, so the recording is absent from the public repository.
const FIXTURE = join(import.meta.dir, "fixtures", "2026-09-24");
const recorded = hasFixture(FIXTURE);
const raws = recorded ? loadFixture(FIXTURE) : [];
const raw: RawResponse = raws[0] ?? {
	url: "https://stat.ripe.net/data/country-resource-stats/data.json?resource=VE&sourceapp=vigia",
	status: 200,
	contentType: "application/json; charset=utf-8",
	body: "",
	fetchedAt: 1_790_293_790_418,
};
const body = (stats: unknown[]) => JSON.stringify({ status: "ok", data: { resource: "VE", stats } });

test.skipIf(!recorded)("expands the recorded merged ranges into one observation per hour", () => {
	const obs = ripestatRouting.normalise(raws);
	expect(obs.length).toBe(191);
	expect(obs[0]?.observedAt).toBe(Date.UTC(2026, 8, 17, 0));
	expect(obs.at(-1)?.observedAt).toBe(Date.UTC(2026, 8, 24, 22));
	expect(obs.at(-1)?.value).toEqual({ v4Prefixes: 2_550, v6Prefixes: 681, asns: 181 });
	for (let i = 1; i < obs.length; i++)
		expect((obs[i]?.observedAt ?? 0) - (obs[i - 1]?.observedAt ?? 0)).toBe(3_600_000);
	for (const o of obs) {
		expect(o.series).toBe("country:VE:routing");
		expect(o.licence).toBe("ripestat-no-redistribution");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
	}
});

test("ranges are inclusive hour starts; -1 is null; fractions kept; bad items skipped", () => {
	const obs = ripestatRouting.normalise([
		{
			...raw,
			body: body([
				{
					timeline: [{ starttime: "2026-09-20T00:00:00", endtime: "2026-09-20T02:00:00" }],
					v4_prefixes_ris: 2545.5,
					v6_prefixes_ris: -1,
					asns_ris: 180,
				},
				{ timeline: [], v4_prefixes_ris: 1, v6_prefixes_ris: 1, asns_ris: 1 },
				{ v4_prefixes_ris: "x" },
			]),
		},
	]);
	expect(obs.map((o) => new Date(o.observedAt).toISOString().slice(11, 13))).toEqual(["00", "01", "02"]);
	expect(obs[0]?.value).toEqual({ v4Prefixes: 2545.5, v6Prefixes: null, asns: 180 });
	expect(() => ripestatRouting.normalise([{ ...raw, body: '{"status":"error"}' }])).toThrow("RIPEstat");
	expect(() => ripestatRouting.normalise([{ ...raw, body: "<html>" }])).toThrow("RIPEstat");
});

test("times without a zone are UTC; the query names the app and asks hourly bins", () => {
	expect(parseUtc("2026-09-24T21:00:00")).toBe(Date.UTC(2026, 8, 24, 21));
	expect(parseUtc("2026-09-24T21:00:00Z")).toBe(Date.UTC(2026, 8, 24, 21));
	const url = new URL(statsUrl(Date.UTC(2026, 8, 24, 23, 11)));
	expect(url.searchParams.get("sourceapp")).toBe("vigia");
	expect(url.searchParams.get("resolution")).toBe("1h");
	expect(url.searchParams.get("starttime")).toBe("2026-09-16T23:11");
});
