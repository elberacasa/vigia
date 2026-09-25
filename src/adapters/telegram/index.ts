import type { Adapter } from "../../core/types.ts";
import { HttpError, SchemaError } from "../../core/types.ts";
import { publisherOf } from "../../news/publishers.ts";
import type { NewsItem, OutletSpec } from "../rss/factory.ts";
import { parsePreview, TELEGRAM_LICENCE } from "./parse.ts";

/**
 * One adapter per public Telegram channel (src/adapters/telegram/channels.ts), read from its web preview
 * (parse.ts has what the page is and what is kept). Its posts are news items like an outlet's headlines: labelled
 * "(Telegram)", counted under their publisher, tagged by the news rules, and never a measurement.
 *
 * Politeness: every channel shares one queue to t.me (`paceKey`), 5 s apart; one page per channel per interval
 * (15 minutes at the fastest); 1 MB cap (pages measure 20–140 KB). t.me sends no validators, so there is no
 * conditional GET to make.
 */
export const TELEGRAM_HOST_GAP_MS = 5_000;
const MIN_INTERVAL_MS = 15 * 60_000;
const DAY = 86_400_000;

export function telegramAdapter(channel: OutletSpec): Adapter<NewsItem> {
	const intervalMs = Math.max(channel.intervalMs ?? 30 * 60_000, MIN_INTERVAL_MS);
	return {
		id: channel.id,
		layer: "news",
		name: { es: channel.name, en: channel.name },
		provider: publisherOf(channel.id).name,
		homepage: channel.homepage,
		licence: TELEGRAM_LICENCE,
		keys: [],
		...(channel.optIn ? { optIn: channel.optIn } : {}),
		...(channel.note ? { note: channel.note } : {}),
		intervalMs,
		// Busy channels post every few minutes; the small ones, and an international desk filtered to Venezuela, at
		// least every few days (measured).
		freshness: {
			fetchMs: 4 * intervalMs,
			dataMs: intervalMs <= 20 * 60_000 && !channel.onlyVenezuela ? DAY : 4 * DAY,
		},
		async fetch(ctx) {
			const raw = await ctx.http.request(channel.url, {
				headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" },
				maxBytes: 1024 * 1024,
				hostGapMs: TELEGRAM_HOST_GAP_MS,
				paceKey: "t.me",
				retries: 1,
				signal: ctx.signal,
			});
			if (raw.status !== 200) throw new HttpError(`respuesta ${raw.status}`, raw.status, channel.url);
			return [raw];
		},
		normalise(raws) {
			const raw = raws[0];
			if (!raw) throw new SchemaError("sin respuesta");
			return parsePreview(raw.body, channel, raw.fetchedAt);
		},
	};
}
