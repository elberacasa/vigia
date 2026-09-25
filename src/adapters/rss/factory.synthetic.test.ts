import { expect, test } from "bun:test";
import { SchemaError } from "../../core/types.ts";
import { itemId, type OutletSpec, parseFeed, rssAdapter } from "./factory.ts";

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
