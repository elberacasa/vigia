import {
	ARTICLES,
	type Article,
	articleUrl,
	type PageviewsValue,
	TOPICS,
	toolUrl,
	WIKIMEDIA_LICENCE,
} from "../adapters/wiki-attention/index.ts";
import type { Store } from "../core/store.ts";
import type { Panel } from "../server/panels.ts";

/**
 * International attention: how many people read Wikipedia's articles about Venezuela each day, and which ones
 * jumped. Counted in code from the stored daily pageviews.
 *
 * Spike rule, per article, on the newest published day D: views(D) ≥ 3 × median(the 28 days before D) AND
 * views(D) − median ≥ 100 (so 2 → 7 on a quiet article is not a spike). The median includes zero days. Fewer than
 * 21 of those 28 days stored: no verdict ("sin línea base").
 */

const DAY = 86_400_000;
export const SPIKE = { factor: 3, minExtra: 100, baselineDays: 28, minBaselineDays: 21 } as const;

export type ArticleRow = {
	project: string;
	lang: "es" | "en" | "pt";
	title: string;
	label: string;
	views: number | null;
	median28: number | null;
	/** views / median28 (null when the median is 0 or there is no baseline). */
	ratio: number | null;
	spike: boolean;
	/** views − median28. */
	extra: number | null;
	/** Last 28 days + the newest day, oldest first (views; null for a day not stored). */
	series: (number | null)[];
	url: string;
	toolUrl: string;
};

export type TopicRow = {
	id: string;
	labelEs: string;
	labelEn: string;
	articles: ArticleRow[];
	/** Sum of the newest day's views across languages. */
	views: number;
	spike: boolean;
	/** Largest ratio among its articles with a baseline. */
	maxRatio: number | null;
	/** Topic views over the sum of its articles' medians: the sort key (null without a baseline). */
	ratio: number | null;
	/** Daily sum of its articles' views, same days as ArticleRow.series (null where no article has the day). */
	series: (number | null)[];
};

export type AttentionView = {
	/** Newest published day, YYYY-MM-DD (UTC), null before the first fetch. */
	day: string | null;
	dayAt: number | null;
	topics: TopicRow[];
	spikes: number;
	/** Views of the newest day across all articles, and the median day of the 28 before it. */
	total: { views: number; median28: number | null };
	rule: typeof SPIKE & { es: string; en: string };
	noteEs: string;
	noteEn: string;
	feed: string;
	attribution: string;
	licence: string;
	sourceUrl: string;
};

