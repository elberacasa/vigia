import { expect, test } from "bun:test";
import type { NewsItem, OutletSpec } from "../adapters/rss/factory.ts";
import { Store } from "../core/store.ts";
import { newsView, storyWeight } from "./news.ts";

const H = 3_600_000;
const NOW = Date.UTC(2026, 8, 25, 0, 0);
const outlets: OutletSpec[] = [
	{
		id: "a",
		name: "A",
		url: "https://a.org/feed",
		kind: "rss",
		region: "national",
		stance: "independent",
		homepage: "https://a.org",
	},
	{
		id: "b",
		name: "B",
		url: "https://b.org/feed",
		kind: "rss",
		region: "VE-V",
		stance: "commercial",
		homepage: "https://b.org",
	},
	{
		id: "c",
		name: "C",
		url: "https://c.org/feed",
		kind: "rss",
		region: "international",
		stance: "public-broadcaster",
		homepage: "https://c.org",
	},
];

function put(
	store: Store,
	outlet: string,
	title: string,
	at: number,
	link = `https://${outlet}.org/${encodeURIComponent(title)}`,
) {
	const value: NewsItem = { outlet, title, link, summary: "", image: null, dateMissing: false, video: false };
	store.insert([
		{
			source: outlet,
			series: `item:${link}`,
			sourceUrl: link,
			fetchedAt: at,
			observedAt: at,
			licence: "headline-link",
			value,
			confidence: 1,
			basis: "report",
		},
	]);
}

test("stories join across outlets, carry every outlet, and count per state and topic", () => {
	const store = new Store(":memory:");
	put(store, "a", "Apagón deja sin luz a Maracaibo y San Francisco", NOW - 3 * H);
	put(store, "b", "Maracaibo y San Francisco sin luz tras apagón", NOW - 2 * H);
	put(store, "c", "Blackout? Apagón en Maracaibo y San Francisco, Venezuela", NOW - 1 * H);
	put(store, "a", "BCV fija el dólar oficial en 855 bolívares", NOW - 1 * H);
	put(store, "a", "Noticia vieja", NOW - 72 * H);
	const view = newsView(store, NOW, outlets);
	const blackout = view.stories[view.top[0] ?? ""];
	expect(blackout?.outletCount).toBe(3);
	expect(blackout?.firstOutlet).toBe("a");
	expect(blackout?.state).toBe("VE-V");
	expect(blackout?.topics).toContain("electricidad");
	expect(view.latest.some((id) => view.stories[id]?.title === "Noticia vieja")).toBe(false);
	expect(view.byState["VE-V"]?.top).toEqual([blackout?.id ?? ""]);
	expect(view.byState["VE-V"]?.topics.electricidad).toBe(3);
	expect(view.topicCounts.economia).toBe(1);
	expect(view.items24h).toBe(4);
	expect(view.outletsReporting24h).toBe(3);
	expect(view.method).toBe("keywords");
});

test("the same link from two feeds of one outlet counts once", () => {
	const store = new Store(":memory:");
	put(store, "a", "Sismo en Carúpano, estado Sucre", NOW - H, "https://x.org/1");
	put(store, "b", "Sismo en Carúpano, estado Sucre", NOW - H, "https://x.org/1");
	expect(newsView(store, NOW, outlets).items24h).toBe(1);
});

test("story weight: outlets matter, and halve every 6 hours", () => {
	expect(storyWeight(4, NOW, NOW)).toBe(4);
	expect(storyWeight(4, NOW - 6 * H, NOW)).toBeCloseTo(2);
	expect(storyWeight(1, NOW, NOW)).toBeLessThan(storyWeight(3, NOW - 6 * H, NOW));
});

test("stories with no Venezuelan place and no known topic weigh a third", () => {
	expect(storyWeight(3, NOW, NOW, false)).toBeCloseTo(1);
	expect(storyWeight(2, NOW, NOW, true)).toBeGreaterThan(storyWeight(3, NOW, NOW, false));
});

test("most covered in 24 h ranks by distinct outlets with dated items in the window, not by recency", () => {
	const store = new Store(":memory:");
	// Three outlets 20 h ago beat one outlet 1 h ago (the front page would rank the fresh one first).
	put(store, "a", "Apagón deja sin luz a Maracaibo y San Francisco", NOW - 20 * H);
	put(store, "b", "Maracaibo y San Francisco sin luz tras apagón", NOW - 20 * H);
	put(store, "c", "Apagón en Maracaibo y San Francisco, Venezuela", NOW - 20 * H);
	put(store, "a", "BCV fija el dólar oficial en 855 bolívares", NOW - 1 * H);
	// A story from 30 h ago is outside the window however many outlets carried it.
	put(store, "b", "Sismo en Carúpano, estado Sucre", NOW - 30 * H);
	put(store, "c", "Sismo sacude Carúpano en el estado Sucre", NOW - 30 * H);
	const view = newsView(store, NOW, outlets);
	expect(view.stories[view.top[0] ?? ""]?.title).toStartWith("BCV");
	const ranked = view.covered24h.map((c) => [view.stories[c.id]?.title.slice(0, 6), c.outlets.length]);
	expect(ranked).toEqual([
		["Apagón", 3],
		["BCV fi", 1],
	]);
});

test("one outlet's two feeds count once: in a story, in 'reporting' and in the total", () => {
	const store = new Store(":memory:");
	const withVideo: OutletSpec[] = [
		...outlets,
		{
			id: "yt-a",
			name: "A (YouTube)",
			url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCx",
			kind: "youtube",
			region: "national",
			stance: "independent",
			homepage: "https://a.org",
			publisher: "a",
		},
	];
	put(store, "a", "Apagón deja sin luz a Maracaibo y San Francisco", NOW - 3 * H);
	put(store, "yt-a", "Apagón deja sin luz a Maracaibo y San Francisco (video)", NOW - 2 * H);
	put(store, "b", "Maracaibo y San Francisco sin luz tras apagón", NOW - 1 * H);
	const view = newsView(store, NOW, withVideo);
	const story = view.stories[view.top[0] ?? ""];
	expect(story?.outlets.length).toBe(3);
	expect(story?.outletCount).toBe(2);
	expect(story?.outlets.find((o) => o.feed === "yt-a")?.id).toBe("a");
	expect(view.outletsReporting24h).toBe(2);
	expect(view.outletsTotal).toBe(3);
	// An opt-in feed that is off (nothing stored) does not count as followed.
	const withOptIn = [
		...withVideo,
		{ ...(withVideo[1] as OutletSpec), id: "d", publisher: undefined, optIn: { es: "x", en: "x" } },
	];
	expect(newsView(store, NOW, withOptIn as OutletSpec[]).outletsTotal).toBe(3);
	expect(view.covered24h[0]?.outlets.sort()).toEqual(["A", "B"]);
});
