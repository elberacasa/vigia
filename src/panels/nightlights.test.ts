import { expect, test } from "bun:test";
import { type NightLights, overpassAt } from "../adapters/gibs-nightlights/index.ts";
import { Store } from "../core/store.ts";
import type { Observation } from "../core/types.ts";
import { VENEZUELA_FRAME } from "../imaging/frame.ts";
import { MIN_BASELINE_NIGHTS, nightlightsView, QUALITY_NOTE, quality, regionView } from "./nightlights.ts";

const date = (i: number) => new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10);

function obs(d: string, series: string, value: NightLights): Observation<NightLights> {
	return {
		source: "gibs-nightlights",
		series,
		sourceUrl: `https://worldview.earthdata.nasa.gov/?t=${d}`,
		fetchedAt: overpassAt(d) + 40 * 3_600_000,
		observedAt: overpassAt(d),
		licence: "nasa-gibs",
		value,
		confidence: 0.8,
		basis: "measurement",
	};
}

function night(d: string, regions: Record<string, { radiance: number | null; clear: number | null }>) {
	const out: Observation<NightLights>[] = [
		obs(d, "mosaic", {
			kind: "mosaic",
			date: d,
			key: `${d}-0123456789abcdef`,
			width: 854,
			height: 768,
			bounds: { ...VENEZUELA_FRAME },
			layer: "L",
			cloudLayer: "C",
			unit: "nW/(cm² sr)",
			ceiling: 38.2,
			pipeline: "gibs-nightlights/1",
		}),
	];
	for (const [iso, r] of Object.entries(regions)) {
		out.push(
			obs(d, iso === "VE" ? "country:VE" : `state:${iso}`, {
				kind: "region",
				date: d,
				iso,
				name: iso === "VE" ? "Venezuela" : `Estado ${iso}`,
				radiance: r.radiance,
				pixels: 1000,
				validPixels: 1000,
				saturatedFraction: 0.01,
				cloudDataFraction: r.clear === null ? 0 : 1,
				clearFraction: r.clear,
			}),
		);
	}
	return out;
}

test("each state against the median of its own previous nights, largest drop first", () => {
	const store = new Store(":memory:");
	// Ten normal nights: Zulia 1.0 (0.9–1.1), Miranda 2.0, Amazonas nearly dark.
	for (let i = 0; i < 10; i++) {
		store.insert(
			night(date(i), {
				VE: { radiance: 0.5, clear: 0.6 },
				"VE-V": { radiance: 0.9 + (i % 3) * 0.1, clear: 0.9 },
				"VE-M": { radiance: 2, clear: 0.9 },
				"VE-R": { radiance: 1, clear: 0.9 },
				"VE-Z": { radiance: 0.006, clear: 0.9 },
			}),
		);
	}
	// Night 11: Zulia half dark under a clear sky; Miranda cloudy and "down" 90 %; Sucre clear, up 10 %.
	store.insert(
		night(date(10), {
			VE: { radiance: 0.4, clear: 0.7 },
			"VE-V": { radiance: 0.5, clear: 0.95 },
			"VE-M": { radiance: 0.2, clear: 0.1 },
			"VE-R": { radiance: 1.1, clear: 0.9 },
			"VE-Z": { radiance: 0.001, clear: 0.9 },
		}),
	);
	const view = nightlightsView(store, overpassAt(date(10)) + 2 * 86_400_000);
	expect(view.date).toBe(date(10));
	expect(view.image?.url).toBe(`/api/blobs/gibs-nightlights/${date(10)}-0123456789abcdef`);
	expect(view.image?.bounds).toEqual({ west: -74.00390625, east: -58.9921875, south: 0, north: 13.5 });
	expect(view.nights).toHaveLength(11);
	// The cloudy −90 % ranks after every comparable state.
	expect(view.states.map((s) => s.iso)).toEqual(["VE-V", "VE-R", "VE-M", "VE-Z"]);

	const zulia = view.states[0];
	expect(zulia?.baselineNights).toBe(10);
	// Previous nights 0.9,1.0,1.1,0.9,1.0,1.1,0.9,1.0,1.1,0.9 → median 1.0.
	expect(zulia?.baseline).toBeCloseTo(1, 10);
	expect(zulia?.pctChange).toBeCloseTo(-50, 10);
	expect(zulia?.comparable).toBe(true);
	expect(zulia?.quality).toBe("clear");

	expect(view.states[1]?.pctChange).toBeCloseTo(10, 10);
	const miranda = view.states[2];
	expect(miranda?.pctChange).toBeCloseTo(-90, 10);
	expect(miranda?.comparable).toBe(false);
	expect(miranda?.qualityNote).toBe(QUALITY_NOTE.cloudy);

	// Too dark for a percentage.
	expect(view.states[3]?.pctChange).toBeNull();
	// The country compares clear nights only: its previous nights were 60 % clear, so no national %.
	expect(view.national?.pctChange).toBeNull();
	expect(view.national?.baselineNights).toBe(0);
	expect(view.national?.quality).toBe("partly");
});

