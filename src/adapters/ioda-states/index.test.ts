import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasFixture, loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { states } from "../../geo/index.ts";
import { iodaStates } from "./index.ts";
import { BIN_S, FULL_WINDOW_S, SHORT_WINDOW_S, signalsUrl, WindowPlanner } from "./ioda.ts";
import { IODA_REGIONS, regionById, regionByIso } from "./regions.ts";

// Recorded IODA responses are not redistributable, so they are absent from the public repository (see hasFixture).
const FIXTURE = join(import.meta.dir, "fixtures", "2026-09-24");
const ENTITIES = join(import.meta.dir, "fixtures", "entities-regions.json");
const recorded = hasFixture(FIXTURE);
const raws = recorded ? loadFixture(FIXTURE) : [];
const first: RawResponse = raws[0] ?? {
	url: "https://api.ioda.inetintel.cc.gatech.edu/v2/signals/raw/region/4488",
	status: 200,
	contentType: "application/json",
	body: "",
	fetchedAt: 1_790_292_710_573,
};

function signalsBody(series: Record<string, unknown>[]): string {
	return JSON.stringify({ type: "signals", error: null, data: [series] });
}
function series(over: Record<string, unknown>): Record<string, unknown> {
	return {
		entityType: "region",
		entityCode: "4488",
		entityName: "Zulia",
		datasource: "ping-slash24",
		from: 1_790_200_000 - (1_790_200_000 % BIN_S),
		until: 1_790_203_000,
		step: 600,
		nativeStep: 600,
		values: [10, 11, 12, null, null],
		...over,
	};
}
const raw = (body: string): RawResponse => ({ ...first, body, fetchedAt: 1_790_290_000_000 });

test.skipIf(!recorded)("normalises the recorded 8-day capture: 24 states + country, three signals", () => {
	const obs = iodaStates.normalise(raws);
	expect(obs.length).toBe(84_671);
	const series = new Set(obs.map((o) => o.series));
	// 24 regions with data (IODA publishes nothing for Dependencias Federales), 3 signals, minus Delta Amacuro's
	// telescope gap, plus 3 country series.
	expect(series.size).toBe(75);
	expect(series.has("state:VE-W:bgp")).toBe(false);
	const zulia = obs.filter((o) => o.series === "state:VE-V:ping-slash24");
	expect(zulia.length).toBe(1_151);
	expect(zulia[0]?.observedAt).toBe(Date.UTC(2026, 8, 16, 23, 40));
	expect(zulia[0]?.value).toEqual({ signal: "ping-slash24", value: 870 });
	expect(zulia.at(-1)?.observedAt).toBe(Date.UTC(2026, 8, 24, 23, 20));
	expect(zulia.at(-1)?.value.value).toBe(824);
	expect(zulia[0]?.location).toEqual({ lat: 10.49321, lon: -72.2638, state: "VE-V", place: "Zulia" });
	expect(zulia[0]?.sourceUrl).toBe("https://ioda.inetintel.cc.gatech.edu/region/4488");
	const country = obs.filter((o) => o.series === "country:VE:bgp");
	expect(country.at(-1)?.value.value).toBe(25_482);
	expect(country[0]?.location).toBeUndefined();
	for (const o of obs) {
		expect(o.source).toBe("ioda-states");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(o.observedAt % (BIN_S * 1_000)).toBe(0);
		expect(o.sourceUrl).toStartWith("https://ioda.inetintel.cc.gatech.edu/");
		expect(o.basis).toBe("measurement");
		expect(o.licence).toBe("ioda-all-rights-reserved");
		expect(Number.isFinite(o.value.value)).toBe(true);
	}
});

test.skipIf(!recorded)(
	"trailing nulls are never stored, and the last re-binned bin waits until it is complete",
	() => {
		// Country bgp in the capture ends [..., 25482, 25482, null, null] at 600 s re-binned from 300 s native.
		const body = JSON.parse((raws[1] as RawResponse).body);
		const values = body.data[0][0].values as (number | null)[];
		expect(values.slice(-2)).toEqual([null, null]);
		const nonNull = values.filter((v) => v !== null).length;
		const obs = iodaStates.normalise([raws[1] as RawResponse]);
		expect(obs.length).toBe(nonNull - 1);
		// Natively 10-minute series keep their last bin.
		const native = iodaStates.normalise([raw(signalsBody([series({})]))]);
		expect(native.map((o) => o.value.value)).toEqual([10, 11, 12]);
		const rebinned = iodaStates.normalise([
			raw(signalsBody([series({ datasource: "bgp", nativeStep: 300 })])),
		]);
		expect(rebinned.map((o) => o.value.value)).toEqual([10, 11]);
	},
);

