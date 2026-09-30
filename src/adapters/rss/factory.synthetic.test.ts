import { expect, test } from "bun:test";
import type { FetchContext, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import {
	FILTERED_LIVENESS_MS,
	isIndexPage,
	itemId,
	newestItemAt,
	type OutletSpec,
	parseFeed,
	rssAdapter,
	searchWindowMs,
} from "./factory.ts";

/**
 * Synthetic feeds for an invented outlet ("Diario Ejemplo", example.org). Recorded feeds carry the outlets' own
 * text and stay out of the public repository; these cover the parser everywhere.
 */

const FETCHED = Date.UTC(2026, 0, 15, 12, 0);
const outlet = (over: Partial<OutletSpec> = {}): OutletSpec => ({
	id: "diario-ejemplo",
	name: "Diario Ejemplo",
	url: "https://example.org/feed/",
	kind: "rss",
	region: "national",
	stance: "independent",
	homepage: "https://example.org/",
	...over,
});

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel><title>Diario Ejemplo</title>
<item>
	<title>Titular de &lt;b&gt;prueba&lt;/b&gt; en Caracas</title>
	<link>https://example.org/noticias/uno?utm_source=rss</link>
	<description><![CDATA[<p>Resumen <strong>sintético</strong> de la nota.</p>]]></description>
	<pubDate>Thu, 15 Jan 2026 10:30:00 GMT</pubDate>
	<enclosure url="https://example.org/img/uno.jpg" type="image/jpeg" length="1"/>
</item>
<item>
	<title>Nota sin fecha</title>
	<link>https://example.org/noticias/dos</link>
	<description>${"x".repeat(600)}</description>
</item>
<item>
	<title>Nota fechada en el futuro</title>
	<link>https://example.org/noticias/tres</link>
	<pubDate>Thu, 15 Jan 2026 15:00:00 GMT</pubDate>
</item>
<item><title>Sin enlace</title><link>javascript:void(0)</link></item>
<item><title></title><link>https://example.org/noticias/vacia</link></item>
</channel></rss>`;

test("RSS 2.0: headline, clean link, plain-text summary and image, dated by the feed", () => {
	const obs = parseFeed(RSS, outlet(), FETCHED);
	expect(obs.length).toBe(3);
	expect(obs[0]).toEqual({
		source: "diario-ejemplo",
		series: `item:${itemId("https://example.org/noticias/uno")}`,
		sourceUrl: "https://example.org/noticias/uno?utm_source=rss",
		fetchedAt: FETCHED,
		observedAt: Date.UTC(2026, 0, 15, 10, 30),
		licence: "headline-link",
		value: {
			outlet: "diario-ejemplo",
			title: "Titular de prueba en Caracas",
			link: "https://example.org/noticias/uno?utm_source=rss",
			summary: "Resumen sintético de la nota.",
			image: "https://example.org/img/uno.jpg",
			dateMissing: false,
			video: false,
		},
		confidence: 1,
		basis: "report",
	});
});

test("an undated or future-dated item takes the fetch time, is flagged, keeps its first sighting", () => {
	const [, undated, future] = parseFeed(RSS, outlet(), FETCHED);
	for (const o of [undated, future]) {
		expect(o?.observedAt).toBe(FETCHED);
		expect(o?.value.dateMissing).toBe(true);
		expect(o?.confidence).toBe(0.6);
		expect(o?.keepFirst).toBe(true);
	}
	expect(undated?.value.summary.length).toBe(400);
	// Within the 15-minute tolerance a slightly-ahead clock is trusted.
	const early = parseFeed(RSS, outlet(), Date.UTC(2026, 0, 15, 14, 50));
	expect(early[2]?.value.dateMissing).toBe(false);
});

test("international desks keep only items that mention Venezuela", () => {
	const obs = parseFeed(RSS, outlet({ onlyVenezuela: true, region: "international" }), FETCHED);
	expect(obs.map((o) => o.value.title)).toEqual(["Titular de prueba en Caracas"]);
});

test("YouTube Atom: alternate link, thumbnail, marked as video", () => {
	const atom = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
<entry>
	<title>Video de ejemplo</title>
	<link rel="alternate" href="https://www.youtube.com/watch?v=AAAAAAAAAAA"/>
	<published>2026-01-15T09:00:00+00:00</published>
	<media:group>
		<media:description>Descripción sintética</media:description>
		<media:thumbnail url="https://i.ytimg.com/vi/AAAAAAAAAAA/hqdefault.jpg" width="480" height="360"/>
	</media:group>
</entry>
</feed>`;
	const [o] = parseFeed(atom, outlet({ kind: "youtube" }), FETCHED);
	expect(o?.value).toMatchObject({
		title: "Video de ejemplo",
		link: "https://www.youtube.com/watch?v=AAAAAAAAAAA",
		summary: "Descripción sintética",
		image: "https://i.ytimg.com/vi/AAAAAAAAAAA/hqdefault.jpg",
		video: true,
		dateMissing: false,
	});
	expect(o?.observedAt).toBe(Date.UTC(2026, 0, 15, 9));
});

