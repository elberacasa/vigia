import { expect, test } from "bun:test";
import { join } from "node:path";
import { goesGlm, type LightningWindow } from "../adapters/goes-glm/index.ts";
import { loadFixture } from "../core/fixtures.ts";
import { Store } from "../core/store.ts";
import { stateByIso } from "../geo/index.ts";
import { lightningPanelView, lightningView } from "./lightning.ts";

const Q = 15 * 60_000;
const T0 = Date.parse("2026-09-29T02:00:00Z");

const win = (start: number, zulia: number, over: Partial<LightningWindow> = {}) => ({
	observedAt: start,
	fetchedAt: start + 20 * 60_000,
	value: {
		windowStart: new Date(start).toISOString(),
		windowMinutes: 15,
		filesListed: 45,
		filesRead: 45,
		complete: true,
		venezuela: zulia + 1,
		catatumbo: zulia,
		lake: 0,
		byState: { "VE-V": zulia, "VE-A": 1 },
		cells: [[9.875, -71.625, zulia] as [number, number, number]],
		flagged: 0,
		satellite: "GOES-19",
		...over,
	} satisfies LightningWindow,
});

test("the last hour is the four newest windows when consecutive", () => {
	const rows = [0, 1, 2, 3, 4].map((i) => win(T0 - i * Q, 10 + i));
	const v = lightningView(rows, T0 + 20 * 60_000);
	expect(v.lastHour).toEqual({
		from: T0 - 3 * Q,
		to: T0 + Q,
		venezuela: 11 + 12 + 13 + 14,
		catatumbo: 10 + 11 + 12 + 13,
		lake: 0,
		complete: true,
	});
	expect(v.cellsLastHour).toEqual([[9.875, -71.625, 46]]);
	expect(v.last24h).toMatchObject({
		venezuela: 65,
		catatumbo: 60,
		windowsRead: 5,
		windowsExpected: 96,
		incomplete: 0,
	});
	expect(v.series24h.map((p) => p.windowStart)).toEqual([4, 3, 2, 1, 0].map((i) => T0 - i * Q));
	// Zulia: 60 flashes in 5 windows (1.25 h) over its area.
	const zulia = v.states.find((s) => s.iso === "VE-V");
	const area = stateByIso("VE-V")?.areaKm2 ?? 1;
	expect(zulia).toMatchObject({ lastHour: 46, last24h: 60, name: stateByIso("VE-V")?.name });
	expect(zulia?.density24h).toBeCloseTo(60 / (area / 1000) / 1.25, 10);
	expect(v.states[0]?.iso).toBe("VE-V");
	expect(v.stale).toBe(false);
});

test("a gap, an incomplete window and staleness are said, not smoothed", () => {
	const gap = [0, 1, 3, 4].map((i) => win(T0 - i * Q, 5));
	expect(lightningView(gap, T0 + 20 * 60_000).lastHour).toBeNull();
	const partial = [0, 1, 2, 3].map((i) =>
		win(T0 - i * Q, 5, i === 2 ? { complete: false, filesRead: 40 } : {}),
	);
	const p = lightningView(partial, T0 + 20 * 60_000);
	expect(p.lastHour?.complete).toBe(false);
	expect(p.last24h.incomplete).toBe(1);
	const old = lightningView(partial, T0 + 2 * 3_600_000);
	expect(old.stale).toBe(true);
	expect(old.lastHour).toBeNull();
	expect(old.cellsLastHour).toEqual([]);
	expect(lightningView([], T0)).toMatchObject({ newest: null, stale: true, lastHour: null, states: [] });
});

test("end to end on the recorded window", () => {
	const store = new Store(":memory:");
	store.insert(
		goesGlm.normalise(
			loadFixture(join(import.meta.dir, "..", "adapters", "goes-glm", "fixtures", "2026-09-29")),
		),
	);
	const v = lightningPanelView(store, Date.parse("2026-09-29T02:27:00Z"));
	expect(v.newest?.windowStart).toBe(T0);
	expect(v.last24h.venezuela).toBe(392);
	expect(v.lastHour).toBeNull(); // one window stored, not an hour
	expect(v.states[0]).toMatchObject({ iso: "VE-F", last24h: 366 });
	expect(v.stale).toBe(false);
	expect(v.attribution).toContain("GLM");
});