test("interior gaps stay gaps, bad numbers and list-valued bins are skipped", () => {
	const obs = iodaStates.normalise([
		raw(signalsBody([series({ values: [5, null, -1, [{ agg_values: { loss_pct: 3 } }], "7", 8, null] })])),
	]);
	expect(obs.map((o) => o.value.value)).toEqual([5, 8]);
	const [a, b] = obs;
	expect((b?.observedAt ?? 0) - (a?.observedAt ?? 0)).toBe(5 * BIN_S * 1_000);
});

test("list-valued datasources, unknown regions and IODA's invalid-region buckets are ignored", () => {
	const obs = iodaStates.normalise([
		raw(
			signalsBody([
				series({ datasource: "ping-slash24-loss", values: [[{ agg_values: { loss_pct: 50 } }]] }),
				series({ entityCode: "4481" }),
				series({ entityCode: "4881" }),
				series({ entityType: "country", entityCode: "CO" }),
			]),
		),
	]);
	expect(obs).toEqual([]);
});

test("one malformed series is skipped; a malformed envelope, an API error or a wrong step throws", () => {
	const ok = iodaStates.normalise([raw(signalsBody([{ entityCode: 4488 }, series({})]))]);
	expect(ok.length).toBe(3);
	expect(() => iodaStates.normalise([raw('{"type":"signals","data":"x"}')])).toThrow("IODA");
	expect(() => iodaStates.normalise([raw("<html>")])).toThrow("IODA");
	expect(() =>
		iodaStates.normalise([raw(JSON.stringify({ type: "signals", error: "invalid datasource", data: null }))]),
	).toThrow("invalid datasource");
	expect(() => iodaStates.normalise([raw(signalsBody([series({ step: 300 })]))])).toThrow("600");
	expect(() => iodaStates.normalise([])).toThrow();
});

test("region table: 25 IODA regions, each an ISO code that src/geo knows, one-to-one", () => {
	expect(IODA_REGIONS.length).toBe(25);
	const isos = new Set(IODA_REGIONS.map((r) => r.iso));
	expect(isos.size).toBe(25);
	expect([...isos].sort()).toEqual(
		states()
			.map((s) => s.iso)
			.sort(),
	);
	for (const r of IODA_REGIONS) {
		const state = states().find((s) => s.iso === r.iso);
		// Names match except IODA's pre-2019 "Vargas" for La Guaira.
		expect(r.iodaName === "Vargas" ? "La Guaira" : r.iodaName).toBe(state?.name ?? "");
	}
	expect(regionById("4498")?.iso).toBe("VE-X");
	expect(regionByIso("VE-A")?.id).toBe("4499");
	expect(regionById("4481")).toBeUndefined();
	expect(regionById("4881")).toBeUndefined();
});

test.skipIf(!hasFixture(ENTITIES))("region table matches the entity list IODA served", () => {
	const entities = JSON.parse(readFileSync(ENTITIES, "utf8")) as { data: { code: string; name: string }[] };
	const served = entities.data.filter((e) => e.code !== "4481" && e.code !== "4881");
	expect(served.map((e) => [e.code, e.name])).toEqual(IODA_REGIONS.map((r) => [r.id, r.iodaName]));
});

test("window planner: 8 days first, then 6 hours, full again after a failure or a day", () => {
	const p = new WindowPlanner();
	const now = Date.UTC(2026, 8, 24, 23, 25, 10);
	const a = p.plan(now);
	expect(a.until).toBe(Date.UTC(2026, 8, 24, 23, 30) / 1_000);
	expect(a.until - a.from).toBe(FULL_WINDOW_S);
	expect(a.maxPoints).toBe(1_152);
	const b = p.plan(now + 600_000);
	expect(b.until - b.from).toBe(SHORT_WINDOW_S);
	expect(b.maxPoints).toBe(36);
	p.reset();
	expect(p.plan(now + 1_200_000).maxPoints).toBe(1_152);
	expect(p.plan(now + 25 * 3_600_000).maxPoints).toBe(1_152);
});

test("one request per signal carries every region", () => {
	const url = new URL(signalsUrl("region", ["4482", "4483"], "bgp", { from: 1, until: 601, maxPoints: 1 }));
	expect(url.pathname).toBe("/v2/signals/raw/region/4482,4483");
	expect(url.searchParams.get("datasource")).toBe("bgp");
	expect(url.searchParams.get("maxPoints")).toBe("1");
});
