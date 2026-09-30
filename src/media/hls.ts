/**
 * HLS (HTTP Live Streaming) as a live check sees it: pure parsing of a playlist and a rule over one probe. Used by the
 * TV directory probe (iptv-org list) and by radio stations that stream over HLS.
 *
 * A probe is what a player does in its first second, minus the video: the playlist, then (for a master playlist)
 * the cheapest variant's media playlist, then the first 2 KB of its newest segment. Never the stream itself.
 * Measured 2026-09-28 on the 59 HTTPS streams of iptv-org's Venezuela list: 77 KB for the whole round, 55 s
 * sequential; 33 answered live.
 */

export type Variant = { readonly url: string; readonly bandwidth: number | null };

export type Playlist =
	| { readonly kind: "master"; readonly variants: readonly Variant[] }
	| {
			readonly kind: "media";
			readonly segments: readonly string[];
			/** `#EXT-X-ENDLIST`: a finished recording (VOD), not a live window. */
			readonly ended: boolean;
			readonly targetDurationS: number | null;
			/** Newest `#EXT-X-PROGRAM-DATE-TIME` (epoch ms), when the server stamps segments. */
			readonly lastProgramDateTime: number | null;
	  }
	| { readonly kind: "invalid" };

/** Resolve a playlist reference against the playlist's own (final, after redirects) URL. */
export function resolveRef(base: string, ref: string): string | null {
	try {
		const u = new URL(ref.trim(), base);
		return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
	} catch {
		return null;
	}
}

/**
 * Pure. `truncated`: the body was cut at the read limit, so its last line may be partial and is dropped.
 * Only `#EXTM3U` bodies are playlists; an HTML error page served as 200 is "invalid".
 */
export function parsePlaylist(body: string, baseUrl: string, truncated = false): Playlist {
	const text = body.charCodeAt(0) === 0xfeff ? body.slice(1) : body;
	if (!text.trimStart().startsWith("#EXTM3U")) return { kind: "invalid" };
	const lines = text.split(/\r?\n/);
	if (truncated) lines.pop();
	if (lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"))) {
		const variants: Variant[] = [];
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] as string;
			if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
			const ref = lines.slice(i + 1).find((l) => l.trim() !== "" && !l.startsWith("#"));
			const url = ref ? resolveRef(baseUrl, ref) : null;
			if (!url) continue;
			const bw = /[:,]BANDWIDTH=(\d+)/.exec(line)?.[1];
			variants.push({ url, bandwidth: bw ? Number(bw) : null });
		}
		return { kind: "master", variants };
	}
	const segments: string[] = [];
	let lastPdt: number | null = null;
	let target: number | null = null;
	for (const raw of lines) {
		const line = raw.trim();
		if (line === "") continue;
		if (line.startsWith("#EXT-X-TARGETDURATION:")) {
			const n = Number(line.slice("#EXT-X-TARGETDURATION:".length));
			if (Number.isFinite(n) && n > 0) target = n;
		} else if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
			const t = Date.parse(line.slice("#EXT-X-PROGRAM-DATE-TIME:".length));
			if (Number.isFinite(t)) lastPdt = t;
		} else if (!line.startsWith("#")) {
			const url = resolveRef(baseUrl, line);
			if (url) segments.push(url);
		}
	}
	return {
		kind: "media",
		segments,
		ended: lines.some((l) => l.trim() === "#EXT-X-ENDLIST"),
		targetDurationS: target,
		lastProgramDateTime: lastPdt,
	};
}

/** The cheapest variant (lowest declared bandwidth; undeclared last), so a check costs the least. */
export function cheapestVariant(variants: readonly Variant[]): Variant | null {
	let best: Variant | null = null;
	for (const v of variants) {
		if (!best) best = v;
		else if (v.bandwidth !== null && (best.bandwidth === null || v.bandwidth < best.bandwidth)) best = v;
	}
	return best;
}

export type SegmentKind = "ts" | "fmp4" | "aac" | "mp3" | "id3" | "unknown";

/**
 * Pure: what the first bytes of a segment are. MPEG-TS (0x47 sync every 188 bytes), fragmented MP4 (a box type
 * at offset 4), ADTS AAC or MPEG audio (frame sync), or an ID3 tag (HLS audio segments start with one). An HTML
 * or JSON error page is "unknown".
 */
