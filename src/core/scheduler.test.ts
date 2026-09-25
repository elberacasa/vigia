import { expect, test } from "bun:test";
import { Scheduler } from "./scheduler.ts";
import { Store } from "./store.ts";
import type { Adapter, HttpLike } from "./types.ts";

const http: HttpLike = {
	request: async () => ({ url: "", status: 200, contentType: "", body: "1", fetchedAt: 0 }),
};

function adapter(id: string, over: Partial<Adapter> = {}): Adapter {
	return {
		id,
		layer: "earth",
		name: { es: id, en: id },
		provider: "p",
		homepage: "https://example.org",
		licence: { id: "l", name: "l", url: "", attribution: "", commercial: true },
		keys: [],
		intervalMs: 60_000,
		freshness: { fetchMs: 60_000, dataMs: null },
		fetch: async (ctx) => [await ctx.http.request("https://example.org")],
		normalise: (raws) =>
			raws.map((r) => ({
				source: id,
				series: "x",
				sourceUrl: "https://example.org",
				fetchedAt: 1,
				observedAt: 1,
				licence: "l",
				value: Number(r.body),
				confidence: 1,
				basis: "measurement" as const,
			})),
		...over,
	};
}

test("a failing feed is recorded and does not affect a healthy one", async () => {
	const store = new Store(":memory:");
	const broken = adapter("broken", {
		normalise: () => {
			throw new Error("schema drift");
		},
	});
	const good = adapter("good");
	const s = new Scheduler([broken, good], { store, http, key: () => undefined });
	expect(await s.runOnce("broken")).toEqual({ ok: false, inserted: 0, error: "schema drift" });
	expect(await s.runOnce("good")).toEqual({ ok: true, inserted: 1, error: null });
	expect(store.lastSuccessAt("broken")).toBeNull();
	expect(s.runtime("broken")?.consecutiveFailures).toBe(1);
	expect(store.latest("good", "x")?.value).toBe(1);
});

test("an adapter may not write another source's rows", async () => {
	const store = new Store(":memory:");
	const liar = adapter("liar", {
		normalise: () => [
			{
				source: "other",
				series: "x",
				sourceUrl: "",
				fetchedAt: 1,
				observedAt: 1,
				licence: "l",
				value: 1,
				confidence: 1,
				basis: "measurement",
			},
		],
	});
	const s = new Scheduler([liar], { store, http, key: () => undefined });
	expect((await s.runOnce("liar")).ok).toBe(false);
	expect(store.latest("other", "x")).toBeNull();
});

test("feeds without their key are locked and not run by the loop", async () => {
	const store = new Store(":memory:");
	let calls = 0;
	const keyed = adapter("keyed", {
		keys: ["nasa-firms-map-key"],
		fetch: async () => {
			calls++;
			return [];
		},
	});
	const s = new Scheduler([keyed], { store, http, key: () => undefined });
	expect(s.isLocked(keyed)).toBe(true);
	s.start();
	await Bun.sleep(30);
	s.stop();
	expect(calls).toBe(0);
});

test("duplicate ids are rejected", () => {
	expect(
		() =>
			new Scheduler([adapter("a"), adapter("a")], {
				store: new Store(":memory:"),
				http,
				key: () => undefined,
			}),
	).toThrow("duplicate");
});

test("opt-in feeds do not run until enabled", async () => {
	const store = new Store(":memory:");
	let calls = 0;
	const p2p = adapter("p2p", {
		optIn: { es: "Términos poco claros", en: "Unclear terms" },
		fetch: async () => {
			calls++;
			return [];
		},
	});
	const off = new Scheduler([p2p], { store, http, key: () => undefined });
	expect(off.isEnabled(p2p)).toBe(false);
	off.start();
	await Bun.sleep(30);
	off.stop();
	expect(calls).toBe(0);
	const on = new Scheduler([p2p], { store, http, key: () => undefined, enabled: () => true });
	expect(on.isEnabled(p2p)).toBe(true);
});

