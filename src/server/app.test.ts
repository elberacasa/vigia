import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { usgsQuakes } from "../adapters/usgs-quakes/index.ts";
import type { KeyStore } from "../config/keys.ts";
import { sessionCookieName } from "../config/session.ts";
import { BlobStore, blobKey } from "../core/blobs.ts";
import { Scheduler } from "../core/scheduler.ts";
import { Store } from "../core/store.ts";
import type { Adapter, HttpLike } from "../core/types.ts";
import type { KeySpec } from "../sources/keyspec.ts";
import { createApp } from "./app.ts";
import { PanelCache } from "./panels.ts";

const TOKEN = "ab".repeat(32);
const COOKIE = `${sessionCookieName(TOKEN)}=${TOKEN}`;

function setup(validate: KeySpec["validate"] = async () => null) {
	const store = new Store(":memory:");
	const http: HttpLike = {
		request: async () => {
			throw new Error("offline");
		},
	};
	const saved = new Map<string, string>();
	const keys: KeyStore = {
		get: (id) => saved.get(id),
		has: (id) => saved.has(id),
		set: (id, v) => void saved.set(id, v),
		remove: (id) => void saved.delete(id),
		origin: (id) => (saved.has(id) ? "file" : null),
	};
	const spec: KeySpec = {
		id: "demo-key",
		provider: "Demo",
		name: { es: "d", en: "d" },
		cost: "free-no-card",
		unlocks: { es: "u", en: "u" },
		signupUrl: "https://example.org",
		minutes: 1,
		steps: { es: [], en: [] },
		validate,
	};
	const scheduler = new Scheduler([], { store, http, key: (id) => keys.get(id) });
	const app = createApp({
		store,
		scheduler,
		adapters: [],
		keys,
		keySpecs: [spec],
		panels: new PanelCache([], store),
		http,
		version: "test",
		sessionToken: TOKEN,
	});
	return { app, saved };
}

const post = (
	origin: string | null,
	body: unknown = { value: "abcd1234" },
	type = "application/json",
	cookie: string | null = COOKIE,
) =>
	new Request("http://localhost:7722/api/keys/demo-key", {
		method: "POST",
		headers: {
			host: "localhost:7722",
			"content-type": type,
			...(origin ? { origin } : {}),
			...(cookie ? { cookie } : {}),
		},
		body: JSON.stringify(body),
	});

test("keys can be saved from this machine, same origin, and are never echoed", async () => {
	const { app, saved } = setup();
	const res = await app.fetch(post("http://localhost:7722"), "127.0.0.1");
	expect(res.status).toBe(200);
	expect(saved.get("demo-key")).toBe("abcd1234");
	const list = await (await app.fetch(new Request("http://localhost:7722/api/keys"), "127.0.0.1")).text();
	expect(list).not.toContain("abcd1234");
	expect(JSON.parse(list).keys[0]).toMatchObject({
		id: "demo-key",
		set: true,
		origin: "file",
		cost: "free-no-card",
	});
});

test("refuses key writes from another machine, another origin, no origin, or a form post", async () => {
	const { app, saved } = setup();
	expect((await app.fetch(post("http://localhost:7722"), "192.168.1.20")).status).toBe(403);
	expect((await app.fetch(post("https://evil.example"), "127.0.0.1")).status).toBe(403);
	expect((await app.fetch(post(null), "127.0.0.1")).status).toBe(403);
	expect(
		(
			await app.fetch(
				post("http://localhost:7722", "value=x", "application/x-www-form-urlencoded"),
				"127.0.0.1",
			)
		).status,
	).toBe(403);
	expect(saved.size).toBe(0);
});

test("an invalid key is reported and not stored", async () => {
	const { app, saved } = setup(async () => "La clave fue rechazada por Demo.");
	const res = await app.fetch(post("http://localhost:7722"), "127.0.0.1");
	expect(res.status).toBe(422);
	expect(await res.json()).toEqual({ ok: false, reason: "La clave fue rechazada por Demo." });
	expect(saved.size).toBe(0);
});

