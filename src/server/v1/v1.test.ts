import { expect, test } from "bun:test";
import type { z } from "zod";
import type { KeyStore } from "../../config/keys.ts";
import { sessionCookieName } from "../../config/session.ts";
import { Scheduler } from "../../core/scheduler.ts";
import { Store } from "../../core/store.ts";
import type { Adapter, HttpLike, Json, Observation } from "../../core/types.ts";
import { createApp, PUBLIC_REFUSAL } from "../app.ts";
import type { DeployConfig } from "../config.ts";
import { type Panel, PanelCache } from "../panels.ts";
import { cell, toCsv } from "./csv.ts";
import { panelFigures } from "./figures.ts";
import { OPERATIONS, openApiDocument } from "./openapi.ts";
import * as S from "./schemas.ts";

const T0 = Date.UTC(2026, 8, 24, 12);
const TOKEN = "cd".repeat(32);
const COOKIE = `${sessionCookieName(TOKEN)}=${TOKEN}`;

function adapter(id: string, raw: boolean): Adapter {
	return {
		id,
		layer: "money",
		name: { es: `Fuente ${id}`, en: `Source ${id}` },
		provider: "Demo",
		homepage: "https://example.org",
		licence: {
			id: `${id}-licence`,
			name: "Demo licence",
			url: "https://example.org/terms",
			attribution: `Fuente: ${id}`,
			commercial: false,
			...(raw ? {} : { raw: false as const }),
		},
		keys: [],
		intervalMs: 60_000,
		freshness: { fetchMs: 3_600_000, dataMs: null },
		fetch: async () => [],
		normalise: () => [],
	};
}

const OPEN = adapter("open-feed", true);
const CLOSED = adapter("closed-feed", false);

const obs = (source: string, series: string, at: number, value: Json): Observation => ({
	source,
	series,
	sourceUrl: `https://example.org/${series}`,
	fetchedAt: at + 60_000,
	observedAt: at,
	licence: `${source}-licence`,
	value,
	confidence: 1,
	basis: "official",
});

const demoPanel: Panel = {
	id: "demo",
	sources: ["open-feed", "closed-feed"],
	compute: () => ({
		rate: {
			feed: "open-feed",
			sourceUrl: "https://example.org/rate",
			observedAt: T0,
			fetchedAt: T0 + 60_000,
			stale: false,
			vesPerUsd: 853.5,
		},
		counts: [{ id: "VE-A", n: 3, updatedAt: T0 }],
		note: '=HYPERLINK("http://evil")',
	}),
};

function setup(deploy: Partial<Pick<DeployConfig, "mode" | "cors" | "metrics">> = {}) {
	let clock = T0 + 3_600_000;
	const now = () => clock;
	const store = new Store(":memory:");
	store.insert([
		obs("open-feed", "usd", T0 - 86_400_000, 850),
		obs("open-feed", "usd", T0, 853.5),
		obs("closed-feed", "headline", T0, "texto de un tercero"),
	]);
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
	const adapters = [OPEN, CLOSED];
	const scheduler = new Scheduler(adapters, { store, http, key: () => undefined, now });
	const app = createApp({
		store,
		scheduler,
		adapters,
		keys,
		keySpecs: [],
		panels: new PanelCache([demoPanel], store, now),
		http,
		version: "test",
		sessionToken: TOKEN,
		now,
		deploy,
		setFeedEnabled: () => {},
	});
	const get = (path: string, headers: Record<string, string> = {}, ip = "127.0.0.1") =>
		app.fetch(
			new Request(`http://localhost:7722${path}`, { headers: { host: "localhost:7722", ...headers } }),
			ip,
		);
	return { app, store, get, tick: (ms: number) => (clock += ms) };
}

/** Parses with the published schema and requires nothing to be dropped: every field in the answer is documented. */
function conforms(schema: z.ZodType, body: unknown): void {
	const parsed = schema.parse(body);
	expect(parsed).toEqual(body as never);
}

test("every v1 JSON route answers in the shape its OpenAPI schema documents", async () => {
	const { get } = setup();
	const cases: [string, z.ZodType][] = [
		["/api/v1", S.IndexResponse],
		["/api/v1/sources", S.SourcesResponse],
		["/api/v1/sources/open-feed", S.SourceResponse],
		["/api/v1/health", S.HealthResponse],
		["/api/v1/panels", S.PanelsResponse],
		["/api/v1/panels/demo", S.PanelResponse],
		["/api/v1/panels/demo/figures", S.FiguresResponse],
		["/api/v1/figures", S.FiguresResponse],
		["/api/v1/sources/open-feed/series", S.SeriesListResponse],
		[`/api/v1/sources/open-feed/series/usd?from=${T0 - 2 * 86_400_000}`, S.SeriesResponse],
		["/api/v1/archive/digests", S.DigestsResponse],
	];
	for (const [path, schema] of cases) {
		const res = await get(path);
		expect(res.status, path).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		const body = (await res.json()) as { apiVersion: string };
		expect(body.apiVersion).toBe("1");
		conforms(schema, body);
	}
});

