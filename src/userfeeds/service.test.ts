import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlertService } from "../alerts/service.ts";
import type { KeyStore } from "../config/keys.ts";
import { sessionCookieName } from "../config/session.ts";
import { Scheduler } from "../core/scheduler.ts";
import { Store } from "../core/store.ts";
import type { Adapter, HttpLike } from "../core/types.ts";
import { createApp } from "../server/app.ts";
import { PanelCache } from "../server/panels.ts";
import { type Resolver, SafeHttp } from "./net.ts";
import { userNewsPanel } from "./panel.ts";
import type { UserFeed } from "./schema.ts";
import {
	feedTitle,
	MAX_USER_ITEMS,
	MAX_USER_TITLE,
	UserFeeds,
	userFeedAdapter,
	userFeedId,
} from "./service.ts";

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title><![CDATA[Diario de Prueba]]></title>
<item><title>Apagón en Maracaibo</title><link>https://diario.example/a</link><pubDate>Thu, 24 Sep 2026 16:00:00 GMT</pubDate></item>
<item><title>Sin fecha</title><link>https://diario.example/b</link></item>
</channel></rss>`;

const resolve: Resolver = async (host) =>
	({ "diario.example": ["93.184.215.14"], "evil.example": ["127.0.0.1"] })[host] ?? [];

function fakeFetch(body: string, status = 200, calls: string[] = []): typeof fetch {
	return (async (input: string | URL | Request) => {
		calls.push(String(input));
		return new Response(body, { status, headers: { "content-type": "application/rss+xml" } });
	}) as typeof fetch;
}

function memoryStore(initial: UserFeed[] = []) {
	let list = initial;
	return {
		list: () => list,
		save: (next: readonly UserFeed[]) => {
			list = [...next];
		},
	};
}

function setup(body = RSS, status = 200) {
	const calls: string[] = [];
	const http = new SafeHttp({ fetchImpl: fakeFetch(body, status, calls), resolve, hostGapMs: 0 });
	const store = memoryStore();
	const feeds = new UserFeeds(store, http, () => Date.UTC(2026, 8, 24, 18), [
		{
			id: "el-pitazo",
			name: "El Pitazo",
			url: "https://elpitazo.net/feed/",
			kind: "rss",
			region: "national",
			stance: "independent",
			homepage: "https://elpitazo.net/",
		},
	]);
	const added: Adapter[] = [];
	const removed: string[] = [];
	feeds.attach({
		add: (a) => void added.push(a),
		replace: (a) => void added.push(a),
		remove: (id) => void removed.push(id),
		trigger: () => {},
	});
	return { feeds, store, calls, added, removed };
}

describe("UserFeeds", () => {
	test("adds a feed only after fetching and parsing it; names it from the feed; schedules it", async () => {
		const { feeds, calls, added } = setup();
		const r = await feeds.add({ url: "https://diario.example/feed", region: "VE-V" });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.feed).toMatchObject({
			id: userFeedId("https://diario.example/feed"),
			name: "Diario de Prueba",
			region: "VE-V",
			intervalMin: 30,
		});
		expect(r.preview).toEqual({ items: 2, newestAt: Date.UTC(2026, 8, 24, 16), title: "Diario de Prueba" });
		expect(calls).toEqual(["https://93.184.215.14/feed"]);
		expect(added.map((a) => a.id)).toEqual([r.feed.id]);
		expect(added[0]?.name.es).toBe("Diario de Prueba (añadida por ti)");
		expect(feeds.outlets()[0]?.stance).toBe("user");
	});

	test("refuses private targets before any request, duplicates, built-ins, and non-feeds", async () => {
		const { feeds, calls } = setup();
		for (const url of ["http://127.0.0.1/feed", "http://localhost/rss", "file:///etc/passwd"]) {
			const r = await feeds.add({ url });
			expect(r.ok).toBe(false);
		}
		const evil = await feeds.add({ url: "https://evil.example/feed" });
		expect(evil).toMatchObject({ ok: false, status: 422 });
		expect(calls).toEqual([]);
		expect(await feeds.add({ url: "https://ElPitazo.net/feed/" })).toMatchObject({ ok: false, status: 409 });
		// The same feed over http, with "www." and without the trailing slash is still the built-in one.
		expect(await feeds.add({ url: "http://www.elpitazo.net/feed" })).toMatchObject({
			ok: false,
			status: 409,
		});
		expect((await feeds.add({ url: "https://diario.example/feed" })).ok).toBe(true);
		expect(await feeds.add({ url: "https://diario.example/feed#x" })).toMatchObject({
			ok: false,
			status: 409,
		});
		expect(await feeds.add({ url: "https://diario.example/x", region: "VE-9" })).toMatchObject({
			status: 400,
		});
		expect(await feeds.add({ url: "https://diario.example/x", extra: 1 })).toMatchObject({ status: 400 });

		const html = setup("<!doctype html><html><body>captcha</body></html>");
		expect(await html.feeds.add({ url: "https://diario.example/feed" })).toMatchObject({
			ok: false,
			status: 422,
		});
		const empty = setup('<rss version="2.0"><channel><title>x</title></channel></rss>');
		expect(await empty.feeds.add({ url: "https://diario.example/feed" })).toMatchObject({ status: 422 });
		const down = setup("no", 500);
		expect(await down.feeds.add({ url: "https://diario.example/feed" })).toMatchObject({ status: 422 });
		expect(html.store.list()).toEqual([]);
	});

	test("updates name, region and interval, reschedules, and removes", async () => {
		const { feeds, added, removed } = setup();
		const r = await feeds.add({ url: "https://diario.example/feed" });
		if (!r.ok) throw new Error("add failed");
		const u = feeds.update(r.feed.id, { name: "Mi diario", region: "international", intervalMin: 60 });
		expect(u).toMatchObject({
			ok: true,
			feed: { name: "Mi diario", region: "international", intervalMin: 60 },
		});
		expect(feeds.update(r.feed.id, { url: "https://x.example/" })).toMatchObject({ ok: false, status: 400 });
		expect(feeds.update("mia-0000000000", {})).toMatchObject({ ok: false, status: 404 });
		expect(added.length).toBe(2);
		expect(feeds.remove(r.feed.id)).toBe(true);
		expect(feeds.remove(r.feed.id)).toBe(false);
		// An edit replaces the scheduled adapter (keeping its back-off); only the removal removes it.
		expect(removed).toEqual([r.feed.id]);
		expect(feeds.list()).toEqual([]);
	});

	test("two feeds of one site are one publisher", async () => {
		const { feeds } = setup();
		const a = await feeds.add({ url: "https://diario.example/feed" });
		const b = await feeds.add({ url: "https://diario.example/seccion/feed" });
		if (!a.ok || !b.ok) throw new Error("add failed");
		expect(feeds.outlets().map((o) => o.publisher)).toEqual([undefined, a.feed.id]);
	});

	test("an entity-expansion bomb in a user feed is refused, not expanded", async () => {
		const entities = Array.from({ length: 200 }, (_, i) => `<!ENTITY e${i} "${"x".repeat(50)}">`).join("");
		const refs = Array.from({ length: 200 }, (_, i) => `&e${i};`).join("");
		const bomb = `<?xml version="1.0"?><!DOCTYPE rss [${entities}]><rss version="2.0"><channel><title>b</title><item><title>${refs}</title><link>https://diario.example/a</link></item></channel></rss>`;
		const { feeds } = setup(bomb);
		expect(await feeds.add({ url: "https://diario.example/feed" })).toMatchObject({ ok: false, status: 422 });
	});

	test("feedTitle reads the channel title, CDATA and entities included", () => {
		expect(feedTitle(RSS)).toBe("Diario de Prueba");
		expect(feedTitle('<feed xmlns="http://www.w3.org/2005/Atom"><title>A &amp; B</title></feed>')).toBe(
			"A & B",
		);
		expect(feedTitle("<rss><channel></channel></rss>")).toBeNull();
	});
});

