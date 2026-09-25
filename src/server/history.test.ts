import { expect, test } from "bun:test";
import { join } from "node:path";
import { iodaStates } from "../adapters/ioda-states/index.ts";
import { BIN_MS } from "../adapters/ioda-states/ioda.ts";
import { IODA_REGIONS } from "../adapters/ioda-states/regions.ts";
import { hasFixture, loadFixture } from "../core/fixtures.ts";
import { Store } from "../core/store.ts";
import type { Observation } from "../core/types.ts";
import { connectivityView } from "../panels/connectivity.ts";
import {
	CARACAS_OFFSET_MS,
	connectivityHistory,
	createHistoryService,
	MAX_SPAN_MS,
	normaliseRequest,
	parseInstant,
	SLICE_MS,
} from "./history.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const LAST_BIN = Date.UTC(2026, 8, 24, 20, 0);
const NOW = LAST_BIN + 25 * MIN;

/** 10-minute bins over 9 days ending at LAST_BIN. */
function binObs(series: string, f: (t: number) => number | null): Observation[] {
	const out: Observation[] = [];
	for (let t = LAST_BIN - 9 * DAY; t <= LAST_BIN; t += BIN_MS) {
		const v = f(t);
		if (v === null) continue;
		out.push({
			source: "ioda-states",
			series,
			sourceUrl: "https://ioda.inetintel.cc.gatech.edu/region/4488",
			fetchedAt: t + 20 * MIN,
			observedAt: t,
			licence: "ioda-all-rights-reserved",
			value: { value: v },
			confidence: 0.8,
			basis: "measurement",
		});
	}
	return out;
}
const wobble = (t: number) => 1 + 0.02 * Math.sin(t / 7_777_777);

test("request parsing: defaults, alignment, span caps and bad input", () => {
	expect(parseInstant("2026-09-24T18:00")).toBe(Date.UTC(2026, 8, 24, 18));
	expect(parseInstant("2026-09-24T18:00-04:00")).toBe(Date.UTC(2026, 8, 24, 22));
	expect(parseInstant(String(NOW))).toBe(NOW);
	expect(parseInstant("yesterday")).toBeNull();
	expect(parseInstant("2026-09-24T18:00;drop")).toBeNull();

	const def = normaliseRequest({ from: null, to: null, step: null }, NOW);
	expect(def).toEqual({ from: LAST_BIN + HOUR - 48 * HOUR, to: LAST_BIN + HOUR, step: "1h" });
	// A window longer than the step allows is cut from the old end.
	const long = normaliseRequest({ from: String(NOW - 60 * DAY), to: null, step: "1h" }, NOW);
	expect("error" in long ? 0 : long.to - long.from).toBe(MAX_SPAN_MS["1h"]);
	// The future is never asked for.
	const future = normaliseRequest({ from: null, to: String(NOW + 5 * DAY), step: "6h" }, NOW);
	// Steps start on Caracas boundaries: 6 h steps at 00/06/12/18 Caracas (04/10/16/22 UTC), days at Caracas midnight.
	expect("error" in future ? 0 : future.to).toBe(Date.UTC(2026, 8, 24, 22));
	const days = normaliseRequest({ from: String(NOW - 3 * DAY), to: null, step: "1d" }, NOW);
	if ("error" in days) throw new Error(days.error);
	expect(new Date(days.from).getUTCHours()).toBe(4);
	expect(new Date(days.to).getUTCHours()).toBe(4);
	expect(normaliseRequest({ from: null, to: null, step: "5m" }, NOW)).toEqual({
		error: "Paso no válido: use 1h, 6h o 1d.",
	});
	expect("error" in normaliseRequest({ from: "x", to: null, step: null }, NOW)).toBe(true);
	expect("error" in normaliseRequest({ from: String(NOW), to: String(NOW - HOUR), step: null }, NOW)).toBe(
		true,
	);
});

