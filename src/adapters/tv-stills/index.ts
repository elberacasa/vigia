import { z } from "zod";
import { blobKey } from "../../core/blobs.ts";
import type { Adapter, FetchContext, Licence, Observation, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { encodeJpeg } from "../../imaging/jpeg.ts";
import { dhash, hamming, lumaStats } from "../../imaging/raster.ts";
import { type Decoder, decodeKeyframe, findDecoder } from "../../media/decoder.ts";
import { grabKeyframe } from "../../media/grab.ts";
import { pool } from "../../media/probe.ts";
import { channelPage, loadCatalog } from "../iptv-ve/index.ts";

/**
 * TV stills: one real frame of every free-to-air channel in the TV directory (iptv-org's Venezuela list, the
 * streams the directory lets in), every 30 minutes, so a card or the TV wall shows what each channel is airing
 * instead of a blank box.
 *
 * Per channel and round: the playlist, the cheapest variant, the first bytes of the newest segment (just enough to
 * hold its first keyframe, src/media/grab.ts), that keyframe demuxed in pure TypeScript (src/media/ts-keyframe.ts),
 * decoded by the machine's ffmpeg if it has one (src/media/decoder.ts), reduced to 480 px wide and re-encoded by
 * Vigía as a JPEG. Served from Vigía's own origin (`/api/blobs/tv-stills/<key>`): the browser never contacts the
 * broadcaster until the viewer presses play. Without ffmpeg nothing is fetched: the round says "no decoder" and
 * every card shows the channel's logo (tv-logos) with "sin cuadro reciente".
 *
 * Measured 2026-09-29 on this machine, three rounds in a row: 37–38 stills of 68 streams (30 not live: 18 × 404,
 * 4 × 403, TLS, DNS, timeouts; 1 fragmented MP4), 5.7 MB the first round (128 KB reads) and 4.0–4.4 MB once the read
 * sizes are learned (median 74 KB per still, largest 0.5 MB), 1.6 s of CPU in ffmpeg and the JPEG encoder plus
 * 0.65 s in Bun, 40 s of wall time (hosts paced); stills 20 KB median, 31 KB largest. A still is a modest-resolution reference image of a public broadcast (480 px wide);
 * nothing in it is analysed beyond its mean brightness (a black screen) and a 64-bit difference hash compared with
 * the previous round's (a picture that stopped changing).
 *
 * Time: a still is dated when its segment was read, i.e. the live edge of the broadcast as this computer received
 * it (typically less than 30 s behind the broadcast itself).
 */

export const TV_STILL_LICENCE: Licence = {
	id: "tv-still-reference",
	name: "Cuadro reducido de la señal pública de cada televisora, tomado por Vigía como referencia",
	url: "https://github.com/iptv-org/iptv",
	attribution: "Imagen: señal de cada televisora; cuadro tomado por Vigía",
	commercial: "unclear",
};

export const STILL_WIDTH = 480;
export const JPEG_QUALITY = 72;
export const PIPELINE_VERSION = "tv-stills/1";
const CONCURRENCY = 4;
export const STILL_CONTENT_TYPE = "application/vnd.vigia.tv-still+json";
export const ROUND_CONTENT_TYPE = "application/vnd.vigia.tv-still-round+json";
/** Below this luma spread a still is one flat colour (black, a slate): the card prefers the logo and says so. */
export const FLAT_SD = 4;

export type TvStill = {
	readonly kind: "still";
	/** The directory entry (iptv-ve `IptvEntry.key`). */
	readonly entry: string;
	readonly channel: string;
	/** Blob key (GET /api/blobs/tv-stills/<key>), or null when no still was made this round. */
	readonly blob: string | null;
	readonly width: number | null;
	readonly height: number | null;
	readonly jpegBytes: number | null;
	/** Why there is no still: "http-404", "timeout", "not-ts" (fragmented MP4), "codec", "decode-error"… */
	readonly reason: string | null;
	/** Mean and spread of luma (0..255) of the whole still. */
	readonly lumaMean: number | null;
	readonly lumaSd: number | null;
	/** One flat colour (black screen, a single-colour slate): shown as such, not as a picture. */
	readonly flat: boolean;
	/** 64-bit difference hash (16 hex digits) of the still. */
	readonly hash: string | null;
	/**
	 * When the picture stopped changing: set when this still's hash is within 2 bits of the previous round's (this
	 * process's memory), to the time of the first still of that run; null when it changed. The card rule shows a
	 * picture unchanged for 50 min as "imagen sin cambios", never as the channel's current frame.
	 */
	readonly unchangedSince: number | null;
	/** Network bytes read for this still (playlists and the segment prefix), and time taken. */
	readonly bytes: number;
	readonly ms: number;
	readonly cpuMs: number;
};

export type TvStillRound = {
	readonly kind: "round";
	/** The ffmpeg that decoded this round ("n9.0.1"), or null: no decoder on this machine, nothing fetched. */
	readonly decoder: string | null;
	readonly attempted: number;
	readonly stills: number;
	readonly bytes: number;
	readonly cpuMs: number;
	readonly ms: number;
	/** Why the others have none, counted. */
	readonly reasons: Record<string, number>;
};

export type TvStillValue = TvStill | TvStillRound;

const StillRecord = z.object({
	entry: z.string().min(1),
	channel: z.string().min(1),
	website: z.string().nullable(),
	at: z.number(),
	blob: z
		.object({
			key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
			width: z.number().int().positive().max(STILL_WIDTH),
			height: z.number().int().positive().max(480),
			bytes: z.number().int().positive(),
			lumaMean: z.number(),
			lumaSd: z.number(),
			hash: z.string().regex(/^[0-9a-f]{16}$/),
		})
		.nullable(),
	reason: z.string().max(40).nullable(),
	unchangedSince: z.number().nullable().default(null),
	bytes: z.number().int().nonnegative(),
	ms: z.number().nonnegative(),
	cpuMs: z.number().nonnegative(),
});
type StillRecord = z.infer<typeof StillRecord>;

const RoundRecord = z.object({
	at: z.number(),
	decoder: z.string().max(40).nullable(),
	attempted: z.number().int().nonnegative(),
	stills: z.number().int().nonnegative(),
	bytes: z.number().int().nonnegative(),
	cpuMs: z.number().nonnegative(),
	ms: z.number().nonnegative(),
	reasons: z.record(z.string(), z.number().int().nonnegative()),
});

/** The previous round's hash per entry and since when it has not changed (process-local). */
const lastHash = new Map<string, { hash: string; since: number }>();

/** Tests only. */
export function resetStillMemory(): void {
	lastHash.clear();
}

/** A blob name for one channel's still at one minute: `s<channel hash>-<minute>` (letters, digits, dash). */
export function stillName(entry: string, at: number): string {
	return `s${Bun.hash(entry).toString(36)}-${Math.floor(at / 60_000).toString(36)}`;
}

async function stillFor(
	entry: { key: string; channel: string; url: string; website: string | null },
	decoder: Decoder,
	ctx: FetchContext,
): Promise<StillRecord> {
	const base = { entry: entry.key, channel: entry.channel, website: entry.website, unchangedSince: null };
	const grab = await grabKeyframe(entry.url, entry.key, ctx);
	if (!grab.ok)
		return {
			...base,
			at: ctx.now(),
			blob: null,
			reason: grab.reason,
			bytes: grab.bytes,
			ms: grab.ms,
			cpuMs: 0,
		};
	const decoded = await decodeKeyframe(decoder, grab.annexB, STILL_WIDTH, ctx.signal);
	const common = { ...base, at: grab.at, bytes: grab.bytes, ms: grab.ms, cpuMs: decoded.cpuMs };
	if (!decoded.ok) return { ...common, blob: null, reason: decoded.reason };
	const t0 = performance.now();
	const jpeg = encodeJpeg(decoded.image, JPEG_QUALITY);
	const stats = lumaStats(decoded.image);
	const hash = dhash(decoded.image);
	const encodeMs = performance.now() - t0;
	const name = stillName(entry.key, grab.at);
	const key = blobKey(name, jpeg, PIPELINE_VERSION);
	if (!ctx.blobs) return { ...common, blob: null, reason: "no-store" };
	ctx.blobs.put(key, jpeg, {
		name,
		contentType: "image/jpeg",
		observedAt: grab.at,
		width: decoded.image.width,
		height: decoded.image.height,
	});
	const prev = lastHash.get(entry.key);
	const unchangedSince = prev && hamming(prev.hash, hash) <= 2 ? prev.since : null;
	lastHash.set(entry.key, { hash, since: unchangedSince ?? grab.at });
	return {
		...common,
		unchangedSince,
		cpuMs: Math.round(decoded.cpuMs + encodeMs),
		reason: null,
		blob: {
			key,
			width: decoded.image.width,
			height: decoded.image.height,
			bytes: jpeg.byteLength,
			lumaMean: stats.mean,
			lumaSd: stats.sd,
			hash,
		},
	};
}

export const tvStills: Adapter<TvStillValue> = {
	id: "tv-stills",
	layer: "news",
	name: {
		es: "TV en vivo: un cuadro de cada canal (cada 30 min)",
		en: "Live TV: one frame of each channel (every 30 min)",
	},
	provider: "Cada televisora (su señal pública), cuadro tomado por Vigía",
	homepage: "https://github.com/iptv-org/iptv",
	licence: TV_STILL_LICENCE,
	keys: [],
	// A person's own Vigía only: a public mirror would re-serve broadcasters' frames to the world (decided
	// 2026-09-29; the mirror shows channel logos). The blob route refuses them on a mirror too.
	defaultIn: { local: true, public: false },
	intervalMs: 30 * 60_000,
	freshness: { fetchMs: 90 * 60_000, dataMs: 90 * 60_000 },
	// A day of stills (the time machine replays the TV wall of any moment in the last 24 h): ~40 channels × 48
	// rounds × ~25 KB ≈ 48 MB.
	blobs: { maxEntries: 4_000, maxBytes: 160 * 1024 * 1024, maxAgeMs: 24 * 3_600_000 },
	note: {
		es:
			"Cada 30 minutos Vigía toma un cuadro de cada canal que emite: lee solo el comienzo del segmento más reciente " +
			"(el primer fotograma completo, unos 6–160 KB por canal) y lo reduce a 480 px. Medido el 29/09/2026: 4 a " +
			"6 MB por ronda (37–38 canales con cuadro), unos 200 MB al día, y 1,6 s de CPU por ronda. Necesita ffmpeg " +
			"en este equipo; sin él no descarga nada y las tarjetas muestran el logo del canal.",
		en:
			"Every 30 minutes Vigía takes one frame of each channel on air: it reads only the start of the newest " +
			"segment (the first complete picture, about 6–160 KB per channel) and shrinks it to 480 px. Measured on " +
			"2026-09-29: 4 to 6 MB a round (37–38 channels with a frame), about 200 MB a day, and 1.6 s of CPU a round. " +
			"Needs ffmpeg on this computer; without it nothing is downloaded and the cards show the channel's logo.",
	},

	async fetch(ctx) {
		const t0 = performance.now();
		const decoder = findDecoder();
		const out: RawResponse[] = [];
		const records: StillRecord[] = [];
		let attempted = 0;
		if (decoder) {
			const catalog = await loadCatalog(ctx);
			const on = catalog.entries.filter((e) => e.status === "on");
			attempted = on.length;
			records.push(...(await pool(on, CONCURRENCY, (e) => stillFor(e, decoder, ctx), ctx.signal)));
		}
		for (const r of records) {
			out.push({
				url: `tv-stills:${r.entry}`,
				status: 200,
				contentType: STILL_CONTENT_TYPE,
				body: JSON.stringify(r),
				fetchedAt: ctx.now(),
			});
		}
		const reasons: Record<string, number> = {};
		for (const r of records) if (r.reason) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
		out.push({
			url: "tv-stills:round",
			status: 200,
			contentType: ROUND_CONTENT_TYPE,
			body: JSON.stringify({
				at: ctx.now(),
				decoder: decoder?.version ?? null,
				attempted,
				stills: records.filter((r) => r.blob !== null).length,
				bytes: records.reduce((n, r) => n + r.bytes, 0),
				cpuMs: Math.round(records.reduce((n, r) => n + r.cpuMs, 0)),
				ms: Math.round(performance.now() - t0),
				reasons,
			}),
			fetchedAt: ctx.now(),
		});
		return out;
	},

	normalise(raws) {
		const out: Observation<TvStillValue>[] = [];
		let round = false;
		for (const raw of raws) {
			let json: unknown;
			try {
				json = JSON.parse(raw.body);
			} catch {
				continue;
			}
			if (raw.contentType === ROUND_CONTENT_TYPE) {
				const r = RoundRecord.safeParse(json);
				if (!r.success) continue;
				round = true;
				const { at, ...rest } = r.data;
				out.push({
					source: "tv-stills",
					series: "round",
					sourceUrl: "https://github.com/iptv-org/iptv",
					fetchedAt: raw.fetchedAt,
					observedAt: Math.min(at, raw.fetchedAt),
					licence: TV_STILL_LICENCE.id,
					value: { kind: "round", ...rest },
					confidence: 1,
					basis: "measurement",
				});
				continue;
			}
			if (raw.contentType !== STILL_CONTENT_TYPE) continue;
			const parsed = StillRecord.safeParse(json);
			if (!parsed.success) continue;
			const r = parsed.data;
			const b = r.blob;
			out.push({
				source: "tv-stills",
				series: `still:${r.entry}`,
				sourceUrl: r.website && /^https?:\/\//.test(r.website) ? r.website : channelPage(r.channel),
				fetchedAt: raw.fetchedAt,
				observedAt: Math.min(r.at, raw.fetchedAt),
				licence: TV_STILL_LICENCE.id,
				value: {
					kind: "still",
					entry: r.entry,
					channel: r.channel,
					blob: b?.key ?? null,
					width: b?.width ?? null,
					height: b?.height ?? null,
					jpegBytes: b?.bytes ?? null,
					reason: b ? null : (r.reason ?? "unknown"),
					lumaMean: b?.lumaMean ?? null,
					lumaSd: b?.lumaSd ?? null,
					flat: b !== null && b.lumaSd < FLAT_SD,
					hash: b?.hash ?? null,
					unchangedSince: b ? r.unchangedSince : null,
					bytes: r.bytes,
					ms: Math.round(r.ms),
					cpuMs: Math.round(r.cpuMs),
				},
				confidence: 1,
				basis: "measurement",
			});
		}
		if (raws.length > 0 && !round) throw new SchemaError("TV: la ronda de cuadros no tiene resumen válido");
		return out;
	},
};
