import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { FetchContext, HttpLike, RawResponse, RequestOptions } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { useResolver } from "../../media/public-host.ts";
import { buildCatalog, type IptvEntry } from "./catalog.ts";
import { channelPage, iptvVe, iptvVeProbe, PROBE_CONTENT_TYPE } from "./index.ts";

// Probes check every host is public (src/media/public-host.ts): answered here without the network.
useResolver(async () => ["93.184.215.14"]);

// Recorded 2026-09-28 ~00:30 UTC from iptv-org.github.io/api and cut by scripts/media/iptv-subset.ts to the rows the
// directory reads (the script checks that the cut classifies exactly like the full 20 MB list). Public domain.
const LIST = loadFixture(join(import.meta.dir, "fixtures", "2026-09-28"));
// A probe round of the 68 "on" streams, 2026-09-28 ~00:32 UTC: our own measurement (CC0).
const PROBE = loadFixture(join(import.meta.dir, "fixtures", "probe-2026-09-28"));

const list = iptvVe.normalise(LIST);
const byChannel = (id: string) => list.filter((o) => o.value.channel === id).map((o) => o.value);
const one = (id: string) => byChannel(id)[0] as IptvEntry;

describe("iptv-ve: the directory", () => {
	test("130 streams concern Venezuela; 68 on, the rest excluded with a reason", () => {
		expect(list).toHaveLength(130);
		const count: Record<string, number> = {};
		for (const o of list) count[o.value.reason ?? "on"] = (count[o.value.reason ?? "on"] ?? 0) + 1;
		expect(count).toEqual({ on: 68, "foreign-pay": 46, "relay-host": 9, "pay-ve": 5, spoofed: 2 });
		for (const o of list) {
			expect(o.source).toBe("iptv-ve");
			expect(o.series).toBe(`iptv:${o.value.key}`);
			expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
			expect(o.sourceUrl).toStartWith("https://iptv-org.github.io/channels/");
			expect((o.value.status === "on") === (o.value.reason === null)).toBe(true);
		}
		expect(new Set(list.map((o) => o.series)).size).toBe(130);
	});

	test("pay channels and head-end relays are out, with the reason", () => {
		for (const v of byChannel("DisneyChannelLatinAmerica.ar")) expect(v.reason).toBe("foreign-pay");
		expect(one("VePlus.ve")).toMatchObject({ status: "excluded", reason: "pay-ve" });
		expect(one("VePlus.ve").reasonDetail).toContain("suscripción");
		// Globovisión is only listed through a server that also relays AXN and Disney Channel.
		expect(byChannel("Globovision.ve")).toEqual([
			expect.objectContaining({ reason: "relay-host", reasonDetail: "181.78.8.199:8000" }),
		]);
		// teleSUR via a Peruvian IPTV operator that also carries Star Channel: a relay, whatever the hostname.
		const telesur = byChannel("Telesur.ve");
		expect(telesur.find((v) => v.url.includes("iptvperu"))?.reason).toBe("relay-host");
		expect(
			telesur.filter((v) => v.status === "on").every((v) => v.url.includes("telesur.ultrabase.net")),
		).toBe(true);
		// A stream that needs a spoofed Referer is not played.
		expect(one("CanalCdelZulia.ve").reason).toBe("spoofed");
		// A single-channel bare IP (TeleAragua's own server) is not a relay.
		expect(one("TeleAragua.ve")).toMatchObject({ status: "on", https: false, states: ["VE-D"] });
		// Venevisión's own CDN stream is on.
		expect(byChannel("Venevision.ve").find((v) => v.status === "on")?.url).toContain("immergo.tv");
	});

	test("state media labelled; owner names never stored", () => {
		expect(new Set(byChannel("Telesur.ve").map((v) => v.ownership))).toEqual(new Set(["state-funded"]));
		expect(one("ANTV.ve").ownership).toBe("state");
		expect(one("Globovision.ve").ownership).toBe("other");
		const text = JSON.stringify(list.map((o) => o.value));
		expect(text).not.toContain('"owners"');
		expect(text).not.toMatch(/Gorrin|Cordero|Ruperti|Hilos/);
	});

	test("regions: iptv-org's areas first (state or city), Vigía's table otherwise", () => {
		expect(one("LaraenRedes.ve")).toMatchObject({ states: ["VE-K"], statesFrom: "iptv-org" });
		expect(one("TVS.ve")).toMatchObject({ states: ["VE-D"], statesFrom: "iptv-org" }); // ct/VEMYC, Maracay
		expect(one("TRT.ve")).toMatchObject({ states: ["VE-S"], statesFrom: "vigia" });
		expect(one("CanalI.ve")).toMatchObject({ states: [], statesFrom: null });
	});

	test("a 304 on every file stores nothing; a missing file or a broken envelope fails loudly", () => {
		expect(
			iptvVe.normalise([{ url: "x/streams.json", status: 304, contentType: "", body: "", fetchedAt: 1 }]),
		).toEqual([]);
		expect(() => iptvVe.normalise(LIST.slice(0, 3))).toThrow(SchemaError);
		const files = { channels: "[]", feeds: "[]", streams: "[]", blocklist: "[]" };
		expect(() => buildCatalog(files)).toThrow(SchemaError);
		expect(() => buildCatalog({ ...files, channels: "<html>" })).toThrow(SchemaError);
	});

	test("synthetic list: rule order, a malformed row skipped, a duplicate URL kept once", () => {
		const ch = (id: string, extra: Record<string, unknown> = {}) => ({
			id,
			name: id,
			owners: [],
			country: id.endsWith(".ve") ? "VE" : "US",
			categories: ["general"],
			is_nsfw: false,
			closed: null,
			replaced_by: null,
			website: null,
			...extra,
		});
		const pad = Array.from({ length: 100 }, (_, i) => ch(`Pad${i}.xx`, { country: "XX" }));
		const channels = [
			...pad,
			ch("Uno.ve"),
			ch("Cerrado.ve", { closed: "2020-01-01" }),
			ch("Adulto.ve", { is_nsfw: true }),
			ch("Reclamo.ve"),
			ch("Cable.us"),
			{ id: 7 },
		];
		const feeds = [
			...pad.map((c) => ({
				channel: c.id,
				id: "SD",
				is_main: true,
				broadcast_area: ["c/XX"],
				languages: [],
			})),
			{ channel: "Cable.us", id: "LA", is_main: true, broadcast_area: ["c/VE", "c/CO"], languages: [] },
		];
		const s = (channel: string, url: string, extra: Record<string, unknown> = {}) => ({
			channel,
			feed: null,
			title: channel,
			url,
			quality: null,
			labels: [],
			user_agent: null,
			referrer: null,
			...extra,
		});
		const streams = [
			...pad.map((c, i) => s(c.id, `https://pad${i}.example/p.m3u8`)),
			s("Uno.ve", "https://uno.example/live.m3u8", { labels: ["Not 24/7"] }),
			s("Uno.ve", "https://uno.example/live.m3u8"),
			s("Cerrado.ve", "https://c.example/a.m3u8"),
			s("Adulto.ve", "https://a.example/a.m3u8"),
			s("Reclamo.ve", "https://r.example/a.m3u8"),
			s("Cable.us", "https://relay.example/cable.m3u8"),
			{ channel: "Uno.ve" },
		];
		const blocklist = [{ channel: "Reclamo.ve", reason: "dmca" }];
		const cat = buildCatalog({
			channels: JSON.stringify(channels),
			feeds: JSON.stringify(feeds),
			streams: JSON.stringify(streams),
			blocklist: JSON.stringify(blocklist),
		});
		expect(cat.entries.map((e) => [e.channel, e.reason, e.notAlways])).toEqual([
			["Adulto.ve", "nsfw", false],
			["Cable.us", "foreign-pay", false],
			["Cerrado.ve", "closed", false],
			["Reclamo.ve", "dmca", false],
			["Uno.ve", null, true],
		]);
	});

	test("channel pages on iptv-org's site", () => {
		expect(channelPage("VenezolanadeTelevision.ve")).toBe(
			"https://iptv-org.github.io/channels/ve/VenezolanadeTelevision",
		);
	});
});