test("replay: a cut shows in the hours it happened, severe only where two signals agree, then recovers", () => {
	const store = new Store(":memory:");
	// Zulia: probing and telescope collapse to 20 % from 14:00 to 16:00 UTC on the last day; Lara: probing only.
	const cutFrom = LAST_BIN - 6 * HOUR;
	const cutTo = LAST_BIN - 4 * HOUR;
	const cut = (level: number) => (t: number) => (t >= cutFrom && t < cutTo ? 0.2 : 1) * level * wobble(t);
	const steady = (level: number) => (t: number) => level * wobble(t);
	for (const iso of ["VE-V", "VE-K"]) {
		store.insert(binObs(`state:${iso}:bgp`, steady(400)));
		store.insert(binObs(`state:${iso}:ping-slash24`, cut(300)));
		store.insert(binObs(`state:${iso}:merit-nt`, iso === "VE-V" ? cut(40) : steady(40)));
	}
	const req = normaliseRequest({ from: String(LAST_BIN - 10 * HOUR), to: null, step: "1h" }, NOW);
	if ("error" in req) throw new Error(req.error);
	const h = connectivityHistory(store, req, NOW);
	expect(h.times.length).toBe(11);
	expect(h.times[0]).toBe(LAST_BIN - 10 * HOUR);
	// Hours are judged at their close: the 14:00 hour closes at 15:00, inside the cut.
	const at = (t: number) => h.times.indexOf(t);
	const zulia = h.states["VE-V"] ?? "";
	const lara = h.states["VE-K"] ?? "";
	expect(zulia[at(cutFrom - HOUR)]).toBe("n"); // 13:00–14:00, closes at the first cut bin: not yet read
	expect(zulia[at(cutFrom)]).toBe("s");
	expect(zulia[at(cutFrom + HOUR)]).toBe("s");
	// Lara: only probing fell (severe on its own), the other two signals stayed normal → a drop, not severe.
	expect(lara[at(cutFrom)]).toBe("d");
	expect(zulia[at(cutTo)]).toBe("n");
	// States without data are "x" the whole way.
	expect(h.states["VE-W"]).toBe("x".repeat(11));
	expect(h.counts[at(cutFrom)]).toEqual({ normal: 0, drop: 1, severe: 1, noData: 23 });
	expect(h.firstJudgedAt).toBe(h.times[0] ?? -1);
	expect(h.feed).toBe("ioda-states");

	// Six-hour steps keep the worst hour.
	const six = normaliseRequest({ from: String(LAST_BIN - 12 * HOUR), to: null, step: "6h" }, NOW);
	if ("error" in six) throw new Error(six.error);
	const h6 = connectivityHistory(store, six, NOW);
	expect(h6.states["VE-V"]).toContain("s");
	expect(h6.states["VE-V"]?.length).toBe(h6.times.length);
});

const IODA_CAPTURE = join(import.meta.dir, "..", "adapters", "ioda-states", "fixtures", "2026-09-24");

// IODA's recording is not redistributable, so it is absent from the public repository (see hasFixture).
test.skipIf(!hasFixture(IODA_CAPTURE))(
	"the hour in progress equals the live panel, over the recorded 8-day IODA capture",
	() => {
		const store = new Store(":memory:");
		let now = 0;
		const raws = loadFixture(IODA_CAPTURE);
		for (const r of raws) now = Math.max(now, r.fetchedAt);
		store.insert(iodaStates.normalise(raws) as Observation[]);
		const live = connectivityView(store, now);
		const req = normaliseRequest({ from: null, to: null, step: "1h" }, now);
		if ("error" in req) throw new Error(req.error);
		const started = performance.now();
		const h = connectivityHistory(store, req, now);
		const ms = performance.now() - started;
		expect(h.times.length).toBe(48);
		for (const s of live.states) {
			const code = { normal: "n", drop: "d", severe: "s", "no-data": "x" }[s.level];
			expect(`${s.id}:${h.states[s.id]?.at(-1)}`).toBe(`${s.id}:${code}`);
		}
		// Lara was the one state below its band that evening.
		expect(h.states["VE-K"]?.at(-1)).toBe("d");
		// 48 h × 24 states × 3 signals, cold.
		expect(ms).toBeLessThan(3_000);
		expect(JSON.stringify(h).length).toBeLessThan(12_000);
	},
);

test("service: layer check, 400 on bad input (own keys only), cache and archive keep answers identical", async () => {
	const store = new Store(":memory:");
	store.insert(binObs("state:VE-V:bgp", (t) => 400 * wobble(t)));
	let t = NOW;
	const service = createHistoryService(store, () => t);
	expect((await service.handle("fires", new URLSearchParams())).status).toBe(404);
	expect((await service.handle("connectivity", new URLSearchParams("step=2h"))).status).toBe(400);
	// Inherited keys of the steps object are not steps (review 3 H9: they returned 200 with from: null).
	for (const bad of ["__proto__", "toString", "constructor", "hasOwnProperty"])
		expect((await service.handle("connectivity", new URLSearchParams(`step=${bad}`))).status).toBe(400);
	const first = await service.handle("connectivity", new URLSearchParams("step=1h"));
	expect(first.status).toBe(200);
	const cached = await service.handle("connectivity", new URLSearchParams("step=1h"));
	expect(cached.body).toBe(first.body);
	t = NOW + 2 * MIN; // past the 60 s cache: recomputed (settled hours from the archive), same answer
	const again = await service.handle("connectivity", new URLSearchParams("step=1h"));
	expect(again.body).not.toBe(first.body);
	expect((again.body as { states: unknown }).states).toEqual((first.body as { states: unknown }).states);
});