export function sniffSegment(bytes: Uint8Array): SegmentKind {
	if (bytes.length >= 189 && bytes[0] === 0x47 && bytes[188] === 0x47) return "ts";
	if (bytes.length >= 8) {
		const box = String.fromCharCode(bytes[4] ?? 0, bytes[5] ?? 0, bytes[6] ?? 0, bytes[7] ?? 0);
		if (["ftyp", "styp", "moof", "sidx", "emsg", "prft"].includes(box)) return "fmp4";
	}
	if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return "id3";
	if (bytes.length >= 2 && bytes[0] === 0xff) {
		const b1 = bytes[1] ?? 0;
		if ((b1 & 0xf6) === 0xf0) return "aac";
		if ((b1 & 0xe0) === 0xe0) return "mp3";
	}
	return "unknown";
}

/** One HTTP step of a probe. `acao` is the response's Access-Control-Allow-Origin, null when absent. */
export type ProbeStep = {
	readonly role: "playlist" | "variant" | "segment";
	readonly origin: string;
	readonly httpStatus: number | null;
	readonly bytes: number;
	readonly acao: string | null;
};

/** What the probe of one HLS stream saw; stored as the synthetic raw record and replayed by tests. */
export type HlsProbe = {
	readonly url: string;
	readonly at: number;
	readonly steps: readonly ProbeStep[];
	/** Failure of the last step: "timeout", "dns", "tls", "refused", "network", or null. */
	readonly error: string | null;
	/** What the probe could conclude before stopping (see `hlsState`). */
	readonly playlist: "master" | "media" | "invalid" | null;
	readonly ended: boolean;
	readonly segments: number;
	readonly segmentKind: SegmentKind | null;
	readonly targetDurationS: number | null;
	/** Probe time minus the newest program-date-time, ms; null when the server does not stamp segments. */
	readonly programDateAgeMs: number | null;
	/** Origins a player would fetch from: every step's final URL and every variant listed in the master. */
	readonly origins: readonly string[];
	readonly ms: number;
};

export type HlsState = "live" | "not-live" | "no-answer";

/** A playlist whose newest stamped segment is older than this is frozen (a server replaying a dead window). */
export const STALE_PLAYLIST_MS = 10 * 60_000;

/**
 * Pure: the stated rule. Live = the playlist (and the variant, if any) answered 2xx with `#EXTM3U`, the media
 * playlist is a live window (no `#EXT-X-ENDLIST`) with at least one segment, the newest segment answered 2xx and
 * its first bytes are audio or video, and (when the server stamps times) the newest stamp is under 10 minutes old.
 */
export function hlsState(p: HlsProbe): { state: HlsState; reason: string | null } {
	const first = p.steps[0];
	if (!first || first.httpStatus === null) return { state: "no-answer", reason: p.error ?? "network" };
	for (const step of p.steps) {
		const prefix = step.role === "playlist" ? "" : `${step.role}-`;
		if (step.httpStatus === null) return { state: "not-live", reason: `${prefix}${p.error ?? "network"}` };
		if (step.httpStatus < 200 || step.httpStatus >= 300)
			return { state: "not-live", reason: `${prefix}http-${step.httpStatus}` };
	}
	if (p.playlist !== "media")
		return { state: "not-live", reason: p.playlist === "master" ? "no-variant" : "not-playlist" };
	if (p.ended) return { state: "not-live", reason: "ended" };
	if (p.segments === 0) return { state: "not-live", reason: "empty" };
	if (p.segmentKind === null) return { state: "not-live", reason: "segment-unread" };
	if (p.segmentKind === "unknown") return { state: "not-live", reason: "segment-not-media" };
	if (p.programDateAgeMs !== null && p.programDateAgeMs > STALE_PLAYLIST_MS)
		return { state: "not-live", reason: "stale-playlist" };
	return { state: "live", reason: null };
}

/**
 * Whether a page on another origin may read every response (hls.js reads playlists and segments with fetch, so it
 * needs CORS; Safari's native player does not). True only when every step said `*`.
 */
export function corsOpen(p: HlsProbe): boolean {
	return p.steps.length > 0 && p.steps.every((s) => s.acao === "*");
}