test("RDF 1.0 with dc:date", () => {
	const rdf = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<item><title>Nota RDF</title><link>https://example.org/rdf/1</link><dc:date>2026-01-15T08:00:00Z</dc:date></item>
</rdf:RDF>`;
	const [o] = parseFeed(rdf, outlet(), FETCHED);
	expect(o?.value.title).toBe("Nota RDF");
	expect(o?.observedAt).toBe(Date.UTC(2026, 0, 15, 8));
});

test("the adapter normalises its one response; HTML or an empty response throws SchemaError", () => {
	const adapter = rssAdapter(outlet());
	const raw = {
		url: "https://example.org/feed/",
		status: 200,
		contentType: "application/rss+xml",
		body: RSS,
	};
	expect(adapter.normalise([{ ...raw, fetchedAt: FETCHED }]).length).toBe(3);
	expect(adapter.licence.id).toBe("headline-link");
	expect(() => parseFeed("<html><body>captcha</body></html>", outlet(), FETCHED)).toThrow(SchemaError);
	expect(() => adapter.normalise([])).toThrow(SchemaError);
});

// Google News `site:` search, in its format: Google's redirect links, " - Outlet" suffixes, a homonym outlet.
const GOOGLE_NEWS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>"site:example.org when:1d" - Google Noticias</title>
<item><title>Titular de prueba sobre Maracaibo - Diario Ejemplo</title><link>https://news.google.com/rss/articles/CBMiAAA?oc=5</link><guid isPermaLink="false">CBMiAAA</guid><pubDate>Thu, 15 Jan 2026 10:00:00 GMT</pubDate><description>&lt;a href="https://news.google.com/rss/articles/CBMiAAA?oc=5"&gt;Titular de prueba sobre Maracaibo&lt;/a&gt;</description><source url="https://www.example.org">Diario Ejemplo</source></item>
<item><title>Otra nota - Ejemplo - Diario Ejemplo</title><link>https://news.google.com/rss/articles/CBMiBBB?oc=5</link><pubDate>Thu, 15 Jan 2026 09:00:00 GMT</pubDate><source url="https://amp.example.org">Diario Ejemplo</source></item>
<item><title>Nota de un homónimo - Diario Ejemplo (Paraguay)</title><link>https://news.google.com/rss/articles/CBMiCCC?oc=5</link><pubDate>Thu, 15 Jan 2026 08:00:00 GMT</pubDate><source url="https://example.org.py">Diario Ejemplo (Paraguay)</source></item>
<item><title>Sin fuente</title><link>https://news.google.com/rss/articles/CBMiDDD?oc=5</link></item>
</channel></rss>`;

test("Google News: only the outlet's own site, Google's title suffix removed, linked through Google", () => {
	const obs = parseFeed(GOOGLE_NEWS, outlet({ via: { kind: "google-news", host: "example.org" } }), FETCHED);
	expect(obs.map((o) => o.value.title)).toEqual(["Titular de prueba sobre Maracaibo", "Otra nota - Ejemplo"]);
	expect(obs.every((o) => o.value.link.startsWith("https://news.google.com/rss/articles/"))).toBe(true);
	expect(obs[0]?.observedAt).toBe(Date.UTC(2026, 0, 15, 10, 0));
	// The same feed read as a plain outlet keeps everything, suffix included.
	expect(parseFeed(GOOGLE_NEWS, outlet(), FETCHED)).toHaveLength(4);
});

// A `site:` search also returns tag and archive pages, and pages Google re-indexed with their old date (2026-09-29).
const GN_NOISE = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>"site:example.org when:1d"</title>
<item><title>Nota de hoy - Diario Ejemplo</title><link>https://news.google.com/rss/articles/A1?oc=5</link><pubDate>Thu, 15 Jan 2026 10:00:00 GMT</pubDate><source url="https://example.org">Diario Ejemplo</source></item>
<item><title>Nota de hace dos días - Diario Ejemplo</title><link>https://news.google.com/rss/articles/A2?oc=5</link><pubDate>Tue, 13 Jan 2026 13:00:00 GMT</pubDate><source url="https://example.org">Diario Ejemplo</source></item>
<item><title>Nota de 2019 re-indexada - Diario Ejemplo</title><link>https://news.google.com/rss/articles/A3?oc=5</link><pubDate>Mon, 14 Jan 2019 10:00:00 GMT</pubDate><source url="https://example.org">Diario Ejemplo</source></item>
<item><title>Política archivos - Página 89 de 89 - Diario Ejemplo</title><link>https://news.google.com/rss/articles/A4?oc=5</link><pubDate>Thu, 15 Jan 2026 09:00:00 GMT</pubDate><source url="https://example.org">Diario Ejemplo</source></item>
<item><title>Sucesos Archives - Diario Ejemplo</title><link>https://news.google.com/rss/articles/A5?oc=5</link><pubDate>Thu, 15 Jan 2026 09:00:00 GMT</pubDate><source url="https://example.org">Diario Ejemplo</source></item>
<item><title>Fiscalía revisa los archivos - Diario Ejemplo</title><link>https://news.google.com/rss/articles/A6?oc=5</link><pubDate>Thu, 15 Jan 2026 08:00:00 GMT</pubDate><source url="https://example.org">Diario Ejemplo</source></item>
</channel></rss>`;

test("Google News: archive pages and items older than the search window (plus two days) are not stories", () => {
	const gn = outlet({
		url: "https://news.google.com/rss/search?q=site:example.org+when:1d&hl=es-419",
		via: { kind: "google-news", host: "example.org" },
	});
	expect(parseFeed(GN_NOISE, gn, FETCHED).map((o) => o.value.title)).toEqual([
		"Nota de hoy",
		"Nota de hace dos días",
		"Fiscalía revisa los archivos",
	]);
	// A week's window keeps the same; a direct feed keeps everything (its own archive is the outlet's business).
	expect(parseFeed(GN_NOISE, { ...gn, url: gn.url.replace("when:1d", "when:7d") }, FETCHED)).toHaveLength(3);
	expect(parseFeed(GN_NOISE, outlet(), FETCHED)).toHaveLength(6);
	expect(searchWindowMs("https://news.google.com/rss/search?q=site:x.org+when:1d")).toBe(3 * 86_400_000);
	expect(searchWindowMs("https://news.google.com/rss/search?q=site:x.org+when:7d")).toBe(9 * 86_400_000);
	expect(searchWindowMs("https://news.google.com/rss/search?q=site:x.org+when:12h")).toBe(
		12 * 3_600_000 + 2 * 86_400_000,
	);
	expect(searchWindowMs("https://example.org/feed/")).toBeNull();
	for (const t of [
		"Zulia Archives - Página 171 de 171",
		"SUCESOS archivos",
		"pádel Archives",
		"Página 4 de 259 - Portada",
		"Inicio | Ejemplo",
		"Latinoamérica - Página 899 de 1700",
	])
		expect(isIndexPage(t)).toBe(true);
	for (const t of [
		"Los archivos del caso",
		"EEUU desclasifica sus archivos",
		"Release of the National Archives",
		"Convocatoria asamblea",
	])
		expect(isIndexPage(t)).toBe(false);
});

// A WordPress site's REST API, read like a feed (Radio Mundial's feeds froze on 2026-09-19 while the site kept
// publishing). Invented posts in the API's shape.
const WP_POSTS = JSON.stringify([
	{
		date_gmt: "2026-01-15T11:00:00",
		link: "https://example.org/nota-maracaibo/",
		title: { rendered: "Apag&oacute;n en Maracaibo &#8220;parcial&#8221;" },
		excerpt: { rendered: "<p>Primeras l&iacute;neas.</p>\n" },
	},
	{
		date_gmt: "2026-01-15T10:00:00",
		link: "https://otro.example.net/x/",
		title: { rendered: "Fuera del sitio" },
	},
	{
		date_gmt: "2026-01-15T09:00:00",
		link: "https://www.example.org/nota-2/",
		title: { rendered: "Otra nota" },
	},
	{ date_gmt: "2026-01-15T09:00:00", link: "https://example.org/sin-titulo/", title: {} },
	"basura",
]);

test("WordPress REST posts: title, link, excerpt and a UTC date; other sites and malformed posts skipped", () => {
	const wp = outlet({ kind: "wp-json", url: "https://example.org/wp-json/wp/v2/posts?per_page=20" });
	const obs = parseFeed(WP_POSTS, wp, FETCHED);
	expect(obs.map((o) => o.value.title)).toEqual(["Apagón en Maracaibo “parcial”", "Otra nota"]);
	expect(obs[0]?.observedAt).toBe(Date.UTC(2026, 0, 15, 11));
	expect(obs[0]?.value.summary).toBe("Primeras líneas.");
	expect(obs[0]?.sourceUrl).toBe("https://example.org/nota-maracaibo/");
	expect(parseFeed(WP_POSTS, { ...wp, onlyVenezuela: true }, FETCHED).map((o) => o.value.title)).toEqual([
		"Apagón en Maracaibo “parcial”",
	]);
	expect(() => parseFeed('{"code":"rest_no_route"}', wp, FETCHED)).toThrow(SchemaError);
	expect(() => parseFeed("<html></html>", wp, FETCHED)).toThrow(SchemaError);
	expect(
		rssAdapter(wp).normalise([
			{ url: wp.url, status: 200, contentType: "application/json", body: WP_POSTS, fetchedAt: FETCHED },
		]),
	).toHaveLength(2);
});

const rssAt = (items: { title: string; at: number }[]) =>
	`<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${items
		.map(
			(it, i) =>
				`<item><title>${it.title}</title><link>https://example.org/n${i}</link><pubDate>${new Date(it.at).toUTCString()}</pubDate></item>`,
		)
		.join("")}</channel></rss>`;

function once(body: string, fetchedAt: number): FetchContext {
	return {
		http: {
			request: async (url: string): Promise<RawResponse> => ({
				url,
				status: 200,
				contentType: "application/rss+xml",
				body,
				fetchedAt,
			}),
		},
		key: () => null,
		now: () => fetchedAt,
		signal: new AbortController().signal,
	} as unknown as FetchContext;
}

test("a feed filtered to Venezuela has no newest-item budget; its whole feed must publish within 30 days", async () => {
	const DAY = 86_400_000;
	const filtered = outlet({ onlyVenezuela: true, intervalMs: 60 * 60_000 });
	const a = rssAdapter(filtered);
	expect(a.freshness.dataMs).toBeNull();
	// Busy, but nothing about Venezuela for weeks: fine, and nothing stored.
	const quiet = rssAt([{ title: "Elecciones en Chile", at: FETCHED - 3_600_000 }]);
	const raws = await a.fetch(once(quiet, FETCHED));
	expect(a.normalise(raws)).toEqual([]);
	expect(newestItemAt(quiet, filtered, FETCHED)).toBe(FETCHED - 3_600_000 - ((FETCHED - 3_600_000) % 1000));
	// The whole feed silent for 31 days: dead, said as such.
	const dead = rssAt([{ title: "Nota sobre Venezuela", at: FETCHED - 31 * DAY }]);
	await expect(rssAdapter(filtered).fetch(once(dead, FETCHED))).rejects.toThrow("desde hace 31 días");
	expect(FILTERED_LIVENESS_MS).toBe(30 * DAY);
	// Unfiltered feeds keep their budget: by polling class, or the publisher's measured one.
	expect(rssAdapter(outlet({ intervalMs: 10 * 60_000 })).freshness.dataMs).toBe(DAY);
	expect(rssAdapter(outlet({ intervalMs: 180 * 60_000 })).freshness.dataMs).toBe(14 * DAY);
	expect(rssAdapter(outlet({ intervalMs: 180 * 60_000, dataBudgetMs: 52 * DAY })).freshness.dataMs).toBe(
		52 * DAY,
	);
});
