import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasFixture } from "../../core/fixtures.ts";
import { SchemaError } from "../../core/types.ts";
import { publisherOf } from "../../news/publishers.ts";
import { OUTLETS } from "../rss/outlets.ts";
import { TELEGRAM_CHANNELS } from "./channels.ts";
import { channelTitle, parsePreview, readPreview, SUMMARY_MAX, TITLE_MAX } from "./parse.ts";

// Recorded previews carry the channels' own posts, so they stay out of the public repository (see hasFixture and
// scripts/export/policy.ts); index.synthetic.test.ts covers the parser everywhere.
const path = (name: string) => join(import.meta.dir, "fixtures", name);
const recorded = (name: string) => hasFixture(path(name));
const page = (name: string) => readFileSync(path(name), "utf8");
const channel = (id: string) => {
	const c = TELEGRAM_CHANNELS.find((x) => x.id === id);
	if (!c) throw new Error(id);
	return c;
};
// Recorded 2026-09-25 about 18:30 UTC.
const FETCHED = Date.UTC(2026, 8, 25, 18, 40);

describe("recorded previews (t.me/s)", () => {
	test.skipIf(!recorded("elpitazo.html"))("El Pitazo: 20 posts, links, times, truncation", () => {
		const html = page("elpitazo.html");
		expect(channelTitle(html)).toBe("El Pitazo");
		const obs = parsePreview(html, channel("tg-el-pitazo"), FETCHED);
		expect(obs.length).toBe(20);
		for (const o of obs) {
			expect(o.source).toBe("tg-el-pitazo");
			expect(o.value.link).toMatch(/^https:\/\/t\.me\/elpitazo\/\d+$/);
			expect(o.sourceUrl).toBe(o.value.link);
			expect([...o.value.title].length).toBeLessThanOrEqual(TITLE_MAX);
			expect([...o.value.summary].length).toBeLessThanOrEqual(SUMMARY_MAX);
			expect(o.value.title).not.toContain("<");
			expect(o.observedAt).toBeLessThanOrEqual(FETCHED);
			expect(o.basis).toBe("report");
			expect(o.licence).toBe("telegram-preview");
			expect(o.value.image).toBeNull();
		}
		expect(obs[0]?.value.link).toBe("https://t.me/elpitazo/58689");
		expect(obs[0]?.observedAt).toBe(Date.parse("2026-09-23T21:06:00+00:00"));
	});
	test.skipIf(!recorded("teleSUR_tv.html"))(
		"teleSUR: an international desk keeps only posts about Venezuela",
		() => {
			const html = page("teleSUR_tv.html");
			expect(readPreview(html).length).toBe(20);
			const kept = parsePreview(html, channel("tg-telesur"), FETCHED);
			expect(kept.length).toBeLessThan(20);
		},
	);
	test.skipIf(!recorded("no-preview.html"))(
		"a missing or private channel (302 to t.me/<name>) fails loudly",
		() => {
			expect(() => readPreview(page("no-preview.html"))).toThrow(SchemaError);
			expect(() => readPreview(page("no-preview.html"))).toThrow(/no existe o no tiene vista pública/);
		},
	);
});

describe("the default channel list", () => {
	test("ids, handles and URLs are unique, and reads are ≥ 15 minutes apart", () => {
		const ids = new Set(OUTLETS.map((o) => o.id));
		expect(ids.size).toBe(OUTLETS.length);
		const urls = TELEGRAM_CHANNELS.map((c) => c.url.toLowerCase());
		expect(new Set(urls).size).toBe(urls.length);
		for (const c of TELEGRAM_CHANNELS) {
			expect(c.id).toStartWith("tg-");
			expect(c.name).toEndWith("(Telegram)");
			expect(c.url).toMatch(/^https:\/\/t\.me\/s\/[A-Za-z0-9_]{5,32}$/);
			expect(c.intervalMs ?? 0).toBeGreaterThanOrEqual(15 * 60_000);
			expect(c.note).toBeDefined();
		}
	});
	test("a channel of an outlet Vigía reads counts as that outlet, never as a second voice", () => {
		for (const c of TELEGRAM_CHANNELS.filter((x) => x.publisher)) {
			const main = OUTLETS.find((o) => o.id === c.publisher);
			expect(main).toBeDefined();
			expect(publisherOf(c.id).id).toBe(c.publisher as string);
			// Same stance as the outlet it belongs to.
			expect(c.stance as string).toBe(main?.stance as string);
		}
		expect(publisherOf("tg-el-pitazo").id).toBe("el-pitazo");
	});
	test("state media are labelled", () => {
		for (const id of ["tg-vtv", "tg-telesur", "tg-prensa-presidencial"])
			expect(channel(id).stance).toBe("state");
		expect(channel("tg-ultimas-noticias").stance).toBe("state-aligned");
	});
});
