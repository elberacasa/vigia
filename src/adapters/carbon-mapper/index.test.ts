import { expect, test } from "bun:test";
import { join } from "node:path";
import { hasFixture, loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { BBOX, carbonMapper, plumesUrl, WINDOW_DAYS } from "./index.ts";

// Recorded 2026-09-29 (276 plumes in the box and window). Withheld from the public export (signed image links).
const FIXTURE = join(import.meta.dir, "fixtures", "2026-09-29");
const recorded = hasFixture(FIXTURE);
const raws = recorded ? loadFixture(FIXTURE) : [];
const obs = recorded ? carbonMapper.normalise(raws) : [];

test.skipIf(!recorded)("keeps the plumes inside Venezuela and assigns facilities by the stated rule", () => {
	expect(obs.length).toBe(265);
	const byState = new Map<string, number>();
	for (const o of obs) byState.set(o.location?.state ?? "", (byState.get(o.location?.state ?? "") ?? 0) + 1);
	expect(Object.fromEntries(byState)).toEqual({
		"VE-N": 89,
		"VE-B": 134,
		"VE-I": 5,
		"VE-G": 3,
		"VE-V": 20,
		"VE-M": 14,
	});
	const first = obs.find((o) => o.series === "plume:tan20260827t160224c37s4001-A");
	expect(first?.value).toMatchObject({
		gas: "CH4",
		instrument: "tan",
		emissionKgH: 3574.7,
		uncertaintyKgH: 126.1,
		sector: "1B2",
		facilityId: "faja-carabobo",
		facilityKm: 0.1,
		municipality: "VE1607",
	});
	expect(first?.observedAt).toBe(Date.parse("2026-08-27T16:02:24.370Z"));
	expect(obs.filter((o) => o.value.facilityId !== null).length).toBe(158);
	for (const o of obs) {
		expect(o.source).toBe("carbon-mapper");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(o.sourceUrl).toStartWith("https://api.carbonmapper.org/");
		// Signed, expiring image links are never stored.
		expect(JSON.stringify(o.value)).not.toContain("Signature");
	}
});

const item = (over: Record<string, unknown> = {}) => ({
	plume_id: "tan20260101t120000c00s0000-A",
	gas: "CH4",
	geometry_json: { type: "Point", coordinates: [-63.0, 8.67] },
	scene_timestamp: "2026-01-01T12:00:00.000Z",
	instrument: "tan",
	platform: "Tanager",
	emission_auto: 1234.56,
	emission_uncertainty_auto: 100.04,
	wind_speed_avg_auto: 3.25,
	sector: "1B2",
	is_offshore: false,
	status: "published",
	hide_emission: false,
	published_at: "2026-02-01T00:00:00Z",
	plume_png: "https://example.invalid/x.png?Signature=abc",
	...over,
});
const raw = (items: unknown[], extra: Record<string, unknown> = {}): RawResponse => ({
	url: plumesUrl(Date.UTC(2026, 2, 1)),
	status: 200,
	contentType: "application/json",
	body: JSON.stringify({ bbox_count: items.length, total_count: 9, limit: 1000, offset: 0, items, ...extra }),
	fetchedAt: Date.UTC(2026, 2, 1),
});

test("synthetic: fields, hidden emissions, places outside Venezuela and bad items", () => {
	const out = carbonMapper.normalise([
		raw([
			item(),
			item({ plume_id: "p-hidden", hide_emission: true }),
			// Bogotá: outside Venezuela, dropped.
			item({ plume_id: "p-colombia", geometry_json: { type: "Point", coordinates: [-74.08, 4.6] } }),
			// Not yet published, dropped.
			item({ plume_id: "p-draft", status: "publish_ready" }),
			// Future scene (clock skew), dropped.
			item({ plume_id: "p-future", scene_timestamp: "2027-01-01T00:00:00Z" }),
			// Malformed: skipped, not fatal.
			item({ plume_id: "p-bad", geometry_json: { type: "Point", coordinates: ["x", 1] } }),
			// The same plume twice (a second page overlapping): kept once.
			item(),
		]),
	]);
	expect(out.map((o) => o.value.plumeId)).toEqual(["tan20260101t120000c00s0000-A", "p-hidden"]);
	expect(out[0]?.value).toMatchObject({ emissionKgH: 1234.6, uncertaintyKgH: 100, windMs: 3.3 });
	expect(out[0]?.location).toEqual({ lat: 8.67, lon: -63, state: "VE-N" });
	expect(out[1]?.value.emissionKgH).toBeNull();
	expect(out[1]?.value.uncertaintyKgH).toBeNull();
	expect(JSON.stringify(out)).not.toContain("Signature");
});

test("synthetic: a bad envelope or no valid item fails the run", () => {
	expect(() => carbonMapper.normalise([{ ...raw([]), body: "<html>" }])).toThrow("no es JSON");
	expect(() => carbonMapper.normalise([{ ...raw([]), body: JSON.stringify({ detail: "x" }) }])).toThrow(
		"items",
	);
	expect(() => carbonMapper.normalise([raw([{ plume_id: 1 }])])).toThrow("ningún elemento");
	expect(carbonMapper.normalise([raw([])])).toEqual([]);
});

test("asks for the Venezuela box and a 400-day window, newest first", () => {
	const now = Date.UTC(2026, 8, 29);
	const q = new URL(plumesUrl(now)).searchParams;
	expect(q.getAll("bbox").map(Number)).toEqual([...BBOX]);
	expect(q.get("datetime")).toBe("2025-08-25T00:00:00Z/2026-09-30T00:00:00Z");
	expect(WINDOW_DAYS).toBe(400);
	expect(q.get("sort")).toBe("desc");
});