export function median(values: readonly number[]): number | null {
	if (!values.length) return null;
	const s = [...values].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

function langOf(a: Article): ArticleRow["lang"] {
	return a.project.startsWith("en") ? "en" : a.project.startsWith("pt") ? "pt" : "es";
}

export function attentionView(store: Store, now: number): AttentionView {
	const from = now - 70 * DAY;
	const byArticle = new Map<string, Map<string, number>>();
	let newest = "";
	for (const a of ARTICLES) {
		const days = new Map<string, number>();
		for (const o of store.history<PageviewsValue>(
			"wiki-attention",
			`pv:${a.project}:${a.title}`,
			from,
			now,
		)) {
			// Revisions (a later fetch of the same day) come later in the list: the last one wins.
			days.set(o.value.date, o.value.views);
			if (o.value.date > newest) newest = o.value.date;
		}
		byArticle.set(`${a.project}:${a.title}`, days);
	}
	const day = newest || null;
	const dayStart = day ? Date.parse(`${day}T00:00:00Z`) : null;
	// The newest day's total is complete at the end of that UTC day: that is its age.
	const dayAt = dayStart === null ? null : dayStart + DAY;
	const window =
		dayStart === null
			? []
			: Array.from({ length: SPIKE.baselineDays }, (_, i) => iso(dayStart - (SPIKE.baselineDays - i) * DAY));

	const rows = ARTICLES.map((a): ArticleRow & { topic: string } => {
		const days = byArticle.get(`${a.project}:${a.title}`) ?? new Map<string, number>();
		const views = day ? (days.get(day) ?? null) : null;
		const base = window.map((d) => days.get(d)).filter((v): v is number => v !== undefined);
		const med = base.length >= SPIKE.minBaselineDays ? median(base) : null;
		const extra = views !== null && med !== null ? views - med : null;
		const spike =
			views !== null &&
			med !== null &&
			extra !== null &&
			views >= SPIKE.factor * med &&
			extra >= SPIKE.minExtra;
		return {
			topic: a.topic,
			project: a.project,
			lang: langOf(a),
			title: a.title,
			label: a.title.replaceAll("_", " "),
			views,
			median28: med,
			ratio: views !== null && med ? Math.round((views / med) * 100) / 100 : null,
			spike,
			extra,
			series: [...window, ...(day ? [day] : [])].map((d) => days.get(d) ?? null),
			url: articleUrl(a),
			toolUrl: toolUrl(a),
		};
	});

	const topics: TopicRow[] = Object.entries(TOPICS).map(([id, label]) => {
		const articles = rows.filter((r) => r.topic === id).map(({ topic: _t, ...r }) => r);
		const ratios = articles.map((a) => a.ratio).filter((r): r is number => r !== null);
		return {
			id,
			labelEs: label.es,
			labelEn: label.en,
			articles,
			views: articles.reduce((s, a) => s + (a.views ?? 0), 0),
			spike: articles.some((a) => a.spike),
			maxRatio: ratios.length ? Math.max(...ratios) : null,
			ratio: (() => {
				const withBase = articles.filter((a) => a.median28 !== null && a.views !== null);
				const med = withBase.reduce((x, a) => x + (a.median28 ?? 0), 0);
				return withBase.length && med > 0
					? Math.round((withBase.reduce((x, a) => x + (a.views ?? 0), 0) / med) * 100) / 100
					: null;
			})(),
			series: (articles[0]?.series ?? []).map((_, i) => {
				const vals = articles
					.map((a) => a.series[i])
					.filter((v): v is number => v !== null && v !== undefined);
				return vals.length ? vals.reduce((x, y) => x + y, 0) : null;
			}),
		};
	});
	topics.sort(
		(a, b) => Number(b.spike) - Number(a.spike) || (b.ratio ?? 0) - (a.ratio ?? 0) || b.views - a.views,
	);

	// Total: per day, the sum over articles; median over the window days.
	const dayTotals = window.map((d) =>
		rows.reduce((s, r) => s + (byArticle.get(`${r.project}:${r.title}`)?.get(d) ?? 0), 0),
	);
	const covered = window.filter((d) => rows.some((r) => byArticle.get(`${r.project}:${r.title}`)?.has(d)));

	return {
		day,
		dayAt,
		topics,
		spikes: rows.filter((r) => r.spike).length,
		total: {
			views: rows.reduce((s, r) => s + (r.views ?? 0), 0),
			median28:
				covered.length >= SPIKE.minBaselineDays
					? median(dayTotals.filter((_, i) => covered.includes(window[i] as string)))
					: null,
		},
		rule: {
			...SPIKE,
			es: "Pico: lecturas del último día ≥ 3 × la mediana de los 28 días anteriores y al menos 100 más. Solo lectores humanos, todas las plataformas.",
			en: "Spike: last day's reads ≥ 3 × the median of the 28 days before, and at least 100 more. Human readers only, all platforms.",
		},
		noteEs:
			"Atención internacional, no noticias: un pico dice que mucha gente buscó el tema, no qué pasó. Wikimedia publica cada día completo unas horas después de medianoche UTC.",
		noteEn:
			"International attention, not news: a spike says many people looked the topic up, not what happened. Wikimedia publishes each full day a few hours after midnight UTC.",
		feed: "wiki-attention",
		attribution: WIKIMEDIA_LICENCE.attribution,
		licence: WIKIMEDIA_LICENCE.id,
		sourceUrl: "https://pageviews.wmcloud.org/",
	};
}

export const attentionPanel: Panel<AttentionView> = {
	id: "attention",
	sources: ["wiki-attention"],
	compute: (store: Store, now: number) => attentionView(store, now),
};
