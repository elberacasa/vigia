import { expect, test } from "bun:test";
import type { KeyStore } from "../config/keys.ts";
import { sessionCookieName } from "../config/session.ts";
import { MB_PER_DAY } from "../core/bandwidth.gen.ts";
import { feedOn, isHeavy, type Machine, type SaverState, saverState } from "../core/bandwidth.ts";
import { Scheduler } from "../core/scheduler.ts";
import { Store } from "../core/store.ts";
import type { Adapter, HttpLike } from "../core/types.ts";
import { createApp } from "./app.ts";
import { ffmpegView } from "./bandwidth-routes.ts";
import { PanelCache } from "./panels.ts";

const TOKEN = "cd".repeat(32);
const COOKIE = `${sessionCookieName(TOKEN)}=${TOKEN}`;

const feed = (id: string, over: Partial<Adapter> = {}): Adapter =>
	({
		id,
		layer: "earth",
		name: { es: id, en: id },
		provider: "p",
		homepage: "https://example.org",
		licence: { id: "l", name: "l", url: "", attribution: "", commercial: true },
		keys: [],
		intervalMs: 600_000,
		freshness: { fetchMs: 600_000, dataMs: null },
		fetch: async () => [],
		normalise: () => [],
		...over,
	}) as Adapter;

/** A room with two heavy feeds (as measured) and two light ones, the data saver wired as main.ts wires it. */
function setup(options: { flag?: boolean; mode?: "local" | "public"; ffmpeg?: boolean } = {}) {
	const store = new Store(":memory:");
	const http: HttpLike = {
		request: async () => {
			throw new Error("offline");
		},
	};
	const keys: KeyStore = {
		get: () => undefined,
		has: () => false,
		set: () => {},
		remove: () => {},
		origin: () => null,
	};
	const adapters = [feed("goes-nsa"), feed("tv-stills"), feed("usgs-quakes"), feed("bcv-official")];
	let setting: boolean | undefined;
	const switches: Record<string, boolean> = {};
	const state = (): SaverState => saverState(options.flag, setting);
	const machine = (): Machine => ({ hasKey: () => false, ffmpeg: options.ffmpeg ?? true });
	const mode = options.mode ?? "local";
	const enabledWith = (a: Adapter, on: boolean) =>
		feedOn(a, mode, switches[a.id], on && isHeavy(a.id, machine()));
	const triggered: string[] = [];
	const scheduler = new Scheduler(adapters, {
		store,
		http,
		key: () => undefined,
		enabled: (a) => enabledWith(a, state().on),
	});
	const trigger = scheduler.trigger.bind(scheduler);
	scheduler.trigger = (id: string) => {
		triggered.push(id);
		trigger(id);
	};
	const app = createApp({
		store,
		scheduler,
		adapters,
		keys,
		keySpecs: [],
		panels: new PanelCache([], store),
		http,
		version: "test",
		sessionToken: TOKEN,
		deploy: { mode },
		bandwidth: {
			state,
			set: (on) => {
				setting = on;
			},
			wouldRun: (a, on) => !scheduler.isLocked(a) && enabledWith(a, on),
			machine,
			userSwitch: (id) => switches[id],
		},
	});
	return { app, store, scheduler, switches, triggered, setting: () => setting };
}

const get = (path: string) =>
	new Request(`http://localhost:7722${path}`, { headers: { host: "localhost:7722" } });
const post = (on: unknown, cookie: string | null = COOKIE) =>
	new Request("http://localhost:7722/api/data-saver", {
		method: "POST",
		headers: {
			host: "localhost:7722",
			origin: "http://localhost:7722",
			"content-type": "application/json",
			...(cookie ? { cookie } : {}),
		},
		body: JSON.stringify({ on }),
	});

const mb = (...ids: string[]) => Math.round(ids.reduce((n, id) => n + (MB_PER_DAY[id] ?? 0), 0) * 10) / 10;

test("first run: meta asks on a person's own Vigía until someone answers; never on a public mirror", async () => {
	const local = setup();
	const meta = await (await local.app.fetch(get("/api/meta"), "127.0.0.1")).json();
	expect(meta.dataSaver).toEqual({ on: false, ask: true });
	await local.app.fetch(post(false), "127.0.0.1");
	expect((await (await local.app.fetch(get("/api/meta"), "127.0.0.1")).json()).dataSaver).toEqual({
		on: false,
		ask: false,
	});
	const mirror = setup({ mode: "public" });
	expect((await (await mirror.app.fetch(get("/api/meta"), "127.0.0.1")).json()).dataSaver).toEqual({
		on: false,
		ask: false,
	});
});

