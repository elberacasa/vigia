import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasFixture, loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { ISP_ASNS, ISPS, iodaAsn } from "./index.ts";

// Recorded IODA responses are not redistributable, so they are absent from the public repository (see hasFixture).
const FIXTURE = join(import.meta.dir, "fixtures", "2026-09-24");
const ENTITIES = join(import.meta.dir, "fixtures", "entities-asn.json");
const recorded = hasFixture(FIXTURE);
const raws = recorded ? loadFixture(FIXTURE) : [];
const first: RawResponse = raws[0] ?? {
	url: "https://api.ioda.inetintel.cc.gatech.edu/v2/signals/raw/asn/8048",
	status: 200,
	contentType: "application/json",
	body: "",
	fetchedAt: 1_790_292_721_911,
};

test.skipIf(!recorded)("normalises the recorded 8-day capture of the main ISPs", () => {
	const obs = iodaAsn.normalise(raws);
	expect(obs.length).toBe(32_673);
	const series = new Set(obs.map((o) => o.series));
	// 10 ASNs × 3 signals, minus AS264731 (Digitel) which IODA does not probe actively.
	expect(series.size).toBe(29);
	expect(series.has("asn:264731:ping-slash24")).toBe(false);
	const cantv = obs.filter((o) => o.series === "asn:8048:ping-slash24");
	expect(cantv.length).toBe(1_150);
	expect(cantv[0]?.observedAt).toBe(Date.UTC(2026, 8, 16, 23, 40));
	expect(cantv[0]?.value.value).toBe(3_897);
	expect(cantv.at(-1)?.value.value).toBe(3_903);
	expect(cantv[0]?.sourceUrl).toBe("https://ioda.inetintel.cc.gatech.edu/asn/8048");
	for (const o of obs) {
		expect(o.source).toBe("ioda-asn");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(o.location).toBeUndefined();
	}
});

test("foreign or unlisted ASNs in a response are ignored", () => {
	const body = JSON.stringify({
		type: "signals",
		error: null,
		data: [
			[
				{
					entityType: "asn",
					entityCode: "174",
					datasource: "bgp",
					from: 1_790_200_200,
					until: 1_790_201_400,
					step: 600,
					nativeStep: 600,
					values: [1, 2],
				},
			],
		],
	});
	expect(iodaAsn.normalise([{ ...first, body }])).toEqual([]);
	expect(() => iodaAsn.normalise([{ ...first, body: "{}" }])).toThrow("IODA");
});

test.skipIf(!hasFixture(ENTITIES))(
	"every ISP ASN exists in IODA's Venezuela list with the holder name we print",
	() => {
		const entities = JSON.parse(readFileSync(ENTITIES, "utf8")) as {
			data: { code: string; attrs?: { org?: string } }[];
		};
		const byCode = new Map(entities.data.map((e) => [e.code, e.attrs?.org ?? ""]));
		for (const isp of ISPS) for (const asn of isp.asns) expect(byCode.get(asn)).toBe(isp.holder);
		expect(new Set(ISP_ASNS).size).toBe(ISP_ASNS.length);
		expect(ISPS.find((i) => i.id === "digitel")?.asns).toEqual(["264731", "27717"]);
	},
);
