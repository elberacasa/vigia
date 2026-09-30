import { expect, test } from "bun:test";
import { join } from "node:path";
import { type GdeltBatch, gdeltVe } from "../adapters/gdelt-ve/index.ts";
import { loadFixture } from "../core/fixtures.ts";
import { Store } from "../core/store.ts";
import type { Observation } from "../core/types.ts";
import { CAMEO_ROOTS, computeGdelt, gdeltPanel } from "./gdelt.ts";

const recorded = gdeltVe.normalise(
	loadFixture(join(import.meta.dir, "..", "adapters", "gdelt-ve", "fixtures", "2026-09-28")),
);
const AT = Date.parse("2026-09-28T07:30:00Z");

const batch = (stream: "en" | "tr", at: number, over: Partial<GdeltBatch>): Observation<GdeltBatch> => ({
	source: "gdelt-ve",
	series: `gdelt:batch:${stream}`,
	sourceUrl: "https://data.gdeltproject.org/gdeltv2/x.export.CSV.zip",
	fetchedAt: at,
	observedAt: at,
	licence: "gdelt-open",
	value: {
		stream,
		missing: false,
		rows: 1000,
		events: 0,
		droppedHomonym: 0,
		national: 0,
		byState: {},
		byRoot: {},
		byQuad: {},
		articles: 0,
		...over,
	},
	confidence: 1,
	basis: "report",
});

test("sums the day's batches; per-state kinds from the articles; the newest articles linked", () => {
	const store = new Store(":memory:");
	store.insert(recorded);
	store.insert([
		batch("en", AT - 3_600_000, {
			events: 3,
			national: 1,
			byState: { "VE-A": 2 },
			byRoot: { "14": 3 },
			byQuad: { "3": 3 },
		}),
		batch("tr", AT - 2 * 3_600_000, { missing: true }),
		// Older than the day: only in the 48-hour curve.
		batch("en", AT - 30 * 3_600_000, { events: 9, byState: { "VE-W": 9 } }),
	]);
	const view = computeGdelt(store, AT + 5 * 60_000);
	const en = recorded.find((o) => o.series === "gdelt:batch:en")?.value as GdeltBatch;
	const tr = recorded.find((o) => o.series === "gdelt:batch:tr")?.value as GdeltBatch;
	expect(view.events).toBe(en.events + tr.events + 3);
	expect(view.droppedHomonym).toBe(16);
	expect(view.batches).toEqual({ received: 3, missing: 1, expected: 192, newestAt: AT });
	expect(view.byState["VE-W"]).toBeUndefined();
	expect(view.hourly).toHaveLength(48);
	expect(view.hourly.reduce((n, h) => n + h.events, 0)).toBe(view.events + 9);
	const placed = Object.values(view.byState).reduce((n, s) => n + s.events, 0);
	expect(placed + view.national).toBe(view.events);
	expect(view.latest.length).toBeGreaterThan(0);
	expect(view.latest.length).toBeLessThanOrEqual(40);
	for (const item of view.latest) expect(item.url).toMatch(/^https?:\/\//);
	expect(view.articles24h).toBe(en.articles + tr.articles);
	expect(view.topDomains[0]?.articles).toBeGreaterThanOrEqual(1);
	expect(Object.keys(CAMEO_ROOTS)).toHaveLength(20);
	for (const s of Object.values(view.byState))
		expect(s.protestArticles + s.materialConflictArticles).toBeLessThanOrEqual(s.events * 2);
});

test("empty store: zeros, no crash; served on demand", () => {
	const view = computeGdelt(new Store(":memory:"), AT);
	expect(view).toMatchObject({
		events: 0,
		national: 0,
		latest: [],
		batches: { received: 0, missing: 0, newestAt: null },
	});
	expect(gdeltPanel.onDemand).toBe(true);
});