/* ---------- Through the real app: the write guard and the panel ---------- */

const TOKEN = "cd".repeat(32);
const COOKIE = `${sessionCookieName(TOKEN)}=${TOKEN}`;

function appSetup(lan = false, mode: "local" | "public" = "local") {
	const dir = mkdtempSync(join(tmpdir(), "vigia-custom-"));
	const store = new Store(":memory:");
	const offline: HttpLike = {
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
	const now = () => Date.UTC(2026, 8, 24, 18);
	const http = new SafeHttp({ fetchImpl: fakeFetch(RSS), resolve, hostGapMs: 0, now });
	const feedStore = memoryStore();
	const userFeeds = new UserFeeds(feedStore, http, now, []);
	const scheduler = new Scheduler([], { store, http: offline, key: () => undefined, now });
	userFeeds.attach(scheduler);
	const panels = new PanelCache([userNewsPanel(userFeeds)], store, now);
	let rules: unknown[] = [];
	const alerts = new AlertService({
		file: join(dir, "alerts.json"),
		rules: () => rules as never,
		saveRules: (next) => {
			rules = [...next];
		},
		panel: (id) => panels.get(id),
		health: () => [],
		publish: () => {},
		now,
	});
	const app = createApp({
		store,
		scheduler,
		adapters: [],
		keys,
		keySpecs: [],
		panels,
		http: offline,
		version: "test",
		sessionToken: TOKEN,
		userFeeds,
		alerts,
		now,
		lan,
		deploy: { mode },
	});
	return { app, scheduler, store, panels, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const req = (
	method: string,
	path: string,
	body?: unknown,
	over: { origin?: string | null; cookie?: string | null; host?: string } = {},
) => {
	const origin = over.origin === undefined ? "http://localhost:7722" : over.origin;
	const cookie = over.cookie === undefined ? COOKIE : over.cookie;
	return new Request(`http://localhost:7722${path}`, {
		method,
		headers: {
			host: over.host ?? "localhost:7722",
			"content-type": "application/json",
			...(origin ? { origin } : {}),
			...(cookie ? { cookie } : {}),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
};

describe("personalisation routes", () => {
	test("adding a feed needs the session cookie, loopback, and the same origin", async () => {
		const { app, cleanup } = appSetup();
		const body = { url: "https://diario.example/feed" };
		const noCookie = await app.fetch(req("POST", "/api/user-feeds", body, { cookie: null }), "127.0.0.1");
		expect(noCookie.status).toBe(403);
		expect(await noCookie.json()).toMatchObject({ code: "session" });
		const otherSite = await app.fetch(
			req("POST", "/api/user-feeds", body, { origin: "https://evil.example" }),
			"127.0.0.1",
		);
		expect(otherSite.status).toBe(403);
		const remote = await app.fetch(req("POST", "/api/user-feeds", body), "192.168.1.20");
		expect(remote.status).toBe(403);
		expect((await (await app.fetch(req("GET", "/api/user-feeds"), "127.0.0.1")).json()).feeds).toEqual([]);

		const ok = await app.fetch(req("POST", "/api/user-feeds", body), "127.0.0.1");
		expect(ok.status).toBe(201);
		const { feed } = (await ok.json()) as { feed: UserFeed };
		// It joins the status page and the sources atlas, labelled as the user's.
		const meta = (await (await app.fetch(req("GET", "/api/meta"), "127.0.0.1")).json()) as {
			feeds: { id: string; mine?: boolean; stance?: string; name: { es: string } }[];
		};
		expect(meta.feeds.find((f) => f.id === feed.id)).toMatchObject({
			mine: true,
			stance: "user",
			name: { es: "Diario de Prueba (añadida por ti)" },
		});
		const health = (await (await app.fetch(req("GET", "/api/health"), "127.0.0.1")).json()) as {
			feeds: { id: string }[];
		};
		expect(health.feeds.map((f) => f.id)).toContain(feed.id);

		const del = await app.fetch(
			req("DELETE", `/api/user-feeds/${feed.id}`, undefined, { cookie: null }),
			"127.0.0.1",
		);
		expect(del.status).toBe(403);
		expect((await app.fetch(req("DELETE", `/api/user-feeds/${feed.id}`), "127.0.0.1")).status).toBe(200);
		cleanup();
	});

	test("a hand-added feed's headlines land in its own panel, labelled, and nowhere else", async () => {
		const { app, scheduler, panels, cleanup } = appSetup();
		const ok = await app.fetch(
			req("POST", "/api/user-feeds", { url: "https://diario.example/feed" }),
			"127.0.0.1",
		);
		const { feed } = (await ok.json()) as { feed: UserFeed };
		const run = await scheduler.runOnce(feed.id);
		expect(run).toMatchObject({ ok: true, inserted: 2 });
		expect(panels.invalidate(feed.id)).toEqual(["user-news"]);
		const view = panels.get("user-news") as {
			mine: boolean;
			stories: Record<string, { title: string; outlets: { stance: string }[] }>;
		};
		expect(view.mine).toBe(true);
		const titles = Object.values(view.stories).map((s) => s.title);
		expect(titles).toContain("Apagón en Maracaibo");
		expect(Object.values(view.stories).every((s) => s.outlets.every((o) => o.stance === "user"))).toBe(true);
		cleanup();
	});

	test("alert rules: validated, guarded, and listed with their status", async () => {
		const { app, cleanup } = appSetup();
		const rule = { id: "r-abc123", enabled: true, createdAt: 1, kind: "gap", minPct: 50 };
		const refused = await app.fetch(
			req("PUT", "/api/alerts/rules", { rules: [rule] }, { cookie: null }),
			"127.0.0.1",
		);
		expect(refused.status).toBe(403);
		const bad = await app.fetch(
			req("PUT", "/api/alerts/rules", { rules: [{ ...rule, kind: "shell" }] }),
			"127.0.0.1",
		);
		expect(bad.status).toBe(400);
		const ok = await app.fetch(req("PUT", "/api/alerts/rules", { rules: [rule] }), "127.0.0.1");
		expect(ok.status).toBe(200);
		const view = (await (await app.fetch(req("GET", "/api/alerts"), "127.0.0.1")).json()) as {
			rules: unknown[];
			status: Record<string, { state: string }>;
		};
		expect(view.rules).toEqual([rule]);
		// No money panel in this app: the rule cannot be judged, and says so.
		expect(view.status["r-abc123"]?.state).toBe("stale");
		expect((await app.fetch(req("DELETE", "/api/alerts/log"), "127.0.0.1")).status).toBe(200);
		expect((await app.fetch(req("POST", "/api/alerts"), "127.0.0.1")).status).toBe(405);
		cleanup();
	});
});

test("serving the local network, the user's feeds and alerts are shown only to the browser with the session", async () => {
	const { app, cleanup } = appSetup(true);
	const ok = await app.fetch(
		req("POST", "/api/user-feeds", { url: "https://diario.example/feed" }),
		"127.0.0.1",
	);
	const { feed } = (await ok.json()) as { feed: UserFeed };
	const lanRead = (path: string) =>
		app.fetch(
			new Request(`http://192.168.1.5:7722${path}`, { headers: { host: "192.168.1.5:7722" } }),
			"192.168.1.9",
		);
	expect((await lanRead("/api/user-feeds")).status).toBe(403);
	expect((await lanRead("/api/alerts")).status).toBe(403);
	expect((await lanRead("/api/panels/user-news")).status).toBe(404);
	const meta = await (await lanRead("/api/meta")).text();
	const health = await (await lanRead("/api/health")).text();
	const panels = (await (await lanRead("/api/panels")).json()) as { panels: Record<string, unknown> };
	expect(meta).not.toContain(feed.id);
	expect(health).not.toContain(feed.id);
	expect(panels.panels["user-news"]).toBeUndefined();
	// The user's own browser, with the cookie, still sees them.
	const owner = await app.fetch(
		new Request("http://192.168.1.5:7722/api/user-feeds", {
			headers: { host: "192.168.1.5:7722", cookie: COOKIE },
		}),
		"192.168.1.9",
	);
	expect(owner.status).toBe(200);
	cleanup();
});

test("the public API (/api/v1), metrics and a public mirror never show the user's feeds, headlines or alerts", async () => {
	const { app, scheduler, cleanup } = appSetup();
	const ok = await app.fetch(
		req("POST", "/api/user-feeds", { url: "https://diario.example/feed" }),
		"127.0.0.1",
	);
	const { feed } = (await ok.json()) as { feed: UserFeed };
	await scheduler.runOnce(feed.id);
	app.publish({
		type: "run",
		source: feed.id,
		ok: true,
		inserted: 2,
		series: [],
		at: Date.UTC(2026, 8, 24, 18),
	});
	for (const path of [
		"/api/v1",
		"/api/v1/sources",
		"/api/v1/health",
		"/api/v1/panels",
		"/api/v1/figures",
		"/api/v1/figures?format=csv",
		"/api/v1/openapi.json",
	]) {
		const text = await (await app.fetch(req("GET", path), "127.0.0.1")).text();
		expect([
			path,
			text.includes(feed.id) || text.includes("Maracaibo") || text.includes("user-news"),
		]).toEqual([path, false]);
	}
	expect((await app.fetch(req("GET", "/api/v1/panels/user-news"), "127.0.0.1")).status).toBe(404);
	for (const path of ["/api/v1/sources", "/api/v1/panels", "/api/v1/figures", "/api/v1/health"])
		expect([path, (await app.fetch(req("GET", path), "127.0.0.1")).status]).toEqual([path, 200]);
	expect(app.metricsText()).not.toContain(feed.id);
	cleanup();

	// A public read-only mirror has no personal features at all.
	const pub = appSetup(false, "public");
	expect((await pub.app.fetch(req("GET", "/api/user-feeds"), "127.0.0.1")).status).toBe(404);
	expect((await pub.app.fetch(req("GET", "/api/alerts"), "127.0.0.1")).status).toBe(404);
	expect(
		(await pub.app.fetch(req("POST", "/api/user-feeds", { url: "https://diario.example/feed" }), "127.0.0.1"))
			.status,
	).not.toBe(201);
	const meta = (await (await pub.app.fetch(req("GET", "/api/meta"), "127.0.0.1")).json()) as { mode: string };
	expect(meta.mode).toBe("public");
	pub.cleanup();
});

test("review 4 H3: serving the LAN, no GET route hands a browser without the session the user's feeds or headlines", async () => {
	const { app, scheduler, cleanup } = appSetup(true);
	const ok = await app.fetch(
		req("POST", "/api/user-feeds", { url: "https://diario.example/feed" }),
		"127.0.0.1",
	);
	const { feed } = (await ok.json()) as { feed: UserFeed };
	expect(await scheduler.runOnce(feed.id)).toMatchObject({ ok: true, inserted: 2 });
	const lan = (path: string, cookie?: string) =>
		app.fetch(
			new Request(`http://192.168.1.5:7722${path}`, {
				headers: { host: "192.168.1.5:7722", "user-agent": "Mozilla/5.0", ...(cookie ? { cookie } : {}) },
			}),
			"192.168.1.9",
		);
	const leaks = (text: string) =>
		["Maracaibo", "diario.example", "Diario de Prueba", feed.id, "user-news"].filter((s) => text.includes(s));

	// The repro: this returned 200 with the feed's name, every headline and every link.
	expect((await lan("/api/evidence?panel=user-news")).status).toBe(404);
	// With the session it is the user's own bundle (the evidence limit is shared by the whole test run: 429 is fine).
	const own = await lan("/api/evidence?panel=user-news", COOKIE);
	expect([200, 429]).toContain(own.status);
	if (own.status === 200) expect(await own.text()).toContain(feed.id);

	// Every GET route of app.ts, custom-routes.ts and v1/routes.ts, plus the feed-id forms.
	const paths = [
		"/",
		"/ahora.txt",
		"/api",
		"/informe",
		"/metrics",
		"/api/meta",
		"/api/health",
		"/api/panels",
		"/api/panels?only=user-news",
		"/api/panels/user-news",
		"/api/incidents",
		"/api/archive/digests",
		"/api/evidence?panel=user-news",
		"/api/evidence?incident=x",
		"/api/bloqueos?dominio=diario.example",
		"/api/history/connectivity",
		"/api/keys",
		"/api/ai/settings",
		"/api/ai/brief",
		"/api/user-feeds",
		`/api/user-feeds/${feed.id}`,
		"/api/alerts",
		"/api/alerts/log",
		"/api/alerts/rules",
		`/api/feeds/${feed.id}/latest`,
		`/api/feeds/${feed.id}/series/x`,
		`/api/blobs/${feed.id}/x`,
		"/api/v1",
		"/api/v1/sources",
		`/api/v1/sources/${feed.id}`,
		`/api/v1/sources/${feed.id}/series`,
		"/api/v1/health",
		"/api/v1/panels",
		"/api/v1/panels/user-news",
		"/api/v1/figures",
		"/api/v1/figures?format=csv",
		"/api/v1/incidents",
		"/api/v1/history/connectivity",
		"/api/v1/archive/digests",
		"/api/v1/openapi.json",
	];
	for (const path of paths) {
		const res = await lan(path);
		expect([path, leaks(await res.text())]).toEqual([path, []]);
	}

	// The event stream: a run of the user's feed reaches only a browser with the session.
	const read = async (res: Response) => {
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		let text = "";
		for (;;) {
			const next = await Promise.race([
				reader.read(),
				new Promise<null>((r) => setTimeout(() => r(null), 30)),
			]);
			if (!next || next.done) break;
			text += new TextDecoder().decode(next.value);
		}
		await reader.cancel();
		return text;
	};
	const stranger = await lan("/api/stream");
	const owner = await lan("/api/stream", COOKIE);
	app.publish({
		type: "run",
		source: feed.id,
		ok: true,
		inserted: 2,
		series: [],
		at: Date.UTC(2026, 8, 24, 18),
	});
	expect(leaks(await read(stranger))).toEqual([]);
	expect(await read(owner)).toContain(feed.id);
	app.closeStreams();
	cleanup();
});

test("review 4 L3: /informe counts Vigía's own feeds only, never the user's", async () => {
	const { app, scheduler, cleanup } = appSetup();
	const ok = await app.fetch(
		req("POST", "/api/user-feeds", { url: "https://diario.example/feed" }),
		"127.0.0.1",
	);
	const { feed } = (await ok.json()) as { feed: UserFeed };
	await scheduler.runOnce(feed.id);
	const html = await (await app.fetch(req("GET", "/informe"), "127.0.0.1")).text();
	// This app has no built-in feeds: the user's one made it "1 de 1".
	expect(html).toContain("0 de 0 fuentes activas");
	cleanup();
});

test("review 4 L4: a hand-added feed keeps its newest 200 items, titles cut at 300 characters, no huge links", () => {
	const items = Array.from(
		{ length: 12_000 },
		(_, i) =>
			`<item><title>${i === 11_999 ? "T".repeat(2_000_000) : `Titular ${i}`}</title><link>https://diario.example/${i}</link><pubDate>${new Date(Date.UTC(2026, 0, 1) + i * 60_000).toUTCString()}</pubDate></item>`,
	).join("");
	const long = `<item><title>Enlace enorme</title><link>https://diario.example/${"x".repeat(5_000)}</link></item>`;
	const body = `<?xml version="1.0"?><rss version="2.0"><channel><title>Grande</title>${items}${long}</channel></rss>`;
	const feed: UserFeed = {
		id: userFeedId("https://diario.example/feed"),
		url: "https://diario.example/feed",
		name: "Grande",
		region: "national",
		intervalMin: 30,
		addedAt: 0,
	};
	const adapter = userFeedAdapter(feed, new SafeHttp({ fetchImpl: fakeFetch(body), resolve, hostGapMs: 0 }));
	const out = adapter.normalise([
		{
			url: feed.url,
			status: 200,
			contentType: "application/rss+xml",
			body,
			fetchedAt: Date.UTC(2026, 8, 24),
		},
	]);
	expect(out).toHaveLength(MAX_USER_ITEMS);
	// The newest first: item 11,999 (the 2 MB title), cut to 300 characters.
	expect(out[0]?.value.title).toHaveLength(MAX_USER_TITLE);
	expect(out[0]?.value.title.endsWith("…")).toBe(true);
	expect(out.every((o) => o.value.title.length <= MAX_USER_TITLE && o.value.link.length <= 2_048)).toBe(true);
	expect(out.at(-1)?.value.title).toBe("Titular 11800");
});
