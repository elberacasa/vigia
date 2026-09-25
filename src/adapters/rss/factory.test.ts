import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasFixture } from "../../core/fixtures.ts";
import type { RawResponse, RequestOptions } from "../../core/types.ts";
import { publisherCount, publisherOf } from "../../news/publishers.ts";
import {
	conditionalHeaders,
	itemId,
	mentionsVenezuela,
	type OutletSpec,
	parseFeed,
	rssAdapter,
	STANCE_LABELS,
} from "./factory.ts";
import { OUTLETS, ROBOTS_NOTE } from "./outlets.ts";

// Recorded feeds carry the outlets' own text, so they are absent from the public repository (see hasFixture);
// factory.synthetic.test.ts covers the parser there.
const feedPath = (id: string) => join(import.meta.dir, "fixtures", id, "feed.xml");
const fixture = (id: string) => readFileSync(feedPath(id), "utf8");
const recorded = (...ids: string[]) => ids.every((id) => hasFixture(feedPath(id)));
const spec = (id: string, over: Partial<OutletSpec> = {}): OutletSpec => {
	const found = OUTLETS.find((o) => o.id === id);
	if (!found) throw new Error(id);
	return { ...found, ...over };
};
const FETCHED = Date.UTC(2026, 8, 24, 23, 30);

describe("RSS / Atom parsing", () => {
	test.skipIf(!recorded("el-pitazo"))("WordPress RSS (El Pitazo)", () => {
		const obs = parseFeed(fixture("el-pitazo"), spec("el-pitazo"), FETCHED);
		expect(obs.length).toBe(10);
		for (const o of obs) {
			expect(o.source).toBe("el-pitazo");
			expect(o.series).toStartWith("item:");
			expect(o.value.link).toStartWith("https://elpitazo.net/");
			expect(o.value.summary.length).toBeLessThanOrEqual(400);
			expect(o.value.summary).not.toContain("<");
			expect(o.observedAt).toBeLessThanOrEqual(FETCHED);
			expect(o.basis).toBe("report");
		}
	});
	test.skipIf(!recorded("yt-el-pitazo"))("YouTube channel Atom", () => {
		const obs = parseFeed(fixture("yt-el-pitazo"), spec("yt-el-pitazo"), FETCHED);
		expect(obs.length).toBeGreaterThan(0);
		expect(obs[0]?.value.video).toBe(true);
		expect(obs[0]?.value.link).toStartWith("https://www.youtube.com/");
		expect(obs[0]?.value.image).toStartWith("https://");
	});
	test.skipIf(!recorded("dw-es"))("RDF 1.0 (DW)", () => {
		expect(
			parseFeed(fixture("dw-es"), spec("dw-es", { onlyVenezuela: false }), FETCHED).length,
		).toBeGreaterThan(0);
	});
	test.skipIf(!recorded("bbc-mundo"))("international desks keep only Venezuela items", () => {
		const all = parseFeed(fixture("bbc-mundo"), spec("bbc-mundo", { onlyVenezuela: false }), FETCHED);
		const ve = parseFeed(fixture("bbc-mundo"), spec("bbc-mundo"), FETCHED);
		expect(ve.length).toBeLessThan(all.length);
		for (const o of ve)
			expect(`${o.value.title} ${o.value.summary}`).toMatch(/venezuel|caracas|maracaibo|pdvsa|chavis/i);
	});
	test("Venezuela filter: places, names and the Essequibo dispute; 'maduro' as an adjective does not count", () => {
		expect(mentionsVenezuela("Delcy Rodríguez habla en la ONU")).toBe(true);
		expect(mentionsVenezuela("Guyana defends the Essequibo ruling")).toBe(true);
		expect(mentionsVenezuela("Maduro fue trasladado a Nueva York")).toBe(true);
		expect(mentionsVenezuela("un mercado maduro para la inversión")).toBe(false);
		expect(mentionsVenezuela("Colombia rompe relaciones con Irán")).toBe(false);
	});
	test.skipIf(!recorded("globovision"))(
		"feeds without dates use fetch time, flagged and with lower confidence (Globovisión)",
		() => {
			const obs = parseFeed(fixture("globovision"), spec("globovision"), FETCHED);
			expect(obs.length).toBeGreaterThan(0);
			for (const o of obs) {
				expect(o.value.dateMissing).toBe(true);
				expect(o.observedAt).toBe(FETCHED);
				expect(o.confidence).toBeLessThan(1);
			}
		},
	);
	test.skipIf(!recorded("informe21"))(
		"an item dated in the future is not trusted (Informe21 had one ~3 h ahead)",
		() => {
			const early = Date.UTC(2026, 8, 24, 12, 0);
			for (const o of parseFeed(fixture("informe21"), spec("informe21"), early)) {
				expect(o.observedAt).toBeLessThanOrEqual(early + 15 * 60_000);
			}
		},
	);
	test("not a feed", () => {
		expect(() => parseFeed("<html><body>captcha</body></html>", spec("el-pitazo"), FETCHED)).toThrow();
	});
	test("item ids ignore tracking parameters", () => {
		expect(itemId("https://www.bbc.com/mundo/articles/x?at_medium=RSS&at_campaign=rss")).toBe(
			itemId("https://www.bbc.com/mundo/articles/x"),
		);
		expect(itemId("https://a.org/n?utm_source=x#top")).toBe(itemId("https://a.org/n"));
	});
});

