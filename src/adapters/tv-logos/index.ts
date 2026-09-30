import { z } from "zod";
import { blobKey } from "../../core/blobs.ts";
import type { Adapter, FetchContext, Observation, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { decodeImage, downscale, encodePng, fitWithin, sniffImage } from "../../imaging/raster.ts";
import { reasonOf } from "../../media/grab.ts";
import { pool } from "../../media/probe.ts";
import { publicRequest } from "../../media/public-host.ts";
import { channelPage, IPTV_LICENCE, loadCatalog } from "../iptv-ve/index.ts";
import { TV_CHANNELS } from "../youtube-live/channels.ts";

/**
 * Channel logos, the image a TV card shows when it has no recent frame ("sin cuadro reciente"), so a card never
 * looks broken. From iptv-org's public `logos.json` (public domain list; each logo belongs to its channel), for the
 * channels in the TV directory and the curated YouTube channels that iptv-org also lists.
 *
 * Every logo is downloaded once by the server (from wherever iptv-org points: imgur, Wikimedia, a channel's own
 * site…), decoded, reduced to fit 256 × 144 and re-encoded as PNG by Vigía, then served from Vigía's own origin
 * (`/api/blobs/tv-logos/<key>`): no remote bytes reach the browser, and the browser never contacts those hosts.
 * PNG and JPEG only (measured 2026-09-29: the 61 logos of the directory's 60 channels are 41 PNG and 20 JPEG).
 *
 * logos.json: 5.7 MB (0.83 MB gzip), ETag and Last-Modified, rebuilt daily with the rest of iptv-org's API. Read
 * once a day with validators; a logo already stored (same URL) is not downloaded again.
 */

const API = "https://iptv-org.github.io/api/logos.json";
export const PIPELINE_VERSION = "tv-logos/1";
export const LOGO_BOX = { width: 256, height: 144 } as const;
export const LOGO_CONTENT_TYPE = "application/vnd.vigia.tv-logo+json";
const NOT_MODIFIED_TYPE = "application/vnd.vigia.not-modified";

const Logo = z.object({
	channel: z.string().min(1),
	feed: z.string().nullable().default(null),
	in_use: z.boolean().default(true),
	tags: z.array(z.string()).default([]),
	width: z.number().nonnegative().default(0),
	height: z.number().nonnegative().default(0),
	format: z.string().nullable().default(null),
	url: z.string().url(),
});
type Logo = z.infer<typeof Logo>;

export type TvLogo = {
	readonly channel: string;
	/** Blob key (GET /api/blobs/tv-logos/<key>), or null when the logo could not be made. */
	readonly blob: string | null;
	readonly width: number | null;
	readonly height: number | null;
	/** Where iptv-org says the logo is (shown as the image's source). */
	readonly url: string;
	readonly reason: string | null;
};

/** Pure: the logo to use for a channel. In use, the channel's own (not a feed's), PNG or JPEG, nearest 256 px wide. */
export function pickLogo(logos: readonly Logo[], channel: string): Logo | null {
	const usable = logos.filter(
		(l) =>
			l.channel === channel &&
			l.in_use &&
			/^https:\/\//.test(l.url) &&
			(l.format === null || /^(png|jpe?g)$/i.test(l.format)),
	);
	const score = (l: Logo) => (l.feed === null ? 0 : 10_000) + Math.abs((l.width || 256) - 256);
	return usable.sort((a, b) => score(a) - score(b) || a.url.localeCompare(b.url))[0] ?? null;
}

/** A blob name per channel (`l<hash>`): a new logo for the channel replaces the old one. */
export function logoName(channel: string): string {
	return `l${Bun.hash(channel).toString(36)}`;
}

/** The channels whose logo Vigía keeps: the directory's "on" channels and the curated YouTube channels. */
function wanted(onChannels: readonly string[]): string[] {
	const out = new Set(onChannels);
	for (const c of TV_CHANNELS) if (c.iptvChannel) out.add(c.iptvChannel);
	return [...out].sort();
}

let parsed: { etag: string | null; lastModified: string | null; logos: Logo[] } | null = null;

async function readLogos(ctx: FetchContext): Promise<Logo[]> {
	const res = await ctx.http.request(API, {
		headers: {
			accept: "application/json",
			...(parsed?.etag ? { "if-none-match": parsed.etag } : {}),
			...(parsed?.lastModified ? { "if-modified-since": parsed.lastModified } : {}),
		},
		maxBytes: 32 * 1024 * 1024,
		timeoutMs: 60_000,
		hostGapMs: 1_000,
		okStatuses: parsed ? [304] : [],
		signal: ctx.signal,
	});
	if (res.status === 304 && parsed) return parsed.logos;
	let json: unknown;
	try {
		json = JSON.parse(res.body);
	} catch {
		throw new SchemaError("iptv-org logos: JSON no válido");
	}
	if (!Array.isArray(json) || json.length < 100) throw new SchemaError("iptv-org logos: lista vacía o corta");
	const logos: Logo[] = [];
	for (const item of json) {
		const l = Logo.safeParse(item);
		if (l.success) logos.push(l.data);
	}
	parsed = { etag: res.etag ?? null, lastModified: res.lastModified ?? null, logos };
	return logos;
}

type LogoRecord = {
	channel: string;
	url: string;
	at: number;
	blob: { key: string; width: number; height: number } | null;
	reason: string | null;
};

async function logoFor(channel: string, logo: Logo, ctx: FetchContext): Promise<LogoRecord> {
	const name = logoName(channel);
	const key = blobKey(name, logo.url, PIPELINE_VERSION);
	const blobs = ctx.blobs;
	if (!blobs) return { channel, url: logo.url, at: ctx.now(), blob: null, reason: "no-store" };
	const stored = blobs.find(name);
	if (stored && stored.key === key && stored.width && stored.height)
		return {
			channel,
			url: logo.url,
			at: stored.createdAt,
			blob: { key, width: stored.width, height: stored.height },
			reason: null,
		};
	try {
		const res = await publicRequest(
			ctx.http,
			logo.url,
			{
				binary: true,
				maxBytes: 2 * 1024 * 1024,
				timeoutMs: 12_000,
				hostGapMs: 1_000,
				retries: 0,
				headers: { accept: "image/png,image/jpeg;q=0.9" },
				signal: ctx.signal,
			},
			ctx.now,
		);
		const bytes = new Uint8Array(Buffer.from(res.body, "base64"));
		if (!sniffImage(bytes)) return { channel, url: logo.url, at: ctx.now(), blob: null, reason: "not-image" };
		const image = decodeImage(bytes);
		const size = fitWithin(image.width, image.height, LOGO_BOX.width, LOGO_BOX.height);
		const png = encodePng(downscale(image, size.width, size.height));
		const meta = blobs.put(key, png, {
			name,
			contentType: "image/png",
			observedAt: ctx.now(),
			width: size.width,
			height: size.height,
		});
		return { channel, url: logo.url, at: meta.createdAt, blob: { key, ...size }, reason: null };
	} catch (error) {
		if (ctx.signal.aborted) throw error;
		const reason =
			error instanceof Error && /image|PNG|JPEG|large|decode|SOI|marker/i.test(error.message)
				? "decode"
				: reasonOf(error);
		return { channel, url: logo.url, at: ctx.now(), blob: null, reason };
	}
}

const Record_ = z.object({
	channel: z.string().min(1),
	url: z.string().url(),
	at: z.number(),
	blob: z
		.object({
			key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
			width: z.number().int().positive().max(LOGO_BOX.width),
			height: z.number().int().positive().max(LOGO_BOX.height),
		})
		.nullable(),
	reason: z.string().max(40).nullable(),
});

export const tvLogos: Adapter<TvLogo> = {
	id: "tv-logos",
	layer: "news",
	name: { es: "TV en vivo: logos de los canales (iptv-org)", en: "Live TV: channel logos (iptv-org)" },
	provider: "iptv-org (lista pública de logos); cada logo es de su canal",
	homepage: "https://github.com/iptv-org/database",
	licence: IPTV_LICENCE,
	keys: [],
	// Every 6 h: a stored logo costs nothing (logos.json answers 304), and one that failed is tried again the same day.
	intervalMs: 6 * 3_600_000,
	// Logos change rarely: a week without a successful read is stale; no data budget (no news is normal).
	freshness: { fetchMs: 7 * 24 * 3_600_000, dataMs: null },
	blobs: { maxEntries: 500, maxBytes: 32 * 1024 * 1024, maxAgeMs: null },

	async fetch(ctx) {
		const catalog = await loadCatalog(ctx);
		const on = catalog.entries.filter((e) => e.status === "on").map((e) => e.channel);
		const logos = await readLogos(ctx);
		const out: RawResponse[] = [];
		const jobs = wanted(on).flatMap((channel) => {
			const logo = pickLogo(logos, channel);
			return logo ? [{ channel, logo }] : [];
		});
		// Four at a time across hosts; the shared client still paces each host (imgur answers 429 when rushed).
		const records = await pool(jobs, 4, (j) => logoFor(j.channel, j.logo, ctx), ctx.signal);
		for (const record of records) {
			out.push({
				url: `tv-logos:${record.channel}`,
				status: 200,
				contentType: LOGO_CONTENT_TYPE,
				body: JSON.stringify(record),
				fetchedAt: ctx.now(),
			});
		}
		if (out.length === 0)
			out.push({ url: API, status: 304, contentType: NOT_MODIFIED_TYPE, body: "", fetchedAt: ctx.now() });
		return out;
	},

	normalise(raws) {
		const out: Observation<TvLogo>[] = [];
		let records = 0;
		for (const raw of raws) {
			if (raw.contentType !== LOGO_CONTENT_TYPE) continue;
			records++;
			let json: unknown;
			try {
				json = JSON.parse(raw.body);
			} catch {
				continue;
			}
			const p = Record_.safeParse(json);
			if (!p.success) continue;
			const r = p.data;
			out.push({
				source: "tv-logos",
				series: `logo:${r.channel}`,
				sourceUrl: channelPage(r.channel),
				fetchedAt: raw.fetchedAt,
				// The time the logo was stored: an unchanged logo is the same observation every day (stored once).
				observedAt: Math.min(r.at, raw.fetchedAt),
				licence: IPTV_LICENCE.id,
				value: {
					channel: r.channel,
					blob: r.blob?.key ?? null,
					width: r.blob?.width ?? null,
					height: r.blob?.height ?? null,
					url: r.url,
					reason: r.blob ? null : (r.reason ?? "unknown"),
				},
				confidence: 1,
				basis: "report",
			});
		}
		if (records > 0 && out.length === 0) throw new SchemaError("TV logos: ningún registro válido");
		return out;
	},
};