test("the OpenAPI document is 3.1, lists every route, and every $ref resolves", async () => {
	const { get } = setup();
	const res = await get("/api/v1/openapi.json");
	expect(res.status).toBe(200);
	const doc = (await res.json()) as {
		openapi: string;
		paths: Record<string, unknown>;
		components: { schemas: Record<string, unknown> };
	};
	expect(doc.openapi).toBe("3.1.0");
	for (const op of OPERATIONS) expect(Object.keys(doc.paths)).toContain(op.path);
	const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"#\/components\/schemas\/([^"#]+)"/g)].map(
		(m) => m[1],
	);
	expect(refs.length).toBeGreaterThan(20);
	for (const r of refs) expect(Object.keys(doc.components.schemas)).toContain(r as string);
	// No generator leftovers: OpenAPI components carry no $schema/$id, and v1 objects stay open to added fields.
	expect(JSON.stringify(doc)).not.toContain('"$schema"');
	expect(JSON.stringify(doc)).not.toContain('"additionalProperties":false');
	expect(openApiDocument("test")).toBe(openApiDocument("test"));
});

test("sources whose terms forbid redistribution never give their rows, only derived results", async () => {
	const { get } = setup();
	expect((await get("/api/v1/sources/closed-feed/series")).status).toBe(403);
	expect((await get("/api/v1/sources/closed-feed/series/headline")).status).toBe(403);
	expect((await get("/api/v1/sources/closed-feed/series/headline?format=csv")).status).toBe(403);
	const all = await (await get("/api/v1/figures?format=csv")).text();
	expect(all).not.toContain("texto de un tercero");
	const meta = (await (await get("/api/v1/sources")).json()) as {
		sources: { id: string; rawAvailable: boolean }[];
	};
	expect(meta.sources.find((s) => s.id === "closed-feed")?.rawAvailable).toBe(false);
	expect((await get("/api/v1/sources/nope/series")).status).toBe(404);
});

test("a time series downloads as CSV with source, times and licence columns", async () => {
	const { get } = setup();
	const res = await get(`/api/v1/sources/open-feed/series/usd?from=${T0 - 2 * 86_400_000}&format=csv`);
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toStartWith("text/csv");
	expect(res.headers.get("content-disposition")).toMatch(
		/^attachment; filename="vigia-open-feed-usd-\d{8}-\d{4}\.csv"$/,
	);
	const bytes = new Uint8Array(await res.arrayBuffer());
	// UTF-8 byte-order mark, so spreadsheets read the accents right.
	expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
	const lines = new TextDecoder().decode(bytes).trimEnd().split("\r\n");
	expect(lines[0]).toBe(
		'"source","series","observed_at","fetched_at","value","source_url","licence","licence_url","attribution","confidence","basis","lat","lon","state","place"',
	);
	expect(lines).toHaveLength(3);
	expect(lines[2]).toBe(
		`"open-feed","usd","${new Date(T0).toISOString()}","${new Date(T0 + 60_000).toISOString()}",853.5,"https://example.org/usd","open-feed-licence","https://example.org/terms","Fuente: open-feed",1,"official",,,,`,
	);
	// Accept: text/csv chooses CSV too; an unknown format is refused.
	const byAccept = await get(`/api/v1/sources/open-feed/series/usd?from=${T0 - 2 * 86_400_000}`, {
		accept: "text/csv",
	});
	expect(byAccept.headers.get("content-type")).toStartWith("text/csv");
	expect((await get("/api/v1/panels/demo/figures?format=xml")).status).toBe(400);
	// Exports are compressed like the rest of the API on a slow connection.
	const gz = await get("/api/v1/figures?format=csv", { "accept-encoding": "gzip" });
	expect(gz.headers.get("vary")).toContain("accept-encoding");
});