test("security headers on every response, JSON 404 for unknown API routes", async () => {
	const { app } = setup();
	const res = await app.fetch(new Request("http://localhost:7722/api/nope"), "127.0.0.1");
	expect(res.status).toBe(404);
	expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
	expect(res.headers.get("x-content-type-options")).toBe("nosniff");
});

test("CSP: frames only from youtube-nocookie, media only from self and the verified radio hosts", async () => {
	const { app } = setup();
	const res = await app.fetch(new Request("http://localhost:7722/api/meta"), "127.0.0.1");
	const csp = res.headers.get("content-security-policy") ?? "";
	const directives = new Map(
		csp.split(";").map((d) => {
			const [name = "", ...values] = d.trim().split(/\s+/);
			return [name, values] as const;
		}),
	);
	expect(directives.get("frame-src")).toEqual(["https://www.youtube-nocookie.com"]);
	expect(directives.get("media-src")).toEqual([
		"'self'",
		"https://guri.tepuyserver.net",
		"https://tx.feyalegrianoticias.com",
	]);
	// Everything else is unchanged: no third-party script, connection, image or style.
	expect(directives.get("default-src")).toEqual(["'self'"]);
	expect(directives.get("script-src")).toEqual(["'self'"]);
	expect(directives.get("connect-src")).toEqual(["'self'"]);
	expect(directives.get("img-src")).toEqual(["'self'", "data:", "blob:"]);
	expect(directives.get("frame-ancestors")).toEqual(["'none'"]);
	expect(csp).not.toContain("youtube.com ");
	expect(csp).not.toMatch(/\*/);
});

test("rate limits a flood from one client", async () => {
	const { app } = setup();
	let limited = 0;
	for (let i = 0; i < 300; i++) {
		const res = await app.fetch(new Request("http://localhost:7722/api/meta"), "10.0.0.9");
		if (res.status === 429) limited++;
	}
	expect(limited).toBeGreaterThan(0);
	expect((await app.fetch(new Request("http://localhost:7722/api/meta"), "10.0.0.10")).status).toBe(200);
});

test("feed toggles follow the same write rules", async () => {
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
	const toggled: [string, boolean][] = [];
	const feed = {
		id: "p2p",
		layer: "money",
		name: { es: "p", en: "p" },
		provider: "x",
		homepage: "https://example.org",
		licence: { id: "l", name: "l", url: "", attribution: "", commercial: true },
		keys: [],
		intervalMs: 1,
		freshness: { fetchMs: 1, dataMs: null },
		optIn: { es: "r", en: "r" },
		fetch: async () => [],
		normalise: () => [],
	} as const;
	const scheduler = new Scheduler([feed], { store, http, key: () => undefined });
	const app = createApp({
		store,
		scheduler,
		adapters: [feed],
		keys,
		keySpecs: [],
		panels: new PanelCache([], store),
		http,
		version: "t",
		sessionToken: TOKEN,
		setFeedEnabled: (id, on) => void toggled.push([id, on]),
	});
	const req = (origin: string) =>
		new Request("http://localhost:7722/api/feeds/p2p/enabled", {
			method: "POST",
			headers: { host: "localhost:7722", origin, "content-type": "application/json", cookie: COOKIE },
			body: '{"on":true}',
		});
	expect((await app.fetch(req("https://evil.example"), "127.0.0.1")).status).toBe(403);
	expect((await app.fetch(req("http://localhost:7722"), "127.0.0.1")).status).toBe(200);
	expect(toggled).toEqual([["p2p", true]]);
	const meta = (await (
		await app.fetch(new Request("http://localhost:7722/api/meta"), "127.0.0.1")
	).json()) as { feeds: { optIn: unknown }[] };
	expect(meta.feeds[0]?.optIn).toEqual({ es: "r", en: "r" });
	// Sources atlas: every feed carries its category and the panels it feeds, even one no table describes.
	expect(meta.feeds[0]).toMatchObject({ category: expect.any(Array), region: "intl", panels: [] });
});

