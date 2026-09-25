import type { Genre, NewsItem, OutletSpec } from "../adapters/rss/factory.ts";
import { OUTLETS } from "../adapters/rss/outlets.ts";
import type { Store } from "../core/store.ts";
import { cluster } from "../news/cluster.ts";
import { tagPlaces } from "../news/places.ts";
import { publishers } from "../news/publishers.ts";
import { stripDateline } from "../news/text.ts";
import { type Topic, topics } from "../news/topics.ts";
import type { Panel } from "../server/panels.ts";

const HOUR = 3_600_000;
const WINDOW_MS = 48 * HOUR;
/** Recency half-life of a story's weight on the front page. */
const HALF_LIFE_MS = 6 * HOUR;

export type StoryOutlet = {
	/** Publisher id: counts of distinct outlets use it (one outlet with two feeds counts once). */
	id: string;
	/** The feed this item came from (e.g. "yt-el-pitazo"). */
	feed: string;
	name: string;
	stance: string;
	/** Absent for newsrooms; "fact-check", "official" (a government body's press site) or "rights" otherwise. */
	genre?: Genre;
	region: string;
	title: string;
	url: string;
	at: number;
	dateMissing: boolean;
};

export type Story = {
	id: string;
	title: string;
	url: string;
	/** Newest item in the story. */
	at: number;
	/** First item: who reported it first, as far as the feeds show. */
	firstAt: number;
	firstOutlet: string;
	outlets: StoryOutlet[];
	outletCount: number;
	topics: Topic[];
	/** ISO state from keyword tagging, when one is clear. */
	state: string | null;
	stateConfidence: number;
	/** Every state the story names with confidence ≥ 0.7. */
	states: string[];
	places: string[];
	video: boolean;
	image: string | null;
};

export type StateNews = {
	items: number;
	stories: number;
	topics: Partial<Record<Topic, number>>;
	/** Up to 8 story ids for this state, weighted like the front page. */
	top: string[];
};

export type NewsView = {
	from: number;
	to: number;
	/** Every story referenced by the lists below, by id. */
	stories: Record<string, Story>;
	/** Front page: weighted by distinct outlets and recency (ids). */
	top: string[];
	/** Newest first (ids). */
	latest: string[];
	/**
	 * Most covered in the last 24 h: stories ranked by distinct outlets with a dated item in that window, with those
	 * outlets' names. Undated items never count (their time is only when Vigía first saw them).
	 */
	covered24h: { id: string; outlets: string[] }[];
	byState: Record<string, StateNews>;
	topicCounts: Partial<Record<Topic, number>>;
	items24h: number;
	/** Distinct publishers with an item in the last 24 h. */
	outletsReporting24h: number;
	/** Distinct publishers followed (not feeds). */
	outletsTotal: number;
	/** Shown in the UI: tagging and grouping are rules, not a model. */
	method: "keywords";
};

interface Tagged {
	id: string;
	outlet: OutletSpec;
	publisher: string;
	item: NewsItem;
	at: number;
	topics: Topic[];
	state: string | null;
	stateConfidence: number;
	/** Every state named with reasonable confidence (a story can span Caracas and Miranda). */
	states: string[];
	places: string[];
}

/** Mentions below this confidence do not count a story toward a state on the map. */
const STATE_COUNT_MIN = 0.7;

const byId = new Map(OUTLETS.map((o) => [o.id, o]));

type Tags = Pick<Tagged, "topics" | "state" | "stateConfidence" | "states" | "places">;

/**
 * Tagging is pure (outlet region + headline + summary) and costs ~0.1 ms an item, the bulk of the view at a few
 * thousand items; each computation re-reads the same 48 h, so results are memoised. Bounded: cleared past 40,000.
 */
const TAG_MEMO = new Map<string, Tags>();
const TAG_MEMO_MAX = 40_000;

