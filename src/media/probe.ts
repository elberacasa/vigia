import { hasAudioFrames } from "../adapters/radio-streams/index.ts";
import type { FetchContext, RequestOptions } from "../core/types.ts";
import { HttpError } from "../core/types.ts";
import { cheapestVariant, type HlsProbe, type ProbeStep, parsePlaylist, sniffSegment } from "./hls.ts";
import { publicRequest } from "./public-host.ts";

/**
 * The network half of a live check, shared by the TV and radio directories. Every request reads only the first
 * bytes it needs (`readBytes`), is not retried (a check that fails says so; the next round is the retry), and goes
 * through the shared client's per-host pace, so one server is never asked twice at once.
 *
 * Every request goes through `publicRequest` (whole-release review, M7): the lists are third parties' (iptv-org,
 * Radio Browser, where anyone can add a station), so a listed URL must be http(s) on a public host, checked before
 * the request and before every redirect hop. A file: URL, a private, loopback or link-local address (a router, the
 * cloud metadata service at 169.254.169.254) is never asked; the reading says "private-host". Only origins actually
 * fetched are recorded for the page's policy (review, B2): not every variant a master playlist lists.
 */

/** A live playlist is a few KB; 256 KB covers the longest DVR windows seen (Canal I: 499 segments). */
const PLAYLIST_BYTES = 256 * 1024;
/** Enough to recognise a TS packet pair, an MP4 box or audio frames. */
const SEGMENT_BYTES = 2 * 1024;
/** First audio bytes of a radio stream: at 128 kb/s about half a second, several frames. */
export const AUDIO_PROBE_BYTES = 8 * 1024;
const TIMEOUT_MS = 10_000;
const ACAO = "access-control-allow-origin";

/** A failure as a short code for the UI and the stored record. */
export function failureCode(error: unknown): string {
	if (error instanceof HttpError && error.status > 0) return `http-${error.status}`;
	const text = error instanceof Error ? error.message : String(error);
	if (text.startsWith("private-host")) return "private-host";
	if (/timed? ?out|timeout|abort/i.test(text)) return "timeout";
	if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|DNS/i.test(text)) return "dns";
	if (/ECONNREFUSED|refused/i.test(text)) return "refused";
	if (/certificate|TLS|SSL/i.test(text)) return "tls";
	return "network";
}

function originOf(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return "";
	}
}

type Got =
	| { ok: true; url: string; body: string; status: number; acao: string | null }
	| { ok: false; status: number | null; error: string };

async function get(url: string, ctx: FetchContext, options: RequestOptions): Promise<Got> {
	try {
		const res = await publicRequest(
			ctx.http,
			url,
			{
				retries: 0,
				timeoutMs: TIMEOUT_MS,
				hostGapMs: 1_500,
				captureHeaders: [ACAO],
				signal: ctx.signal,
				...options,
			},
			ctx.now,
		);
		return {
			ok: true,
			url: res.url || url,
			body: res.body,
			status: res.status,
			acao: res.headers?.[ACAO] ?? null,
		};
	} catch (error) {
		return {
			ok: false,
			status: error instanceof HttpError && error.status > 0 ? error.status : null,
			error: failureCode(error),
		};
	}
}

const PLAYLIST_ACCEPT = "application/vnd.apple.mpegurl, application/x-mpegurl, audio/mpegurl, */*;q=0.5";

