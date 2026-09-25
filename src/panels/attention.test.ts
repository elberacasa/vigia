import { expect, test } from "bun:test";
import { join } from "node:path";
import { wikiAttention } from "../adapters/wiki-attention/index.ts";
import { loadFixture } from "../core/fixtures.ts";
import { Store } from "../core/store.ts";
import type { RawResponse } from "../core/types.ts";
import { attentionView, median } from "./attention.ts";

const NOW = Date.UTC(2026, 8, 25, 2, 0);
const raws = loadFixture(join(import.meta.dir, "../adapters/wiki-attention/fixtures/2026-09-25"));

function storeFrom(rs: readonly RawResponse[]): Store {
	const store = new Store(":memory:");
	store.insert(wikiAttention.normalise(rs));
	return store;
}

test("median, zeros included", () => {
	expect(median([])).toBeNull();
	expect(median([3, 1, 2])).toBe(2);
	expect(median([0, 0, 10, 20])).toBe(5);
});

test("recorded 2026-09-23: nine topics, every article with a baseline, sparkline of 29 days", () => {
	const v = attentionView(storeFrom(raws), NOW);
	expect(v.day).toBe("2026-09-23");
	expect(v.topics.length).toBe(9);
	const all = v.topics.flatMap((t) => t.articles);
	expect(all.length).toBe(21);
	expect(all.every((a) => a.median28 !== null && a.series.length === 29)).toBe(true);
	const esVe = all.find((a) => a.project === "es.wikipedia" && a.title === "Venezuela");
	expect(esVe?.views).toBe(1636);
	expect(v.total.views).toBe(all.reduce((s, a) => s + (a.views ?? 0), 0));
	// Sorted: spikes first, then by the topic's ratio (its views over the sum of its medians).
	for (let i = 1; i < v.topics.length; i++) {
		const a = v.topics[i - 1];
		const b = v.topics[i];
		if (a && b && a.spike === b.spike) expect(a.ratio ?? 0).toBeGreaterThanOrEqual(b.ratio ?? 0);
	}
	const ve = v.topics.find((x) => x.id === "venezuela");
	const views = ve?.articles.reduce((x, a) => x + (a.views ?? 0), 0) ?? 0;
	const meds = ve?.articles.reduce((x, a) => x + (a.median28 ?? 0), 0) ?? 1;
	expect(ve?.ratio).toBeCloseTo(views / meds, 2);
});

test("spike rule: ≥ 3× the 28-day median and ≥ 100 more; a small article's 2 → 7 is not a spike", () => {
	// Rewrite the newest day of two articles: en Venezuela to 4× its median, es CANTV to 7.
	const tweak = (url: string, views: number) =>
		raws.map((r) => {
			if (!r.url.includes(url)) return r;
			const d = JSON.parse(r.body) as { items: { timestamp: string; views: number }[] };
			for (const i of d.items) if (i.timestamp.startsWith("20260923")) i.views = views;
			return { ...r, body: JSON.stringify(d) };
		});
	const base = attentionView(storeFrom(raws), NOW);
	const enVe = base.topics
		.flatMap((t) => t.articles)
		.find((a) => a.project === "en.wikipedia" && a.title === "Venezuela");
	const med = enVe?.median28 ?? 0;
	expect(med).toBeGreaterThan(1000);
	const spiked = attentionView(
		storeFrom(tweak("/en.wikipedia.org/all-access/user/Venezuela/", med * 4)),
		NOW,
	);
	const row = spiked.topics
		.flatMap((t) => t.articles)
		.find((a) => a.project === "en.wikipedia" && a.title === "Venezuela");
	expect(row?.spike).toBe(true);
	expect(row?.ratio).toBe(4);
	expect(spiked.topics[0]?.id).toBe("venezuela");
	expect(spiked.spikes).toBeGreaterThanOrEqual(1);
	const small = attentionView(storeFrom(tweak("/es.wikipedia.org/all-access/user/CANTV/", 90)), NOW);
	const cantv = small.topics
		.flatMap((t) => t.articles)
		.find((a) => a.project === "es.wikipedia" && a.title === "CANTV");
	// 90 is ≥ 3× a median of ~28 but not 100 more.
	expect(cantv?.ratio).toBeGreaterThan(3);
	expect(cantv?.spike).toBe(false);
});

test("with fewer than 21 baseline days there is no verdict", () => {
	const short = raws.map((r) => {
		const d = JSON.parse(r.body) as { items?: { timestamp: string }[] };
		if (!d.items) return r;
		return { ...r, body: JSON.stringify({ items: d.items.filter((i) => i.timestamp >= "20260910") }) };
	});
	// The adapter fills from the requested start: remove the filled zeros by storing only real days.
	const store = new Store(":memory:");
	store.insert(wikiAttention.normalise(short).filter((o) => !o.value.filled));
	const v = attentionView(store, NOW);
	expect(v.topics.flatMap((t) => t.articles).every((a) => a.median28 === null && !a.spike)).toBe(true);
	expect(v.total.median28).toBeNull();
});

test("empty store: no day, no topics' views", () => {
	const v = attentionView(new Store(":memory:"), NOW);
	expect(v.day).toBeNull();
	expect(v.spikes).toBe(0);
});
