import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { ARTICLES, pageviewsUrl, wikiAttention } from "./index.ts";

const raws = loadFixture(join(import.meta.dir, "fixtures", "2026-09-25"));
const obs = wikiAttention.normalise(raws);
const of = (series: string) => obs.filter((o) => o.series === series);

test("21 articles × 59 days (2026-07-27 .. 2026-09-23), newest day yesterday UTC", () => {
	expect(raws.length).toBe(ARTICLES.length);
	expect(obs.length).toBe(21 * 59);
	const es = of("pv:es.wikipedia:Venezuela");
	expect(es[0]?.value.date).toBe("2026-07-27");
	expect(es.at(-1)?.value.date).toBe("2026-09-23");
	expect(es.at(-1)?.value.views).toBe(1636);
	for (const o of obs) {
		expect(o.source).toBe("wiki-attention");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(o.observedAt).toBe(Date.parse(`${o.value.date}T00:00:00Z`) + 86_400_000);
		expect(o.sourceUrl).toStartWith("https://pageviews.wmcloud.org/?project=");
	}
});

test("days the API omits are zeros, marked filled; nothing is filled past the newest published day", () => {
	const bd = of("pv:es.wikipedia:Bolívar_digital");
	expect(bd.length).toBe(59);
	expect(bd.some((o) => o.value.filled && o.value.views === 0)).toBe(true);
	expect(of("pv:en.wikipedia:Venezuela").every((o) => !o.value.filled)).toBe(true);
	// Drop the newest day from every response: the day disappears for all, it is not filled as zero.
	const trimmed = raws.map((r) => {
		const d = JSON.parse(r.body) as { items?: { timestamp: string }[] };
		if (!d.items) return r;
		return {
			...r,
			body: JSON.stringify({ items: d.items.filter((i) => !i.timestamp.startsWith("20260923")) }),
		};
	});
	const t = wikiAttention.normalise(trimmed);
	expect(t.some((o) => o.value.date === "2026-09-23")).toBe(false);
});

test("a 404 is no data, never zeros (review 3 M7); unreadable responses fail the run", () => {
	const [first] = raws as [RawResponse];
	const four = raws.map((r, i) => (i === 0 ? { ...r, status: 404, body: '{"type":"not-found"}' } : r));
	const out = wikiAttention.normalise(four);
	// Nothing for the missing article (it used to be 59 rows of views 0 that overwrote the real history)…
	expect(out.filter((o) => o.series === "pv:es.wikipedia:Venezuela")).toEqual([]);
	// …and the others are untouched.
	expect(out.length).toBe(20 * 59);
	// Every article missing: an empty run, not an error and not zeros.
	expect(wikiAttention.normalise(raws.map((r) => ({ ...r, status: 404, body: "{}" })))).toEqual([]);
	const bad = raws.map((r) => ({ ...r, body: "<html>" }));
	expect(() => wikiAttention.normalise(bad)).toThrow("readable");
	expect(first.url).toBe(pageviewsUrl(ARTICLES[0] ?? { project: "", title: "", topic: "" }, first.fetchedAt));
});

test("zeros are filled only between two days the response reported, never before the first or after the last", () => {
	const [first] = raws as [RawResponse];
	const items = (JSON.parse(first.body) as { items: { timestamp: string }[] }).items;
	// Keep three days of the first article: the 1st, the 10th and the 20th of its range.
	const kept = [items[0], items[9], items[19]];
	const sparse = raws.map((r, i) => (i === 0 ? { ...r, body: JSON.stringify({ items: kept }) } : r));
	const rows = wikiAttention.normalise(sparse).filter((o) => o.series === "pv:es.wikipedia:Venezuela");
	expect(rows.length).toBe(20);
	expect(rows.filter((o) => !o.value.filled).length).toBe(3);
	expect(rows.filter((o) => o.value.filled).every((o) => o.value.views === 0)).toBe(true);
	// The other articles reach 2026-09-23; this one stops at the last day it reported.
	expect(rows.at(-1)?.value.date).toBe(
		`${kept[2]?.timestamp.slice(0, 4)}-${kept[2]?.timestamp.slice(4, 6)}-${kept[2]?.timestamp.slice(6, 8)}`,
	);
});

test("titles are percent-encoded in the URL", () => {
	const pdvsa = ARTICLES.find((a) => a.title === "Petróleos_de_Venezuela");
	expect(pdvsa && pageviewsUrl(pdvsa, Date.UTC(2026, 8, 24))).toBe(
		"https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/es.wikipedia.org/all-access/user/Petr%C3%B3leos_de_Venezuela/daily/20260726/20260924",
	);
});