describe("fetch guards", () => {
	const raw = (status: number, body: string): RawResponse => ({
		url: "u",
		status,
		contentType: "",
		body,
		fetchedAt: FETCHED,
	});
	const run = (r: RawResponse) =>
		rssAdapter(spec("el-pitazo")).fetch({
			http: { request: async () => r },
			key: () => undefined,
			now: () => FETCHED,
			signal: new AbortController().signal,
		});
	test("a 202 captcha page is a failure, not an empty feed", async () => {
		await expect(run(raw(202, "<html>wait</html>"))).rejects.toThrow("202");
	});
	test("an HTML challenge with 200 is a failure", async () => {
		await expect(run(raw(200, "<!DOCTYPE html><html>js challenge</html>"))).rejects.toThrow("HTML");
	});
});

describe("conditional requests", () => {
	type Sent = { headers: Record<string, string>; okStatuses: readonly number[] };
	const harness = (responses: RawResponse[]) => {
		const sent: Sent[] = [];
		const adapter = rssAdapter(spec("el-pitazo"));
		const ctx = {
			http: {
				request: async (_url: string, options: RequestOptions = {}) => {
					sent.push({ headers: { ...options.headers }, okStatuses: options.okStatuses ?? [] });
					const next = responses.shift();
					if (!next) throw new Error("no more responses");
					return next;
				},
			},
			key: () => undefined,
			now: () => FETCHED,
			signal: new AbortController().signal,
		};
		return { sent, run: async () => adapter.normalise(await adapter.fetch(ctx)) };
	};
	// Synthetic, so it runs in the public repository too (recorded feeds are withheld there).
	const items = Array.from(
		{ length: 10 },
		(_, i) =>
			`<item><title>Titular ${i}</title><link>https://example.org/n/${i}</link><pubDate>Thu, 24 Sep 2026 2${i % 3}:0${i}:00 +0000</pubDate></item>`,
	).join("");
	const feed = (over: Partial<RawResponse> = {}): RawResponse => ({
		url: "u",
		status: 200,
		contentType: "application/rss+xml",
		body: `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${items}</channel></rss>`,
		fetchedAt: FETCHED,
		...over,
	});

	test("sends the validators of the last feed that parsed; a 304 is a success with nothing new", async () => {
		const h = harness([
			feed({ etag: '"v1"', lastModified: "Thu, 24 Sep 2026 22:54:26 GMT" }),
			feed({ status: 304, body: "" }),
		]);
		expect((await h.run()).length).toBe(10);
		expect(h.sent[0]?.headers["if-none-match"]).toBeUndefined();
		expect(await h.run()).toEqual([]);
		expect(h.sent[1]?.headers["if-none-match"]).toBe('"v1"');
		expect(h.sent[1]?.headers["if-modified-since"]).toBe("Thu, 24 Sep 2026 22:54:26 GMT");
		expect(h.sent[1]?.okStatuses).toEqual([304]);
	});
	test("a feed that does not parse is never remembered, so the next request is unconditional", async () => {
		const h = harness([feed({ etag: '"broken"', body: "<moved>see the new address</moved>" }), feed()]);
		await expect(h.run()).rejects.toThrow();
		await h.run();
		expect(h.sent[1]?.headers["if-none-match"]).toBeUndefined();
		expect(h.sent[1]?.okStatuses).toEqual([]);
	});
	test("without validators nothing conditional is sent and a 304 is not accepted", () => {
		expect(conditionalHeaders(null)).toEqual({});
		expect(conditionalHeaders({ etag: '"x"' })).toEqual({ "if-none-match": '"x"' });
	});
});

