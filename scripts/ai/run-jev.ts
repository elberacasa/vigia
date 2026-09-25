/**
 * Runs the fast layer (Jev) over exported news items: `bun scripts/ai/run-jev.ts <items.jsonl> <out.jsonl> [limit]`.
 * Uses the ledgered, cached client with a hard budget of US$5 (edit BUDGET_USD). The key comes from the environment
 * (TYPESAFE_API_KEY, never printed). Resumable: items already in <out> are skipped. Default directory:
 * $VIGIA_AI_DIR (default `runs/ai`).
 */
import { existsSync, readFileSync } from "node:fs";
import { JevJudge } from "../../src/ai/jev.ts";
import { Ledger } from "../../src/ai/ledger.ts";
import { type NewsInput, newsQuestions, newsState, toLabels } from "../../src/ai/news-questions.ts";
import { HttpClient } from "../../src/core/http.ts";
import { Store } from "../../src/core/store.ts";

const AI_DIR = process.env.VIGIA_AI_DIR ?? "runs/ai";
const [input = `${AI_DIR}/items.jsonl`, out = `${AI_DIR}/jev.jsonl`, limitArg] = process.argv.slice(2);
const limit = limitArg ? Number(limitArg) : Number.POSITIVE_INFINITY;
const BUDGET_USD = 5;
const store = new Store(`${AI_DIR}/ai.sqlite`);
const ledger = new Ledger(store, (provider) => (provider === "typesafe" ? BUDGET_USD : 0));
const judge = new JevJudge(() => process.env.TYPESAFE_API_KEY, new HttpClient(), ledger, store);
const questions = newsQuestions();

const done = new Set<string>(
	existsSync(out)
		? readFileSync(out, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((l) => (JSON.parse(l) as { id: string }).id)
		: [],
);
const items = readFileSync(input, "utf8")
	.trim()
	.split("\n")
	.map((l) => JSON.parse(l) as NewsInput & { id: string })
	.filter((i) => !done.has(i.id))
	.slice(0, limit);

let n = 0;
const started = performance.now();
const lines: string[] = [];
const CONCURRENCY = 4;
let next = 0;
async function worker() {
	while (next < items.length) {
		const item = items[next++];
		if (!item) break;
		const t0 = performance.now();
		const result = await judge.evaluate(newsState(item), questions, "news-classify");
		lines.push(
			JSON.stringify({
				id: item.id,
				model: result.model,
				cached: result.cached,
				ms: Math.round(performance.now() - t0),
				labels: toLabels(result.answers),
			}),
		);
		n++;
		if (n % 50 === 0) console.log(`${n}/${items.length} · spent US$${ledger.spent("typesafe").toFixed(4)}`);
	}
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const prev = existsSync(out) ? readFileSync(out, "utf8") : "";
await Bun.write(out, `${prev}${lines.join("\n")}${lines.length ? "\n" : ""}`);
const s = ledger.summary().find((x) => x.provider === "typesafe");
console.log(
	`done ${n} items in ${((performance.now() - started) / 1000).toFixed(1)} s · total requests ${s?.requests ?? 0}, input tokens ${s?.inputTokens ?? 0}, spent US$${(s?.costUsd ?? 0).toFixed(4)} of ${BUDGET_USD}`,
);