test("cloud-filled nights never enter a baseline; the national % needs a clear night (review 2, M5)", () => {
	const store = new Store(":memory:");
	// Eight clear nights at 1.0 and seven cloudy nights that repeat a dimmer 0.5, interleaved.
	for (let i = 0; i < 15; i++) {
		const clear = i % 2 === 0;
		store.insert(
			night(date(i), {
				VE: { radiance: clear ? 1 : 0.5, clear: clear ? 0.9 : 0.2 },
				"VE-V": { radiance: clear ? 1 : 0.5, clear: clear ? 0.9 : 0.2 },
			}),
		);
	}
	// A normal clear night: 0 %, not the +100 % a median over cloudy nights gave.
	store.insert(night(date(15), { VE: { radiance: 1, clear: 0.95 }, "VE-V": { radiance: 1, clear: 0.95 } }));
	let view = nightlightsView(store, overpassAt(date(15)) + 86_400_000);
	expect(view.states[0]?.baseline).toBe(1);
	expect(view.states[0]?.pctChange).toBe(0);
	expect(view.national?.pctChange).toBe(0);
	// A partly clear night: the state may compare, the country does not.
	store.insert(night(date(16), { VE: { radiance: 0.5, clear: 0.7 }, "VE-V": { radiance: 0.5, clear: 0.7 } }));
	view = nightlightsView(store, overpassAt(date(16)) + 86_400_000);
	expect(view.states[0]?.pctChange).toBe(-50);
	expect(view.national?.pctChange).toBeNull();
	expect(view.national?.comparable).toBe(false);
});

test("no % change until there are enough previous nights; unknown quality without a cloud mask", () => {
	const store = new Store(":memory:");
	for (let i = 0; i < MIN_BASELINE_NIGHTS - 1; i++)
		store.insert(night(date(i), { "VE-V": { radiance: 1, clear: 0.9 } }));
	store.insert(night(date(9), { "VE-V": { radiance: 0.5, clear: null } }));
	const view = nightlightsView(store, overpassAt(date(9)) + 86_400_000);
	const zulia = view.states[0];
	expect(zulia?.baselineNights).toBe(MIN_BASELINE_NIGHTS - 1);
	expect(zulia?.baseline).toBe(1);
	expect(zulia?.pctChange).toBeNull();
	expect(zulia?.quality).toBe("unknown");
	expect(zulia?.qualityNote).toContain("puede incluir noches anteriores por nubes");
});

test("quality thresholds and a missing radiance", () => {
	expect([quality(0.8), quality(0.79), quality(0.6), quality(0.59), quality(null)]).toEqual([
		"clear",
		"partly",
		"partly",
		"cloudy",
		"unknown",
	]);
	const base = {
		kind: "region" as const,
		date: "2026-09-10",
		iso: "VE-V",
		name: "Zulia",
		pixels: 1,
		validPixels: 0,
		saturatedFraction: null,
		cloudDataFraction: 1,
		clearFraction: 1,
	};
	const prev = Array.from({ length: 8 }, () => ({ ...base, radiance: 1 }));
	expect(regionView({ ...base, radiance: null }, prev)).toMatchObject({ pctChange: null, comparable: false });
});

test("after an outage the slider only offers nights whose pictures are still kept", () => {
	const store = new Store(":memory:");
	for (const i of [0, 1, 2, 20, 21]) store.insert(night(date(i), { "VE-V": { radiance: 1, clear: 0.9 } }));
	const view = nightlightsView(store, overpassAt(date(21)) + 86_400_000);
	expect(view.nights.map((n) => n.date)).toEqual([date(20), date(21)]);
	// And the baseline only uses the 14 nights before the newest.
	expect(view.states[0]?.baselineNights).toBe(1);
});

test("no data yet: an empty view that still carries the caveats and acknowledgement", () => {
	const view = nightlightsView(new Store(":memory:"), Date.UTC(2026, 8, 24));
	expect(view).toMatchObject({ date: null, image: null, states: [], national: null, nights: [] });
	expect(view.caveats.length).toBeGreaterThan(0);
	expect(view.acknowledgement).toContain("Global Imagery Browse Services");
});
