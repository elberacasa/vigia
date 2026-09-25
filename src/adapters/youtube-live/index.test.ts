import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasFixture, loadFixture } from "../../core/fixtures.ts";
import type { FetchContext, HttpLike, RawResponse } from "../../core/types.ts";
import { HttpError } from "../../core/types.ts";
import { TV_CHANNELS } from "./channels.ts";
import {
	CHECK_CONTENT_TYPE,
	type LiveCheck,
	livePageUrl,
	playerResponseJson,
	readLivePage,
	stateOf,
	type YoutubeLive,
	youtubeLive,
} from "./index.ts";

// Recorded 2026-09-24 ~20:59 UTC: one check of each of the 12 channels' /live page.
// Recorded responses carry third-party content, so they are absent from the public repository (see hasFixture).
const FIXTURE = join(import.meta.dir, "fixtures", "2026-09-24");
const recorded = hasFixture(FIXTURE);
const raws = recorded ? loadFixture(FIXTURE) : [];
const page = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "pages", name), "utf8");
const channel = (id: string) => {
	const c = TV_CHANNELS.find((x) => x.id === id);
	if (!c) throw new Error(id);
	return c;
};
const meta = { at: Date.UTC(2026, 8, 24, 21), httpStatus: 200, finalUrl: "https://www.youtube.com/x/live" };

test.skipIf(!recorded)("replays the recorded run: 8 live, 1 scheduled, 3 without a stream", () => {
	const obs = youtubeLive.normalise(raws);
	expect(obs.length).toBe(12);
	const by = new Map(obs.map((o) => [o.value.channel, o.value]));
	const states = [...by.values()].map((v) => v.state);
	expect(states.filter((s) => s === "live").length).toBe(8);
	expect(by.get("venevision")?.state).toBe("offline");
	expect(by.get("voa")?.state).toBe("upcoming");
	expect(by.get("evtv")?.state).toBe("offline");
	expect(by.get("televen")?.state).toBe("offline");
	expect(by.get("vtv")).toMatchObject({ state: "live", videoId: "AA-3AgVHw3M", playability: "OK" });
	// Live per YouTube, but its player says unplayable from this computer: kept, and said.
	expect(by.get("ntn24")).toMatchObject({ state: "live", playability: "UNPLAYABLE" });
	for (const o of obs) {
		expect(o.source).toBe("youtube-live");
		expect(o.series).toBe(`yt:${o.value.channel}`);
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(new URL(o.sourceUrl).host).toBe("www.youtube.com");
		if (o.value.state === "live")
			expect(o.sourceUrl).toBe(`https://www.youtube.com/watch?v=${o.value.videoId}`);
	}
});

test.skipIf(!recorded)("reads real page excerpts: live, scheduled, no stream", () => {
	const dw = readLivePage(page("dw-live.html"), "dw", meta);
	expect(stateOf(dw, channel("dw"))).toMatchObject({
		state: "live",
		videoId: "yZh3xsFqCt8",
		startedAt: Date.parse("2026-04-28T18:12:42+00:00"),
	});
	const voa = readLivePage(page("voa-upcoming.html"), "voa", meta);
	expect(stateOf(voa, channel("voa"))).toMatchObject({
		state: "upcoming",
		playability: "LIVE_STREAM_OFFLINE",
	});
	const televen = readLivePage(page("televen-offline.html"), "televen", meta);
	expect(televen.player).toBeNull();
	expect(stateOf(televen, channel("televen")).state).toBe("offline");
	const ntn = readLivePage(page("ntn24-live-unplayable.html"), "ntn24", meta);
	expect(stateOf(ntn, channel("ntn24"))).toMatchObject({
		state: "live",
		playabilityReason: "Video unavailable",
	});
});

