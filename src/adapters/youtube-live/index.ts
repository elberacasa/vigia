import { z } from "zod";
import { blobKey } from "../../core/blobs.ts";
import type { Adapter, FetchContext, Licence, Observation, RawResponse } from "../../core/types.ts";
import { HttpError, SchemaError } from "../../core/types.ts";
import { encodeJpeg } from "../../imaging/jpeg.ts";
import { crop, decodeImage, dhash, downscale, lumaStats, type Rgba } from "../../imaging/raster.ts";
import { TV_CHANNELS, type TvChannel } from "./channels.ts";

/**
 * Is each channel broadcasting live on YouTube right now? Measured without a key: every 30 minutes Vigía opens
 * each channel's public `/channel/<id>/live` page once, as a visitor's browser would, and reads two things
 * YouTube itself puts in it:
 *
 * - while a stream is on, the page is that stream's watch page, and its embedded player data
 *   (`ytInitialPlayerResponse.videoDetails`) says `isLive: true` for the channel's own id;
 * - a scheduled stream says `isUpcoming: true` (and `LIVE_STREAM_OFFLINE`): not live;
 * - with no stream, `/live` falls back to the channel page, whose canonical link is the channel itself.
 *
 * Anything else (a consent wall, a bot check, a changed page, another channel's id) is "unknown", never "off
 * air". `isLiveNow` in the microdata is NOT used: YouTube omits it from some responses (verified 2026-09-24:
 * two fetches of the same live CNN page, one with it and one without).
 *
 * Opt-in: YouTube's terms restrict automated access to the site, and each check downloads the page (~270 KB
 * compressed, ~1.2 MB of HTML), about 150 MB a day for 12 channels. Without it the cards still play (the player
 * resolves the live stream itself); only the measured state is missing, and the UI says so.
 *
 * What is stored is our own reading (state, video id, the stream's title and start time), never the page.
 *
 * Thumbnail: when a channel is live, the server also reads YouTube's live thumbnail of that video
 * (`i.ytimg.com/vi/<id>/sddefault_live.jpg`, 640 × 480, ~31 KB, `cache-control: max-age=300`; YouTube renews it
 * every few minutes and states no capture time), crops the letterbox bars, reduces it to 480 px and re-encodes it,
 * and serves it from Vigía's own origin (`/api/blobs/youtube-live/<key>`), so a card shows what the channel is
 * airing without the browser contacting YouTube. Dated by when Vigía read it, labelled "miniatura de YouTube".
 * Playing happens only in YouTube's official embedded player (youtube-nocookie.com), which YouTube's terms
 * permit for public videos whose owner allows embedding.
 */

export const YOUTUBE_LIVE_LICENCE: Licence = {
	id: "youtube-live-status",
	name: "Estado medido por Vigía en páginas públicas de YouTube; reproducción con el reproductor oficial",
	url: "https://www.youtube.com/t/terms",
	attribution: "Transmisiones: canales oficiales en YouTube",
	commercial: "unclear",
	// Titles and ids are YouTube metadata: shown in the panel, not redistributed as a raw feed.
	raw: false,
};

const SITE = "https://www.youtube.com";
export const CHECK_CONTENT_TYPE = "application/vnd.vigia.youtube-live+json";

export function livePageUrl(channelId: string): string {
	return `${SITE}/channel/${channelId}/live`;
}

/** What one check of a `/live` page found, reduced in `fetch` to the few fields that decide the state. */
export type LiveCheck = {
	readonly channel: string;
	readonly at: number;
	readonly httpStatus: number | null;
	/** Host the request ended on (a consent wall lives on consent.youtube.com). */
	readonly finalHost: string | null;
	readonly error: string | null;
	readonly canonical: string | null;
	readonly player: {
		readonly status: string | null;
		readonly reason: string | null;
		readonly videoId: string | null;
		readonly channelId: string | null;
		readonly isLive: boolean;
		readonly isUpcoming: boolean;
		readonly title: string | null;
		readonly startedAt: string | null;
	} | null;
};

/**
 * The JSON object assigned to `var ytInitialPlayerResponse = {…};`, cut by brace matching that respects
 * strings (titles contain braces and `;`). Null when the page has none.
 */
export function playerResponseJson(html: string): string | null {
	const marker = "var ytInitialPlayerResponse = ";
	const at = html.indexOf(marker);
	if (at < 0) return null;
	const start = at + marker.length;
	if (html[start] !== "{") return null;
	let depth = 0;
	let inString = false;
	for (let i = start; i < html.length; i++) {
		const c = html[i];
		if (inString) {
			if (c === "\\") i++;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') inString = true;
		else if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) return html.slice(start, i + 1);
		}
	}
	return null;
}

