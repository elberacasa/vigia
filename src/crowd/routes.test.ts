import { describe, expect, test } from "bun:test";
import type { KeyStore } from "../config/keys.ts";
import { Scheduler } from "../core/scheduler.ts";
import { Store } from "../core/store.ts";
import type { HttpLike } from "../core/types.ts";
import { crowdPanel } from "../panels/crowd.ts";
import { createApp } from "../server/app.ts";
import { PanelCache } from "../server/panels.ts";
import { solve } from "./pow-solve.ts";
import { hostIsLiteral } from "./routes.ts";
import type { CrowdMode } from "./rules.ts";
import { CrowdService } from "./service.ts";

const TOKEN = "cd".repeat(32);
const BARALT = "ve.zulia.baralt";

function setup(
	options: { mode?: CrowdMode; lan?: boolean; enabled?: boolean; proxies?: readonly string[] } = {},
) {
	const mode = options.mode ?? "local";
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
	const crowd = new CrowdService({
		store,
		mode,
		enabled: options.enabled ?? true,
		powBits: 2,
		trustedProxy: (ip) => (options.proxies ?? []).includes(ip),
	});
	const app = createApp({
		store,
		scheduler: new Scheduler([], { store, http, key: () => undefined }),
		adapters: [],
		keys,
		keySpecs: [],
		panels: new PanelCache([crowdPanel], store),
		http,
		version: "test",
		sessionToken: TOKEN,
		lan: options.lan ?? false,
		deploy: { mode },
		crowd,
	});
	return { app, crowd, store };
}

type Post = {
	host: string;
	origin?: string | null;
	type?: string;
	site?: string;
	body?: unknown;
	raw?: string;
	length?: number;
};

async function challenge(app: ReturnType<typeof setup>["app"], host: string, ip: string) {
	const res = await app.fetch(new Request(`http://${host}/api/crowd/challenge`, { headers: { host } }), ip);
	const c = (await res.json()) as { challenge: string; difficulty: number };
	return { challenge: c.challenge, nonce: solve(c.challenge, c.difficulty)?.nonce ?? "" };
}

async function post(app: ReturnType<typeof setup>["app"], ip: string, p: Post) {
	const pow = await challenge(app, p.host, ip);
	const body =
		p.raw ?? JSON.stringify({ municipality: BARALT, answers: { luz: "no" }, ...pow, ...(p.body as object) });
	const origin = p.origin === undefined ? `http://${p.host}` : p.origin;
	const res = await app.fetch(
		new Request(`http://${p.host}/api/crowd/reports`, {
			method: "POST",
			headers: {
				host: p.host,
				"content-type": p.type ?? "application/json",
				...(origin ? { origin } : {}),
				...(p.site ? { "sec-fetch-site": p.site } : {}),
				...(p.length ? { "content-length": String(p.length) } : {}),
			},
			body,
		}),
		ip,
	);
	return { status: res.status, body: (await res.json()) as { ok?: boolean; code?: string; error?: string } };
}

