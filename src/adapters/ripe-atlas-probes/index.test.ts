import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import {
	activeProbeIds,
	type ConnectionEvents,
	eventsUrl,
	type ProbeCounts,
	ripeAtlasProbes,
} from "./index.ts";

// Recorded 2026-09-24 23:39 UTC. Probe positions in the fixture were replaced by their state's label point
// before committing (probes are often homes); state membership, and so every count, is unchanged.
const raws = loadFixture(join(import.meta.dir, "fixtures", "2026-09-24"));
const [probes, events] = raws as [RawResponse, RawResponse];

test("reduces the recorded probe list and events to counts per state and hour", () => {
	const obs = ripeAtlasProbes.normalise(raws);
	expect(obs.length).toBe(72);
	const national = obs.find((o) => o.series === "country:VE:probes");
	expect(national?.value).toEqual({ connected: 45, disconnected: 8, droppedLastHour: 1, unlocated: 0 });
	expect(national?.observedAt).toBe(probes.fetchedAt);
	const zulia = obs.find((o) => o.series === "state:VE-V:probes");
	expect(zulia?.value).toEqual({ connected: 9, disconnected: 3, droppedLastHour: 1, unlocated: 0 });
	expect(zulia?.location).toEqual({ lat: 10.49321, lon: -72.2638, state: "VE-V", place: "Zulia" });
	const stateRows = obs.filter((o) => o.series.startsWith("state:") && o.series.endsWith(":probes"));
	expect(stateRows.length).toBe(14);
	const sum = stateRows.reduce((n, o) => n + (o.value as ProbeCounts).connected, 0);
	expect(sum).toBe(45);
	const hour = obs.find(
		(o) => o.series === "country:VE:connection-events" && o.observedAt === Date.UTC(2026, 8, 23, 23),
	);
	expect(hour?.value).toEqual({ disconnects: 4, connects: 2, probesDisconnecting: 4 });
	const total = obs
		.filter((o) => o.series === "country:VE:connection-events")
		.reduce((n, o) => n + (o.value as ConnectionEvents).disconnects, 0);
	expect(total).toBe(26);
	for (const o of obs) {
		expect(o.source).toBe("ripe-atlas-probes");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(o.observedAt).toBeGreaterThanOrEqual(0);
		// SAFETY: no probe id or probe position ever leaves normalise.
		expect(o.series).not.toMatch(/prb|probe:\d/);
		expect(JSON.stringify(o.value)).not.toMatch(/prb|coordinates|"id"/);
		if (o.location) expect(o.location.place).toBeDefined();
	}
});

test("works without the events call, skips malformed probes and events, throws on a broken list", () => {
	expect(ripeAtlasProbes.normalise([probes]).length).toBe(15);
	const body = JSON.parse(probes.body);
	body.results[0] = { id: "x" };
	const list = { ...probes, body: JSON.stringify(body) };
	const badEvent = { ...events, body: JSON.stringify([{ prb_id: 1, event: "reboot", timestamp: 1 }]) };
	expect(ripeAtlasProbes.normalise([list, badEvent]).length).toBe(15);
	expect(() => ripeAtlasProbes.normalise([{ ...probes, body: "[]" }])).toThrow("RIPE Atlas");
	expect(() => ripeAtlasProbes.normalise([probes, { ...events, body: "{}" }])).toThrow("msm 7000");
	expect(() => ripeAtlasProbes.normalise([])).toThrow();
});

test("events are asked only for connected or disconnected probes, over 26 hours", () => {
	const ids = activeProbeIds(probes.body);
	expect(ids.length).toBe(53);
	const url = new URL(eventsUrl(ids, Date.UTC(2026, 8, 24, 12)));
	expect(url.pathname).toBe("/api/v2/measurements/7000/results/");
	expect(Number(url.searchParams.get("stop")) - Number(url.searchParams.get("start"))).toBe(26 * 3_600);
	expect(url.searchParams.get("probe_ids")?.split(",").length).toBe(53);
	expect(activeProbeIds("{}")).toEqual([]);
});
