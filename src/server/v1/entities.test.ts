import { expect, test } from "bun:test";
import type { z } from "zod";
import { ADAPTERS } from "../../adapters/registry.ts";
import type { KeyStore } from "../../config/keys.ts";
import { Scheduler } from "../../core/scheduler.ts";
import { Store } from "../../core/store.ts";
import type { HttpLike, Json, Observation } from "../../core/types.ts";
import { registry } from "../../ontology/registry.ts";
import type {
	EntityDetail,
	EntityRef,
	EntityView,
	LocateView,
	NowItem,
	SearchView,
	TimelineView,
} from "../../ontology/view.ts";
import { createApp } from "../app.ts";
import { PANELS } from "../panel-registry.ts";
import { PanelCache } from "../panels.ts";
import * as S from "./schemas.ts";

const T0 = Date.UTC(2026, 8, 28, 12);
const HOUR = 3_600_000;
const TOKEN = "ef".repeat(32);

const guri = registry().get("infra.guri")?.point ?? { lat: 7.76, lon: -62.99 };

const observations: Observation[] = [
	{
		source: "el-pitazo",
		series: "item:1",
		sourceUrl: "https://example.org/1",
		fetchedAt: T0 - HOUR + 60_000,
		observedAt: T0 - HOUR,
		licence: "headline-link",
		value: {
			outlet: "el-pitazo",
			title: "Apagón en Maracaibo: vecinos reportan cortes; el CNE no se pronuncia",
			link: "https://example.org/1",
			summary: "Texto de un tercero que no se redistribuye.",
			image: null,
			dateMissing: false,
			video: false,
		},
		confidence: 1,
		basis: "report",
	},
	{
		source: "usgs-quakes",
		series: "quake:us1",
		sourceUrl: "https://earthquake.usgs.gov/earthquakes/eventpage/us1",
		fetchedAt: T0 - 2 * HOUR + 60_000,
		observedAt: T0 - 2 * HOUR,
		licence: "usgs-public-domain",
		value: { mag: 4.4, placeEs: "a 12 km al N de Guri (Bolívar)", depthKm: 10 } as Json,
		location: { lat: guri.lat + 0.1, lon: guri.lon, state: "VE-F" },
		confidence: 1,
		basis: "measurement",
	},
	{
		source: "ioda-events",
		series: "event:asn/8048:bgp:1",
		sourceUrl: "https://ioda.inetintel.cc.gatech.edu/asn/8048",
		fetchedAt: T0 - HOUR,
		observedAt: T0 - 3 * HOUR,
		licence: "ioda",
		value: {
			entityType: "asn",
			entityCode: "8048",
			entityName: "CANTV (AS8048)",
			key: "cantv",
			datasource: "bgp",
			startS: (T0 - 3 * HOUR) / 1000,
			durationS: 1800,
			score: 100,
			method: "median",
		},
		confidence: 1,
		basis: "measurement",
	},
];

function setup() {
	let clock = T0;
	const now = () => clock;
	const store = new Store(":memory:");
	store.insert(observations);
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
	const scheduler = new Scheduler(ADAPTERS, { store, http, key: () => undefined, now });
	const app = createApp({
		store,
		scheduler,
		adapters: ADAPTERS,
		keys,
		keySpecs: [],
		panels: new PanelCache(PANELS, store, now),
		http,
		version: "test",
		sessionToken: TOKEN,
		now,
		setFeedEnabled: () => {},
	});
	const get = (path: string, ip = "127.0.0.1") =>
		app.fetch(new Request(`http://localhost:7722${path}`, { headers: { host: "localhost:7722" } }), ip);
	return { app, store, get, tick: (ms: number) => (clock += ms) };
}

/** Parses with the published schema and requires nothing to be dropped: every field in the answer is documented. */
function conforms(schema: z.ZodType, body: unknown): void {
	expect(schema.parse(body)).toEqual(body as never);
}

// The client's types (src/ontology/view.ts) and the published schemas describe the same shapes.
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Envelope = { apiVersion: "1"; generatedAt: number };
const sameRef: Mutual<z.infer<typeof S.EntityRef>, EntityRef> = true;
const sameDetail: Mutual<z.infer<typeof S.EntityDetail>, EntityDetail> = true;
const sameNow: Mutual<z.infer<typeof S.NowItem>, NowItem> = true;
const sameEntity: Mutual<z.infer<typeof S.EntityResponse>, Envelope & EntityView> = true;
const sameTimeline: Mutual<z.infer<typeof S.TimelineResponse>, Envelope & TimelineView> = true;
const sameSearch: Mutual<z.infer<typeof S.EntitySearchResponse>, Envelope & SearchView> = true;
const sameLocate: Mutual<z.infer<typeof S.LocateResponse>, Envelope & LocateView> = true;