test("outlet list is sane", () => {
	expect(OUTLETS.length).toBeGreaterThanOrEqual(70);
	expect(new Set(OUTLETS.map((o) => o.id)).size).toBe(OUTLETS.length);
	expect(new Set(OUTLETS.map((o) => o.url)).size).toBe(OUTLETS.length);
	const byId = new Map(OUTLETS.map((o) => [o.id, o]));
	const stances = new Set(Object.keys(STANCE_LABELS));
	for (const o of OUTLETS) {
		expect(o.url).toStartWith("https://");
		expect(["national", "international", "diaspora"].includes(o.region) || /^VE-[A-Z]$/.test(o.region)).toBe(
			true,
		);
		expect(stances.has(o.stance)).toBe(true);
		expect(["es", "en", "pt", undefined]).toContain(o.lang);
		expect(["news", "fact-check", "official", "rights", undefined]).toContain(o.genre);
		// A publisher reference points at a main entry (never at another secondary feed).
		if (o.publisher) {
			const main = byId.get(o.publisher);
			expect(main).toBeDefined();
			expect(main?.publisher).toBeUndefined();
		}
		// YouTube's robots.txt excludes /feeds/videos.xml: every channel is on by default (2026-09-25) and
		// carries the neutral robots note, never an opt-in.
		if (o.kind === "youtube") {
			expect(o.note).toBe(ROBOTS_NOTE);
			expect(o.optIn).toBeUndefined();
		}
		// Government press sites are the state speaking: their stance says so.
		if (o.genre === "official") expect(["state", "multilateral"]).toContain(o.stance);
	}
});

test("robots-excluded feeds are on by default with a neutral note, at their own interval (2026-09-25)", () => {
	const robots = OUTLETS.filter((o) => o.note === ROBOTS_NOTE);
	// The four outlets whose robots.txt excludes their feed, and every YouTube channel feed.
	for (const id of ["el-diario", "espacio-publico", "observatorio-dd-hh", "globovision"])
		expect(robots.map((o) => o.id)).toContain(id);
	expect(
		robots
			.filter((o) => o.kind !== "youtube")
			.map((o) => o.id)
			.sort(),
	).toEqual(["el-diario", "espacio-publico", "globovision", "observatorio-dd-hh"]);
	expect(robots.filter((o) => o.kind === "youtube").length).toBe(
		OUTLETS.filter((o) => o.kind === "youtube").length,
	);
	expect(ROBOTS_NOTE.es).toBe(
		"Su robots.txt excluye lectores automáticos; Vigía lo lee a ritmo bajo por decisión del proyecto.",
	);
	for (const o of robots) {
		const a = rssAdapter(o);
		expect(a.optIn).toBeUndefined();
		expect(a.note).toEqual(ROBOTS_NOTE);
		// The intervals they had as opt-in feeds (10 min for five busy channels, 20–60 min for the rest); never faster.
		expect(a.intervalMs).toBeGreaterThanOrEqual((o.kind === "youtube" ? 10 : 20) * 60_000);
		expect(a.licence.id).toBe("headline-link");
	}
});

