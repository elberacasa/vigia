/**
 * Harvests older headlines for training from WordPress feeds' paged archives (`/feed/?paged=N`):
 * `bun scripts/ai/harvest.ts <out.jsonl> [pages]`. Polite: 3 s between requests to the same host, stops at the first
 * error or empty page per outlet. Training data only; nothing here is shown in the app. Default directory:
 * $VIGIA_AI_DIR (default `runs/ai`); links already in its items.jsonl are skipped.
 */
import { existsSync, readFileSync } from "node:fs";
import { parseFeed } from "../../src/adapters/rss/factory.ts";
import { OUTLETS } from "../../src/adapters/rss/outlets.ts";
import { HttpClient } from "../../src/core/http.ts";
import { stripDateline } from "../../src/news/text.ts";

const AI_DIR = process.env.VIGIA_AI_DIR ?? "runs/ai";
const [out = `${AI_DIR}/harvest.jsonl`, pagesArg = "12"] = process.argv.slice(2);
const pages = Number(pagesArg);
const http = new HttpClient({ defaultHostGapMs: 3_000 });
const seen = new Set<string>(
	existsSync(`${AI_DIR}/items.jsonl`)
		? readFileSync(`${AI_DIR}/items.jsonl`, "utf8")
				.trim()
				.split("\n")
				.map((l) => (JSON.parse(l) as { link: string }).link)
		: [],
);
const wordpress = OUTLETS.filter((o) => o.kind === "rss" && /\/feed\/?$/.test(o.url));
const lines: string[] = [];
await Promise.all(
	wordpress.map(async (outlet) => {
		for (let page = 2; page <= pages; page++) {
			try {
				const url = `${outlet.url.replace(/\/$/, "")}/?paged=${page}`;
				const raw = await http.request(url, { hostGapMs: 3_000, retries: 0, timeoutMs: 20_000 });
				if (raw.status !== 200 || /^\s*<!doctype html|^\s*<html/i.test(raw.body)) break;
				const obs = parseFeed(raw.body, outlet, raw.fetchedAt);
				let fresh = 0;
				for (const o of obs) {
					if (seen.has(o.value.link)) continue;
					seen.add(o.value.link);
					fresh++;
					lines.push(
						JSON.stringify({
							id: Bun.hash(o.value.link).toString(36),
							outlet: outlet.name,
							outletId: outlet.id,
							region: outlet.region,
							stance: outlet.stance,
							at: o.observedAt,
							title: o.value.title,
							summary: stripDateline(o.value.summary).slice(0, 400),
							link: o.value.link,
						}),
					);
				}
				if (fresh === 0) break;
			} catch {
				break;
			}
		}
	}),
);
await Bun.write(out, `${lines.join("\n")}\n`);
console.log(`${wordpress.length} WordPress outlets, ${lines.length} new items → ${out}`);