const PlayerResponse = z.object({
	playabilityStatus: z.object({ status: z.string().optional(), reason: z.string().optional() }).optional(),
	videoDetails: z
		.object({
			videoId: z.string().optional(),
			channelId: z.string().optional(),
			title: z.string().optional(),
			isLive: z.boolean().optional(),
			isUpcoming: z.boolean().optional(),
		})
		.optional(),
	microformat: z
		.object({
			playerMicroformatRenderer: z
				.object({
					liveBroadcastDetails: z.object({ startTimestamp: z.string().optional() }).optional(),
				})
				.optional(),
		})
		.optional(),
});

/** Pure: what a `/live` page says, reduced to a `LiveCheck` (tests replay real pages through this). */
export function readLivePage(
	html: string,
	channel: string,
	meta: { at: number; httpStatus: number | null; finalUrl: string | null },
): LiveCheck {
	const canonical = /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1] ?? null;
	let player: LiveCheck["player"] = null;
	const json = playerResponseJson(html);
	if (json !== null) {
		let parsed: unknown = null;
		try {
			parsed = JSON.parse(json);
		} catch {
			parsed = null;
		}
		const p = PlayerResponse.safeParse(parsed);
		if (p.success && p.data.videoDetails) {
			const d = p.data.videoDetails;
			player = {
				status: p.data.playabilityStatus?.status ?? null,
				reason: p.data.playabilityStatus?.reason?.slice(0, 200) ?? null,
				videoId: d.videoId ?? null,
				channelId: d.channelId ?? null,
				isLive: d.isLive === true,
				isUpcoming: d.isUpcoming === true,
				title: d.title?.slice(0, 200) ?? null,
				startedAt:
					p.data.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.startTimestamp ?? null,
			};
		}
	}
	let finalHost: string | null = null;
	try {
		finalHost = meta.finalUrl ? new URL(meta.finalUrl).hostname : null;
	} catch {
		finalHost = null;
	}
	return { channel, at: meta.at, httpStatus: meta.httpStatus, finalHost, error: null, canonical, player };
}

export type LiveState = "live" | "upcoming" | "offline" | "unknown";

export type YoutubeLive = {
	readonly channel: string;
	readonly state: LiveState;
	/** The live (or scheduled) video, when the page named one for this channel. */
	readonly videoId: string | null;
	readonly title: string | null;
	/** When the live stream started, per YouTube (epoch ms). */
	readonly startedAt: number | null;
	/** YouTube's own playability verdict from this computer ("OK", "UNPLAYABLE"…) and its reason. */
	readonly playability: string | null;
	readonly playabilityReason: string | null;
	/** Why the state is "unknown", in a short stable code. */
	readonly why: string | null;
	/** YouTube's live thumbnail as Vigía stored it (only while live): blob key, size, when it was read. */
	readonly thumb: YoutubeThumb | null;
};

export type YoutubeThumb = {
	/** GET /api/blobs/youtube-live/<key>. */
	readonly blob: string;
	readonly width: number;
	readonly height: number;
	/** When Vigía read it (YouTube gives no capture time; its thumbnail is at most a few minutes old). */
	readonly readAt: number;
	/**
	 * 64-bit difference hash. Many 24/7 channels set a fixed cover image as the live thumbnail (measured 2026-09-29:
	 * DW, France 24, VPItv): the same hash an hour apart means a cover, not a frame (panels/cardimage.ts).
	 */
	readonly hash: string;
};

const VIDEO_ID = /^[\w-]{11}$/;

/** Pure: the rule that turns one check into a state. */
export function stateOf(check: LiveCheck, expected: TvChannel): Omit<YoutubeLive, "channel" | "thumb"> {
	const none = { videoId: null, title: null, startedAt: null, playability: null, playabilityReason: null };
	if (check.error !== null) return { ...none, state: "unknown", why: check.error };
	if (check.finalHost !== null && check.finalHost !== "www.youtube.com")
		return {
			...none,
			state: "unknown",
			why: check.finalHost.startsWith("consent.") ? "consent" : "redirect",
		};
	if (check.httpStatus !== 200) return { ...none, state: "unknown", why: `http-${check.httpStatus}` };
	const p = check.player;
	if (p) {
		if (p.channelId !== expected.channelId) return { ...none, state: "unknown", why: "other-channel" };
		const videoId = p.videoId && VIDEO_ID.test(p.videoId) ? p.videoId : null;
		const started = p.startedAt ? Date.parse(p.startedAt) : Number.NaN;
		const state: LiveState = p.isUpcoming ? "upcoming" : p.isLive ? "live" : "offline";
		return {
			state,
			videoId,
			title: p.title,
			startedAt: state === "live" && Number.isFinite(started) && started <= check.at ? started : null,
			playability: p.status,
			playabilityReason: p.reason,
			why: null,
		};
	}
	if (check.canonical === `${SITE}/channel/${expected.channelId}`)
		return { ...none, state: "offline", why: null };
	return { ...none, state: "unknown", why: "unexpected-page" };
}