/**
 * Six states with three signals over 9 days (the other 19 have no data, which the replay still judges), and a cut in
 * Zulia and Lara 30 h before LAST_BIN.
 */
const WITH_DATA = new Set(["VE-V", "VE-K", "VE-L", "VE-A", "VE-M", "VE-G"]);
function fullStore(): Store {
	const store = new Store(":memory:");
	const cutFrom = LAST_BIN - 30 * HOUR;
	const cutTo = LAST_BIN - 27 * HOUR;
	for (const r of IODA_REGIONS.filter((x) => WITH_DATA.has(x.iso))) {
		const cut = r.iso === "VE-V" || r.iso === "VE-K";
		const f = (level: number) => (t: number) =>
			(cut && t >= cutFrom && t < cutTo ? 0.2 : 1) * level * wobble(t + r.iso.charCodeAt(3) * HOUR);
		store.insert(binObs(`state:${r.iso}:bgp`, f(400)));
		store.insert(binObs(`state:${r.iso}:ping-slash24`, f(300)));
		store.insert(binObs(`state:${r.iso}:merit-nt`, f(40)));
	}
	return store;
}

const reference = (store: Store, q: string, now = NOW) => {
	const p = new URLSearchParams(q);
	const req = normaliseRequest({ from: p.get("from"), to: p.get("to"), step: p.get("step") }, now);
	if ("error" in req) throw new Error(req.error);
	return connectivityHistory(store, req, now);
};

const statesOf = (r: { body: unknown }) => (r.body as { states: Record<string, string> }).states;

test("H9: settled hours are archived in the store; a second service (or a restart) reads them back, same answer", async () => {
	const store = fullStore();
	const pure = reference(store, "step=1h");
	expect(pure.states["VE-V"]).toContain("s");
	const cold = createHistoryService(store, () => NOW);
	const first = await cold.handle("connectivity", new URLSearchParams("step=1h"));
	expect(statesOf(first)).toEqual(pure.states);
	expect(cold.stats.evaluated).toBe(48 * 25);
	const warm = createHistoryService(store, () => NOW);
	const second = await warm.handle("connectivity", new URLSearchParams("step=1h"));
	expect(statesOf(second)).toEqual(pure.states);
	// Only the hour in progress is evaluated again.
	expect(warm.stats.evaluated).toBe(25);
});

test("H9: a revised or backfilled bin drops the archived levels it could change; pruning drops the ones it fed", async () => {
	const store = fullStore();
	const q = "step=1h";
	await createHistoryService(store, () => NOW).handle("connectivity", new URLSearchParams(q));
	// IODA revises Mérida's probing 20 h back down to 10 %, for two hours: a severe-capable drop that was not there.
	const from = LAST_BIN - 20 * HOUR;
	const revised = binObs("state:VE-L:ping-slash24", (t) =>
		t >= from && t < from + 2 * HOUR ? 30 : 300 * wobble(t + "L".charCodeAt(0) * HOUR),
	).filter((o) => o.observedAt >= from && o.observedAt < from + 2 * HOUR);
	store.insert(revised.map((o) => ({ ...o, fetchedAt: NOW })));
	store.insert(
		binObs("state:VE-L:merit-nt", () => 4).filter(
			(o) => o.observedAt >= from && o.observedAt < from + 2 * HOUR,
		),
	);
	const after = createHistoryService(store, () => NOW);
	const res = await after.handle("connectivity", new URLSearchParams(q));
	const pure = reference(store, q);
	expect(pure.states["VE-L"]).toContain("s");
	expect(statesOf(res)).toEqual(pure.states);
	// Only Mérida's hours after the revised bin were recomputed, plus every state's unsettled hours.
	expect(after.stats.evaluated).toBeLessThan(25 + 21);

	// Retention prunes the oldest two days: levels that read them are recomputed (fewer baseline days now).
	store.pruneObservations(LAST_BIN - 7 * DAY);
	const pruned = createHistoryService(store, () => NOW);
	const q7 = `step=6h&from=${NOW - 7 * DAY}`;
	expect(statesOf(await pruned.handle("connectivity", new URLSearchParams(q7)))).toEqual(
		reference(store, q7).states,
	);
});