export function tagItem(outlet: OutletSpec, item: Pick<NewsItem, "title" | "summary">): Tags {
	const key = `${outlet.region}\u0000${item.title}\u0000${item.summary}`;
	const hit = TAG_MEMO.get(key);
	if (hit) return hit;
	const text = `${item.title}. ${stripDateline(item.summary)}`;
	const venezuelanOutlet = outlet.region !== "international";
	const homeState = outlet.region.startsWith("VE-") ? outlet.region : undefined;
	const options = { venezuelanOutlet, ...(homeState ? { homeState } : {}) };
	// Places from the headline first; the summary only adds context.
	const places = tagPlaces(item.title, options);
	const withSummary = places.primaryState ? places : tagPlaces(text, options);
	const tags: Tags = {
		topics: topics(text),
		state: withSummary.primaryState,
		stateConfidence: withSummary.confidence,
		states: [
			...new Set(withSummary.mentions.filter((m) => m.confidence >= STATE_COUNT_MIN).map((m) => m.state)),
		],
		places: [...new Set(withSummary.mentions.map((m) => m.place))],
	};
	if (TAG_MEMO.size >= TAG_MEMO_MAX) TAG_MEMO.clear();
	TAG_MEMO.set(key, tags);
	return tags;
}

/**
 * Front-page weight: distinct outlets, halved every 6 h. A story with no Venezuelan place and no known topic
 * (sports abroad, celebrity news) weighs a third: it can still lead, but only if it is far bigger.
 */
export function storyWeight(outletCount: number, lastAt: number, now: number, relevant = true): number {
	return outletCount * 0.5 ** (Math.max(0, now - lastAt) / HALF_LIFE_MS) * (relevant ? 1 : 1 / 3);
}

const relevant = (s: { states: string[]; topics: string[] }) => s.states.length > 0 || s.topics.length > 0;