test("the view types and the published schemas are the same shapes", () => {
	expect([sameRef, sameDetail, sameNow, sameEntity, sameTimeline, sameSearch, sameLocate]).toEqual(
		Array(7).fill(true),
	);
});

test("every entity route answers in the shape its OpenAPI schema documents, for every entity type", async () => {
	const { get, app } = setup();
	await app.syncLinks();
	const cases: [string, z.ZodType][] = [
		["/api/v1/entities?q=zulia", S.EntitySearchResponse],
		["/api/v1/entities?type=state&limit=500", S.EntitySearchResponse],
		["/api/v1/entities/ve", S.EntityResponse],
		["/api/v1/entities/ve.zulia", S.EntityResponse],
		["/api/v1/entities/ve.zulia.maracaibo", S.EntityResponse],
		["/api/v1/entities/ve.distrito-capital.libertador.catedral", S.EntityResponse],
		["/api/v1/entities/infra.guri", S.EntityResponse],
		["/api/v1/entities/infra.refineria-amuay", S.EntityResponse],
		["/api/v1/entities/infra.puerto-cabello", S.EntityResponse],
		["/api/v1/entities/infra.represa-del-guri", S.EntityResponse],
		["/api/v1/entities/net.cantv", S.EntityResponse],
		["/api/v1/entities/asn.8048", S.EntityResponse],
		["/api/v1/entities/outlet.el-pitazo", S.EntityResponse],
		["/api/v1/entities/inst.bcv", S.EntityResponse],
		["/api/v1/entities/ve.zulia/timeline", S.TimelineResponse],
		["/api/v1/entities/infra.guri/timeline?kinds=quake", S.TimelineResponse],
		["/api/v1/locate?lat=10.65&lon=-71.64", S.LocateResponse],
	];
	for (const [path, schema] of cases) {
		const res = await get(path);
		expect(res.status, path).toBe(200);
		conforms(schema, await res.json());
	}
});

test("an entity page: parents, children, population side by side, links, and every figure sourced", async () => {
	const { get, app } = setup();
	await app.syncLinks();
	const zulia = (await (await get("/api/v1/entities/ve.zulia.maracaibo")).json()) as EntityView;
	expect(zulia.parents.map((p) => p.id)).toEqual(["ve.zulia", "ve"]);
	expect(zulia.children.byType.parish).toBeGreaterThan(10);
	expect(zulia.population?.census2011?.people).toBeGreaterThan(1_000_000);
	expect(zulia.population?.worldpop2026?.people).toBeGreaterThan(1_000_000);
	expect(zulia.links.backlog).toBe(0);
	// The headline names Maracaibo: it is a story of the municipality, labelled as keyword location.
	expect(zulia.stories.map((s) => [s.title, s.rule, s.outlet?.id])).toEqual([
		[
			"Apagón en Maracaibo: vecinos reportan cortes; el CNE no se pronuncia",
			"text-place",
			"outlet.el-pitazo",
		],
	]);
	// IODA measures per state: a municipality shows its state's figure, scoped to the state.
	for (const n of zulia.now) {
		expect(n.source.attribution.length, n.layer).toBeGreaterThan(0);
		if (n.computed) expect(n.method, n.layer).not.toBeNull();
	}
	// No feed has run in this test: every figure from a feed is marked stale (a zero from a feed that is not
	// updating is not a measurement of zero); the headline count sums the archive and carries no feed of its own.
	expect(zulia.now.length).toBeGreaterThan(3);
	expect(zulia.now.filter((n) => n.layer !== "news").every((n) => n.stale)).toBe(true);
	const news = zulia.now.find((n) => n.layer === "news");
	expect(news?.figures).toEqual({ headlines48h: 1 });
	expect(news?.scope.id).toBe("ve.zulia.maracaibo");
	// A facility: its operator, what is near it, and the quake within 30 km in its timeline.
	const g = (await (await get("/api/v1/entities/infra.guri")).json()) as EntityView;
	expect(g.entity.related.map((r) => r.entity.id)).toEqual(["inst.corpoelec"]);
	expect(g.entity.dataset.licence.id).toBe("odbl-1.0");
	expect(g.nearby.items.some((n) => n.entity.id === "infra.represa-del-guri")).toBe(true);
	const tl = (await (await get("/api/v1/entities/infra.guri/timeline")).json()) as TimelineView;
	expect(tl.items.map((i) => [i.kind, i.rule])).toEqual([["quake", "near"]]);
	expect(tl.items[0]?.km).toBeCloseTo(11, 0);
});

