import { expect, test } from "bun:test";
import type { RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { BIN_S } from "../ioda-states/ioda.ts";
import { iodaAsn } from "./index.ts";

/**
 * Synthetic IODA signals responses for the watched ISPs (invented values). IODA's recorded responses are not
 * redistributable and stay out of the public repository; these run everywhere.
 */

const FROM = Date.UTC(2026, 0, 15, 10) / 1_000;
const FETCHED = Date.UTC(2026, 0, 15, 11);

function raw(items: unknown[]): RawResponse {
	return {
		url: "https://api.ioda.inetintel.cc.gatech.edu/v2/signals/raw/asn/8048?datasource=bgp",
		status: 200,
		contentType: "application/json",
		body: JSON.stringify({ type: "signals", error: null, data: [items] }),
		fetchedAt: FETCHED,
	};
}
const series = (entityCode: string, datasource: string, values: unknown[], nativeStep = BIN_S) => ({
	entityType: "asn",
	entityCode,
	datasource,
	from: FROM,
	until: FROM + 4 * BIN_S,
	step: BIN_S,
	nativeStep,
	values,
});

test("watched ASNs become per-ISP measurements with no location; others are ignored", () => {
	const obs = iodaAsn.normalise([
		raw([
			series("8048", "ping-slash24", [3_000, 2_990]),
			series("174", "bgp", [1, 2]),
			series("27717", "bgp", [40]),
		]),
	]);
	expect(obs.map((o) => [o.series, o.value.value])).toEqual([
		["asn:8048:ping-slash24", 3_000],
		["asn:8048:ping-slash24", 2_990],
		["asn:27717:bgp", 40],
	]);
	expect(obs[0]).toEqual({
		source: "ioda-asn",
		series: "asn:8048:ping-slash24",
		sourceUrl: "https://ioda.inetintel.cc.gatech.edu/asn/8048",
		fetchedAt: FETCHED,
		observedAt: FROM * 1_000,
		licence: "ioda-all-rights-reserved",
		value: { signal: "ping-slash24", value: 3_000 },
		confidence: 1,
		basis: "measurement",
	});
});

test("a re-binned series drops its incomplete last bin; errors throw SchemaError", () => {
	const obs = iodaAsn.normalise([raw([series("8048", "bgp", [10, 11, 12, null], 300)])]);
	expect(obs.map((o) => o.value.value)).toEqual([10, 11]);
	expect(() =>
		iodaAsn.normalise([{ ...raw([]), body: JSON.stringify({ type: "signals", error: "boom", data: null }) }]),
	).toThrow(SchemaError);
	expect(() => iodaAsn.normalise([])).toThrow(SchemaError);
});
