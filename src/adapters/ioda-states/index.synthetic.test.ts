import { expect, test } from "bun:test";
import type { RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { stateByIso } from "../../geo/index.ts";
import { iodaStates } from "./index.ts";
import { BIN_S } from "./ioda.ts";

/**
 * Synthetic IODA signals responses (invented values). IODA's recorded responses are not redistributable and stay
 * out of the public repository; these run everywhere.
 */

const FROM = Date.UTC(2026, 0, 15, 10) / 1_000;
const FETCHED = Date.UTC(2026, 0, 15, 11);

function series(entityType: string, entityCode: string, datasource: string, values: unknown[]) {
	return {
		entityType,
		entityCode,
		datasource,
		from: FROM,
		until: FROM + 6 * BIN_S,
		step: BIN_S,
		nativeStep: BIN_S,
		values,
	};
}
function raw(items: unknown[]): RawResponse {
	return {
		url: "https://api.ioda.inetintel.cc.gatech.edu/v2/signals/raw/region/4488,4499?datasource=ping-slash24",
		status: 200,
		contentType: "application/json",
		body: JSON.stringify({ type: "signals", error: null, data: [items] }),
		fetchedAt: FETCHED,
	};
}

test("region and country series become 10-minute measurements, each state placed at its label", () => {
	const obs = iodaStates.normalise([
		raw([
			series("region", "4488", "ping-slash24", [100, 101, null]),
			series("region", "4499", "bgp", [2_000]),
			series("country", "VE", "merit-nt", [5_000, 5_100]),
		]),
	]);
	expect(obs.map((o) => [o.series, o.value.value])).toEqual([
		["state:VE-V:ping-slash24", 100],
		["state:VE-V:ping-slash24", 101],
		["state:VE-A:bgp", 2_000],
		["country:VE:merit-nt", 5_000],
		["country:VE:merit-nt", 5_100],
	]);
	const zulia = stateByIso("VE-V");
	if (!zulia) throw new Error("Zulia missing from src/geo");
	expect(obs[0]).toEqual({
		source: "ioda-states",
		series: "state:VE-V:ping-slash24",
		sourceUrl: "https://ioda.inetintel.cc.gatech.edu/region/4488",
		fetchedAt: FETCHED,
		observedAt: FROM * 1_000,
		licence: "ioda-all-rights-reserved",
		value: { signal: "ping-slash24", value: 100 },
		confidence: 1,
		basis: "measurement",
		location: { lat: zulia.label.lat, lon: zulia.label.lon, state: "VE-V", place: "Zulia" },
	});
	expect(obs[1]?.observedAt).toBe((FROM + BIN_S) * 1_000);
	expect(obs.at(-1)?.sourceUrl).toBe("https://ioda.inetintel.cc.gatech.edu/country/VE");
	expect(obs.at(-1)?.location).toBeUndefined();
});

test("bins after the fetch are never stored; a broken envelope throws SchemaError", () => {
	const future = iodaStates.normalise([
		{ ...raw([series("region", "4488", "bgp", [1, 2, 3])]), fetchedAt: (FROM + BIN_S) * 1_000 },
	]);
	expect(future.map((o) => o.value.value)).toEqual([1, 2]);
	expect(() => iodaStates.normalise([{ ...raw([]), body: "<html>" }])).toThrow(SchemaError);
	expect(() =>
		iodaStates.normalise([{ ...raw([]), body: '{"type":"signals","error":null,"data":"x"}' }]),
	).toThrow(SchemaError);
});