test("timelines never pass on the rows of sources whose terms forbid it", async () => {
	const { get, app } = setup();
	await app.syncLinks();
	const cne = (await (await get("/api/v1/entities/inst.cne/timeline")).json()) as TimelineView;
	const headline = cne.items.find((i) => i.kind === "headline");
	expect(headline?.title.es).toContain("CNE");
	expect(headline?.url).toBe("https://example.org/1");
	expect(headline?.figures).toBeNull();
	expect(JSON.stringify(cne)).not.toContain("Texto de un tercero");
	const cantv = (await (await get("/api/v1/entities/net.cantv/timeline")).json()) as TimelineView;
	expect(cantv.items.map((i) => [i.kind, i.figures])).toEqual([["outage", null]]);
	// USGS is public domain: its figures travel.
	const guri = (await (await get("/api/v1/entities/infra.guri/timeline")).json()) as TimelineView;
	expect(guri.items[0]?.figures).toEqual({ mag: 4.4, depthKm: 10 });
});

test("search, list, locate; clear errors for unknown ids and bad parameters", async () => {
	const { get } = setup();
	const s = (await (await get("/api/v1/entities?q=maracaibo&type=municipality")).json()) as SearchView;
	expect(s.results[0]?.entity.id).toBe("ve.zulia.maracaibo");
	expect(s.results[0]?.parent?.id).toBe("ve.zulia");
	const list = (await (await get("/api/v1/entities?type=state&limit=500")).json()) as SearchView;
	expect(list.results).toHaveLength(25);
	expect(list.truncated).toBe(false);
	const parishes = (await (await get("/api/v1/entities?type=parish&limit=500")).json()) as SearchView;
	expect(parishes.truncated).toBe(true);
	const at = (await (await get("/api/v1/locate?lat=10.5061&lon=-66.9146")).json()) as LocateView;
	expect(at.places.map((p) => p.id)).toContain("ve.distrito-capital.libertador");
	expect(at.how).toBe("inside");
	const sea = (await (await get("/api/v1/locate?lat=13&lon=-66")).json()) as LocateView;
	expect(sea).toMatchObject({ places: [], how: "outside", near: [] });
	for (const [path, status] of [
		["/api/v1/entities/ve.narnia", 404],
		["/api/v1/entities/VE.ZULIA", 404],
		["/api/v1/entities", 400],
		["/api/v1/entities?type=planet", 400],
		[`/api/v1/entities?q=${"x".repeat(101)}`, 400],
		["/api/v1/entities/ve.zulia/timeline?limit=abc", 400],
		["/api/v1/entities/ve.zulia/timeline?kinds=gossip", 400],
		["/api/v1/entities/ve.zulia/timeline?kinds=constructor", 400],
		["/api/v1/entities/ve.zulia/timeline?kinds=__proto__,toString", 400],
		["/api/v1/locate?lat=abc&lon=1", 400],
		["/api/v1/locate?lat=95&lon=1", 400],
		["/api/v1/locate?lon=1", 400],
	] as const) {
		const res = await get(path);
		expect(res.status, path).toBe(status);
		expect(((await res.json()) as { error: string }).error.length).toBeGreaterThan(0);
	}
});

test("rate limits: timelines count as heavy requests; one client cannot starve the others", async () => {
	const { get, tick } = setup();
	let limited = 0;
	for (let i = 0; i < 30; i++) {
		const res = await get("/api/v1/entities/ve.zulia/timeline", "10.0.0.1");
		if (res.status === 429) {
			limited++;
			expect(res.headers.get("retry-after")).toBe("5");
		}
	}
	// A burst of 120 tokens at 5 each: 24 pass, the rest wait.
	expect(limited).toBe(6);
	expect((await get("/api/v1/entities/ve.zulia/timeline", "10.0.0.2")).status).toBe(200);
	tick(10_000);
	expect((await get("/api/v1/entities/ve.zulia/timeline", "10.0.0.1")).status).toBe(200);
});

test("responses revalidate: an unchanged entity page answers 304 to its ETag", async () => {
	const { get, tick, app } = setup();
	await app.syncLinks();
	const first = await get("/api/v1/entities/infra.planta-centro");
	const etag = first.headers.get("etag") ?? "";
	expect(etag).toMatch(/^W\/"/);
	tick(1_000);
	const again = await first.clone().text();
	expect(again.length).toBeGreaterThan(0);
	const res = await getWith(app, "/api/v1/entities/infra.planta-centro", { "if-none-match": etag });
	expect(res.status).toBe(304);
});

function getWith(app: ReturnType<typeof createApp>, path: string, headers: Record<string, string>) {
	return app.fetch(
		new Request(`http://localhost:7722${path}`, { headers: { host: "localhost:7722", ...headers } }),
		"127.0.0.1",
	);
}
