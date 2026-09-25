import { expect, test } from "bun:test";
import type { FeedMeta } from "../../lib/data.ts";
import {
	applyFilters,
	type Bucket,
	bucketOf,
	growth,
	NO_FILTERS,
	summarize,
	sunflower,
	toRows,
} from "./model.ts";

const feed = (id: string, over: Partial<FeedMeta> = {}): FeedMeta => ({
	id,
	layer: "news",
	name: { es: id, en: id },
	provider: id,
	homepage: `https://${id}.example/`,
	licence: { id: "headline-link", name: "Titular", url: "https://x", attribution: "", commercial: "unclear" },
	keys: [],
	intervalMs: 600_000,
	freshness: { fetchMs: 2_400_000, dataMs: null },
	optIn: null,
	...over,
});

const META: FeedMeta[] = [
	feed("la-verdad", {
		name: { es: "La Verdad (Zulia)", en: "La Verdad (Zulia)" },
		category: ["news"],
		region: "VE-V",
		country: "VE",
		lang: "es",
		publisher: "laverdad.com",
		added: "2026-09-24T23:44Z",
	}),
	feed("dw-a", {
		category: ["news"],
		region: "intl",
		country: "DE",
		publisher: "dw.com",
		added: "2026-09-24T23:44Z",
	}),
	feed("dw-b", {
		category: ["news"],
		region: "intl",
		country: "DE",
		publisher: "dw.com",
		added: "2026-09-25T01:00Z",
	}),
	feed("telesur", { category: ["news"], region: "intl", country: "VE", publisher: "telesurtv.net" }),
	feed("firms", {
		layer: "earth",
		name: { es: "Focos de calor", en: "Active fires" },
		category: ["earth", "space"],
		region: "intl",
		country: "US",
		kind: "satellite",
		publisher: "nasa",
		keys: ["firms"],
		added: "2026-09-24T19:47Z",
	}),
	// An older cached meta without atlas fields still yields a row.
	feed("old", { layer: "money" }),
];

const buckets = new Map<string, Bucket>([
	["la-verdad", "live"],
	["dw-a", "stale"],
	["dw-b", "failing"],
	["firms", "live"],
]);

test("health states collapse to what a reader acts on", () => {
	expect(bucketOf("ok")).toBe("live");
	expect(bucketOf("degraded")).toBe("live");
	expect(bucketOf("stale")).toBe("stale");
	expect(bucketOf(undefined)).toBe("pending");
});

test("rows fall back to the layer when the server sent no atlas fields", () => {
	const old = toRows(META).find((r) => r.id === "old");
	expect(old).toMatchObject({ primary: "money", region: "intl", country: "INT", kind: "api", added: null });
});

test("search ignores accents and case and needs every word; filters combine", () => {
	const rows = toRows(META);
	const ids = (f: Partial<typeof NO_FILTERS>) =>
		applyFilters(rows, { ...NO_FILTERS, ...f }, buckets).map((r) => r.id);
	expect(ids({ q: "VERDAD zulia" })).toEqual(["la-verdad"]);
	expect(ids({ q: "fócos" })).toEqual(["firms"]);
	expect(ids({ region: "state" })).toEqual(["la-verdad"]);
	expect(ids({ category: "space" })).toEqual(["firms"]);
	expect(ids({ needsKey: true })).toEqual(["firms"]);
	expect(ids({ bucket: "pending" }).sort()).toEqual(["old", "telesur"]);
	expect(ids({ country: "DE", bucket: "failing" })).toEqual(["dw-b"]);
});

test("sorting by date added puts the newest first and undated last", () => {
	const rows = toRows(META);
	const out = applyFilters(rows, NO_FILTERS, buckets, "added").map((r) => r.id);
	expect(out[0]).toBe("dw-b");
	expect(out.slice(-2).sort()).toEqual(["old", "telesur"]);
});

test("summary counts feeds, distinct publishers, states and countries abroad", () => {
	const s = summarize(toRows(META), buckets);
	expect(s.feeds).toBe(6);
	expect(s.publishers).toBe(5);
	expect(s.buckets).toEqual({ live: 2, stale: 1, failing: 1, locked: 0, off: 0, pending: 2 });
	expect(s.regions).toEqual({ VE: 0, state: 1, diaspora: 0, intl: 5 });
	expect(s.states).toEqual([
		{ key: "VE-V", feeds: 1, publishers: 1, buckets: { ...s.states[0]?.buckets, live: 1 } as never },
	]);
	// A Caracas-based international channel is not "outside Venezuela".
	expect(s.countries.map((c) => [c.key, c.feeds])).toEqual([
		["DE", 2],
		["INT", 1],
		["US", 1],
	]);
	expect(s.categories[0]).toMatchObject({ key: "news", feeds: 4, publishers: 3 });
	expect(s.needsKey).toBe(1);
	expect(s.undated).toBe(2);
});

test("growth is a cumulative step per instant, ending at now", () => {
	const g = growth(toRows(META), Date.parse("2026-09-26T00:00Z"));
	expect(g).toEqual([
		{ t: Date.parse("2026-09-24T19:47Z"), n: 1 },
		{ t: Date.parse("2026-09-24T23:44Z"), n: 3 },
		{ t: Date.parse("2026-09-25T01:00Z"), n: 4 },
		{ t: Date.parse("2026-09-26T00:00Z"), n: 4 },
	]);
	expect(growth([], 0)).toEqual([]);
});

test("sunflower points never overlap for any count", () => {
	for (const n of [1, 2, 7, 40, 300]) {
		const pts = sunflower(n, 10);
		expect(pts.length).toBe(n);
		let min = Number.POSITIVE_INFINITY;
		for (let i = 0; i < pts.length; i++)
			for (let j = i + 1; j < pts.length; j++) {
				const a = pts[i] as [number, number];
				const b = pts[j] as [number, number];
				min = Math.min(min, Math.hypot(a[0] - b[0], a[1] - b[1]));
			}
		if (n > 1) expect(min).toBeGreaterThan(6);
	}
});
