import type { FetchContext } from "../core/types.ts";
import { HttpError } from "../core/types.ts";
import { cheapestVariant, parsePlaylist, STALE_PLAYLIST_MS } from "./hls.ts";
import { failureCode } from "./probe.ts";
import { publicRequest } from "./public-host.ts";
import { firstKeyframe } from "./ts-keyframe.ts";

/**
 * The network half of a TV still: the playlist, the cheapest variant, and only the first bytes of the newest
 * segment, enough to hold its first keyframe (ts-keyframe.ts). The read size is learned per stream: it starts at
 * 128 KB and next time asks for 1.5 × what the keyframe needed (at least 48 KB); a keyframe that does not fit is
 * read again at twice the size, up to 1 MB. Measured 2026-09-28: keyframes end 6–160 KB into the segment (median ~31 KB).
 * Every URL (playlist, variant, segment, and each one's final URL after redirects) must be on a public host
 * (public-host.ts): a listed stream cannot make Vigía picture its own network.
 */

const PLAYLIST_BYTES = 256 * 1024;
export const FIRST_READ = 128 * 1024;
export const MIN_READ = 48 * 1024;
export const MAX_READ = 1024 * 1024;
const TIMEOUT_MS = 15_000;

/** Bytes the keyframe needed last time, per stream (process-local; a restart starts at FIRST_READ again). */
const needed = new Map<string, number>();

export type GrabResult =
	| {
			readonly ok: true;
			readonly annexB: Uint8Array;
			/** When the segment was read (epoch ms). */
			readonly at: number;
			/** Newest program-date-time of the media playlist (epoch ms), when the server stamps segments. */
			readonly programDateTime: number | null;
			readonly bytes: number;
			readonly ms: number;
	  }
	| { readonly ok: false; readonly reason: string; readonly bytes: number; readonly ms: number };

export function readSizeFor(key: string): number {
	const last = needed.get(key);
	if (last === undefined) return FIRST_READ;
	return Math.min(MAX_READ, Math.max(MIN_READ, Math.ceil((last * 1.5) / 1024) * 1024));
}

/** Tests only. */
export function resetReadSizes(): void {
	needed.clear();
}

async function text(url: string, ctx: FetchContext): Promise<{ body: string; url: string; bytes: number }> {
	const res = await publicRequest(
		ctx.http,
		url,
		{
			readBytes: PLAYLIST_BYTES,
			retries: 0,
			timeoutMs: TIMEOUT_MS,
			hostGapMs: 1_500,
			headers: { accept: "application/vnd.apple.mpegurl, application/x-mpegurl, */*;q=0.5" },
			signal: ctx.signal,
		},
		ctx.now,
	);
	// A public host that redirected inside the network: its bytes are dropped.
	return { body: res.body, url: res.url || url, bytes: Buffer.byteLength(res.body) };
}

async function prefix(url: string, size: number, ctx: FetchContext): Promise<Uint8Array> {
	const res = await publicRequest(
		ctx.http,
		url,
		{
			readBytes: size,
			binary: true,
			retries: 0,
			timeoutMs: TIMEOUT_MS,
			hostGapMs: 1_500,
			signal: ctx.signal,
		},
		ctx.now,
	);
	return new Uint8Array(Buffer.from(res.body, "base64"));
}

/** A failure as a short code: "http-404", "private-host", "timeout"… */
export function reasonOf(error: unknown): string {
	if (error instanceof HttpError && error.message.startsWith("private-host")) return "private-host";
	if (error instanceof HttpError && error.status > 0) return `http-${error.status}`;
	return failureCode(error);
}

/** Fetch the first keyframe of the newest segment of `url` (an HLS playlist), keyed `key` for the read size. */
export async function grabKeyframe(url: string, key: string, ctx: FetchContext): Promise<GrabResult> {
	const t0 = performance.now();
	let bytes = 0;
	const fail = (reason: string): GrabResult => ({
		ok: false,
		reason,
		bytes,
		ms: Math.round(performance.now() - t0),
	});
	try {
		let got = await text(url, ctx);
		bytes += got.bytes;
		let playlist = parsePlaylist(got.body, got.url, got.bytes >= PLAYLIST_BYTES);
		if (playlist.kind === "master") {
			const variant = cheapestVariant(playlist.variants);
			if (!variant) return fail("no-variant");
			got = await text(variant.url, ctx);
			bytes += got.bytes;
			playlist = parsePlaylist(got.body, got.url, got.bytes >= PLAYLIST_BYTES);
		}
		if (playlist.kind !== "media") return fail("not-playlist");
		if (playlist.ended) return fail("ended");
		// A playlist whose newest stamped segment is old is a server replaying a dead window (the probe's rule).
		if (playlist.lastProgramDateTime !== null && ctx.now() - playlist.lastProgramDateTime > STALE_PLAYLIST_MS)
			return fail("stale-playlist");
		const newest = playlist.segments.at(-1);
		if (!newest) return fail("empty");
		let size = readSizeFor(key);
		for (;;) {
			const at = ctx.now();
			const data = await prefix(newest, size, ctx);
			bytes += data.byteLength;
			const frame = firstKeyframe(data);
			if (frame.ok) {
				needed.set(key, frame.endOffset);
				return {
					ok: true,
					annexB: frame.annexB,
					at,
					programDateTime: playlist.lastProgramDateTime,
					bytes,
					ms: Math.round(performance.now() - t0),
				};
			}
			// The segment ended before the keyframe did (a short segment is complete: nothing more to read).
			if (frame.reason === "incomplete" && data.byteLength >= size && size < MAX_READ) {
				size = Math.min(MAX_READ, size * 2);
				continue;
			}
			return fail(frame.reason === "not-ts" ? "not-ts" : frame.reason);
		}
	} catch (error) {
		if (ctx.signal.aborted) throw error;
		return fail(reasonOf(error));
	}
}
