import { expect, test } from "bun:test";
import type { RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { ripestatRouting, statsUrl } from "./index.ts";

/**
 * Synthetic payloads in the shape of RIPEstat's country-resource-stats response (invented counts). The recorded
 * response stays out of the public repository (RIPEstat's terms forbid redistribution); these run everywhere.
 */

const FETCHED = Date.UTC(2026, 0, 15, 12, 30);

function raw(stats: unknown[], fetchedAt = FETCHED): RawResponse {
	return {
		url: statsUrl(fetchedAt),
		status: 200,
		contentType: "application/json; charset=utf-8",
		body: JSON.stringify({ status: "ok", data: { resource: "VE", stats } }),
		fetchedAt,
	};
}
const stat = (start: string, end: string, v4: number, v6: number, asns: number) => ({
	timeline: [{ starttime: start, endtime: end }],
	v4_prefixes_ris: v4,
	v6_prefixes_ris: v6,
	asns_ris: asns,
});

test("merged ranges expand to one hourly observation each, sorted, ending at the fetch", () => {
	const obs = ripestatRouting.normalise([
		raw([
			stat("2026-01-15T09:00:00", "2026-01-15T10:00:00", 1_000, 200, 50),
			stat("2026-01-15T11:00:00", "2026-01-15T14:00:00", 1_010, 201, 51),
		]),
	]);
	// 09, 10, 11, 12: 13:00 and 14:00 are after the fetch and dropped.
	expect(obs.map((o) => new Date(o.observedAt).toISOString().slice(11, 13))).toEqual([
		"09",
		"10",
		"11",
		"12",
	]);
	expect(obs[0]).toMatchObject({
		source: "ripestat-routing",
		series: "country:VE:routing",
		sourceUrl: "https://stat.ripe.net/app/launchpad/VE",
		fetchedAt: FETCHED,
		licence: "ripestat-no-redistribution",
		basis: "measurement",
		confidence: 1,
		value: { v4Prefixes: 1_000, v6Prefixes: 200, asns: 50 },
	});
	expect(obs.at(-1)?.value).toEqual({ v4Prefixes: 1_010, v6Prefixes: 201, asns: 51 });
});

test("-1 is null, fractions are kept, malformed items and impossible ranges are skipped", () => {
	const obs = ripestatRouting.normalise([
		raw([
			stat("2026-01-15T02:00:00", "2026-01-15T02:00:00", 99.5, -1, 7),
			stat("2026-01-15T05:00:00", "2026-01-15T04:00:00", 1, 1, 1),
			stat("2025-01-01T00:00:00", "2026-01-15T00:00:00", 1, 1, 1),
			{ timeline: [], v4_prefixes_ris: 1, v6_prefixes_ris: 1, asns_ris: 1 },
			{ v4_prefixes_ris: "x" },
		]),
	]);
	expect(obs.length).toBe(1);
	expect(obs[0]?.value).toEqual({ v4Prefixes: 99.5, v6Prefixes: null, asns: 7 });
});

test("an error status, non-JSON or no response throws SchemaError", () => {
	expect(() => ripestatRouting.normalise([{ ...raw([]), body: '{"status":"error"}' }])).toThrow(SchemaError);
	expect(() => ripestatRouting.normalise([{ ...raw([]), body: "<html>" }])).toThrow(SchemaError);
	expect(() => ripestatRouting.normalise([])).toThrow(SchemaError);
});