test("panel figures carry their provenance; text a spreadsheet would run is neutralised", async () => {
	const rows = panelFigures(
		"demo",
		demoPanel.compute(new Store(":memory:"), T0),
		demoPanel.sources,
		new Map([
			[OPEN.id, OPEN],
			[CLOSED.id, CLOSED],
		]),
	);
	expect(rows).toEqual([
		{
			panel: "demo",
			path: "rate.vesPerUsd",
			label: null,
			value: 853.5,
			feed: "open-feed",
			sourceUrl: "https://example.org/rate",
			observedAt: T0,
			fetchedAt: T0 + 60_000,
			stale: false,
			licence: "open-feed-licence",
			licenceUrl: "https://example.org/terms",
			attribution: "Fuente: open-feed",
			panelSources: ["open-feed", "closed-feed"],
		},
		{
			panel: "demo",
			path: "counts[VE-A].n",
			label: null,
			value: 3,
			// Two feeds and no feed named around the number: unknown, never guessed.
			feed: null,
			sourceUrl: null,
			observedAt: null,
			fetchedAt: null,
			stale: null,
			licence: null,
			licenceUrl: null,
			attribution: null,
			panelSources: ["open-feed", "closed-feed"],
		},
	]);
	expect(cell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
	expect(cell("+1")).toBe(`"'+1"`);
	expect(cell(-3.5)).toBe("-3.5");
	expect(cell("a,b")).toBe('"a,b"');
	expect(cell(null)).toBe("");
	expect(toCsv(["a", "b"], [[1, "x\ny"]])).toBe('﻿"a","b"\r\n1,"x\ny"\r\n');
});

test("CSV (review 4 L2): every text cell quoted, so a ';' split cannot start a cell; the formula guard sees past blanks", () => {
	// Excel in Spanish splits on ';': unquoted, "https://x/a;=1+1" became a cell starting with "=".
	expect(cell("https://x/a;=1+1")).toBe('"https://x/a;=1+1"');
	expect(cell("Caracas; Zulia")).toBe('"Caracas; Zulia"');
	// Leading space, NBSP, other Unicode blanks and zero-widths before the formula character.
	for (const lead of [" ", "  ", "\u00a0", "\u2007", "\u3000", "\u200b", "\ufeff", " \u00a0"])
		expect(cell(`${lead}=cmd|' /C calc'!A0`)).toBe(`"'${lead}=cmd|' /C calc'!A0"`);
	expect(cell("\tx")).toBe(`"'\tx"`);
	expect(cell("@SUM(A1)")).toBe(`"'@SUM(A1)"`);
	// Ordinary text and numbers are untouched (numbers stay numbers).
	expect(cell("Distrito Capital")).toBe('"Distrito Capital"');
	expect(cell("a = b")).toBe('"a = b"');
	expect(cell(12.5)).toBe("12.5");
	expect(cell(true)).toBe("true");
});

test("conditional requests: ETag and Last-Modified revalidate to 304, and a change gives a new ETag", async () => {
	const { get, tick, store } = setup();
	const first = await get("/api/v1/sources/open-feed/series/usd");
	const etag = first.headers.get("etag") ?? "";
	const lastModified = first.headers.get("last-modified") ?? "";
	expect(etag).toMatch(/^W\/"[0-9a-f]+"$/);
	expect(new Date(lastModified).getTime()).toBe(Math.floor((T0 + 60_000) / 1000) * 1000);
	expect(first.headers.get("cache-control")).toBe("public, max-age=30");
	tick(5_000);
	// generatedAt moved on; the content did not.
	const again = await get("/api/v1/sources/open-feed/series/usd", { "if-none-match": etag });
	expect(again.status).toBe(304);
	expect(await again.text()).toBe("");
	expect(again.headers.get("etag")).toBe(etag);
	expect(
		(await get("/api/v1/sources/open-feed/series/usd", { "if-modified-since": lastModified })).status,
	).toBe(304);
	// If-None-Match wins over If-Modified-Since (RFC 9110).
	expect(
		(
			await get("/api/v1/sources/open-feed/series/usd", {
				"if-none-match": 'W/"0"',
				"if-modified-since": lastModified,
			})
		).status,
	).toBe(200);
	store.insert([obs("open-feed", "usd", T0 + 1_800_000, 854)]);
	const changed = await get("/api/v1/sources/open-feed/series/usd", { "if-none-match": etag });
	expect(changed.status).toBe(200);
	expect(changed.headers.get("etag")).not.toBe(etag);
	// Panels: the same computed view revalidates too.
	const panel = await get("/api/v1/panels/demo");
	expect(
		(await get("/api/v1/panels/demo", { "if-none-match": panel.headers.get("etag") ?? "" })).status,
	).toBe(304);
});

test("CORS: off in local mode by default, open for reads when configured, never for writes", async () => {
	const local = setup();
	const plain = await local.get("/api/v1/panels", { origin: "https://other.example" });
	expect(plain.headers.get("access-control-allow-origin")).toBeNull();
	const open = setup({ cors: true });
	const res = await open.get("/api/v1/panels", { origin: "https://other.example" });
	expect(res.headers.get("access-control-allow-origin")).toBe("*");
	expect(res.headers.get("access-control-allow-credentials")).toBeNull();
	expect(res.headers.get("access-control-expose-headers")).toContain("etag");
	const pre = await open.app.fetch(
		new Request("http://localhost:7722/api/v1/panels", {
			method: "OPTIONS",
			headers: {
				host: "localhost:7722",
				origin: "https://other.example",
				"access-control-request-method": "GET",
			},
		}),
		"127.0.0.1",
	);
	expect(pre.status).toBe(204);
	expect(pre.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");
	const post = await open.app.fetch(
		new Request("http://localhost:7722/api/v1/panels", {
			method: "POST",
			headers: { host: "localhost:7722" },
		}),
		"127.0.0.1",
	);
	expect(post.status).toBe(405);
	expect(post.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
	// CORS never reaches the internal routes.
	expect((await open.get("/api/panels")).headers.get("access-control-allow-origin")).toBeNull();
});

test("rate limits answer 429 with Retry-After; exports cost more", async () => {
	const { get } = setup();
	let status = 200;
	let n = 0;
	let last: Response | null = null;
	while (status !== 429 && n < 200) {
		last = await get("/api/v1/figures?format=csv", {}, "10.0.0.9");
		status = last.status;
		n++;
	}
	expect(status).toBe(429);
	expect(n).toBeLessThanOrEqual(25);
	expect(last?.headers.get("retry-after")).toBe("5");
	// Another client is unaffected.
	expect((await get("/api/v1/panels", {}, "10.0.0.10")).status).toBe(200);
});

test("HEAD answers the headers without a body", async () => {
	const { app } = setup();
	const res = await app.fetch(
		new Request("http://localhost:7722/api/v1/panels", {
			method: "HEAD",
			headers: { host: "localhost:7722" },
		}),
		"127.0.0.1",
	);
	expect(res.status).toBe(200);
	expect(res.headers.get("etag")).toBeTruthy();
	expect(await res.text()).toBe("");
});

test("public mode: every write refused regardless of cookie, no token exchange, any Host served", async () => {
	const { app } = setup({ mode: "public" });
	const write = await app.fetch(
		new Request("http://localhost:7722/api/feeds/open-feed/enabled", {
			method: "POST",
			headers: {
				host: "localhost:7722",
				origin: "http://localhost:7722",
				"content-type": "application/json",
				cookie: COOKIE,
			},
			body: JSON.stringify({ on: false }),
		}),
		"127.0.0.1",
	);
	expect(write.status).toBe(403);
	expect(((await write.json()) as { error: string }).error).toBe(PUBLIC_REFUSAL);
	for (const path of ["/api/keys/demo", "/api/ai/settings", "/api/ai/brief"]) {
		const res = await app.fetch(
			new Request(`http://localhost:7722${path}`, {
				method: "POST",
				headers: {
					host: "localhost:7722",
					origin: "http://localhost:7722",
					"content-type": "application/json",
					cookie: COOKIE,
				},
				body: "{}",
			}),
			"127.0.0.1",
		);
		expect(res.status, path).toBe(403);
	}
	const exchange = await app.fetch(
		new Request(`http://mirror.example/?token=${TOKEN}`, { headers: { host: "mirror.example" } }),
		"203.0.113.5",
	);
	expect(exchange.headers.get("set-cookie")).toBeNull();
	const meta = await app.fetch(
		new Request("http://mirror.example/api/meta", { headers: { host: "mirror.example" } }),
		"203.0.113.5",
	);
	expect(meta.status).toBe(200);
	expect(((await meta.json()) as { mode: string }).mode).toBe("public");
	// Local mode keeps refusing a foreign Host.
	const local = setup();
	const foreign = await local.app.fetch(
		new Request("http://mirror.example/api/meta", { headers: { host: "mirror.example" } }),
		"203.0.113.5",
	);
	expect(foreign.status).toBe(421);
});

test("/metrics: Prometheus text for this machine only unless opened; counts requests and feed runs", async () => {
	const { app, get, store } = setup();
	await get("/api/v1/panels");
	store.recordRun({
		source: "open-feed",
		startedAt: T0,
		finishedAt: T0 + 1_500,
		ok: true,
		error: null,
		bytes: 10,
		received: 1,
		inserted: 1,
	});
	app.publish({ type: "run", source: "open-feed", ok: true, inserted: 1, series: ["usd"], at: T0 + 1_500 });
	const res = await get("/metrics");
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
	const text = await res.text();
	expect(text).toContain('vigia_build_info{version="test",mode="local"} 1');
	expect(text).toContain('vigia_feed_state{feed="open-feed",state="pending"} 0');
	expect(text).toContain('vigia_http_requests_total{family="api_v1",code="2xx"} 1');
	expect(text).toContain('vigia_feed_runs_total{feed="open-feed",result="ok"} 1');
	expect(text).toContain('vigia_feed_run_duration_seconds_bucket{feed="open-feed",le="2"} 1');
	expect(text).toContain('vigia_feed_run_duration_seconds_bucket{feed="open-feed",le="1"} 0');
	expect(text).toMatch(/vigia_http_request_duration_seconds_count\{family="api_v1"\} 1\n/);
	// Every sample line is "name{labels} number".
	for (const line of text.trim().split("\n"))
		if (!line.startsWith("#")) expect(line).toMatch(/^[a-z_]+(\{[^}]*\})? (-?[\d.e+-]+|NaN|\+Inf)$/);
	// Another machine, or this machine through a reverse proxy with a public Host: not found.
	expect((await get("/metrics", {}, "192.168.1.9")).status).toBe(404);
	expect((await get("/metrics", { host: "vigia.example.org" })).status).not.toBe(200);
	const open = setup({ metrics: "open", mode: "public" });
	expect(
		(
			await open.app.fetch(
				new Request("http://x.example/metrics", { headers: { host: "x.example" } }),
				"203.0.113.1",
			)
		).status,
	).toBe(200);
	const off = setup({ metrics: "off" });
	expect((await off.get("/metrics")).status).toBe(404);
});

test("security headers on every route family, including errors, 304s and exports", async () => {
	const { app, get } = setup({ cors: true });
	const panel = await get("/api/v1/panels");
	const responses: [string, Response][] = [
		["api v1", panel],
		["api v1 304", await get("/api/v1/panels", { "if-none-match": panel.headers.get("etag") ?? "" })],
		["api v1 csv", await get("/api/v1/figures?format=csv")],
		["api v1 404", await get("/api/v1/nope")],
		["api v1 403", await get("/api/v1/sources/closed-feed/series")],
		["openapi", await get("/api/v1/openapi.json")],
		["api docs", await get("/api")],
		["report", await get("/informe")],
		["metrics", await get("/metrics")],
		["internal api", await get("/api/panels")],
		["internal 404", await get("/api/nope")],
		["text", await get("/ahora.txt")],
		["static 404", await get("/nothing-here.js")],
		[
			"preflight",
			await app.fetch(
				new Request("http://localhost:7722/api/v1/panels", {
					method: "OPTIONS",
					headers: { host: "localhost:7722" },
				}),
				"127.0.0.1",
			),
		],
		[
			"foreign host",
			await app.fetch(
				new Request("http://evil.example/", { headers: { host: "evil.example" } }),
				"127.0.0.1",
			),
		],
	];
	for (const [name, res] of responses) {
		expect(res.headers.get("content-security-policy"), name).toContain("default-src 'self'");
		expect(res.headers.get("content-security-policy"), name).toContain("frame-ancestors 'none'");
		expect(res.headers.get("x-content-type-options"), name).toBe("nosniff");
		expect(res.headers.get("referrer-policy"), name).toBe("no-referrer");
		expect(res.headers.get("cross-origin-opener-policy"), name).toBe("same-origin");
		expect(res.headers.get("permissions-policy"), name).toContain("geolocation=()");
	}
});

test("the API docs page and the report are complete, escaped and script-free", async () => {
	const { get } = setup();
	const docs = await (await get("/api")).text();
	for (const op of OPERATIONS) expect(docs).toContain(op.path.replace(/[{}]/g, (c) => c));
	expect(docs).toContain('<html lang="es">');
	expect(docs).toContain("/api/v1/openapi.json");
	expect(docs).not.toContain("<script");
	const report = await get("/informe");
	expect(report.headers.get("content-type")).toBe("text/html; charset=utf-8");
	const html = await report.text();
	expect(html).toContain("Informe diario");
	expect(html).toContain("@media print");
	expect(html).toContain("Fuentes y licencias");
	expect(html).not.toContain("<script");
});

test("exported figures carry no floating-point noise but keep published precision", async () => {
	const { tidy } = await import("./figures.ts");
	expect(tidy(855.6625 - 853.4993)).toBe(2.1632);
	expect(tidy(972.648677)).toBe(972.648677);
	expect(tidy(855.6625)).toBe(855.6625);
	expect(tidy(7_640_872)).toBe(7_640_872);
});