describe("iptv-ve-probe: live now", () => {
	const obs = iptvVeProbe.normalise(PROBE);
	const reading = (id: string) => obs.find((o) => o.value.channel === id)?.value;

	test("replays the recorded round: 38 of 68 live, 123 KB read", () => {
		expect(obs).toHaveLength(68);
		expect(obs.filter((o) => o.value.state === "live")).toHaveLength(38);
		expect(obs.reduce((n, o) => n + o.value.bytes, 0)).toBe(122_848);
		for (const o of obs) {
			expect(o.source).toBe("iptv-ve-probe");
			expect(o.series).toStartWith("tv:");
			expect(o.basis).toBe("measurement");
			expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
			expect(o.sourceUrl).toMatch(/^https?:\/\//);
		}
		// Every probed stream is one the directory had on.
		const on = new Set(list.filter((o) => o.value.status === "on").map((o) => o.value.key));
		for (const o of obs) expect(on.has(o.value.key)).toBe(true);
	});

	test("exact readings", () => {
		expect(reading("CanalI.ve")).toMatchObject({
			state: "live",
			segmentKind: "fmp4",
			cors: true,
			https: true,
		});
		// Its segments come from another host that sends no CORS header: live, but hls.js cannot play it in the page.
		expect(reading("VenevisionInternacional.ve")).toMatchObject({
			state: "live",
			cors: false,
			origins: ["https://venevision.vod.immergo.tv", "https://vod2live.univtec.com"],
		});
		expect(reading("AnzoateguiTV.ve")).toMatchObject({ state: "not-live", reason: "http-404" });
	});

	test("a malformed record is skipped; nothing valid fails the run", () => {
		const bad: RawResponse = {
			url: "https://x",
			status: 200,
			contentType: PROBE_CONTENT_TYPE,
			body: "{}",
			fetchedAt: 1,
		};
		expect(iptvVeProbe.normalise([...PROBE, bad])).toHaveLength(68);
		expect(() => iptvVeProbe.normalise([bad])).toThrow(SchemaError);
	});

	test("fetch: probes only the 'on' streams through the shared client, reading a few KB each", async () => {
		const requested: { url: string; options: RequestOptions | undefined }[] = [];
		const listBodies = new Map(LIST.map((r) => [r.url, r.body]));
		const http: HttpLike = {
			async request(url, options) {
				requested.push({ url, options });
				const body = listBodies.get(url);
				if (body !== undefined)
					return { url, status: 200, contentType: "application/json", body, fetchedAt: 5 };
				return {
					url,
					status: 200,
					contentType: "text/html",
					body: "<html>nope</html>",
					fetchedAt: 5,
					headers: {},
				};
			},
		};
		const ctx: FetchContext = {
			http,
			key: () => undefined,
			now: () => 10,
			signal: new AbortController().signal,
		};
		const raws = await iptvVeProbe.fetch(ctx);
		expect(raws).toHaveLength(68);
		const probes = requested.filter((r) => !listBodies.has(r.url));
		expect(probes).toHaveLength(68);
		for (const p of probes) {
			expect(p.options?.readBytes).toBeLessThanOrEqual(256 * 1024);
			expect(p.options?.retries).toBe(0);
		}
		expect(
			iptvVeProbe
				.normalise(raws)
				.every((o) => o.value.state === "not-live" && o.value.reason === "not-playlist"),
		).toBe(true);
	});
});
