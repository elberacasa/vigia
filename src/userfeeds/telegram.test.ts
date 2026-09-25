import { describe, expect, test } from "bun:test";
import type { OutletSpec } from "../adapters/rss/factory.ts";
import { type Resolver, SafeHttp } from "./net.ts";
import type { UserFeed } from "./schema.ts";
import { UserFeeds, userFeedAdapter } from "./service.ts";

/** Synthetic t.me/s page for an invented channel; recorded pages stay out of the repository. */
const PREVIEW = `<!DOCTYPE html><html><head><meta property="og:title" content="Canal Ejemplo"></head><body>
<div class="tgme_channel_info"><div class="tgme_channel_info_header_title"><span dir="auto">Canal Ejemplo</span></div></div>
<section class="tgme_channel_history">
<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="CanalEjemplo/7">
<div class="tgme_widget_message_text js-message_text">Corte de luz en Maracaibo<br/>Detalle del reporte.</div>
<a class="tgme_widget_message_date" href="https://t.me/CanalEjemplo/7"><time datetime="2026-09-24T16:00:00+00:00" class="time">16:00</time></a>
</div></div></section></body></html>`;
const LANDING = `<html><body><div class="tgme_page"><div class="tgme_page_title">Alguien</div></div></body></html>`;

const NOW = Date.UTC(2026, 8, 24, 18);
const builtin: OutletSpec = {
	id: "tg-el-pitazo",
	name: "El Pitazo (Telegram)",
	url: "https://t.me/s/elpitazo",
	kind: "telegram",
	region: "national",
	stance: "independent",
	homepage: "https://t.me/elpitazo",
};

function setup(
	pages: Record<string, { status: number; body: string; location?: string }>,
	tme = "149.154.167.99",
) {
	const calls: string[] = [];
	const resolve: Resolver = async (host) => (host === "t.me" ? [tme] : []);
	const fetchImpl = (async (input: string | URL | Request) => {
		const url = new URL(String(input));
		calls.push(url.pathname);
		const page = pages[url.pathname] ?? { status: 404, body: "" };
		return new Response(page.body, {
			status: page.status,
			headers: { "content-type": "text/html", ...(page.location ? { location: page.location } : {}) },
		});
	}) as typeof fetch;
	let list: UserFeed[] = [];
	const store = {
		list: () => list,
		save: (next: readonly UserFeed[]) => {
			list = [...next];
		},
	};
	const feeds = new UserFeeds(store, new SafeHttp({ fetchImpl, resolve, hostGapMs: 0 }), () => NOW, [
		builtin,
	]);
	return { feeds, calls, store };
}

describe("a Telegram channel in Mis fuentes", () => {
	test("@name becomes its preview address, is read once, named from the channel, and labelled", async () => {
		const { feeds, calls } = setup({ "/s/canalejemplo": { status: 200, body: PREVIEW } });
		const r = await feeds.add({ url: "@CanalEjemplo" });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.feed.url).toBe("https://t.me/s/canalejemplo");
		expect(r.feed.name).toBe("Canal Ejemplo");
		expect(r.preview).toEqual({ items: 1, newestAt: Date.UTC(2026, 8, 24, 16), title: "Canal Ejemplo" });
		expect(calls).toEqual(["/s/canalejemplo"]);
		const adapter = userFeedAdapter(r.feed, new SafeHttp());
		expect(adapter.name.es).toBe("Canal Ejemplo (Telegram, añadida por ti)");
		expect(adapter.licence.id).toBe("telegram-preview");
		const obs = adapter.normalise([
			{ url: r.feed.url, status: 200, contentType: "text/html", body: PREVIEW, fetchedAt: NOW },
		]);
		expect(obs[0]?.value.link).toBe("https://t.me/CanalEjemplo/7");
		expect(feeds.meta(r.feed).publisher).toBe("t.me/canalejemplo");
	});
	test("t.me/name, t.me/s/name and a post link all name the same channel; a second add is refused", async () => {
		const { feeds } = setup({ "/s/canalejemplo": { status: 200, body: PREVIEW } });
		expect((await feeds.add({ url: "https://t.me/CanalEjemplo/7" })).ok).toBe(true);
		const again = await feeds.add({ url: "t.me/s/canalejemplo" });
		expect(again).toMatchObject({ ok: false, status: 409 });
	});
	test("a channel Vigía already reads is refused with its name", async () => {
		const { feeds, calls } = setup({});
		const r = await feeds.add({ url: "@ElPitazo" });
		expect(r).toEqual({ ok: false, status: 409, reason: "Vigía ya sigue ese canal: El Pitazo (Telegram)." });
		expect(calls).toEqual([]);
	});
	test("invite links and bad handles are refused before any request", async () => {
		const { feeds, calls } = setup({});
		for (const url of ["https://t.me/+AbCdEf", "t.me/joinchat/xyz", "@ab", "@canal-ejemplo"])
			expect(await feeds.add({ url })).toMatchObject({ ok: false, status: 400 });
		expect(calls).toEqual([]);
	});
	test("a missing channel or one without a public preview (302 to t.me/name) is explained, and nothing is saved", async () => {
		const { feeds, store } = setup({
			"/s/nadieaqui": { status: 302, body: "", location: "https://t.me/nadieaqui" },
			"/nadieaqui": { status: 200, body: LANDING },
		});
		const r = await feeds.add({ url: "@nadieaqui" });
		expect(r).toMatchObject({ ok: false, status: 422 });
		if (!r.ok) expect(r.reason).toContain("no existe o no tiene vista pública");
		expect(store.list()).toEqual([]);
	});
	test("the SSRF checks still apply: t.me resolving to a private address is refused", async () => {
		const { feeds, calls } = setup({ "/s/canalejemplo": { status: 200, body: PREVIEW } }, "10.0.0.5");
		const r = await feeds.add({ url: "@canalejemplo" });
		expect(r).toMatchObject({ ok: false, status: 422 });
		expect(calls).toEqual([]);
	});
	test("two channels are two publishers (they share the host t.me)", async () => {
		const second = PREVIEW.replaceAll("CanalEjemplo", "OtroCanal").replaceAll("Canal Ejemplo", "Otro Canal");
		const { feeds } = setup({
			"/s/canalejemplo": { status: 200, body: PREVIEW },
			"/s/otrocanal": { status: 200, body: second },
		});
		expect((await feeds.add({ url: "@canalejemplo" })).ok).toBe(true);
		expect((await feeds.add({ url: "@otrocanal" })).ok).toBe(true);
		expect(feeds.outlets().map((o) => o.publisher ?? o.id)).toEqual(feeds.list().map((f) => f.id));
		expect(feeds.outlets().every((o) => o.kind === "telegram")).toBe(true);
	});
});