test("H9: a cold replay never holds the event loop; the synchronous replay would", async () => {
	const store = fullStore();
	const q = `step=6h&from=${NOW - 3 * DAY}`;
	const t0 = performance.now();
	reference(store, q);
	const blocking = performance.now() - t0;
	let last = performance.now();
	let longest = 0;
	const timer = setInterval(() => {
		const t = performance.now();
		longest = Math.max(longest, t - last);
		last = t;
	}, 2);
	const service = createHistoryService(store, () => NOW);
	const res = await service.handle("connectivity", new URLSearchParams(q));
	clearInterval(timer);
	expect(res.status).toBe(200);
	expect(statesOf(res)).toEqual(reference(store, q).states);
	// The same work in one piece holds the loop for its whole length; sliced, the longest stall is about SLICE_MS.
	expect(blocking).toBeGreaterThan(3 * SLICE_MS);
	expect(longest).toBeLessThan(Math.max(50, blocking / 3));
});

test("H9: identical requests share one replay; different ones queue, and past the queue bound get a 503", async () => {
	const store = fullStore();
	const service = createHistoryService(store, () => NOW, { maxPending: 1 });
	const q = new URLSearchParams(`step=6h&from=${NOW - 3 * DAY}`);
	const [a, b, other] = await Promise.all([
		service.handle("connectivity", q),
		service.handle("connectivity", q),
		service.handle("connectivity", new URLSearchParams("step=1h")),
	]);
	expect(a).toBe(b);
	const solo = createHistoryService(fullStore(), () => NOW);
	await solo.handle("connectivity", q);
	expect(service.stats.evaluated).toBe(solo.stats.evaluated);
	expect(other.status).toBe(503);
	expect(other.retryAfter).toBeGreaterThan(0);
});

test("H9: a request past its time budget is a 503, keeps the hours it finished, and a retry continues", async () => {
	const store = fullStore();
	const q = `step=6h&from=${NOW - 3 * DAY}`;
	const t0 = performance.now();
	const expected = reference(store, q);
	// A budget of a third of the whole replay: the first attempts run out, each continuing where the last stopped.
	// (The budget must cover the hour in progress, which is evaluated on every request: 25 states, one hour each.)
	const budgetMs = (performance.now() - t0) / 3;
	let attempts = 0;
	let evaluated = 0;
	let res: Awaited<ReturnType<ReturnType<typeof createHistoryService>["handle"]>>;
	do {
		const service = createHistoryService(store, () => NOW, { budgetMs });
		res = await service.handle("connectivity", new URLSearchParams(q));
		evaluated += service.stats.evaluated;
		attempts++;
	} while (res.status === 503 && attempts < 20);
	expect(attempts).toBeGreaterThan(1);
	expect(res.status).toBe(200);
	expect(statesOf(res)).toEqual(expected.states);
	// Retries continued rather than restarted: closed hours were evaluated once overall (plus one hour in progress
	// per state per attempt, and at most the evaluation cut short by each deadline).
	const solo = createHistoryService(fullStore(), () => NOW);
	await solo.handle("connectivity", new URLSearchParams(q));
	expect(evaluated).toBeLessThanOrEqual(solo.stats.evaluated + (attempts - 1) * 25);
}, 30_000);

test("H9: warm() fills the archive in the background so a later request reads finished hours", async () => {
	const store = fullStore();
	const service = createHistoryService(store, () => NOW, { warmPauseMs: 0 });
	const filled = await service.warm(2);
	expect(filled).toBeGreaterThan(40 * 25);
	const reader = createHistoryService(store, () => NOW);
	const res = await reader.handle("connectivity", new URLSearchParams("step=1h"));
	expect(statesOf(res)).toEqual(reference(store, "step=1h").states);
	expect(reader.stats.evaluated).toBe(25);
});