/** Probe one HLS stream: playlist, cheapest variant (if a master), first 2 KB of the newest segment. */
export async function probeHls(url: string, ctx: FetchContext): Promise<HlsProbe> {
	const at = ctx.now();
	const t0 = performance.now();
	const steps: ProbeStep[] = [];
	const origins = new Set<string>();
	let error: string | null = null;
	let playlistKind: HlsProbe["playlist"] = null;
	let ended = false;
	let segments = 0;
	let segmentKind: HlsProbe["segmentKind"] = null;
	let targetDurationS: number | null = null;
	let programDateAgeMs: number | null = null;
	const done = (): HlsProbe => ({
		url,
		at,
		steps,
		error,
		playlist: playlistKind,
		ended,
		segments,
		segmentKind,
		targetDurationS,
		programDateAgeMs,
		origins: [...origins].filter(Boolean).sort(),
		ms: Math.round(performance.now() - t0),
	});

	const fetchPlaylist = async (target: string, role: "playlist" | "variant") => {
		const got = await get(target, ctx, { readBytes: PLAYLIST_BYTES, headers: { accept: PLAYLIST_ACCEPT } });
		if (!got.ok) {
			steps.push({ role, origin: originOf(target), httpStatus: got.status, bytes: 0, acao: null });
			error = got.error;
			return null;
		}
		const bytes = Buffer.byteLength(got.body);
		origins.add(originOf(got.url));
		steps.push({ role, origin: originOf(got.url), httpStatus: got.status, bytes, acao: got.acao });
		return parsePlaylist(got.body, got.url, bytes >= PLAYLIST_BYTES);
	};

	let playlist = await fetchPlaylist(url, "playlist");
	if (!playlist) return done();
	if (playlist.kind === "master") {
		const variant = cheapestVariant(playlist.variants);
		if (!variant) {
			playlistKind = "master";
			return done();
		}
		playlist = await fetchPlaylist(variant.url, "variant");
		if (!playlist) return done();
	}
	playlistKind = playlist.kind;
	if (playlist.kind !== "media") return done();
	ended = playlist.ended;
	segments = playlist.segments.length;
	targetDurationS = playlist.targetDurationS;
	programDateAgeMs = playlist.lastProgramDateTime === null ? null : at - playlist.lastProgramDateTime;
	const newest = playlist.segments[playlist.segments.length - 1];
	if (ended || !newest) return done();

	const seg = await get(newest, ctx, { readBytes: SEGMENT_BYTES, binary: true });
	if (!seg.ok) {
		steps.push({ role: "segment", origin: originOf(newest), httpStatus: seg.status, bytes: 0, acao: null });
		error = seg.error;
		return done();
	}
	const bytes = Buffer.from(seg.body, "base64");
	origins.add(originOf(seg.url));
	steps.push({
		role: "segment",
		origin: originOf(seg.url),
		httpStatus: seg.status,
		bytes: bytes.byteLength,
		acao: seg.acao,
	});
	segmentKind = sniffSegment(bytes);
	return done();
}

/** What an audio probe saw: the radio-streams reading, plus the final origin (after redirects). */
export type AudioProbe = {
	readonly url: string;
	readonly at: number;
	readonly httpStatus: number | null;
	readonly contentType: string | null;
	readonly bytes: number;
	readonly audioFrames: boolean;
	readonly origin: string;
	readonly ms: number;
	readonly error: string | null;
};

/** Tune in like a listener's player for half a second (first 8 KB), then hang up. */
export async function probeAudio(url: string, ctx: FetchContext): Promise<AudioProbe> {
	const at = ctx.now();
	const t0 = performance.now();
	try {
		const res = await publicRequest(
			ctx.http,
			url,
			{
				headers: { accept: "audio/*;q=1, */*;q=0.1", "icy-metadata": "0" },
				readBytes: AUDIO_PROBE_BYTES,
				binary: true,
				retries: 0,
				timeoutMs: TIMEOUT_MS,
				hostGapMs: 2_000,
				signal: ctx.signal,
			},
			ctx.now,
		);
		const bytes = Buffer.from(res.body, "base64");
		return {
			url,
			at,
			httpStatus: res.status,
			contentType: res.contentType.slice(0, 80) || null,
			bytes: bytes.byteLength,
			audioFrames: hasAudioFrames(bytes),
			origin: originOf(res.url || url),
			ms: Math.round(performance.now() - t0),
			error: null,
		};
	} catch (error) {
		return {
			url,
			at,
			httpStatus: error instanceof HttpError && error.status > 0 ? error.status : null,
			contentType: null,
			bytes: 0,
			audioFrames: false,
			origin: originOf(url),
			ms: Math.round(performance.now() - t0),
			error: failureCode(error),
		};
	}
}

/** Run `task` over `items` with at most `limit` in flight (hosts are still paced one request at a time). */
export async function pool<T, R>(
	items: readonly T[],
	limit: number,
	task: (item: T) => Promise<R>,
	signal?: AbortSignal,
): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length && !signal?.aborted) {
			const i = next++;
			out[i] = await task(items[i] as T);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out.filter((x) => x !== undefined);
}
