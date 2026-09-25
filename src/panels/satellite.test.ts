import { expect, test } from "bun:test";
import type { GoesFrame } from "../adapters/goes-nsa/index.ts";
import { Store } from "../core/store.ts";
import type { Observation } from "../core/types.ts";
import { VENEZUELA_FRAME } from "../imaging/frame.ts";
import { NIGHT_NOTE, satelliteView } from "./satellite.ts";

const T0 = Date.UTC(2026, 8, 24, 12, 0);

function frame(at: number, key: string, lighting: GoesFrame["lighting"] = "day"): Observation<GoesFrame> {
	return {
		source: "goes-nsa",
		series: "geocolor",
		sourceUrl: `https://cdn.star.nesdis.noaa.gov/x/${key}.jpg`,
		fetchedAt: at + 15 * 60_000,
		observedAt: at,
		licence: "noaa-public-domain",
		value: {
			key,
			name: key.split("-")[0] ?? key,
			width: 427,
			height: 384,
			bounds: { ...VENEZUELA_FRAME },
			lighting,
			staticCityLights: lighting !== "day",
			sourceSize: "1800x1080",
			pipeline: "goes-nsa/1",
		},
		confidence: 1,
		basis: "measurement",
	};
}

test("the loop is the newest 24 frames, oldest first, with same-origin URLs and the newest age", () => {
	const store = new Store(":memory:");
	// 30 frames every 10 min, with one outage slot.
	store.insert(
		Array.from({ length: 30 }, (_, i) => i)
			.filter((i) => i !== 27)
			.map((i) => frame(T0 + i * 600_000, `f${i}-aaaa`)),
	);
	const now = T0 + 29 * 600_000 + 17 * 60_000;
	const view = satelliteView(store, now);
	expect(view.frames).toHaveLength(24);
	expect(view.frames[0]?.key).toBe("f5-aaaa");
	expect(view.frames.at(-1)?.key).toBe("f29-aaaa");
	expect(view.frames.map((f) => f.key)).not.toContain("f27-aaaa");
	expect(view.newest?.url).toBe("/api/blobs/goes-nsa/f29-aaaa");
	expect(view.newestAgeMs).toBe(17 * 60_000);
	expect(view.attribution).toBe("NOAA/NESDIS/STAR, GOES-19");
	expect(view.bounds).toEqual({ west: -74.00390625, east: -58.9921875, south: 0, north: 13.5 });
	expect(view.nightNote).toBeNull();
});

test("a stale feed still shows its last loop, with its true age; night frames carry the caveat", () => {
	const store = new Store(":memory:");
	store.insert([frame(T0, "old-aaaa", "day"), frame(T0 + 5 * 3_600_000, "a-aaaa", "mixed")]);
	store.insert([frame(T0 + 5 * 3_600_000 + 600_000, "b-aaaa", "night")]);
	const view = satelliteView(store, T0 + 8 * 3_600_000);
	// The 5-hour-older frame is outside the loop window of the newest.
	expect(view.frames.map((f) => f.key)).toEqual(["a-aaaa", "b-aaaa"]);
	expect(view.newestAgeMs).toBe(3 * 3_600_000 - 600_000);
	expect(view.nightNote).toBe(NIGHT_NOTE);
	expect(view.frames.map((f) => f.staticCityLights)).toEqual([true, true]);
});

test("a reprocessed frame replaces the earlier version of the same scan", () => {
	const store = new Store(":memory:");
	store.insert([frame(T0, "s-1111")]);
	store.insert([frame(T0, "s-2222")]);
	const view = satelliteView(store, T0 + 1_000);
	expect(view.frames.map((f) => f.key)).toEqual(["s-2222"]);
});

test("no data: an empty, honest view", () => {
	const view = satelliteView(new Store(":memory:"), T0);
	expect(view).toMatchObject({ frames: [], newest: null, newestAgeMs: null, bounds: null, nightNote: null });
});
