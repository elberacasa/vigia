import { expect, test } from "bun:test";
import type { VsfSite } from "../adapters/vesinfiltro-blocks/index.ts";
import { Store } from "../core/store.ts";
import { blockTimeline } from "./blocktimeline.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1, 4);

function vsf(store: Store, at: number, cells: VsfSite["isps"]) {
	const value: VsfSite = {
		site: "Ejemplo",
		domain: "ejemplo.com",
		key: "ejemplo.com",
		active: true,
		category: "Medios",
		isps: cells,
		updated: new Date(at).toISOString().slice(0, 10),
	};
	store.insert([
		{
			source: "vesinfiltro-blocks",
			series: "site:ejemplo.com",
			sourceUrl: "x",
			fetchedAt: at,
			observedAt: at,
			licence: "l",
			value,
			confidence: 1,
			basis: "report",
		},
	]);
}

function ooniRun(store: Store, at: number, flagged: Record<string, string[]>, measurements = 400_000) {
	store.insert([
		{
			source: "ooni-ve",
			series: "country:VE:summary",
			sourceUrl: "x",
			fetchedAt: at,
			observedAt: at,
			licence: "l",
			value: { kind: "summary", measurements, anomalies: 0 },
			confidence: 1,
			basis: "measurement",
		},
		...Object.entries(flagged).map(([domain, isps]) => ({
			source: "ooni-ve",
			series: `domain:${domain}`,
			sourceUrl: "x",
			fetchedAt: at,
			observedAt: at,
			licence: "l",
			value: {
				kind: "domain",
				domain,
				isps: isps.map((isp) => ({ isp, measurements: 20, anomalies: 15, anomalyRate: 0.75, flagged: true })),
			},
			confidence: 1,
			basis: "measurement" as const,
		})),
	]);
}

test("VE sin Filtro: a block and an unblock between two list updates, per ISP", () => {
	const store = new Store(":memory:");
	vsf(store, T0, [
		{ isp: "cantv", status: "blocked", methods: ["DNS"] },
		{ isp: "movistar", status: "ok", methods: [] },
	]);
	vsf(store, T0 + 3 * DAY, [
		{ isp: "cantv", status: "ok", methods: [] },
		{ isp: "movistar", status: "blocked", methods: ["DNS", "HTTP/HTTPS"] },
	]);
	const tl = blockTimeline(store, T0 + 4 * DAY);
	expect(tl.changes.map((c) => [c.kind, c.isp, c.after, c.by])).toEqual([
		["unblocked", "cantv", T0, T0 + 3 * DAY],
		["blocked", "movistar", T0, T0 + 3 * DAY],
	]);
	expect(tl.changes[1]?.methods).toEqual(["DNS", "HTTP/HTTPS"]);
	expect(tl.watchingSince.vesinfiltro).toBe(T0);
});

test("the first version is a baseline, and 'no data' is not an unblock", () => {
	const store = new Store(":memory:");
	vsf(store, T0, [{ isp: "cantv", status: "blocked", methods: ["DNS"] }]);
	expect(blockTimeline(store, T0 + DAY).changes).toEqual([]);
	vsf(store, T0 + DAY, [{ isp: "cantv", status: "no-data", methods: [] }]);
	expect(blockTimeline(store, T0 + 2 * DAY).changes).toEqual([]);
});

const H3 = 3 * 3_600_000;
const ooniKinds = (store: Store, at: number) =>
	blockTimeline(store, at)
		.changes.filter((c) => c.source === "ooni")
		.map((c) => `${c.kind}:${c.domain}:${c.isp}`)
		.sort();

test("OONI: a new flag is an event at once; a flag ends only after two consecutive complete runs without it", () => {
	const store = new Store(":memory:");
	ooniRun(store, T0, { "a.com": ["cantv"], "b.com": ["cantv", "digitel"] });
	ooniRun(store, T0 + H3, { "b.com": ["cantv"], "c.com": ["inter"] });
	// One absence is not enough.
	expect(ooniKinds(store, T0 + DAY)).toEqual(["flagged:c.com:inter"]);
	ooniRun(store, T0 + 2 * H3, { "b.com": ["cantv"], "c.com": ["inter"] });
	const tl = blockTimeline(store, T0 + DAY);
	expect(ooniKinds(store, T0 + DAY)).toEqual([
		"flagged:c.com:inter",
		"unflagged:a.com:cantv",
		"unflagged:b.com:digitel",
	]);
	// The change happened between the last run that flagged it and the first that did not.
	const a = tl.changes.find((c) => c.domain === "a.com");
	expect([a?.after, a?.by]).toEqual([T0, T0 + H3]);
	expect(tl.versions.ooni).toBe(3);
});