export function newsView(store: Store, now: number, outlets: readonly OutletSpec[] = OUTLETS): NewsView {
	const from = now - WINDOW_MS;
	const pubs = publishers(outlets);
	const publisherId = (o: OutletSpec) => pubs.get(o.id)?.id ?? o.id;
	const tagged: Tagged[] = [];
	const seenLinks = new Set<string>();
	for (const outlet of outlets) {
		for (const o of store.latestPerSeries<NewsItem>(outlet.id, from, 400)) {
			if (o.observedAt > now + 15 * 60_000) continue;
			const item = o.value;
			if (seenLinks.has(item.link)) continue;
			seenLinks.add(item.link);
			const tags = tagItem(outlet, item);
			tagged.push({
				id: `${outlet.id}:${o.series}`,
				outlet,
				publisher: publisherId(outlet),
				item,
				at: o.observedAt,
				...tags,
			});
		}
	}

	const index = new Map(tagged.map((t) => [t.id, t]));
	const groups = cluster(
		tagged.map((t) => ({ id: t.id, title: t.item.title, at: t.at, outlet: t.publisher })),
	);
	const stories: Story[] = groups.map((ids) => {
		const members = ids.map((id) => index.get(id) as Tagged).sort((a, b) => a.at - b.at);
		// Items without a feed date carry our fetch time: never let them define "first" or "newest".
		const dated = members.filter((m) => !m.item.dateMissing);
		const timed = dated.length ? dated : members;
		const first = timed[0] as Tagged;
		const last = timed[timed.length - 1] as Tagged;
		const topicSet = new Set(members.flatMap((m) => m.topics));
		// Story state: the most frequent tagged state among members, ties → none.
		const votes = new Map<string, number>();
		for (const m of members) if (m.state) votes.set(m.state, (votes.get(m.state) ?? 0) + 1);
		const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
		const state = ranked[0] && (!ranked[1] || ranked[0][1] > ranked[1][1]) ? ranked[0][0] : null;
		const stateConfidence = state
			? Math.max(...members.filter((m) => m.state === state).map((m) => m.stateConfidence))
			: 0;
		const outletIds = new Set(members.map((m) => m.publisher));
		// Bounded payload: one row per publisher (its newest item, so "outlets in the last 12 h" stays right), plus the
		// story's first item. A story's size is then at most the number of publishers, whatever they post.
		const newestByPublisher = new Map<string, Tagged>();
		for (const m of members) {
			const kept = newestByPublisher.get(m.publisher);
			if (!kept || (!m.item.dateMissing && (kept.item.dateMissing || m.at >= kept.at)))
				newestByPublisher.set(m.publisher, m);
		}
		const shown = [...new Set([members[0] as Tagged, ...newestByPublisher.values()])].sort(
			(a, b) => a.at - b.at,
		);
		return {
			id: Bun.hash(ids.join("|")).toString(36),
			title: first.item.title,
			url: first.item.link,
			at: last.at,
			firstAt: first.at,
			firstOutlet: first.outlet.id,
			outlets: shown.map((m) => ({
				id: m.publisher,
				feed: m.outlet.id,
				name: m.outlet.name,
				stance: m.outlet.stance,
				...(m.outlet.genre && m.outlet.genre !== "news" ? { genre: m.outlet.genre } : {}),
				region: m.outlet.region,
				title: m.item.title,
				url: m.item.link,
				at: m.at,
				dateMissing: m.item.dateMissing,
			})),
			outletCount: outletIds.size,
			topics: [...topicSet],
			state,
			stateConfidence,
			states: [...new Set(members.flatMap((m) => m.states))],
			places: [...new Set(members.flatMap((m) => m.places))].slice(0, 6),
			video: members.every((m) => m.item.video),
			image: members.find((m) => m.item.image)?.item.image ?? null,
		};
	});

	const weighted = [...stories].sort(
		(a, b) =>
			storyWeight(b.outletCount, b.at, now, relevant(b)) -
				storyWeight(a.outletCount, a.at, now, relevant(a)) || b.at - a.at,
	);
	const top = weighted.slice(0, 40);
	// Stories whose every item lacks a feed date carry our fetch time: list them after dated ones.
	const undated = (s: Story) => s.outlets.every((o) => o.dateMissing);
	const latest = [...stories]
		.sort((a, b) => Number(undated(a)) - Number(undated(b)) || b.at - a.at)
		.slice(0, 60);

	const dayAgo = now - 24 * HOUR;
	const byState: Record<string, StateNews> = {};
	const topicCounts: Partial<Record<Topic, number>> = {};
	const reporting = new Set<string>();
	let items24h = 0;
	const stateEntry = (iso: string): StateNews => {
		let entry = byState[iso];
		if (!entry) {
			entry = { items: 0, stories: 0, topics: {}, top: [] };
			byState[iso] = entry;
		}
		return entry;
	};
	for (const t of tagged) {
		if (t.at < dayAgo) continue;
		items24h++;
		reporting.add(t.publisher);
		for (const topic of t.topics) topicCounts[topic] = (topicCounts[topic] ?? 0) + 1;
		for (const iso of t.states) {
			const s = stateEntry(iso);
			s.items++;
			for (const topic of t.topics) s.topics[topic] = (s.topics[topic] ?? 0) + 1;
		}
	}
	const covered = stories
		.map((story) => {
			const names = new Map<string, string>();
			for (const o of story.outlets)
				if (!o.dateMissing && o.at >= dayAgo) names.set(o.id, pubs.get(o.feed)?.name ?? o.name);
			return { story, outlets: [...names.values()] };
		})
		.filter((c) => c.outlets.length > 0 && relevant(c.story))
		.sort(
			(a, b) =>
				b.outlets.length - a.outlets.length ||
				b.story.at - a.story.at ||
				a.story.id.localeCompare(b.story.id),
		)
		.slice(0, 12);
	const referenced = new Map<string, Story>();
	for (const story of [...top, ...latest, ...covered.map((c) => c.story)]) referenced.set(story.id, story);
	for (const story of weighted) {
		if (story.at < dayAgo) continue;
		for (const iso of story.states) {
			const entry = stateEntry(iso);
			entry.stories++;
			if (entry.top.length < 8) {
				entry.top.push(story.id);
				referenced.set(story.id, story);
			}
		}
	}
	return {
		from,
		to: now,
		stories: Object.fromEntries(referenced),
		top: top.map((story) => story.id),
		latest: latest.map((story) => story.id),
		covered24h: covered.map((c) => ({ id: c.story.id, outlets: c.outlets })),
		byState,
		topicCounts,
		items24h,
		outletsReporting24h: reporting.size,
		// Followed publishers: those with a feed on by default, plus any opt-in one the user turned on (it reported).
		outletsTotal: new Set([
			...outlets.filter((o) => !o.optIn).map(publisherId),
			...tagged.map((t) => t.publisher),
		]).size,
		method: "keywords",
	};
}

export const newsPanel: Panel<NewsView> = {
	id: "news",
	sources: OUTLETS.map((o) => o.id),
	compute: (store: Store, now: number) => newsView(store, now),
};

export function outletById(id: string): OutletSpec | undefined {
	return byId.get(id);
}
