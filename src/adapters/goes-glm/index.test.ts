import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import {
	CATATUMBO,
	dueWindows,
	FILES_PER_WINDOW,
	fileStart,
	goesGlm,
	listedFiles,
	listingUrl,
	listingWindow,
	tallyFlashes,
	WINDOW_MS,
} from "./index.ts";

// Recorded 2026-09-29 02:26 UTC: one run, the window 02:00–02:15 UTC (22:00–22:15 in Caracas). The S3 listing and,
// for each of the 45 files, the byte ranges read from it (17 per file, ~24 KB of ~600 KB). NOAA data, public domain.
const raws = loadFixture(join(import.meta.dir, "fixtures", "2026-09-29"));
const obs = goesGlm.normalise(raws);

test("one complete window: 45 of 45 files, flashes per state", () => {
	expect(obs.length).toBe(1);
	const o = obs[0];
	expect(new Date(o?.observedAt ?? 0).toISOString()).toBe("2026-09-29T02:00:00.000Z");
	expect(o?.value).toMatchObject({
		windowStart: "2026-09-29T02:00:00.000Z",
		windowMinutes: 15,
		filesListed: 45,
		filesRead: 45,
		complete: true,
		venezuela: 392,
		catatumbo: 0,
		lake: 0,
		byState: { "VE-F": 366, "VE-B": 15, "VE-I": 6, "VE-P": 5 },
		satellite: "GOES-19",
	});
	const v = o?.value;
	// Every good flash in the region is in exactly one cell; Venezuela's are a subset.
	const inCells = (v?.cells ?? []).reduce((n, c) => n + c[2], 0);
	expect(inCells).toBeGreaterThanOrEqual(v?.venezuela ?? 0);
	expect(Object.values(v?.byState ?? {}).reduce((n, x) => n + x, 0)).toBe(v?.venezuela ?? -1);
	expect(o?.confidence).toBe(1);
	expect(o?.basis).toBe("measurement");
	expect(o?.observedAt).toBeLessThan(o?.fetchedAt ?? 0);
});

test("a file that cannot be read makes the window incomplete, not wrong", () => {
	const broken = raws.map((r, i) => (i === 3 ? { ...r, body: '{"size":10,"ranges":[]}' } : r));
	const v = goesGlm.normalise(broken)[0]?.value;
	expect(v?.filesRead).toBe(44);
	expect(v?.complete).toBe(false);
	expect(goesGlm.normalise(broken)[0]?.confidence).toBeCloseTo(44 / 45, 10);
	// Without the files at all: listed 45, read 0, nothing counted.
	const listingOnly = goesGlm.normalise(raws.slice(0, 1))[0]?.value;
	expect(listingOnly).toMatchObject({ filesListed: 45, filesRead: 0, venezuela: 0, complete: false });
});

test("file names, listings and windows", () => {
	const key = "GLM-L2-LCFA/2026/272/02/OR_GLM-L2-LCFA_G19_s20262720214400_e20262720215000_c20262720215017.nc";
	expect(new Date(fileStart(key) ?? 0).toISOString()).toBe("2026-09-29T02:14:40.000Z");
	expect(fileStart("README.txt")).toBeNull();
	const w = Date.parse("2026-09-29T02:15:00Z");
	const url = listingUrl(w);
	expect(url).toContain("prefix=GLM-L2-LCFA%2F2026%2F272%2F02%2F");
	expect(listingWindow(url)).toBe(w);
	// 31 Dec of a leap year is day 366.
	expect(listingUrl(Date.parse("2028-12-31T23:45:00Z"))).toContain("2028%2F366%2F23");
	// The listing asks for 50 keys: the window's 45 and the first 5 of the next, which are left out.
	const listed = listedFiles((raws[0] as RawResponse).body);
	expect(listed.length).toBe(FILES_PER_WINDOW + 5);
	expect(listed.filter((f) => (fileStart(f.key) ?? 0) < Date.parse("2026-09-29T02:15:00Z")).length).toBe(
		FILES_PER_WINDOW,
	);
	// At 02:26 the newest readable window is 02:00 (02:15 closes at 02:30).
	const due = dueWindows(Date.parse("2026-09-29T02:26:40Z"));
	expect(new Date(due[0] ?? 0).toISOString()).toBe("2026-09-29T02:00:00.000Z");
	// 02:00 back to 00:30: the windows that started within the last 2 hours.
	expect(due.length).toBe(7);
	expect((due[0] ?? 0) - (due[1] ?? 0)).toBe(WINDOW_MS);
	expect(new Date(dueWindows(Date.parse("2026-09-29T02:20:00Z"))[0] ?? 0).toISOString()).toBe(
		"2026-09-29T02:00:00.000Z",
	);
	expect(new Date(dueWindows(Date.parse("2026-09-29T02:19:59Z"))[0] ?? 0).toISOString()).toBe(
		"2026-09-29T01:45:00.000Z",
	);
});

test("tally: states, the lake in Zulia, the Catatumbo box, flagged and outside flashes", () => {
	const points: [number, number, number][] = [
		[10.65, -71.63, 0], // Maracaibo: Zulia
		[9.8, -71.6, 0], // on Lake Maracaibo: Zulia, lake, Catatumbo box
		[9.5, -72.0, 0], // Zulia land in the Catatumbo box
		[10.5, -66.9, 0], // Caracas: Distrito Capital
		[7.0, -73.0, 0], // Colombia: in the region, not Venezuela
		[10.5, -66.9, 1], // flagged by GLM: not counted
		[25.0, -80.0, 0], // Florida: outside the region
	];
	const t = tallyFlashes([
		{ lat: points.map((p) => p[0]), lon: points.map((p) => p[1]), quality: points.map((p) => p[2]) },
	]);
	expect(t.venezuela).toBe(4);
	expect(t.byState).toEqual({ "VE-V": 3, "VE-A": 1 });
	expect(t.lake).toBe(1);
	expect(t.catatumbo).toBe(2);
	expect(t.flagged).toBe(1);
	expect(t.cells.reduce((n, c) => n + c[2], 0)).toBe(5);
	expect(t.cells.find((c) => c[0] === 9.875 && c[1] === -71.625)?.[2]).toBe(1);
	expect(CATATUMBO.minLat).toBeLessThan(9.75);
});

test("a listing that is not S3's fails loudly", () => {
	const listing = raws[0] as RawResponse;
	expect(() => goesGlm.normalise([{ ...listing, body: "<html>" }])).toThrow("S3");
});
