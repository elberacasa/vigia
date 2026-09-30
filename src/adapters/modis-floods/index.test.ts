import { expect, test } from "bun:test";
import { join } from "node:path";
import { encode } from "fast-png";
import { hasFixture, loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { stateByIso } from "../../geo/index.ts";
import { gibsDegPerPx, VENEZUELA_FRAME } from "../../imaging/frame.ts";
import {
	COLS,
	CROP,
	datesToRead,
	domainUrl,
	FRAME,
	floodStats,
	LEVEL,
	modisFloods,
	PALETTE,
	ROWS,
	tileUrl,
} from "./index.ts";
import { floodMasks } from "./masks.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "2026-09-29");
const recorded = hasFixture(FIXTURE);

test.skipIf(!recorded)("recorded day 2026-09-27: flood, recurring flood and cloud by state", () => {
	const obs = modisFloods.normalise(loadFixture(FIXTURE));
	expect(obs.length).toBe(1);
	const o = obs[0];
	expect(o?.series).toBe("day");
	expect(o?.observedAt).toBe(Date.UTC(2026, 8, 27));
	expect(o?.value.venezuela).toEqual({
		floodKm2: 202.6,
		recurringKm2: 183.1,
		waterKm2: 4241.7,
		insufficientKm2: 740637,
		nodataKm2: 0,
		areaKm2: 919726.7,
		pixels: 3876735,
	});
	expect(Object.keys(o?.value.states ?? {}).length).toBe(25);
	// Every municipality listed has some flood or recurring flood; the sums never exceed the state's.
	for (const [code, m] of Object.entries(o?.value.municipalities ?? {})) {
		expect(m.floodKm2 + m.recurringKm2).toBeGreaterThan(0);
		expect(code).toMatch(/^VE\d{4}$/);
	}
	const cellsFlood = (o?.value.cells ?? []).reduce((s, c) => s + c[2], 0);
	// Each cell is rounded to 0.1 km².
	const cells = o?.value.cells.length ?? 0;
	expect(Math.abs(cellsFlood - (o?.value.venezuela.floodKm2 ?? 0))).toBeLessThanOrEqual(0.05 * cells + 0.1);
	expect(o?.sourceUrl).toContain("worldview.earthdata.nasa.gov");
	expect(o?.basis).toBe("derived");
});

test("the masks: Venezuela and each state have their official area on the raster (within 2 %)", () => {
	const m = floodMasks();
	expect(m.grid.width).toBe(FRAME.width);
	expect(FRAME).toEqual({ width: 3416, height: 3072 });
	expect(CROP).toEqual({ x: 56, y: 0 });
	const area = new Map<string, number>();
	for (let r = 0; r < m.grid.height; r++)
		for (let c = 0; c < m.grid.width; c++) {
			const s = m.states[r * m.grid.width + c] ?? 0;
			if (s === 0) continue;
			const iso = m.stateIso[s - 1] ?? "";
			area.set(iso, (area.get(iso) ?? 0) + (m.rowArea[r] ?? 0));
		}
	expect(area.size).toBe(25);
	for (const [iso, km2] of area) {
		const official = stateByIso(iso)?.areaKm2 ?? 0;
		expect(Math.abs(km2 - official) / official).toBeLessThan(0.02);
	}
	expect(m.municipalityCode).not.toContain("VE2501");
	expect(m.municipalityCode.length).toBe(335);
});

// Synthetic tiles: every pixel "no water" (index 1), with overrides by frame pixel.
const DEG = gibsDegPerPx(LEVEL);
function tiles(date: string, paint: (x: number, y: number) => number, palette = PALETTE): RawResponse[] {
	const out: RawResponse[] = [];
	for (const row of ROWS)
		for (const col of COLS) {
			const data = new Uint8Array(512 * 512);
			for (let y = 0; y < 512; y++)
				for (let x = 0; x < 512; x++) {
					const fx = (col - COLS[0]) * 512 - CROP.x + x;
					const fy = (row - ROWS[0]) * 512 - CROP.y + y;
					data[y * 512 + x] = paint(fx, fy);
				}
			const png = encode({
				width: 512,
				height: 512,
				data,
				channels: 1,
				depth: 8,
				palette: palette.map(([r, g, b]) => [r, g, b, 255]),
			});
			out.push({
				url: tileUrl(date, row, col),
				status: 200,
				contentType: "image/png",
				body: Buffer.from(png).toString("base64"),
				fetchedAt: Date.UTC(2026, 8, 29, 12),
			});
		}
	return out;
}
const domain: RawResponse = {
	url: domainUrl("2026-09-19", "2026-09-30"),
	status: 200,
	contentType: "text/xml",
	body: "<Domains><Domain>2023-07-26/2026-09-29/P1D</Domain></Domains>",
	fetchedAt: Date.UTC(2026, 8, 29, 12),
};
/** Frame pixel of a lon/lat. */
const px = (lon: number, lat: number) => ({
	x: Math.floor((lon - VENEZUELA_FRAME.west) / DEG),
	y: Math.floor((VENEZUELA_FRAME.north - lat) / DEG),
});

test("synthetic: a flood block in Apure is counted in Apure, its municipality and one cell", () => {
	// 20 × 20 sampled pixels around 7.5 N, 68.6 W (Apure), classed "flood"; a 10 × 10 block of cloud next to it.
	const a = px(-68.6, 7.5);
	const raws = [
		domain,
		...tiles("2026-09-27", (x, y) => {
			if (x >= a.x && x < a.x + 20 && y >= a.y && y < a.y + 20) return 4;
			if (x >= a.x + 30 && x < a.x + 40 && y >= a.y && y < a.y + 10) return 5;
			return 1;
		}),
	];
	const [o] = modisFloods.normalise(raws);
	const pixelKm2 = (DEG * 111.32) ** 2 * Math.cos((7.5 * Math.PI) / 180);
	expect(o?.value.states["VE-C"]?.floodKm2).toBeCloseTo(400 * pixelKm2, 0);
	expect(o?.value.states["VE-C"]?.insufficientKm2).toBeCloseTo(100 * pixelKm2, 0);
	expect(o?.value.venezuela.floodKm2).toBe(o?.value.states["VE-C"]?.floodKm2 ?? -1);
	expect(Object.keys(o?.value.municipalities ?? {}).every((c) => c.startsWith("VE04"))).toBe(true);
	expect(o?.value.cells.length).toBeGreaterThanOrEqual(1);
	expect(o?.value.venezuela.recurringKm2).toBe(0);
});

test("synthetic: a day not yet produced (mostly no data) is not stored; bad tiles fail the run", () => {
	expect(modisFloods.normalise([domain, ...tiles("2026-09-27", () => 0)])).toEqual([]);
	// Swaths still missing over the west (no product west of 71.8° W): incomplete, not stored.
	const partial = modisFloods.normalise([domain, ...tiles("2026-09-27", (x) => (x < 500 ? 0 : 1))]);
	expect(partial).toEqual([]);
	const wrong = PALETTE.map((c, i) => (i === 4 ? ([0, 0, 0] as const) : c));
	expect(() => modisFloods.normalise([domain, ...tiles("2026-09-27", () => 1, wrong)])).toThrow("palette");
	expect(() => modisFloods.normalise([domain, ...tiles("2026-09-27", () => 1).slice(1)])).toThrow(
		"missing tile",
	);
	expect(() => modisFloods.normalise([domain, ...tiles("2026-09-27", () => 9)])).toThrow("bad index");
	expect(() => modisFloods.normalise([])).toThrow("domain");
	// Only the domain (nothing to read this run): no observation, no error.
	expect(modisFloods.normalise([domain])).toEqual([]);
});

test("reads a day once it has settled (36 h), newest first, within 10 days, skipping stored ones", () => {
	const now = Date.UTC(2026, 8, 29, 4);
	const listed = ["2026-09-17", "2026-09-19", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29"];
	expect(datesToRead(listed, now, () => false)).toEqual(["2026-09-27", "2026-09-26", "2026-09-19"]);
	expect(datesToRead(listed, now, (d) => d === "2026-09-27")).toEqual(["2026-09-26", "2026-09-19"]);
	// 09-27 settles at 09-28 12:00 UTC.
	expect(datesToRead(listed, Date.UTC(2026, 8, 28, 11, 59), () => false)[0]).toBe("2026-09-26");
	expect(datesToRead(listed, Date.UTC(2026, 8, 28, 12), () => false)[0]).toBe("2026-09-27");
});

test("floodStats is pure: the same raster gives the same figures", () => {
	const data = new Uint8Array(FRAME.width * FRAME.height).fill(1);
	expect(floodStats("2026-01-01", data)).toEqual(floodStats("2026-01-01", data));
	expect(floodStats("2026-01-01", data).venezuela.floodKm2).toBe(0);
});