test("large JSON is gzipped when the client accepts it; SSE is not", async () => {
	const { compress } = await import("./app.ts");
	const big = new Response(JSON.stringify({ x: "a".repeat(5000) }), {
		headers: { "content-type": "application/json" },
	});
	const out = await compress(new Request("http://x/", { headers: { "accept-encoding": "gzip, br" } }), big);
	expect(out.headers.get("content-encoding")).toBe("gzip");
	expect(
		JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await out.arrayBuffer())))).x.length,
	).toBe(5000);
	const sse = new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
	expect(
		(await compress(new Request("http://x/", { headers: { "accept-encoding": "gzip" } }), sse)).headers.get(
			"content-encoding",
		),
	).toBeNull();
});

test("serves stored images same-origin, immutable, with strict path validation and the API rate limit", async () => {
	const dir = mkdtempSync(join(tmpdir(), "vigia-app-blobs-"));
	try {
		const store = new Store(":memory:");
		const http: HttpLike = { request: async () => Promise.reject(new Error("offline")) };
		const blobs = new BlobStore(dir);
		const key = blobKey("20262671600", "src");
		blobs
			.scope("goes-nsa", { maxEntries: 5, maxBytes: 1e6, maxAgeMs: null })
			.put(key, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
				name: "20262671600",
				contentType: "image/jpeg",
				observedAt: 1,
			});
		const feed = { ...(usgsQuakes as unknown as Adapter), id: "goes-nsa" };
		const app = createApp({
			store,
			scheduler: new Scheduler([], { store, http, key: () => undefined }),
			adapters: [feed],
			keys: { get: () => undefined, has: () => false, set: () => {}, remove: () => {}, origin: () => null },
			keySpecs: [],
			panels: new PanelCache([], store),
			http,
			blobs,
			version: "test",
			sessionToken: TOKEN,
		});
		const get = (path: string, headers: Record<string, string> = {}, ip = "127.0.0.1") =>
			app.fetch(new Request(`http://localhost:7722${path}`, { headers }), ip);

		const ok = await get(`/api/blobs/goes-nsa/${key}`);
		expect(ok.status).toBe(200);
		expect(ok.headers.get("content-type")).toBe("image/jpeg");
		expect(ok.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
		expect(ok.headers.get("content-security-policy")).toContain("default-src 'self'");
		expect(new Uint8Array(await ok.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
		const etag = ok.headers.get("etag") ?? "";
		expect((await get(`/api/blobs/goes-nsa/${key}`, { "if-none-match": etag })).status).toBe(304);
		expect((await get(`/api/blobs/goes-nsa/${key}`, { "if-none-match": `"x", W/${etag}` })).status).toBe(304);
		const head = await app.fetch(
			new Request(`http://localhost:7722/api/blobs/goes-nsa/${key}`, { method: "HEAD" }),
			"127.0.0.1",
		);
		expect(head.status).toBe(200);
		expect(head.headers.get("content-length")).toBe("4");

		const bad = [
			`/api/blobs/usgs-quakes/${key}`,
			"/api/blobs/goes-nsa/missing-0000",
			`/api/blobs/goes-nsa/${key}.jpg`,
			`/api/blobs/goes-nsa/${key}/x`,
			"/api/blobs/goes-nsa/..%2f..%2fvigia.sqlite",
			"/api/blobs/goes-nsa/%2e%2e",
			"/api/blobs/..%2fgoes-nsa/x",
			"/api/blobs/goes-nsa/",
			"/api/blobs/goes-nsa",
		];
		for (const path of bad) expect((await get(path)).status).toBe(404);

		let limited = 0;
		for (let i = 0; i < 260; i++)
			if ((await get(`/api/blobs/goes-nsa/${key}`, {}, "10.0.0.9")).status === 429) limited++;
		expect(limited).toBeGreaterThan(0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("DNS rebinding: a foreign Host is refused on a loopback-only server, and can never write", async () => {
	const { isLoopbackHost } = await import("./app.ts");
	expect(isLoopbackHost("localhost:7722")).toBe(true);
	expect(isLoopbackHost("127.0.0.1:7722")).toBe(true);
	expect(isLoopbackHost("[::1]:7722")).toBe(true);
	expect(isLoopbackHost("attacker.example:7722")).toBe(false);
	expect(isLoopbackHost("127.0.0.1.attacker.example")).toBe(false);
	const { app, saved } = setup();
	const read = await app.fetch(
		new Request("http://attacker.example:7722/api/meta", { headers: { host: "attacker.example:7722" } }),
		"127.0.0.1",
	);
	expect(read.status).toBe(421);
	const write = await app.fetch(
		new Request("http://attacker.example:7722/api/keys/demo-key", {
			method: "POST",
			headers: {
				host: "attacker.example:7722",
				origin: "http://attacker.example:7722",
				"content-type": "application/json",
			},
			body: JSON.stringify({ value: "abcd1234" }),
		}),
		"127.0.0.1",
	);
	expect(write.status).toBe(421);
	expect(saved.size).toBe(0);
});

test("session token: the terminal link sets an HttpOnly SameSite=Strict cookie and redirects to the clean URL", async () => {
	const { app } = setup();
	const res = await app.fetch(new Request(`http://localhost:7722/?token=${TOKEN}`), "127.0.0.1");
	expect(res.status).toBe(303);
	expect(res.headers.get("location")).toBe("/");
	const cookie = res.headers.get("set-cookie") ?? "";
	expect(cookie).toStartWith(`${COOKIE};`);
	expect(cookie).toContain("HttpOnly");
	expect(cookie).toContain("SameSite=Strict");
	expect(cookie).toContain("Path=/");
	// Other query parameters and the page survive; a "//host" path can never become an off-site redirect.
	const deep = await app.fetch(new Request(`http://localhost:7722/guia?token=${TOKEN}&x=1`), "127.0.0.1");
	expect(deep.headers.get("location")).toBe("/guia?x=1");
	const sneaky = await app.fetch(
		new Request(`http://localhost:7722//evil.example/?token=${TOKEN}`),
		"127.0.0.1",
	);
	expect(sneaky.headers.get("location")).toBe("/evil.example/");
	// A wrong token is stripped the same way but earns no cookie.
	const wrong = await app.fetch(new Request(`http://localhost:7722/?token=${"cd".repeat(32)}`), "127.0.0.1");
	expect(wrong.status).toBe(303);
	expect(wrong.headers.get("set-cookie")).toBeNull();
});

test("session token: every write needs the cookie on top of loopback, Host and Origin (reverse-proxy case)", async () => {
	const { app, saved } = setup();
	// What a default nginx proxy relays: loopback peer, loopback Host, a forged matching Origin. No cookie.
	const proxied = await app.fetch(
		post("http://localhost:7722", undefined, "application/json", null),
		"127.0.0.1",
	);
	expect(proxied.status).toBe(403);
	expect(await proxied.json()).toMatchObject({ code: "session", error: expect.stringContaining("terminal") });
	const wrongCookie = await app.fetch(
		post(
			"http://localhost:7722",
			undefined,
			"application/json",
			`${sessionCookieName(TOKEN)}=${"cd".repeat(32)}`,
		),
		"127.0.0.1",
	);
	expect(wrongCookie.status).toBe(403);
	// Another instance's cookie (other token, other name) does not count either.
	const other = "ef".repeat(32);
	const foreign = await app.fetch(
		post("http://localhost:7722", undefined, "application/json", `${sessionCookieName(other)}=${other}`),
		"127.0.0.1",
	);
	expect(foreign.status).toBe(403);
	expect(saved.size).toBe(0);
	// The cookie alone is not enough: the Origin check still applies.
	expect((await app.fetch(post("https://evil.example"), "127.0.0.1")).status).toBe(403);
	for (const [path, body] of [
		["/api/ai/settings", '{"brief":"claude-code"}'],
		["/api/ai/brief", "{}"],
		["/api/feeds/x/enabled", '{"on":true}'],
	] as const) {
		const res = await app.fetch(
			new Request(`http://localhost:7722${path}`, {
				method: "POST",
				headers: {
					host: "localhost:7722",
					origin: "http://localhost:7722",
					"content-type": "application/json",
				},
				body,
			}),
			"127.0.0.1",
		);
		expect(res.status).toBe(403);
	}
	const del = await app.fetch(
		new Request("http://localhost:7722/api/keys/demo-key", {
			method: "DELETE",
			headers: {
				host: "localhost:7722",
				origin: "http://localhost:7722",
				"content-type": "application/json",
			},
		}),
		"127.0.0.1",
	);
	expect(del.status).toBe(403);
	// Reads stay open without the cookie.
	expect((await app.fetch(new Request("http://localhost:7722/api/keys"), "127.0.0.1")).status).toBe(200);
	expect((await app.fetch(new Request("http://localhost:7722/api/meta"), "127.0.0.1")).status).toBe(200);
});

test("GET /api/bloqueos passes the domain (capped) to the lookup; absent lookup is a 404", async () => {
	const store = new Store(":memory:");
	const http: HttpLike = { request: async () => Promise.reject(new Error("offline")) };
	const asked: string[] = [];
	const live: boolean[] = [];
	const base = {
		store,
		scheduler: new Scheduler([], { store, http, key: () => undefined }),
		adapters: [],
		keys: { get: () => undefined, has: () => false, set: () => {}, remove: () => {}, origin: () => null },
		keySpecs: [],
		panels: new PanelCache([], store),
		http,
		version: "t",
		sessionToken: TOKEN,
	} satisfies Parameters<typeof createApp>[0];
	const app = createApp({
		...base,
		lookupDomain: async (d, options) => {
			asked.push(d);
			live.push(options.live);
			return d.includes(" ") ? { error: "Escribe un dominio válido." } : { domain: d };
		},
	});
	const get = (a: typeof app, q: string) =>
		a.fetch(
			new Request(`http://localhost:7722/api/bloqueos?dominio=${q}`, { headers: { host: "localhost:7722" } }),
			"127.0.0.1",
		);
	const res = await get(app, "infobae.com");
	expect(res.status).toBe(200);
	expect(((await res.json()) as { lookup: unknown }).lookup).toEqual({ domain: "infobae.com" });
	await get(app, "x".repeat(400));
	expect(asked[1]?.length).toBe(300);
	expect((await get(createApp(base), "a.com")).status).toBe(404);
	// A malformed domain is a 400 with the reason, not a 200 (review 3 M1).
	const bad = await get(app, "no%20es");
	expect(bad.status).toBe(400);
	expect(((await bad.json()) as { lookup: { error: string } }).lookup.error).toContain("válido");
});

test("GET /api/bloqueos: only Vigía's own page may trigger a live OONI query; any page still reads stored answers", async () => {
	const store = new Store(":memory:");
	const http: HttpLike = { request: async () => Promise.reject(new Error("offline")) };
	const live: boolean[] = [];
	const app = createApp({
		store,
		scheduler: new Scheduler([], { store, http, key: () => undefined }),
		adapters: [],
		keys: { get: () => undefined, has: () => false, set: () => {}, remove: () => {}, origin: () => null },
		keySpecs: [],
		panels: new PanelCache([], store),
		http,
		version: "t",
		sessionToken: TOKEN,
		lookupDomain: async (d, options) => {
			live.push(options.live);
			return { domain: d };
		},
	});
	const get = (headers: Record<string, string>) =>
		app.fetch(
			new Request("http://localhost:7722/api/bloqueos?dominio=x1.com", {
				headers: { host: "localhost:7722", ...headers },
			}),
			"127.0.0.1",
		);
	const cases: [Record<string, string>, boolean][] = [
		[{ "sec-fetch-site": "same-origin" }, true], // the /bloqueos page's fetch
		[{ "sec-fetch-site": "none" }, true], // typed into the address bar
		[{ "sec-fetch-site": "cross-site" }, false], // <img src="http://localhost:7722/api/bloqueos?…"> elsewhere
		[{ "sec-fetch-site": "same-site" }, false], // another port on localhost is another origin
		[{ "sec-fetch-site": "cross-site", origin: "http://localhost:7722" }, false], // the header wins
		[{}, false], // no browser metadata at all
		[{ referer: "http://localhost:7722/bloqueos" }, true], // an old browser on Vigía's page
		[{ referer: "https://evil.example/" }, false],
		[{ origin: "null" }, false],
	];
	for (const [headers, want] of cases) {
		const res = await get(headers);
		expect(res.status).toBe(200);
		expect(`${JSON.stringify(headers)} → ${live.at(-1)}`).toBe(`${JSON.stringify(headers)} → ${want}`);
	}
});

test("raw rows of sources whose terms forbid redistribution are refused; other feeds stay open", async () => {
	const { ripestatRouting } = await import("../adapters/ripestat-routing/index.ts");
	const { iodaStates } = await import("../adapters/ioda-states/index.ts");
	const { rssAdapter } = await import("../adapters/rss/factory.ts");
	const { OUTLETS } = await import("../adapters/rss/outlets.ts");
	const outlet = rssAdapter(OUTLETS[0] as (typeof OUTLETS)[number]);
	const store = new Store(":memory:");
	const http: HttpLike = {
		request: async () => ({ url: "", status: 200, contentType: "", fetchedAt: 0, body: "" }),
	};
	const adapters = [ripestatRouting, iodaStates, usgsQuakes, outlet] as unknown as Adapter[];
	const app = createApp({
		store,
		scheduler: new Scheduler([], { store, http, key: () => undefined }),
		adapters,
		keys: { get: () => undefined, has: () => false, set: () => {}, remove: () => {}, origin: () => null },
		keySpecs: [],
		panels: new PanelCache([], store),
		http,
		version: "test",
		sessionToken: "t".repeat(64),
	});
	const get = (path: string) =>
		app.fetch(
			new Request(`http://localhost:7722${path}`, { headers: { host: "localhost:7722" } }),
			"127.0.0.1",
		);
	expect((await get("/api/feeds/ripestat-routing/latest")).status).toBe(403);
	expect((await get("/api/feeds/ioda-states/series/state%3AVE-V")).status).toBe(403);
	// Headlines are display-only (title + link on the page), as evidence bundles already treat them.
	expect((await get(`/api/feeds/${outlet.id}/latest`)).status).toBe(403);
	expect((await get(`/api/feeds/${outlet.id}/series/x`)).status).toBe(403);
	expect((await get("/api/feeds/usgs-quakes/latest")).status).toBe(200);
});

test("a malformed percent-escape is a 400 on every route that decodes a path segment (review 4 L1)", async () => {
	const store = new Store(":memory:");
	const http: HttpLike = {
		request: async () => ({ url: "", status: 200, contentType: "", fetchedAt: 0, body: "" }),
	};
	const app = createApp({
		store,
		scheduler: new Scheduler([], { store, http, key: () => undefined }),
		adapters: [usgsQuakes] as unknown as Adapter[],
		keys: { get: () => undefined, has: () => false, set: () => {}, remove: () => {}, origin: () => null },
		keySpecs: [],
		panels: new PanelCache([], store),
		http,
		version: "test",
		sessionToken: "t".repeat(64),
	});
	const get = (path: string) =>
		app.fetch(
			new Request(`http://localhost:7722${path}`, { headers: { host: "localhost:7722" } }),
			"127.0.0.1",
		);
	for (const path of [
		"/api/panels/%E0%A4%A",
		"/api/feeds/usgs-quakes/series/%E0%A4%A",
		"/api/v1/sources/usgs-quakes/series/%E0%A4%A",
	]) {
		const res = await get(path);
		expect([path, res.status]).toEqual([path, 400]);
	}
	// Well-formed escapes still work.
	expect((await get("/api/feeds/usgs-quakes/series/a%20b")).status).toBe(200);
	expect((await get("/api/panels/nope%20x")).status).toBe(404);
});

test("live streams are capped per client by IPv6 /64, and a closed stream frees its slot (review 4 M9)", async () => {
	const { app } = setup();
	const open = (ip: string) =>
		app.fetch(new Request("http://localhost:7722/api/stream", { headers: { host: "localhost:7722" } }), ip);
	const held: Response[] = [];
	for (let i = 1; i <= 6; i++) {
		const res = await open(`2001:db8:7:8::${i}`);
		expect(res.status).toBe(200);
		held.push(res);
	}
	const seventh = await open("2001:db8:7:8::99");
	expect(seventh.status).toBe(429);
	expect(seventh.headers.get("retry-after")).toBe("30");
	expect((await open("2001:db8:7:9::1")).status).toBe(200); // another /64
	await held[0]?.body?.cancel();
	expect((await open("2001:db8:7:8::100")).status).toBe(200);
	app.closeStreams();
});

test("/api/meta: each licence sent once, a strong ETag, 304 on If-None-Match, cacheable briefly (review 4 M7)", async () => {
	const { ripestatRouting } = await import("../adapters/ripestat-routing/index.ts");
	const { rssAdapter } = await import("../adapters/rss/factory.ts");
	const { OUTLETS } = await import("../adapters/rss/outlets.ts");
	const outlets = OUTLETS.slice(0, 5).map((o) => rssAdapter(o));
	const adapters = [usgsQuakes, ripestatRouting, ...outlets] as unknown as Adapter[];
	const store = new Store(":memory:");
	const http: HttpLike = {
		request: async () => ({ url: "", status: 200, contentType: "", fetchedAt: 0, body: "" }),
	};
	const app = createApp({
		store,
		scheduler: new Scheduler([], { store, http, key: () => undefined }),
		adapters,
		keys: { get: () => undefined, has: () => false, set: () => {}, remove: () => {}, origin: () => null },
		keySpecs: [],
		panels: new PanelCache([], store),
		http,
		version: "test",
		sessionToken: "t".repeat(64),
	});
	const get = (headers: Record<string, string> = {}) =>
		app.fetch(
			new Request("http://localhost:7722/api/meta", { headers: { host: "localhost:7722", ...headers } }),
			"127.0.0.1",
		);
	const first = await get();
	expect(first.status).toBe(200);
	const etag = first.headers.get("etag") ?? "";
	expect(etag).toMatch(/^"[\w-]+"$/);
	expect(first.headers.get("cache-control")).not.toContain("no-store");
	const body = (await first.json()) as {
		feeds: { id: string; licence: string }[];
		licences: Record<string, unknown>;
	};
	// Licences by key, each once; every feed's key resolves to exactly its adapter's licence.
	const keys = Object.keys(body.licences);
	expect(keys.length).toBeLessThan(adapters.length);
	for (const a of adapters) {
		const feed = body.feeds.find((f) => f.id === a.id);
		expect(typeof feed?.licence).toBe("string");
		expect(body.licences[feed?.licence ?? ""]).toEqual(a.licence);
	}
	// Same representation → 304 with no body; the gzip representation has its own tag and revalidates too.
	const again = await get({ "if-none-match": etag });
	expect(again.status).toBe(304);
	expect(await again.text()).toBe("");
	const gz = await get({ "accept-encoding": "gzip" });
	const gzTag = gz.headers.get("etag") ?? "";
	expect(gz.headers.get("content-encoding")).toBe("gzip");
	expect(gzTag).not.toBe(etag);
	expect((await get({ "accept-encoding": "gzip", "if-none-match": gzTag })).status).toBe(304);
	// Stable between requests (no clock in the body), so revalidation actually hits.
	expect((await get()).headers.get("etag")).toBe(etag);
});
