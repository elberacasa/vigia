/**
 * Telegram public channel previews: https://t.me/s/<channel>, the HTML page Telegram serves to anyone for a public
 * channel (the newest ~20 posts, each with `data-post="<channel>/<id>"`, its text and a `<time datetime>`).
 *
 * Measured 2026-09-25 from this machine: 20–140 KB per page, 0.5–1 s; no robots.txt (404); no ETag or
 * Last-Modified (`cache-control: no-store`), so there is no conditional GET: politeness is one page per channel per
 * interval (never under 15 minutes) and one request to t.me at a time, 5 s apart. A handle that does not exist, or a
 * channel with its preview turned off, answers 302 to t.me/<channel> (a page with no posts): reported as such.
 *
 * Stored per post, like a news headline: the first line of its text (≤ 200 characters) as the title, the rest
 * (≤ 400) as the summary, the post's link t.me/<channel>/<id> and its time. Never media, views, reactions or the
 * full text. Posts with no text (a photo alone) and service messages are skipped.
 *
 * Parsing is linear (indexOf and bounded regexes over one post at a time), so a hostile page cannot stall the
 * server; each extracted post is validated with Zod before it becomes an observation.
 */
import { z } from "zod";
import type { Licence, Observation } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { stripHtml } from "../../news/text.ts";
import { itemId, mentionsVenezuela, type NewsItem, type OutletSpec } from "../rss/factory.ts";

export const TELEGRAM_LICENCE: Licence = {
	id: "telegram-preview",
	name: "Vista pública de un canal de Telegram (t.me/s): texto breve y enlace",
	url: "https://telegram.org/tos",
	attribution: "Publicaciones públicas de cada canal en Telegram; el contenido pertenece a su canal.",
	commercial: "unclear",
	// Display only, like headlines: the raw endpoints never hand out the stored post text.
	raw: false,
};

/** Telegram usernames: 5–32 characters, a letter first, letters, digits and underscores (a few old ones have 4). */
export const TELEGRAM_HANDLE = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;

export const TITLE_MAX = 200;
export const SUMMARY_MAX = 400;
const FUTURE_TOLERANCE_MS = 15 * 60_000;
/** A page is ~20 posts; never read more than this many from one page. */
const MAX_POSTS = 60;

/**
 * The channel handle in what a person types: "@canal", "canal", "t.me/canal", "https://t.me/s/canal",
 * "telegram.me/canal", "https://t.me/canal/123". Null when it is not a public channel handle (an invite link
 * "t.me/+…" or "joinchat" is private, so it is refused).
 */
export function telegramHandle(input: string): string | null {
	let s = input.trim();
	if (!s || s.length > 200) return null;
	if (s.startsWith("@")) s = s.slice(1);
	const m =
		/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/(?:s\/)?([^/?#]+)(?:\/\d+)?\/?(?:[?#].*)?$/i.exec(
			s,
		);
	const handle = m ? (m[1] ?? "") : s;
	if (!TELEGRAM_HANDLE.test(handle) || handle.endsWith("_")) return null;
	if (/^(joinchat|addstickers|share|proxy|socks|iv|s)$/i.test(handle)) return null;
	return handle;
}

/** Whether what a person typed names a Telegram channel rather than a feed URL ("@x", "t.me/x"). */
export function looksLikeTelegram(input: string): boolean {
	const s = input.trim();
	return s.startsWith("@") || /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\//i.test(s);
}

export const previewUrl = (handle: string): string => `https://t.me/s/${handle}`;

/** The handle of a preview URL (https://t.me/s/<handle>), or null for any other URL. */
export function previewHandle(url: string): string | null {
	const m = /^https:\/\/t\.me\/s\/([A-Za-z0-9_]{4,32})\/?$/.exec(url.trim());
	return m?.[1] ?? null;
}

const PostSchema = z
	.object({
		channel: z.string().regex(/^[A-Za-z0-9_]{4,32}$/),
		id: z.number().int().positive().max(1e12),
		lines: z.array(z.string()).min(1),
		datetime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/),
	})
	.strict();

export type PreviewPost = z.infer<typeof PostSchema>;

