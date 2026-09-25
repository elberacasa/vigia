/**
 * The AI news classifier at runtime. Labels every recent item with the backend the user chose (local model or Jev)
 * and stores the result per (item, model) in ai_outputs. Never touches the core: the news panel works without it,
 * and the AI section reads these outputs to show its own, clearly labelled view.
 */
import type { NewsItem, OutletSpec } from "../adapters/rss/factory.ts";
import type { Store } from "../core/store.ts";
import type { FastJudge } from "./judge.ts";
import type { LinearModel } from "./local/model.ts";
import { EVENT_TYPES, newsQuestions, newsState, TOPIC_DEFS, toLabels } from "./news-questions.ts";

export type Backend = "off" | "local" | "jev";

/** The labels the AI section shows, whatever backend produced them. */
export type AiNewsLabels = {
	model: string;
	aboutVenezuela: number;
	blackout: number;
	topics: Record<string, number>;
	eventType: string;
	eventConfidence: number;
	state: string;
	stateConfidence: number;
	severity: number;
};

export const LOCAL_MODEL_ID = "vigia-local-news-1";

export function localLabels(
	model: LinearModel,
	item: { title: string; summary: string; region: string },
): AiNewsLabels {
	const p = model.predict(item);
	const top = (d: Record<string, number> | undefined): [string, number] =>
		Object.entries(d ?? {}).sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
	const [eventType, eventConfidence] = top(p.dist.event_type);
	const [state, stateConfidence] = top(p.dist.state);
	const sev = p.dist.severity ?? {};
	const severity = ["0", "1", "2", "3"].reduce((s, k) => s + Number(k) * (sev[k] ?? 0), 0);
	const topics: Record<string, number> = {};
	for (const t of Object.keys(TOPIC_DEFS)) topics[t] = p.yes[`topic_${t}`] ?? 0;
	return {
		model: LOCAL_MODEL_ID,
		aboutVenezuela: p.yes.about_venezuela ?? 0,
		blackout: p.yes.blackout ?? 0,
		topics,
		eventType: eventType in EVENT_TYPES ? eventType : "otro",
		eventConfidence,
		state,
		stateConfidence,
		severity,
	};
}

export interface RecentItem {
	readonly key: string;
	readonly outlet: OutletSpec;
	readonly item: NewsItem;
}

export function recentItems(store: Store, outlets: readonly OutletSpec[], since: number): RecentItem[] {
	const out: RecentItem[] = [];
	const seen = new Set<string>();
	for (const outlet of outlets) {
		for (const o of store.latestPerSeries<NewsItem>(outlet.id, since, 400)) {
			if (seen.has(o.value.link)) continue;
			seen.add(o.value.link);
			out.push({ key: Bun.hash(o.value.link).toString(36), outlet, item: o.value });
		}
	}
	return out;
}

export function storedLabels(
	store: Store,
	model: string,
	keys: readonly string[],
): Map<string, AiNewsLabels> {
	const map = new Map<string, AiNewsLabels>();
	const q = store.db.query<{ output: string }, [string, string]>(
		"SELECT output FROM ai_outputs WHERE feature = 'news' AND item = ? AND model = ?",
	);
	for (const key of keys) {
		const row = q.get(key, model);
		if (row) map.set(key, JSON.parse(row.output) as AiNewsLabels);
	}
	return map;
}

function save(store: Store, key: string, labels: AiNewsLabels, at: number): void {
	store.db.run(
		"INSERT OR REPLACE INTO ai_outputs (feature, item, model, at, output) VALUES ('news', ?, ?, ?, ?)",
		[key, labels.model, at, JSON.stringify(labels)],
	);
}

/** Labels items the chosen backend has not labelled yet. Jev: at most `maxRequests` per call (budget-checked). */
export async function classifyPending(options: {
	store: Store;
	backend: Backend;
	items: readonly RecentItem[];
	local: LinearModel | null;
	jev: FastJudge | null;
	now: number;
	maxRequests?: number;
}): Promise<{ labelled: number; model: string | null; error: string | null }> {
	const { store, backend, items, now } = options;
	if (backend === "off") return { labelled: 0, model: null, error: null };
	if (backend === "local") {
		if (!options.local) return { labelled: 0, model: null, error: "modelo local no disponible" };
		const done = storedLabels(
			store,
			LOCAL_MODEL_ID,
			items.map((i) => i.key),
		);
		let n = 0;
		store.db.transaction(() => {
			for (const it of items) {
				if (done.has(it.key)) continue;
				save(
					store,
					it.key,
					localLabels(options.local as LinearModel, { ...it.item, region: it.outlet.region }),
					now,
				);
				n++;
			}
		})();
		return { labelled: n, model: LOCAL_MODEL_ID, error: null };
	}
	const judge = options.jev;
	if (!judge) return { labelled: 0, model: null, error: "Jev no configurado" };
	const done = new Set(
		store.db
			.query<{ item: string }, []>(
				"SELECT item FROM ai_outputs WHERE feature = 'news' AND model LIKE 'jev-%'",
			)
			.all()
			.map((r) => r.item),
	);
	const questions = newsQuestions();
	let n = 0;
	let model: string | null = null;
	for (const it of items) {
		if (n >= (options.maxRequests ?? 60)) break;
		if (done.has(it.key)) continue;
		try {
			const result = await judge.evaluate(
				newsState({
					outlet: it.outlet.name,
					region: it.outlet.region,
					title: it.item.title,
					summary: it.item.summary,
				}),
				questions,
				"news-classify",
			);
			const l = toLabels(result.answers);
			model = result.model;
			save(
				store,
				it.key,
				{
					model: result.model,
					aboutVenezuela: l.about_venezuela,
					blackout: l.blackout,
					topics: Object.fromEntries(Object.entries(l.topics).map(([k, v]) => [k, v ?? 0])),
					eventType: l.event_type.choice,
					eventConfidence: l.event_type.confidence,
					state: l.state.choice,
					stateConfidence: l.state.confidence,
					severity: l.severity.score,
				},
				now,
			);
			n++;
		} catch (error) {
			return { labelled: n, model, error: error instanceof Error ? error.message : String(error) };
		}
	}
	return { labelled: n, model, error: null };
}