test("every stance has a neutral label in both languages", () => {
	for (const [id, label] of Object.entries(STANCE_LABELS)) {
		expect(label.es.length).toBeGreaterThan(2);
		expect(label.en.length).toBeGreaterThan(2);
		expect(id).toMatch(/^[a-z-]+$/);
	}
});

test("publishers: secondary feeds count as their outlet", () => {
	expect(publisherOf("yt-el-pitazo")).toEqual({ id: "el-pitazo", name: "El Pitazo" });
	expect(publisherOf("el-pitazo-regiones").id).toBe("el-pitazo");
	expect(publisherOf("tal-cual").id).toBe("tal-cual");
	expect(publisherCount()).toBeLessThan(OUTLETS.length);
	expect(rssAdapter(spec("yt-el-pitazo")).provider).toBe("El Pitazo");
	expect(publisherCount()).toBe(OUTLETS.filter((o) => !o.publisher).length);
});

describe("fixtures of the 2026-09-24 wave (recorded by scripts/probe-feeds.ts)", () => {
	const LATER = Date.UTC(2026, 8, 25, 12, 0);
	const cases: { id: string; host: string; stance: string; region: string; lang?: string; genre?: string }[] =
		[
			{ id: "rnv", host: "rnv.gob.ve", stance: "state", region: "national" },
			{ id: "el-carabobeno", host: "el-carabobeno.com", stance: "independent", region: "VE-G" },
			{ id: "portuguesa-reporta", host: "portuguesareporta.com", stance: "commercial", region: "VE-P" },
			{
				id: "govuk-venezuela-news",
				host: "www.gov.uk",
				stance: "state",
				region: "international",
				lang: "en",
				genre: "official",
			},
			{
				id: "folha-bv-venezuela",
				host: "folhabv.com.br",
				stance: "commercial",
				region: "international",
				lang: "pt",
			},
			{ id: "cibercuba", host: "www.cibercuba.com", stance: "independent", region: "international" },
		];
	for (const c of cases) {
		test(`${c.id}: classified as documented`, () => {
			const outlet = spec(c.id);
			expect(outlet.stance).toBe(c.stance as never);
			expect(outlet.region).toBe(c.region);
			expect(outlet.lang ?? "es").toBe((c.lang ?? "es") as never);
			expect(outlet.genre).toBe(c.genre as never);
		});
		test.skipIf(!recorded(c.id))(`${c.id}: dated items from its own site`, () => {
			const outlet = spec(c.id);
			const obs = parseFeed(fixture(c.id), outlet, LATER);
			expect(obs.length).toBeGreaterThan(0);
			for (const o of obs) {
				expect(new URL(o.value.link).host.endsWith(c.host.replace(/^www\./, ""))).toBe(true);
				expect(o.value.dateMissing).toBe(false);
				if (outlet.onlyVenezuela) expect(mentionsVenezuela(`${o.value.title} ${o.value.summary}`)).toBe(true);
			}
		});
	}
	test.skipIf(!recorded("cibercuba"))(
		"a general foreign desk keeps only its Venezuela items (CiberCuba)",
		() => {
			const all = parseFeed(fixture("cibercuba"), spec("cibercuba", { onlyVenezuela: false }), LATER);
			const ve = parseFeed(fixture("cibercuba"), spec("cibercuba"), LATER);
			expect(ve.length).toBeGreaterThan(0);
			expect(ve.length).toBeLessThan(all.length);
		},
	);
});