/** The channel's title as the page shows it (for a default name), or null. */
export function channelTitle(html: string): string | null {
	const head = html.slice(0, 60_000);
	const m =
		/<div class="tgme_channel_info_header_title"[^>]{0,200}>([\s\S]{0,600}?)<\/div>/.exec(head) ??
		/<meta property="og:title" content="([^"]{0,300})"/.exec(head);
	const text = m?.[1] ? stripHtml(m[1]).trim() : "";
	return text ? [...text].slice(0, 80).join("") : null;
}

/** The text block of one post, split on line breaks and stripped to plain lines. */
function textLines(segment: string): string[] {
	const start = segment.indexOf('class="tgme_widget_message_text');
	if (start === -1) return [];
	const open = segment.indexOf(">", start);
	if (open === -1) return [];
	// The text block holds inline markup only (b, i, a, br, span, tg-emoji); it ends at the first </div>.
	const end = segment.indexOf("</div>", open);
	const inner = segment.slice(open + 1, end === -1 ? undefined : end);
	return inner
		.split(/<br\s*\/?>/i)
		.map((part) => stripHtml(part))
		.filter((line) => line.length > 0);
}

/**
 * Every post on a preview page, validated. Throws SchemaError when the page is not a channel preview (the redirect
 * target of a missing or private channel, a challenge page), so the run fails loudly and the last headlines stay.
 */
export function readPreview(html: string): PreviewPost[] {
	if (!html.includes("tgme_widget_message_wrap")) {
		// A preview with its channel header but no post yet.
		if (html.includes("tgme_channel_history")) return [];
		// The plain t.me/<channel> page a 302 leads to: no such handle, a person or group, or the preview is off.
		if (html.includes("tgme_page"))
			throw new SchemaError("el canal no existe o no tiene vista pública (t.me/s)");
		throw new SchemaError("no es la vista pública de un canal de Telegram");
	}
	const out: PreviewPost[] = [];
	const parts = html.split('<div class="tgme_widget_message_wrap');
	for (const segment of parts.slice(1, MAX_POSTS + 1)) {
		if (segment.includes("service_message")) continue;
		const post = /data-post="([A-Za-z0-9_]{1,64})\/(\d{1,12})"/.exec(segment);
		const time = /<a class="tgme_widget_message_date"[^>]{0,300}><time datetime="([^"]{10,40})"/.exec(
			segment,
		);
		const parsed = PostSchema.safeParse({
			channel: post?.[1],
			id: post?.[2] ? Number(post[2]) : undefined,
			lines: textLines(segment),
			datetime: time?.[1],
		});
		if (parsed.success) out.push(parsed.data);
	}
	return out;
}

function cut(text: string, max: number): string {
	const chars = [...text];
	if (chars.length <= max) return text;
	const head = chars.slice(0, max - 1).join("");
	const space = head.lastIndexOf(" ");
	return `${(space > max * 0.6 ? head.slice(0, space) : head).trimEnd()}…`;
}

/** Posts of a channel preview as news items of `outlet` (a built-in channel or a feed the user added). */
export function parsePreview(html: string, outlet: OutletSpec, fetchedAt: number): Observation<NewsItem>[] {
	const out: Observation<NewsItem>[] = [];
	for (const post of readPreview(html)) {
		// A preview lists only its own channel's posts; anything else is not what this outlet publishes.
		const handle = previewHandle(outlet.url);
		if (handle && post.channel.toLowerCase() !== handle.toLowerCase()) continue;
		const [first = "", ...rest] = post.lines;
		const title = cut(first, TITLE_MAX);
		const summary = cut(rest.join(" "), SUMMARY_MAX);
		if (outlet.onlyVenezuela && !mentionsVenezuela(`${first} ${rest.join(" ")}`)) continue;
		const link = `https://t.me/${post.channel}/${post.id}`;
		const published = Date.parse(post.datetime);
		const dateMissing = !Number.isFinite(published) || published > fetchedAt + FUTURE_TOLERANCE_MS;
		out.push({
			source: outlet.id,
			series: `item:${itemId(link)}`,
			sourceUrl: link,
			fetchedAt,
			observedAt: dateMissing ? fetchedAt : published,
			licence: TELEGRAM_LICENCE.id,
			value: { outlet: outlet.id, title, link, summary, image: null, dateMissing, video: false },
			confidence: dateMissing ? 0.6 : 1,
			basis: "report",
			...(dateMissing ? { keepFirst: true as const } : {}),
		});
	}
	return out;
}
