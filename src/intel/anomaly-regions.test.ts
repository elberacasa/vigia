import { expect, test } from "bun:test";
import { Store } from "../core/store.ts";
import type { Json, Observation } from "../core/types.ts";
import { anomaliesFrom, groupRegions } from "../panels/anomalies.ts";
import { ANOMALY_RULES, chainByOnset, DAY, HOUR, MIN, revertedStep } from "./anomaly.ts";
import { dropOnset, type Judged, judgeAll, METRICS } from "./anomaly-series.ts";

const NOW = Date.UTC(2026, 8, 28, 22);

test("chaining by start: each within the window of the previous one", () => {
	const at = (m: number) => ({ onsetAt: NOW + m * MIN });
	expect(chainByOnset([at(0), at(20), at(45), at(200)], 30 * MIN).map((g) => g.length)).toEqual([3, 1]);
	expect(chainByOnset([at(0), at(31)], 30 * MIN).map((g) => g.length)).toEqual([1, 1]);
});

test("a drop's start: the first bin of the run below the threshold, missing bins inside it included", () => {
	const store = new Store(":memory:");
	const bin = 10 * MIN;
	const newest = Math.floor(NOW / bin) * bin;
	const rows: Observation[] = [];
	for (let t = newest - 8 * DAY; t <= newest; t += bin) {
		// Normal 1,000; from 50 minutes ago 300, with one bin missing in the run.
		if (t === newest - 20 * MIN) continue;
		const v = t >= newest - 50 * MIN ? 300 : 1_000;
		rows.push({
			source: "ioda-states",
			series: "state:VE-S:ping-slash24",
			sourceUrl: "x",
			fetchedAt: t,
			observedAt: t,
			licence: "ioda",
			value: { signal: "ping-slash24", value: v },
			confidence: 1,
			basis: "measurement",
		});
	}
	store.insert(rows);
	expect(dropOnset(store, "VE-S", "ping-slash24", newest, 0.85)).toBe(newest - 50 * MIN);
});

const judged = (entity: string, changePct: number, score: number, onsetAt: number): Judged => ({
	metric: METRICS.connectivity,
	entity,
	feed: "ioda-states",
	sourceUrl: "https://ioda.inetintel.cc.gatech.edu/",
	observedAt: NOW - 10 * MIN,
	fetchedAt: NOW,
	result: {
		unusual: true,
		direction: "down",
		value: 1,
		baseline: 2,
		changePct,
		score,
		tail: null,
		points: 7,
	},
	from: NOW - 7 * DAY,
	to: NOW - DAY,
	detail: { level: "severe", onsetAt },
});

test("states that dropped together are one regional item, each with its own figure; a lone state stays alone", () => {
	const view = anomaliesFrom(
		[
			judged("ve.tachira", -62.6, -37.6, NOW - 60 * MIN),
			judged("ve.amazonas", -57.1, -34.3, NOW - 50 * MIN),
			judged("ve.zulia", -40, -12, NOW - 5 * HOUR),
		],
		NOW,
		[],
	);
	expect(view.items.map((i) => i.metric.id).sort()).toEqual(["connectivity", "connectivity.region"]);
	const region = view.items.find((i) => i.members !== null);
	expect(region?.title.es).toBe("Caída simultánea de conectividad: Táchira (−62,6 %) y Amazonas (−57,1 %)");
	expect(region).toMatchObject({
		entity: { id: "ve" },
		value: null,
		baseline: null,
		changePct: null,
		score: -37.6,
	});
	expect(region?.members?.map((m) => [m.entity.id, m.changePct])).toEqual([
		["ve.tachira", -62.6],
		["ve.amazonas", -57.1],
	]);
	expect(view.grouped.map((g) => [g.entity.id, g.groupId])).toEqual([
		["ve.tachira", region?.id ?? null],
		["ve.amazonas", region?.id ?? null],
	]);
	expect(view.counts).toMatchObject({ unusual: 3, regions: 1, grouped: 2 });
	expect(region?.rule.es).toContain("sin promediar");
	// Nothing to group: the list is unchanged.
	const lone = groupRegions(view.grouped.slice(0, 1).map((g) => ({ ...g, groupId: null })));
	expect(lone.grouped).toEqual([]);
});

test("a move reverted within the stated points: the earlier step, found only when it was unusual", () => {
	const flat = Array.from({ length: 40 }, () => 100);
	expect(revertedStep([...flat, 110, 110, 100.5], (k) => k === 40)).toEqual({ step: 40, afterSteps: 2 });
	// Not back within a quarter of the jump: not reverted.
	expect(revertedStep([...flat, 110, 104], (k) => k === 40)).toBeNull();
	// Back, but the step was ordinary: nothing to relabel.
	expect(revertedStep([...flat, 110, 100], () => false)).toBeNull();
	// Too late: more than maxSteps points after.
	const late = [...flat, 110, ...Array.from({ length: ANOMALY_RULES.revert.maxSteps }, () => 110), 100];
	expect(revertedStep(late, (k) => k === 40)).toBeNull();
	// Already reverted at an earlier point: that pair was told then.
	expect(revertedStep([...flat, 110, 100, 100], (k) => k === 40)).toBeNull();
});

test("reserves through the reader: a spike taken back is one item, labelled, ranked after the others", () => {
	const store = new Store(":memory:");
	const rows: Observation[] = [];
	const dates: number[] = [];
	for (let t = Date.UTC(2025, 5, 2, 4); dates.length < 90; t += DAY) {
		const d = new Date(t).getUTCDay();
		if (d !== 0 && d !== 6) dates.push(t);
	}
	// Mid-month dates only matter here; a 12 % jump on point 80, back on point 82.
	dates.forEach((t, i) => {
		const v = i === 80 || i === 81 ? 14_560 : 13_000 + (i % 3);
		rows.push({
			source: "bcv-reserves",
			series: "reserves",
			sourceUrl: "https://www.bcv.org.ve/",
			fetchedAt: t,
			observedAt: t,
			licence: "bcv",
			value: { date: new Date(t).toISOString().slice(0, 10), totalMusd: v } as Json,
			confidence: 1,
			basis: "official",
		});
	});
	store.insert(rows.slice(0, 83));
	const at = (dates[82] as number) + 12 * HOUR;
	const j = judgeAll(store, at, { connectivity: null, linkBacklog: 0, classes: new Set(["change"]) }).find(
		(x) => x.metric.id === "bcv.reserves",
	);
	expect(j?.observedAt).toBe(dates[80]);
	expect(j?.detail).toMatchObject({ reverted: true, revertedAfterSteps: 2 });
	const view = anomaliesFrom(
		[j as Judged, { ...judged("ve.zulia", -30, -5, NOW), detail: { level: "severe" } }],
		at,
		[],
	);
	expect(view.items.map((i) => i.metric.id)).toEqual(["connectivity", "bcv.reserves"]);
	const r = view.items[1];
	expect(r?.reverted?.text.es).toContain("revertido por el BCV a los 2 días hábiles");
	expect(r?.title.es).toContain("revertido por el BCV");
	expect(r?.reverted?.value).toBe(13_000 + (82 % 3));
	expect(view.counts.reverted).toBe(1);
});
