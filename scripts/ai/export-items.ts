/**
 * Exports stored news items for labelling and training: `bun scripts/ai/export-items.ts [db] [out.jsonl]`.
 * One line per distinct link: outlet, region, title, summary, and what the keyword rules say (the baseline).
 * Default database: this machine's Vigía database (`vigia paths`; VIGIA_HOME selects another instance).
 * Default output directory: $VIGIA_AI_DIR (default `runs/ai`).
 */
import { join } from "node:path";

import type { NewsItem } from "../../src/adapters/rss/factory.ts";
import { OUTLETS } from "../../src/adapters/rss/outlets.ts";
import { resolvePaths } from "../../src/config/paths.ts";
import { Store } from "../../src/core/store.ts";
import { tagPlaces } from "../../src/news/places.ts";
import { stripDateline } from "../../src/news/text.ts";
import { topics } from "../../src/news/topics.ts";

const AI_DIR = process.env.VIGIA_AI_DIR ?? "runs/ai";
const [dbPath = join(resolvePaths().data, "vigia.sqlite"), out = `${AI_DIR}/items.jsonl`] =
	process.argv.slice(2);
const store = new Store(dbPath);
const seen = new Set<string>();
const lines: string[] = [];
for (const outlet of OUTLETS) {
	for (const o of store.latestPerSeries<NewsItem>(outlet.id, 0, 5_000)) {
		const item = o.value;
		if (seen.has(item.link)) continue;
		seen.add(item.link);
		const text = `${item.title}. ${stripDateline(item.summary)}`;
		const venezuelanOutlet = outlet.region !== "international";
		const places = tagPlaces(text, {
			venezuelanOutlet,
			...(outlet.region.startsWith("VE-") ? { homeState: outlet.region } : {}),
		});
		lines.push(
			JSON.stringify({
				id: Bun.hash(item.link).toString(36),
				outlet: outlet.name,
				outletId: outlet.id,
				region: outlet.region,
				stance: outlet.stance,
				at: o.observedAt,
				title: item.title,
				summary: stripDateline(item.summary).slice(0, 400),
				link: item.link,
				baseline: {
					topics: topics(text),
					state: places.primaryState,
					states: [...new Set(places.mentions.map((m) => m.state))],
					candidates: [...new Set(places.mentions.map((m) => m.state))],
				},
			}),
		);
	}
}
await Bun.write(out, `${lines.join("\n")}\n`);
console.log(`${lines.length} items → ${out}`);
