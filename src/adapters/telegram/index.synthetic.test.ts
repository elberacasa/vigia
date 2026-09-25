import { describe, expect, test } from "bun:test";
import { type RawResponse, type RequestOptions, SchemaError } from "../../core/types.ts";
import type { OutletSpec } from "../rss/factory.ts";
import { telegramAdapter } from "./index.ts";
import {
	channelTitle,
	looksLikeTelegram,
	parsePreview,
	previewHandle,
	previewUrl,
	readPreview,
	TITLE_MAX,
	telegramHandle,
} from "./parse.ts";

/**
 * A synthetic preview page for an invented channel ("Canal Ejemplo", @canalejemplo) in the markup t.me/s serves.
 * Recorded pages carry the channels' own posts and stay out of the public repository.
 */
const FETCHED = Date.UTC(2026, 0, 15, 12, 0);
const outlet = (over: Partial<OutletSpec> = {}): OutletSpec => ({
	id: "tg-canal-ejemplo",
	name: "Canal Ejemplo (Telegram)",
	url: "https://t.me/s/canalejemplo",
	kind: "telegram",
	region: "national",
	stance: "independent",
	homepage: "https://t.me/canalejemplo",
	...over,
});

const post = (
	id: number,
	text: string | null,
	datetime = "2026-01-15T10:30:00+00:00",
	channel = "canalejemplo",
) =>
	`<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message js-widget_message" data-post="${channel}/${id}">
<div class="tgme_widget_message_bubble">
${text === null ? '<a class="tgme_widget_message_photo_wrap" href="https://t.me/canalejemplo/1"></a>' : `<div class="tgme_widget_message_text js-message_text" dir="auto">${text}</div>`}
<div class="tgme_widget_message_footer"><span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="https://t.me/${channel}/${id}"><time datetime="${datetime}" class="time">10:30</time></a></span></div>
</div></div></div>`;

const page = (...posts: string[]) => `<!DOCTYPE html><html><head>
<meta property="og:title" content="Canal Ejemplo"></head><body>
<div class="tgme_channel_info"><div class="tgme_channel_info_header_title"><span dir="auto">Canal Ejemplo</span></div></div>
<section class="tgme_channel_history js-message_history">${posts.join("\n")}</section></body></html>`;

describe("reading a preview page", () => {
	test("first line is the headline, the rest the summary, link and time from the post", () => {
		const html = page(
			post(
				101,
				"<b>Titular de prueba en Caracas</b><br/><br/>Resumen <i>sintético</i> &amp; más.<br/>Segunda línea.",
			),
			post(102, 'Solo una línea con <a href="https://example.org/">enlace</a>', "2026-01-15T11:00:00+00:00"),
		);
		expect(channelTitle(html)).toBe("Canal Ejemplo");
		const obs = parsePreview(html, outlet(), FETCHED);
		expect(obs.length).toBe(2);
		expect(obs[0]?.value).toEqual({
			outlet: "tg-canal-ejemplo",
			title: "Titular de prueba en Caracas",
			link: "https://t.me/canalejemplo/101",
			summary: "Resumen sintético & más. Segunda línea.",
			image: null,
			dateMissing: false,
			video: false,
		});
		expect(obs[0]?.observedAt).toBe(Date.UTC(2026, 0, 15, 10, 30));
		expect(obs[0]?.sourceUrl).toBe("https://t.me/canalejemplo/101");
		expect(obs[0]?.series).toStartWith("item:");
		expect(obs[1]?.value.title).toBe("Solo una línea con enlace");
		expect(obs[1]?.value.summary).toBe("");
	});
	test("a long first line is cut at a word with an ellipsis", () => {
		const long = `${"palabra ".repeat(60)}fin`;
		const obs = parsePreview(page(post(1, long)), outlet(), FETCHED);
		const title = obs[0]?.value.title ?? "";
		expect([...title].length).toBeLessThanOrEqual(TITLE_MAX);
		expect(title).toEndWith("…");
		expect(title).not.toContain("  ");
	});
	test("posts with no text, service messages, other channels and malformed posts are skipped", () => {
		const service = `<div class="tgme_widget_message_wrap"><div class="tgme_widget_message service_message" data-post="canalejemplo/5"><div class="tgme_widget_message_text">Channel photo updated</div></div></div>`;
		const obs = parsePreview(
			page(
				post(1, null),
				service,
				post(2, "De otro canal", undefined, "otrocanal"),
				post(3, "Fecha rota", "ayer"),
				post(4, "Válida"),
			),
			outlet(),
			FETCHED,
		);
		expect(obs.map((o) => o.value.title)).toEqual(["Válida"]);
	});
	test("a post dated in the future is kept with the fetch time and marked", () => {
		const obs = parsePreview(page(post(1, "Del futuro", "2026-01-16T00:00:00+00:00")), outlet(), FETCHED);
		expect(obs[0]?.value.dateMissing).toBe(true);
		expect(obs[0]?.observedAt).toBe(FETCHED);
		expect(obs[0]?.keepFirst).toBe(true);
	});
	test("an international desk keeps only posts about Venezuela", () => {
		const obs = parsePreview(
			page(post(1, "Cumbre en Ginebra"), post(2, "Elecciones en Venezuela")),
			outlet({ onlyVenezuela: true }),
			FETCHED,
		);
		expect(obs.map((o) => o.value.title)).toEqual(["Elecciones en Venezuela"]);
	});
	test("a preview with no posts yet is empty; other pages throw SchemaError", () => {
		expect(readPreview(page())).toEqual([]);
		const landing =
			'<html><body><div class="tgme_page"><div class="tgme_page_title">Alguien</div></div></body></html>';
		expect(() => readPreview(landing)).toThrow(/no existe o no tiene vista pública/);
		expect(() => readPreview("<html><body>Just a moment…</body></html>")).toThrow(SchemaError);
	});
	test("script in a post is text, never markup", () => {
		const obs = parsePreview(page(post(1, "Hola<script>alert(1)</script> mundo")), outlet(), FETCHED);
		expect(obs[0]?.value.title).toBe("Hola mundo");
	});
});

