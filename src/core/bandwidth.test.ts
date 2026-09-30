import { expect, test } from "bun:test";
import { ADAPTERS } from "../adapters/registry.ts";
import { MB_PER_DAY, UNMEASURED } from "./bandwidth.gen.ts";
import {
	AS_MEASURED,
	dailyMb,
	estimate,
	feedOn,
	HEAVY_MB_PER_DAY,
	heavyAsMeasured,
	isHeavy,
	saverState,
} from "./bandwidth.ts";
import { onByDefault } from "./defaults.ts";

const why = { es: "motivo", en: "reason" };

test("the data saver's state: the flag wins, then the user's setting, else off and not asked yet", () => {
	expect(saverState(undefined, undefined)).toEqual({ on: false, source: "unset" });
	expect(saverState(undefined, true)).toEqual({ on: true, source: "setting" });
	expect(saverState(undefined, false)).toEqual({ on: false, source: "setting" });
	expect(saverState(true, false)).toEqual({ on: true, source: "flag" });
	expect(saverState(false, true)).toEqual({ on: false, source: "flag" });
});

test("a feed's switch: the user's own wins, then the data saver (heavy feeds off), then the mode's default", () => {
	const plain = {};
	const optIn = { optIn: why };
	const personal = { note: why, defaultIn: { local: true, public: false } };
	// No switch, saver not holding it back: the default.
	expect(feedOn(plain, "local", undefined, false)).toBe(true);
	expect(feedOn(optIn, "local", undefined, false)).toBe(false);
	expect(feedOn(personal, "public", undefined, false)).toBe(false);
	// The saver holds a heavy feed back.
	expect(feedOn(plain, "local", undefined, true)).toBe(false);
	// The user's switch wins over both.
	expect(feedOn(plain, "local", true, true)).toBe(true);
	expect(feedOn(plain, "local", false, false)).toBe(false);
	expect(feedOn(optIn, "local", true, true)).toBe(true);
});

test("heavy is decided by the measured threshold, and a key that shrinks the download makes a feed light", () => {
	for (const [id, mb] of Object.entries(MB_PER_DAY)) expect(isHeavy(id)).toBe(mb >= HEAVY_MB_PER_DAY);
	expect(isHeavy("no-such-feed")).toBe(false);
	expect(dailyMb("no-such-feed")).toBeNull();
	// FIRMS without a key downloads the whole South America file every hour; with its free key, Venezuela's box.
	expect(isHeavy("firms-fires")).toBe(true);
	expect(isHeavy("firms-fires", { hasKey: (k) => k === "nasa-firms-map-key", ffmpeg: true })).toBe(false);
	// Without ffmpeg the TV stills adapter downloads nothing, so it is not heavy until ffmpeg is installed.
	expect(isHeavy("tv-stills")).toBe(true);
	expect(dailyMb("tv-stills", { hasKey: () => false, ffmpeg: false })).toBe(0);
	expect(isHeavy("tv-stills", { hasKey: () => false, ffmpeg: false })).toBe(false);
});

test("the heavy set as measured on 2026-09-29 (a change here is a finding: update PERF.md and the guide)", () => {
	expect(heavyAsMeasured().sort()).toEqual([
		"firms-fires",
		"goes-glm",
		"goes-nsa",
		"iptv-ve-probe",
		"public-cams",
		"radio-browser-probe",
		"tv-stills",
		"youtube-live",
	]);
});

test("the table covers every feed on by default, and names only feeds that exist", () => {
	const ids = new Set(ADAPTERS.map((a) => a.id));
	for (const id of [...Object.keys(MB_PER_DAY), ...UNMEASURED]) expect(ids.has(id)).toBe(true);
	const missing = ADAPTERS.filter(
		(a) => onByDefault(a, "local") && MB_PER_DAY[a.id] === undefined && !UNMEASURED.includes(a.id),
	).map((a) => a.id);
	expect(missing).toEqual([]);
	for (const mb of Object.values(MB_PER_DAY)) expect(mb).toBeGreaterThanOrEqual(0);
});

test("an estimate sums the measured feeds that would run and counts the ones without a figure", () => {
	const feeds = [{ id: "goes-nsa" }, { id: "usgs-quakes" }, { id: "no-such-feed" }, { id: "tv-stills" }];
	const all = estimate(feeds, () => true, AS_MEASURED);
	expect(all.feeds).toBe(4);
	expect(all.unmeasured).toBe(1);
	const expected =
		(MB_PER_DAY["goes-nsa"] ?? 0) + (MB_PER_DAY["usgs-quakes"] ?? 0) + (MB_PER_DAY["tv-stills"] ?? 0);
	expect(all.mb).toBeCloseTo(expected, 1);
	const light = estimate(feeds, (id) => !isHeavy(id), AS_MEASURED);
	expect(light.mb).toBeLessThan(all.mb);
});