/** A short stable reason for a network failure (never the raw message). */
function failure(error: unknown): string {
	if (error instanceof HttpError && error.status > 0) return `http-${error.status}`;
	const text = error instanceof Error ? error.message : String(error);
	if (/timed? ?out|timeout|abort/i.test(text)) return "timeout";
	if (/exceeded|too large/i.test(text)) return "too-large";
	return "network";
}

export const THUMB_PIPELINE = "youtube-thumb/1";
const THUMB_WIDTH = 480;
const VIDEO_ID_RE = /^[\w-]{11}$/;

export function thumbUrl(videoId: string): string {
	return `https://i.ytimg.com/vi/${videoId}/sddefault_live.jpg`;
}

/**
 * Pure: YouTube's 4:3 thumbnail of a 16:9 stream has black bars above and below; crop them when they are there
 * (flat and dark), keep the picture whole otherwise, then reduce to 480 px wide.
 */
export function trimThumb(image: Rgba): Rgba {
	const bar = Math.round((image.height - (image.width * 9) / 16) / 2);
	let out = image;
	if (bar >= 4) {
		const top = lumaStats(image, { x: 0, y: 0, w: 1, h: bar / image.height });
		const bottom = lumaStats(image, { x: 0, y: 1 - bar / image.height, w: 1, h: bar / image.height });
		if (top.mean < 12 && top.sd < 6 && bottom.mean < 12 && bottom.sd < 6)
			out = crop(image, 0, bar, image.width, image.height - 2 * bar);
	}
	const width = Math.min(THUMB_WIDTH, out.width);
	return downscale(out, width, Math.round((out.height * width) / out.width));
}

/** Read, clean and store the live thumbnail of `videoId`; null when anything fails (the card then shows the logo). */
async function storeThumb(
	channel: TvChannel,
	videoId: string,
	ctx: FetchContext,
): Promise<YoutubeThumb | null> {
	return (await readThumb(`y${Bun.hash(channel.id).toString(36)}`, videoId, ctx))?.thumb ?? null;
}

async function readThumb(
	prefix: string,
	videoId: string,
	ctx: FetchContext,
): Promise<{ thumb: YoutubeThumb } | null> {
	const blobs = ctx.blobs;
	if (!blobs || !VIDEO_ID_RE.test(videoId)) return null;
	try {
		const res = await ctx.http.request(thumbUrl(videoId), {
			binary: true,
			maxBytes: 1024 * 1024,
			timeoutMs: 20_000,
			hostGapMs: 1_000,
			retries: 0,
			headers: { accept: "image/jpeg" },
			signal: ctx.signal,
		});
		const readAt = ctx.now();
		const image = trimThumb(decodeImage(new Uint8Array(Buffer.from(res.body, "base64"))));
		const jpeg = encodeJpeg(image, 72);
		const name = `${prefix}-${Math.floor(readAt / 60_000).toString(36)}`;
		const key = blobKey(name, jpeg, THUMB_PIPELINE);
		blobs.put(key, jpeg, {
			name,
			contentType: "image/jpeg",
			observedAt: readAt,
			width: image.width,
			height: image.height,
		});
		return { thumb: { blob: key, width: image.width, height: image.height, readAt, hash: dhash(image) } };
	} catch (error) {
		if (ctx.signal.aborted) throw error;
		return null;
	}
}

async function check(channel: TvChannel, ctx: FetchContext): Promise<LiveCheck> {
	const at = ctx.now();
	try {
		const res = await ctx.http.request(livePageUrl(channel.channelId), {
			headers: { accept: "text/html" },
			retries: 1,
			timeoutMs: 30_000,
			maxBytes: 6 * 1024 * 1024,
			okStatuses: [404],
			// One page every 5 s: a run of 12 channels takes about a minute.
			hostGapMs: 5_000,
			signal: ctx.signal,
		});
		return readLivePage(res.body, channel.id, { at, httpStatus: res.status, finalUrl: res.url });
	} catch (error) {
		return {
			channel: channel.id,
			at,
			httpStatus: null,
			finalHost: null,
			error: failure(error),
			canonical: null,
			player: null,
		};
	}
}

const Thumb = z.object({
	blob: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
	width: z.number().int().positive().max(THUMB_WIDTH),
	height: z.number().int().positive().max(THUMB_WIDTH),
	readAt: z.number(),
	hash: z.string().regex(/^[0-9a-f]{16}$/),
});