describe("handles", () => {
	test("accepts @name, name, t.me/name, t.me/s/name, a post link, telegram.me", () => {
		for (const input of [
			"@canalejemplo",
			"canalejemplo",
			"t.me/canalejemplo",
			"https://t.me/canalejemplo",
			"https://t.me/s/canalejemplo/",
			"https://t.me/canalejemplo/123",
			"http://www.telegram.me/canalejemplo?x=1",
			"  @canalejemplo  ",
		])
			expect(telegramHandle(input)).toBe("canalejemplo");
	});
	test("refuses invite links, bad names and other hosts", () => {
		for (const input of [
			"https://t.me/+AbCdEf123",
			"https://t.me/joinchat/AAAA",
			"@a",
			"@1canal",
			"@canal_",
			"@canal-ejemplo",
			"https://example.org/canalejemplo",
			"t.me/s",
			"",
		])
			expect(telegramHandle(input)).toBeNull();
	});
	test("preview URLs round-trip; only t.me/s/<handle> is a preview", () => {
		expect(previewUrl("canalejemplo")).toBe("https://t.me/s/canalejemplo");
		expect(previewHandle("https://t.me/s/canalejemplo")).toBe("canalejemplo");
		expect(previewHandle("https://t.me/canalejemplo")).toBeNull();
		expect(previewHandle("https://evil.example/t.me/s/x")).toBeNull();
		expect(looksLikeTelegram("@x")).toBe(true);
		expect(looksLikeTelegram("t.me/x")).toBe(true);
		expect(looksLikeTelegram("https://example.org/feed")).toBe(false);
	});
});

describe("adapter", () => {
	test("polite: one queue to t.me, ≥ 15 min, 1 MB cap, no key", async () => {
		const adapter = telegramAdapter(outlet({ intervalMs: 60_000 }));
		expect(adapter.intervalMs).toBe(15 * 60_000);
		expect(adapter.keys).toEqual([]);
		expect(adapter.licence.raw).toBe(false);
		const calls: { url: string; options: RequestOptions | undefined }[] = [];
		const http = {
			request: async (url: string, options?: RequestOptions): Promise<RawResponse> => {
				calls.push({ url, options });
				return {
					url,
					status: 200,
					contentType: "text/html",
					body: page(post(1, "Hola")),
					fetchedAt: FETCHED,
				};
			},
		};
		const raws = await adapter.fetch({
			http,
			key: () => null,
			signal: new AbortController().signal,
		} as unknown as Parameters<typeof adapter.fetch>[0]);
		const seen = calls[0];
		expect(seen?.url).toBe("https://t.me/s/canalejemplo");
		expect(seen?.options?.paceKey).toBe("t.me");
		expect(seen?.options?.hostGapMs).toBeGreaterThanOrEqual(5_000);
		expect(seen?.options?.maxBytes).toBe(1024 * 1024);
		expect(adapter.normalise(raws).length).toBe(1);
	});
});