test("GET /api/history/connectivity: served with a short private cache, bad input is a 400, and it is rate limited", async () => {
	const { createApp } = await import("./app.ts");
	const { PanelCache } = await import("./panels.ts");
	const { Scheduler } = await import("../core/scheduler.ts");
	const store = new Store(":memory:");
	store.insert(binObs("state:VE-V:bgp", (t) => 400 * wobble(t)));
	const http = {
		request: async () => {
			throw new Error("offline");
		},
	};
	const app = createApp({
		store,
		scheduler: new Scheduler([], { store, http, key: () => undefined }),
		adapters: [],
		keys: { get: () => undefined, has: () => false, set: () => {}, remove: () => {}, origin: () => null },
		keySpecs: [],
		panels: new PanelCache([], store),
		http,
		version: "test",
		sessionToken: "t".repeat(32),
		now: () => NOW,
	});
	const get = (q: string) =>
		app.fetch(
			new Request(`http://localhost:7722/api/history/connectivity${q}`, {
				headers: { host: "localhost:7722" },
			}),
			"127.0.0.1",
		);
	const ok = await get("?step=1h");
	expect(ok.status).toBe(200);
	expect(ok.headers.get("cache-control")).toBe("private, max-age=60");
	const body = (await ok.json()) as { times: number[]; states: Record<string, string> };
	expect(body.times.length).toBe(48);
	expect(Object.keys(body.states).length).toBe(25);
	expect((await get("?step=2h")).status).toBe(400);
	expect(
		(
			await app.fetch(
				new Request("http://localhost:7722/api/history/fires", { headers: { host: "localhost:7722" } }),
				"127.0.0.1",
			)
		).status,
	).toBe(404);
	// 20 per client, then 429 (the general API bucket is larger).
	let limited = 0;
	for (let i = 0; i < 25; i++) if ((await get("?step=1h")).status === 429) limited++;
	expect(limited).toBeGreaterThan(0);
	app.closeStreams();
});

test("archived hours and Caracas-aligned steps share one hour grid: a warmed archive serves 1 d and 6 h steps", async () => {
	expect(CARACAS_OFFSET_MS % HOUR).toBe(0);
	const store = fullStore();
	await createHistoryService(store, () => NOW, { warmPauseMs: 0 }).warm(8);
	for (const q of [`step=1d&from=${NOW - 7 * DAY}`, `step=6h&from=${NOW - 3 * DAY}`]) {
		const reader = createHistoryService(store, () => NOW);
		const res = await reader.handle("connectivity", new URLSearchParams(q));
		const body = res.body as { times: number[]; states: Record<string, string> };
		// Steps start at Caracas boundaries (04:00, 10:00, 16:00, 22:00 UTC)…
		for (const t of body.times) expect((t - CARACAS_OFFSET_MS) % (q.includes("1d") ? DAY : 6 * HOUR)).toBe(0);
		// …and every closed hour inside them comes from the archive: only the hour in progress is evaluated.
		expect(reader.stats.evaluated).toBe(25);
		expect(body.states).toEqual(reference(store, q).states);
	}
});

test("L8 (review 4): a watermark far behind is synced in slices that yield, with the same result as one piece", async () => {
	const store = fullStore();
	await createHistoryService(store, () => NOW).handle("connectivity", new URLSearchParams("step=1h"));
	// A day of revisions for every state arrives while no request runs: the watermark falls far behind.
	for (const r of IODA_REGIONS.filter((x) => WITH_DATA.has(x.iso)))
		for (const s of ["bgp", "ping-slash24", "merit-nt"])
			store.insert(binObs(`state:${r.iso}:${s}`, (t) => 7 + (t % 13)).map((o) => ({ ...o, fetchedAt: NOW })));
	const { LevelArchive } = await import("./history.ts");
	const archive = new LevelArchive(store);
	const steps = archive.syncSteps(500, 0);
	let pauses = 0;
	let longest = 0;
	for (;;) {
		const t0 = performance.now();
		const step = steps.next();
		longest = Math.max(longest, performance.now() - t0);
		if (step.done) break;
		pauses++;
	}
	// About 23,000 new rows (6 states, 3 signals, 9 days) in ranges of 500: it pauses between ranges, and no range
	// holds the loop.
	expect(pauses).toBeGreaterThan(40);
	expect(longest).toBeLessThan(SLICE_MS + 40);
	// The range query uses the rowid, not the (source, …) index that made each range scan every IODA row.
	const plan = store.db
		.query<{ detail: string }, []>(
			"EXPLAIN QUERY PLAN SELECT series, MIN(observed_at) AS t FROM obs WHERE id > 0 AND id <= 9 AND +source = 'ioda-states' GROUP BY series",
		)
		.all()
		.map((r) => r.detail)
		.join(" ");
	expect(plan).toContain("INTEGER PRIMARY KEY");
	// Everything the new rows could change was dropped: the next answer equals the pure replay.
	const q = "step=1h";
	expect(
		statesOf(await createHistoryService(store, () => NOW).handle("connectivity", new URLSearchParams(q))),
	).toEqual(reference(store, q).states);
});