test.skipIf(!recorded)(
	"a page for another channel, a consent wall or a changed page is unknown, never off air",
	() => {
		const dw = readLivePage(page("dw-live.html"), "cnnee", meta);
		expect(stateOf(dw, channel("cnnee"))).toMatchObject({ state: "unknown", why: "other-channel" });
		const consent = readLivePage("<html>consent</html>", "dw", {
			...meta,
			finalUrl: "https://consent.youtube.com/m?continue=x",
		});
		expect(stateOf(consent, channel("dw"))).toMatchObject({ state: "unknown", why: "consent" });
		const changed = readLivePage("<html><body>new layout</body></html>", "dw", meta);
		expect(stateOf(changed, channel("dw"))).toMatchObject({ state: "unknown", why: "unexpected-page" });
		const missing = readLivePage("", "dw", { ...meta, httpStatus: 404 });
		expect(stateOf(missing, channel("dw"))).toMatchObject({ state: "unknown", why: "http-404" });
	},
);

test("brace matching survives braces and quotes inside titles", () => {
	const html = `x var ytInitialPlayerResponse = {"videoDetails":{"title":"a } \\" { b;","isLive":true}};var y = 1;`;
	expect(JSON.parse(playerResponseJson(html) ?? "null")).toEqual({
		videoDetails: { title: 'a } " { b;', isLive: true },
	});
	expect(playerResponseJson("no player here")).toBeNull();
	expect(playerResponseJson('var ytInitialPlayerResponse = {"a":')).toBeNull();
});

test("a live start time in the future is dropped (clock skew)", () => {
	const c: LiveCheck = {
		channel: "dw",
		at: 1_000,
		httpStatus: 200,
		finalHost: "www.youtube.com",
		error: null,
		canonical: null,
		player: {
			status: "OK",
			reason: null,
			videoId: "yZh3xsFqCt8",
			channelId: channel("dw").channelId,
			isLive: true,
			isUpcoming: false,
			title: "t",
			startedAt: "2099-01-01T00:00:00Z",
		},
	};
	expect(stateOf(c, channel("dw")).startedAt).toBeNull();
});

test.skipIf(!recorded)("bad records are skipped; a run with none valid fails loudly", () => {
	const good = raws[0] as RawResponse;
	const obs = youtubeLive.normalise([good, { ...good, body: "{" }, { ...good, body: '{"channel":"x"}' }]);
	expect(obs.length).toBe(1);
	expect(() => youtubeLive.normalise([{ ...good, body: "{" }])).toThrow("ningún registro");
});

test("fetch asks each channel's /live page once and turns a failure into an unknown record", async () => {
	const asked: string[] = [];
	const http: HttpLike = {
		async request(url) {
			asked.push(url);
			if (url.includes(channel("dw").channelId))
				throw new HttpError("HTTP 429 from www.youtube.com", 429, url);
			return {
				url,
				status: 200,
				contentType: "text/html",
				body: '<link rel="canonical" href="https://www.youtube.com/channel/none">',
				fetchedAt: 5,
			};
		},
	};
	const ctx: FetchContext = {
		http,
		key: () => undefined,
		now: () => 5,
		signal: new AbortController().signal,
	};
	const out = await youtubeLive.fetch(ctx);
	expect(asked).toEqual(TV_CHANNELS.map((c) => livePageUrl(c.channelId)));
	expect(out.every((r) => r.contentType === CHECK_CONTENT_TYPE)).toBe(true);
	const obs = youtubeLive.normalise(out);
	const dw = obs.find((o) => o.value.channel === "dw")?.value as YoutubeLive;
	expect(dw).toMatchObject({ state: "unknown", why: "http-429" });
});

test("the catalogue: unique ids and channel ids, every state medium labelled", () => {
	expect(new Set(TV_CHANNELS.map((c) => c.id)).size).toBe(TV_CHANNELS.length);
	expect(new Set(TV_CHANNELS.map((c) => c.channelId)).size).toBe(TV_CHANNELS.length);
	for (const c of TV_CHANNELS) expect(c.channelId).toMatch(/^UC[\w-]{22}$/);
	expect(channel("vtv").ownership).toBe("state");
	expect(channel("telesur").ownership).toBe("state-funded");
	// On by default (2026-09-25), with a note the user can act on; same 30-min interval as before.
	expect(youtubeLive.optIn).toBeUndefined();
	expect(youtubeLive.note?.es).toContain("por decisión del proyecto");
	expect(youtubeLive.intervalMs).toBe(30 * 60_000);
});