const Check = z.object({
	thumb: Thumb.nullable().optional(),
	channel: z.string(),
	at: z.number(),
	httpStatus: z.number().int().nullable(),
	finalHost: z.string().nullable(),
	error: z.string().nullable(),
	canonical: z.string().nullable(),
	player: z
		.object({
			status: z.string().nullable(),
			reason: z.string().nullable(),
			videoId: z.string().nullable(),
			channelId: z.string().nullable(),
			isLive: z.boolean(),
			isUpcoming: z.boolean(),
			title: z.string().nullable(),
			startedAt: z.string().nullable(),
		})
		.nullable(),
});

export const youtubeLive: Adapter<YoutubeLive> = {
	id: "youtube-live",
	layer: "news",
	name: {
		es: "TV en vivo: ¿transmite ahora? (canales oficiales en YouTube)",
		en: "Live TV: on air now? (official YouTube channels)",
	},
	provider: "YouTube (páginas públicas de cada canal), medido por Vigía",
	homepage: "https://www.youtube.com/",
	licence: YOUTUBE_LIVE_LICENCE,
	keys: [],
	intervalMs: 30 * 60_000,
	// Two missed runs make it stale; the panel itself says "EN VIVO" only within 45 min of a check.
	freshness: { fetchMs: 90 * 60_000, dataMs: 90 * 60_000 },
	// Live thumbnails for a day (the time machine): 12 channels × 48 checks × ~20 KB at most.
	blobs: { maxEntries: 800, maxBytes: 24 * 1024 * 1024, maxAgeMs: 24 * 3_600_000 },
	// On by default since 2026-09-25 by the project's decision; same 30-min interval and pacing.
	note: {
		es:
			"Cada 30 minutos Vigía abre la página pública «/live» de 12 canales de YouTube (unos 270 KB cada una, " +
			"~150 MB al día) para saber cuáles transmiten en vivo. Los términos de YouTube restringen el acceso " +
			"automatizado; Vigía la lee a ritmo bajo por decisión del proyecto. Cuando un canal transmite, lee también su " +
			"miniatura en vivo (~31 KB) y la sirve reducida desde este equipo durante un día, para la tarjeta del canal. " +
			"Apágala si prefieres ahorrar datos: los canales se pueden ver igual.",
		en:
			"Every 30 minutes Vigía opens the public “/live” page of 12 YouTube channels (about 270 KB each, ~150 MB " +
			"a day) to learn which are live. YouTube's terms restrict automated access; Vigía reads it at a low rate " +
			"by the project's decision. When a channel is live it also reads its live thumbnail (~31 KB) and serves it, " +
			"reduced, from this computer for a day, for the channel's card. Turn it off to save data: the channels still play.",
	},

	async fetch(ctx) {
		const out: RawResponse[] = [];
		for (const channel of TV_CHANNELS) {
			if (ctx.signal.aborted) break;
			const record = await check(channel, ctx);
			const state = stateOf(record, channel);
			const thumb =
				state.state === "live" && state.videoId ? await storeThumb(channel, state.videoId, ctx) : null;
			out.push({
				url: livePageUrl(channel.channelId),
				status: 200,
				contentType: CHECK_CONTENT_TYPE,
				body: JSON.stringify({ ...record, thumb }),
				fetchedAt: ctx.now(),
			});
		}
		return out;
	},

	normalise(raws) {
		const out: Observation<YoutubeLive>[] = [];
		for (const raw of raws) {
			if (raw.contentType !== CHECK_CONTENT_TYPE) continue;
			let json: unknown;
			try {
				json = JSON.parse(raw.body);
			} catch {
				continue;
			}
			const parsed = Check.safeParse(json);
			if (!parsed.success) continue;
			const c = parsed.data as LiveCheck;
			const channel = TV_CHANNELS.find((x) => x.id === c.channel);
			if (!channel) continue;
			const state = stateOf(c, channel);
			// A thumbnail is kept only with the live reading it was taken for.
			const thumb = state.state === "live" ? (parsed.data.thumb ?? null) : null;
			const value: YoutubeLive = { channel: channel.id, ...state, thumb };
			out.push({
				source: "youtube-live",
				series: `yt:${channel.id}`,
				sourceUrl:
					value.state === "live" && value.videoId
						? `${SITE}/watch?v=${value.videoId}`
						: livePageUrl(channel.channelId),
				fetchedAt: raw.fetchedAt,
				observedAt: Math.min(c.at, raw.fetchedAt),
				licence: YOUTUBE_LIVE_LICENCE.id,
				value,
				// Our reading of YouTube's own flags; "unknown" says so instead of guessing.
				confidence: value.state === "unknown" ? 0 : 0.95,
				basis: "measurement",
			});
		}
		if (raws.length > 0 && out.length === 0) throw new SchemaError("YouTube en vivo: ningún registro válido");
		return out;
	},
};