describe("the anonymous write guard", () => {
	test("from this machine, same origin, JSON: accepted with no session cookie", async () => {
		const { app } = setup();
		const r = await post(app, "127.0.0.1", { host: "localhost:7722", site: "same-origin" });
		expect(r.status).toBe(200);
		expect(r.body.ok).toBe(true);
		// Counted, held or replaced: the answer is always "received" (no real-time oracle behind a shared address).
		expect((r.body as { results: unknown[] }).results).toEqual([
			{ service: "luz", answer: "no", status: "received" },
		]);
		// With the page's per-device token: accepted, and the answer is the same "received".
		const withToken = await post(app, "127.0.0.1", {
			host: "localhost:7722",
			body: { token: "AAAAAAAAAAAAAAAAAAAAAA" },
		});
		expect(withToken.status).toBe(200);
		expect((await post(app, "127.0.0.1", { host: "localhost:7722", body: { token: "no" } })).status).toBe(
			400,
		);
		const again = await post(app, "127.0.0.1", { host: "localhost:7722" });
		expect((again.body as { results: { status: string }[] }).results[0]?.status).toBe("received");
	});

	test("no Origin, another origin, a cross-site fetch or a form post: refused", async () => {
		const { app } = setup();
		const host = "localhost:7722";
		expect((await post(app, "127.0.0.1", { host, origin: null })).status).toBe(403);
		expect((await post(app, "127.0.0.1", { host, origin: "https://evil.example" })).status).toBe(403);
		expect((await post(app, "127.0.0.1", { host, site: "cross-site" })).status).toBe(403);
		expect((await post(app, "127.0.0.1", { host, type: "text/plain" })).status).toBe(415);
		expect((await post(app, "127.0.0.1", { host, type: "application/x-www-form-urlencoded" })).status).toBe(
			415,
		);
	});

	test("oversized or malformed bodies are refused before anything is counted", async () => {
		const { app, store } = setup();
		const host = "localhost:7722";
		// Declared too long: refused before reading; not declared: read up to the cap, then refused.
		expect((await post(app, "127.0.0.1", { host, raw: "x".repeat(5_000), length: 5_000 })).status).toBe(413);
		expect((await post(app, "127.0.0.1", { host, raw: "x".repeat(5_000) })).status).toBe(400);
		expect((await post(app, "127.0.0.1", { host, raw: "{not json" })).status).toBe(400);
		expect((await post(app, "127.0.0.1", { host, body: { municipality: "ve.zulia" } })).status).toBe(400);
		expect(store.db.query("SELECT COUNT(*) AS n FROM crowd_counts").get()).toEqual({ n: 0 });
	});

	test("a chunked body with no declared length is still capped", async () => {
		const { app } = setup();
		const host = "localhost:7722";
		const chunks = new ReadableStream<Uint8Array>({
			start(c) {
				for (let i = 0; i < 10; i++) c.enqueue(new TextEncoder().encode("x".repeat(1_000)));
				c.close();
			},
		});
		const res = await app.fetch(
			new Request(`http://${host}/api/crowd/reports`, {
				method: "POST",
				headers: { host, origin: `http://${host}`, "content-type": "application/json" },
				body: chunks,
			}),
			"127.0.0.1",
		);
		expect(res.status).toBe(400);
	});

	test("a household on the LAN may report to a personal Vigía by its address; a rebound DNS name may not", async () => {
		const { app } = setup({ lan: true });
		expect((await post(app, "192.168.1.30", { host: "192.168.1.10:7722" })).status).toBe(200);
		expect((await post(app, "fd00::30", { host: "[fd00::10]:7722" })).status).toBe(200);
		// DNS rebinding: the attacker's page is same-origin with its own name, which now resolves to the LAN address.
		const rebound = await post(app, "192.168.1.31", { host: "attacker.example:7722" });
		expect(rebound.status).toBe(403);
		// A public address never reaches a personal Vigía's reports (a port forwarded by mistake).
		const remote = await post(app, "8.8.8.8", { host: "192.168.1.10:7722" });
		expect(remote.status).toBe(403);
		expect(remote.body.code).toBe("remote");
	});

	test("a public mirror takes reports from public addresses; an undeclared proxy (private peer) is refused with the fix", async () => {
		const { app } = setup({ mode: "public" });
		const ok = await post(app, "8.8.4.4", { host: "vigia.example.org" });
		expect(ok.status).toBe(200);
		const proxy = await post(app, "172.18.0.1", { host: "vigia.example.org" });
		expect(proxy.status).toBe(503);
		expect(proxy.body.error).toContain("VIGIA_TRUST_PROXY");
		// A declared CDN edge (public) as the client: its X-Forwarded-For was missing, the visitor is unknown.
		const cdn = setup({ mode: "public", proxies: ["203.0.113.44", "8.8.4.4"] });
		const edge = await post(cdn.app, "8.8.4.4", { host: "vigia.example.org" });
		expect(edge.status).toBe(503);
		expect(edge.body.code).toBe("proxy");
		// The other writes stay refused on a public mirror.
		const res = await app.fetch(
			new Request("http://vigia.example.org/api/ai/settings", {
				method: "POST",
				headers: {
					host: "vigia.example.org",
					origin: "http://vigia.example.org",
					"content-type": "application/json",
				},
				body: "{}",
			}),
			"8.8.4.4",
		);
		expect(res.status).toBe(403);
	});

	test("turned off: 404 with code off, and the page can tell from GET /api/crowd", async () => {
		const { app } = setup({ enabled: false });
		const info = await app.fetch(
			new Request("http://localhost:7722/api/crowd", { headers: { host: "localhost:7722" } }),
			"127.0.0.1",
		);
		expect(((await info.json()) as { enabled: boolean }).enabled).toBe(false);
		const r = await app.fetch(
			new Request("http://localhost:7722/api/crowd/reports", {
				method: "POST",
				headers: {
					host: "localhost:7722",
					origin: "http://localhost:7722",
					"content-type": "application/json",
				},
				body: "{}",
			}),
			"127.0.0.1",
		);
		expect(r.status).toBe(404);
	});

	test("unknown crowd paths and methods", async () => {
		const { app } = setup();
		const get = (path: string, method = "GET") =>
			app.fetch(
				new Request(`http://localhost:7722${path}`, { method, headers: { host: "localhost:7722" } }),
				"127.0.0.1",
			);
		expect((await get("/api/crowd/nope")).status).toBe(404);
		expect((await get("/api/crowd/reports")).status).toBe(405);
		expect((await get("/api/crowd", "DELETE")).status).toBe(405);
	});

	test("the published counts are an ordinary panel", async () => {
		const { app, crowd } = setup();
		await post(app, "127.0.0.1", { host: "localhost:7722" });
		crowd.snapshot();
		const res = await app.fetch(
			new Request("http://localhost:7722/api/panels/crowd", { headers: { host: "localhost:7722" } }),
			"127.0.0.1",
		);
		const view = (await res.json()) as { panel: { municipalities: { entity: string; reports: number }[] } };
		expect(view.panel.municipalities[0]).toMatchObject({ entity: BARALT, reports: 1 });
	});
});

test("hosts that cannot be rebound: localhost names and address literals only", () => {
	for (const h of ["localhost:7722", "vigia.localhost", "192.168.1.10:7722", "[fe80::1]:7722", "10.0.0.2"])
		expect(hostIsLiteral(h)).toBe(true);
	for (const h of ["attacker.example", "localhost.attacker.example", "192.168.1.10.nip.io", "casa.local"])
		expect(hostIsLiteral(h)).toBe(false);
});
