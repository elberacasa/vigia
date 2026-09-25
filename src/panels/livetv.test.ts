import { expect, test } from "bun:test";
import { join } from "node:path";
import { radioStreams } from "../adapters/radio-streams/index.ts";
import { RADIO_STATIONS } from "../adapters/radio-streams/stations.ts";
import { TV_CHANNELS } from "../adapters/youtube-live/channels.ts";
import { youtubeLive } from "../adapters/youtube-live/index.ts";
import { hasFixture, loadFixture } from "../core/fixtures.ts";
import { Store } from "../core/store.ts";
import { computeLiveTv, RADIO_BUDGET_MS, TV_BUDGET_MS } from "./livetv.ts";

// Recorded responses carry third-party content, so they are absent from the public repository (see hasFixture).
const YT = join(import.meta.dir, "../adapters/youtube-live/fixtures/2026-09-24");
const RADIO = join(import.meta.dir, "../adapters/radio-streams/fixtures/2026-09-24");
const recorded = hasFixture(YT) && hasFixture(RADIO);
const yt = recorded ? youtubeLive.normalise(loadFixture(YT)) : [];
const radio = recorded ? radioStreams.normalise(loadFixture(RADIO)) : [];
const newest = Math.max(...[...yt, ...radio].map((o) => o.observedAt));

function store(withYt = true): Store {
	const s = new Store(":memory:");
	s.insert(radio);
	if (withYt) s.insert(yt);
	return s;
}

test.skipIf(!recorded)("fresh readings: 8 of 12 channels live, VOA scheduled, 5 of 5 radios on air", () => {
	const v = computeLiveTv(store(), newest + 60_000);
	expect(v.cards.length).toBe(TV_CHANNELS.length + RADIO_STATIONS.length);
	expect(v.tv).toMatchObject({ live: 8, measured: 12, total: 12 });
	expect(v.radio).toMatchObject({ live: 5, measured: 5, total: 5 });
	const vtv = v.cards.find((c) => c.id === "vtv");
	expect(vtv).toMatchObject({ state: "live", labelEs: "Medio estatal · Venezuela" });
	expect(vtv?.play).toEqual({
		type: "youtube",
		channelId: "UC_8sCVycu3FXidPNoZwOHqA",
		videoId: "AA-3AgVHw3M",
	});
	expect(v.cards.find((c) => c.id === "voa")).toMatchObject({ state: "upcoming", title: "El Mundo al Día" });
	expect(v.cards.find((c) => c.id === "televen")).toMatchObject({
		state: "off",
		detail: "no-stream",
		title: null,
	});
	expect(v.cards.find((c) => c.id === "ntn24")).toMatchObject({ state: "live", playability: "UNPLAYABLE" });
	const fya = v.cards.find((c) => c.id === "fya-nacional");
	expect(fya).toMatchObject({ state: "live", kind: "radio", latencyMs: 421 });
	expect(fya?.play).toEqual({
		type: "audio",
		url: "https://tx.feyalegrianoticias.com/listen/nacional/radio.mp3",
	});
});

test.skipIf(!recorded)("past the budget nothing is called live: radio after 15 min, TV after 45 min", () => {
	const s = store();
	const radioLate = computeLiveTv(s, newest + RADIO_BUDGET_MS + 60_000);
	expect(radioLate.radio.live).toBe(0);
	expect(radioLate.cards.find((c) => c.id === "fya-nacional")).toMatchObject({
		state: "stale",
		detail: "live",
	});
	expect(radioLate.tv.live).toBe(8);
	const tvLate = computeLiveTv(s, newest + TV_BUDGET_MS + 60_000);
	expect(tvLate.tv.live).toBe(0);
	const dw = tvLate.cards.find((c) => c.id === "dw");
	expect(dw).toMatchObject({ state: "stale", detail: "live", title: null });
	// A stale reading no longer names the video: the player falls back to the channel's own live stream.
	expect(dw?.play).toEqual({ type: "youtube", channelId: "UCT4Jg8h03dD0iN3Pb5L0PMA", videoId: null });
});

test.skipIf(!recorded)(
	"with the YouTube check off, TV is unmeasured (never off air) and still playable",
	() => {
		const v = computeLiveTv(store(false), newest);
		expect(v.tv).toMatchObject({ live: 0, measured: 0, checkedAt: null });
		for (const c of v.cards.filter((x) => x.kind === "tv")) {
			expect(c.state).toBe("unmeasured");
			expect(c.play.type).toBe("youtube");
		}
	},
);