test("a feed with a note (e.g. robots.txt) is on by default and can be turned off", () => {
	const store = new Store(":memory:");
	const noted = adapter("yt", { note: { es: "Su robots.txt excluye lectores automáticos", en: "robots" } });
	expect(new Scheduler([noted], { store, http, key: () => undefined }).isEnabled(noted)).toBe(true);
	const off = new Scheduler([noted], { store, http, key: () => undefined, enabled: () => false });
	expect(off.isEnabled(noted)).toBe(false);
});

test("a database failure while recording a run does not crash or wedge the scheduler", async () => {
	const store = new Store(":memory:");
	const logs: string[] = [];
	const s = new Scheduler([adapter("a")], { store, http, key: () => undefined, log: (l) => logs.push(l) });
	store.recordRun = () => {
		throw new Error("SQLITE_FULL: database or disk is full");
	};
	const result = await s.runOnce("a");
	expect(result.ok).toBe(true);
	expect(s.runtime("a")?.running).toBe(false);
	expect(logs.some((l) => l.includes("SQLITE_FULL"))).toBe(true);
});

test("feeds added while running can be replaced without losing their back-off or a run in flight, and removed", async () => {
	const store = new Store(":memory:");
	const s = new Scheduler([], { store, http, key: () => undefined });
	let release: () => void = () => {};
	const slow = adapter("mine", {
		fetch: async (ctx) => {
			await new Promise<void>((r) => {
				release = r;
			});
			return [await ctx.http.request("https://example.org")];
		},
		normalise: () => {
			throw new Error("broken feed");
		},
	});
	s.add(slow);
	expect(() => s.add(slow)).toThrow(/duplicate/);
	const run = s.runOnce("mine");
	expect(s.runtime("mine")?.running).toBe(true);
	s.replace(adapter("mine", { intervalMs: 120_000 }));
	release();
	await run;
	// The in-flight run cleared its own flag on the same slot, and its failure counts.
	expect(s.runtime("mine")).toMatchObject({ running: false, consecutiveFailures: 1 });
	s.replace(adapter("mine"));
	expect(s.runtime("mine")?.consecutiveFailures).toBe(1);
	s.remove("mine");
	expect(s.runtime("mine")).toBeNull();
});

test("drain waits for every run in flight, a feed added later (a user's own) or removed meanwhile included (review 4 L6)", async () => {
	const store = new Store(":memory:");
	let finish: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const s = new Scheduler([adapter("built-in")], { store, http, key: () => undefined });
	const mine = adapter("user-feed-1", {
		fetch: async (ctx) => {
			await gate;
			return [await ctx.http.request("https://example.org")];
		},
	});
	s.add(mine);
	const run = s.runOnce("user-feed-1");
	s.remove("user-feed-1"); // removed while its run is in flight: the run still finishes and is recorded
	expect(s.activeRuns).toBe(1);
	// Nothing finishes: drain gives up at its deadline and says so.
	expect(await s.drain(Date.now() + 60)).toBe(false);
	setTimeout(finish, 20);
	expect(await s.drain(Date.now() + 2_000)).toBe(true);
	expect(s.activeRuns).toBe(0);
	await run;
	expect(store.lastSuccessAt("user-feed-1")).not.toBeNull();
});

test("a run cut short by stopping Vigía is not recorded as the source failing (restart shows no false failures)", async () => {
	const store = new Store(":memory:");
	const recorded: string[] = [];
	const record = store.recordRun.bind(store);
	store.recordRun = (run) => {
		recorded.push(run.source);
		record(run);
	};
	const logs: string[] = [];
	const slow = adapter("slow", {
		fetch: (ctx) =>
			new Promise((_, reject) => {
				ctx.signal.addEventListener("abort", () => reject(new Error("The operation was aborted.")));
			}),
	});
	const s = new Scheduler([slow], { store, http, key: () => undefined, log: (l) => logs.push(l) });
	const run = s.runOnce("slow");
	s.stop();
	expect((await run).ok).toBe(false);
	expect(recorded).toEqual([]);
	expect(logs).toEqual([]);
	expect(s.runtime("slow")).toMatchObject({ running: false, consecutiveFailures: 0 });
	expect(s.activeRuns).toBe(0);
});