test("the view: both choices' measured daily download, the heavy feeds, and what this machine downloaded", async () => {
	const { app, store } = setup();
	store.recordRun({
		source: "usgs-quakes",
		startedAt: Date.now() - 60_000,
		finishedAt: Date.now(),
		ok: true,
		error: null,
		bytes: 1,
		wire: 2 * 1_048_576,
		received: 0,
		inserted: 0,
	});
	const v = await (await app.fetch(get("/api/data-saver"), "127.0.0.1")).json();
	expect(v).toMatchObject({ on: false, source: "unset", ask: true, threshold: 20 });
	expect(v.heavy.map((h: { id: string }) => h.id)).toEqual(["tv-stills", "goes-nsa"]);
	expect(v.estimate.off.mb).toBeCloseTo(mb("goes-nsa", "tv-stills", "usgs-quakes", "bcv-official"), 1);
	expect(v.estimate.on.mb).toBeCloseTo(mb("usgs-quakes", "bcv-official"), 1);
	expect(v.estimate.current).toEqual(v.estimate.off);
	expect(v.downloaded).toMatchObject({ mb: 2, feeds: 1 });
});

test("turning it on holds the heavy feeds back, the user's own switch still wins, turning it off restarts them", async () => {
	const { app, scheduler, switches, triggered } = setup();
	const res = await app.fetch(post(true), "127.0.0.1");
	expect(res.status).toBe(200);
	const v = await res.json();
	expect(v).toMatchObject({ on: true, source: "setting", ask: false });
	expect(scheduler.isEnabled(feed("goes-nsa"))).toBe(false);
	expect(scheduler.isEnabled(feed("usgs-quakes"))).toBe(true);
	expect(v.estimate.current).toEqual(v.estimate.on);
	switches["goes-nsa"] = true;
	expect(scheduler.isEnabled(feed("goes-nsa"))).toBe(true);
	const again = await (await app.fetch(get("/api/data-saver"), "127.0.0.1")).json();
	expect(again.heavy.find((h: { id: string }) => h.id === "goes-nsa")).toMatchObject({
		on: true,
		override: true,
	});
	await app.fetch(post(false), "127.0.0.1");
	expect(triggered.sort()).toEqual(["goes-nsa", "tv-stills"]);
});

test("writes need this machine's session; a mirror and a start-up flag refuse them with the reason", async () => {
	const noSession = setup();
	expect((await noSession.app.fetch(post(true, null), "127.0.0.1")).status).toBe(403);
	expect(noSession.setting()).toBeUndefined();
	expect((await noSession.app.fetch(post("sí"), "127.0.0.1")).status).toBe(400);
	const mirror = setup({ mode: "public" });
	expect((await mirror.app.fetch(post(true), "127.0.0.1")).status).toBe(403);
	const flagged = setup({ flag: true });
	const res = await flagged.app.fetch(post(false), "127.0.0.1");
	expect(res.status).toBe(409);
	expect((await res.json()).code).toBe("flag");
	expect(flagged.scheduler.isEnabled(feed("tv-stills"))).toBe(false);
});

test("without ffmpeg the TV stills download nothing: not heavy, not counted", async () => {
	const { app } = setup({ ffmpeg: false });
	const v = await (await app.fetch(get("/api/data-saver"), "127.0.0.1")).json();
	expect(v.heavy.map((h: { id: string }) => h.id)).toEqual(["goes-nsa"]);
	expect(v.estimate.off.mb).toBeCloseTo(mb("goes-nsa", "usgs-quakes", "bcv-official"), 1);
});

test("ffmpeg: found, missing, or turned off on purpose", () => {
	expect(ffmpegView(true, { VIGIA_FFMPEG: "0" })).toEqual({
		found: false,
		version: null,
		disabled: true,
		fromEnv: false,
	});
	expect(ffmpegView(true, { VIGIA_FFMPEG: "/nonexistent/ffmpeg" })).toMatchObject({
		found: false,
		fromEnv: true,
	});
	ffmpegView(true, {});
});