test("OONI: a domain near the threshold that drops out for one run and returns does not flicker", () => {
	const store = new Store(":memory:");
	ooniRun(store, T0, { "a.com": ["cantv"] });
	ooniRun(store, T0 + H3, {});
	ooniRun(store, T0 + 2 * H3, { "a.com": ["cantv"] });
	ooniRun(store, T0 + 3 * H3, {});
	ooniRun(store, T0 + 4 * H3, { "a.com": ["cantv"] });
	expect(ooniKinds(store, T0 + DAY)).toEqual([]);
});

test("OONI: an empty or thin run is not evidence that anything was unblocked (review 2, H6)", () => {
	const store = new Store(":memory:");
	const flagged = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`d${i}.com`, ["cantv"]]));
	for (let i = 0; i < 4; i++) ooniRun(store, T0 + i * H3, flagged, 400_000 + i * 1_000);
	// OONI answers with nothing, twice, then with a quarter of the usual volume, twice.
	ooniRun(store, T0 + 4 * H3, {}, 0);
	ooniRun(store, T0 + 5 * H3, {}, 0);
	ooniRun(store, T0 + 6 * H3, { "d0.com": ["cantv"] }, 100_000);
	ooniRun(store, T0 + 7 * H3, { "d0.com": ["cantv"] }, 100_000);
	expect(ooniKinds(store, T0 + DAY)).toEqual([]);
	// Back to normal volume with the same set: still nothing.
	ooniRun(store, T0 + 8 * H3, flagged, 390_000);
	expect(ooniKinds(store, T0 + DAY)).toEqual([]);
	// Two complete runs without d1 do end its flag.
	const without = { ...flagged };
	delete without["d1.com"];
	ooniRun(store, T0 + 9 * H3, without, 395_000);
	ooniRun(store, T0 + 10 * H3, without, 401_000);
	expect(ooniKinds(store, T0 + 2 * DAY)).toEqual(["unflagged:d1.com:cantv"]);
});

test("real OONI adapter output: identical runs give no changes, even when the optional request fails", async () => {
	const { join } = await import("node:path");
	const { loadFixture } = await import("../core/fixtures.ts");
	const { ooniVe } = await import("../adapters/ooni-ve/index.ts");
	const raws = loadFixture(join(import.meta.dir, "..", "adapters", "ooni-ve", "fixtures", "2026-09-24"));
	const store = new Store(":memory:");
	const H3 = 3 * 3_600_000;
	for (let i = 0; i < 4; i++) {
		const shifted = raws.map((r) => ({ ...r, fetchedAt: r.fetchedAt + i * H3 }));
		// Run 2 loses the optional "latest measurement" response.
		const run = i === 2 ? shifted.slice(0, 2) : shifted;
		store.insert(ooniVe.normalise(run));
	}
	const tl = blockTimeline(store, (raws[2]?.fetchedAt ?? 0) + 5 * H3);
	expect(tl.versions.ooni).toBe(4);
	expect(tl.changes.filter((c) => c.source === "ooni")).toEqual([]);
});

test("real OONI adapter output: a domain leaving the flagged set is one 'unflagged' change per ISP", async () => {
	const { join } = await import("node:path");
	const { loadFixture } = await import("../core/fixtures.ts");
	const { ooniVe } = await import("../adapters/ooni-ve/index.ts");
	const raws = loadFixture(join(import.meta.dir, "..", "adapters", "ooni-ve", "fixtures", "2026-09-24"));
	const store = new Store(":memory:");
	const first = ooniVe.normalise(raws);
	store.insert(first);
	const flagged = first.filter((o) => o.series.startsWith("domain:"));
	const dropped = flagged[0];
	if (!dropped) throw new Error("fixture has no flagged domain");
	const later = raws.map((r) => ({ ...r, fetchedAt: r.fetchedAt + 3 * 3_600_000 }));
	const second = ooniVe.normalise(later).filter((o) => o.series !== dropped.series);
	store.insert(second);
	// One run without it is not yet an unflag.
	expect(blockTimeline(store, (raws[2]?.fetchedAt ?? 0) + 4 * 3_600_000).changes).toEqual([]);
	const third = raws.map((r) => ({ ...r, fetchedAt: r.fetchedAt + 6 * 3_600_000 }));
	store.insert(ooniVe.normalise(third).filter((o) => o.series !== dropped.series));
	const tl = blockTimeline(store, (raws[2]?.fetchedAt ?? 0) + 7 * 3_600_000);
	const ooni = tl.changes.filter((c) => c.source === "ooni");
	expect(ooni.length).toBeGreaterThan(0);
	expect(new Set(ooni.map((c) => `${c.kind}:${c.domain}`))).toEqual(
		new Set([`unflagged:${dropped.series.slice(7)}`]),
	);
});
