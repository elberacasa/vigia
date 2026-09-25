/* Pure helpers for the "En vivo: TV y radio" panel (web/src/panels/LiveTv.tsx). */

const YT_ID = /^[\w-]{11}$/;
/** Channels decorate titles with "🔴" and the like; the state is ours to show, so pictographs are dropped. */
const PICTOGRAPHS = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\uFE0F\u200D]/gu;

export function plainTitle(title: string): string {
	return title.replace(PICTOGRAPHS, "").replace(/\s+/g, " ").trim();
}
const YT_CHANNEL = /^UC[\w-]{22}$/;

/**
 * The official embedded player, cookie-less domain; a named live video, or the channel's current live stream.
 * `apiOrigin` turns on the player's message API (the 2×2 wall uses it to keep one tile audible at a time).
 */
export function embedUrl(
	play: { channelId: string; videoId: string | null },
	mute: boolean,
	apiOrigin?: string,
): string | null {
	const q = new URLSearchParams({ autoplay: "1", rel: "0", playsinline: "1" });
	if (mute) q.set("mute", "1");
	if (apiOrigin) {
		q.set("enablejsapi", "1");
		q.set("origin", apiOrigin);
	}
	if (play.videoId && YT_ID.test(play.videoId))
		return `https://www.youtube-nocookie.com/embed/${play.videoId}?${q}`;
	if (!YT_CHANNEL.test(play.channelId)) return null;
	q.set("channel", play.channelId);
	return `https://www.youtube-nocookie.com/embed/live_stream?${q}`;
}

export const PLAYER_ORIGIN = "https://www.youtube-nocookie.com";

/**
 * Whether the player reports sound on, from one of its "infoDelivery" messages (a JSON string); null when the
 * message says nothing about sound (most do not). Muted, or volume 0, is silent.
 */
export function playerAudible(data: unknown): boolean | null {
	if (typeof data !== "string" || data.length > 100_000) return null;
	let msg: unknown;
	try {
		msg = JSON.parse(data);
	} catch {
		return null;
	}
	if (typeof msg !== "object" || msg === null) return null;
	const { event, info } = msg as { event?: unknown; info?: unknown };
	if (event !== "infoDelivery" || typeof info !== "object" || info === null) return null;
	const { muted, volume } = info as { muted?: unknown; volume?: unknown };
	if (typeof muted !== "boolean" && typeof volume !== "number") return null;
	return muted !== true && (typeof volume !== "number" || volume > 0);
}

/** The commands the wall sends: start listening, and mute. */
export const PLAYER_LISTEN = (id: number) => JSON.stringify({ event: "listening", id, channel: "widget" });
export const PLAYER_MUTE = JSON.stringify({ event: "command", func: "mute", args: [] });
