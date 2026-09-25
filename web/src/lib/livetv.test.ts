import { expect, test } from "bun:test";
import { embedUrl, plainTitle, playerAudible } from "./livetv.ts";

test("embeds only the cookie-less official player: a named live video, else the channel's live stream", () => {
	expect(embedUrl({ channelId: "UCT4Jg8h03dD0iN3Pb5L0PMA", videoId: "yZh3xsFqCt8" }, false)).toBe(
		"https://www.youtube-nocookie.com/embed/yZh3xsFqCt8?autoplay=1&rel=0&playsinline=1",
	);
	expect(embedUrl({ channelId: "UCT4Jg8h03dD0iN3Pb5L0PMA", videoId: null }, true)).toBe(
		"https://www.youtube-nocookie.com/embed/live_stream?autoplay=1&rel=0&playsinline=1&mute=1&channel=UCT4Jg8h03dD0iN3Pb5L0PMA",
	);
	// Anything that is not a YouTube id never reaches the iframe.
	expect(embedUrl({ channelId: "UCT4Jg8h03dD0iN3Pb5L0PMA", videoId: "../x?y=1" }, false)).toContain(
		"live_stream",
	);
	expect(embedUrl({ channelId: "javascript:alert(1)", videoId: null }, false)).toBeNull();
});

test("titles lose the channels' own 🔴 badges; the live state is ours to show", () => {
	expect(plainTitle("🔴 DW Español | En vivo")).toBe("DW Español | En vivo");
	expect(plainTitle("🔴EN VIVO teleSUR 24/7 — Última Hora")).toBe("EN VIVO teleSUR 24/7 — Última Hora");
	expect(plainTitle("Globovisión en vivo TV | Señal Digital")).toBe("Globovisión en vivo TV | Señal Digital");
});

test("review 4 L13: the wall's players report sound through the message API; anything else is ignored", () => {
	expect(
		embedUrl({ channelId: "UCT4Jg8h03dD0iN3Pb5L0PMA", videoId: null }, true, "http://localhost:7722"),
	).toBe(
		"https://www.youtube-nocookie.com/embed/live_stream?autoplay=1&rel=0&playsinline=1&mute=1&enablejsapi=1&origin=http%3A%2F%2Flocalhost%3A7722&channel=UCT4Jg8h03dD0iN3Pb5L0PMA",
	);
	const info = (i: object) => JSON.stringify({ event: "infoDelivery", info: i });
	expect(playerAudible(info({ muted: false, volume: 100 }))).toBe(true);
	expect(playerAudible(info({ muted: true, volume: 100 }))).toBe(false);
	expect(playerAudible(info({ muted: false, volume: 0 }))).toBe(false);
	expect(playerAudible(info({ currentTime: 12 }))).toBeNull();
	expect(playerAudible(JSON.stringify({ event: "onReady" }))).toBeNull();
	expect(playerAudible("not json")).toBeNull();
	expect(playerAudible({ event: "infoDelivery" })).toBeNull();
});
