import { describe, expect, test } from "bun:test";
import {
	cheapestVariant,
	corsOpen,
	type HlsProbe,
	hlsState,
	parsePlaylist,
	resolveRef,
	STALE_PLAYLIST_MS,
	sniffSegment,
} from "./hls.ts";

const MASTER = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
720p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
https://cdn.example.org/360p/playlist.m3u8
#EXT-X-STREAM-INF:RESOLUTION=320x180
180p.m3u8
`;

const MEDIA = `#EXTM3U\r
#EXT-X-VERSION:3\r
#EXT-X-TARGETDURATION:6\r
#EXT-X-MEDIA-SEQUENCE:1041\r
#EXT-X-PROGRAM-DATE-TIME:2026-09-28T22:00:00.000Z\r
#EXTINF:6.0,\r
seg1041.ts\r
#EXT-X-PROGRAM-DATE-TIME:2026-09-28T22:00:06.000Z\r
#EXTINF:6.0,\r
seg1042.ts?token=a\r
`;

describe("parsePlaylist", () => {
	test("a master lists its variants, resolved against the playlist's URL", () => {
		const p = parsePlaylist(MASTER, "https://tv.example.org/live/master.m3u8");
		expect(p.kind).toBe("master");
		if (p.kind !== "master") return;
		expect(p.variants.map((v) => v.url)).toEqual([
			"https://tv.example.org/live/720p/playlist.m3u8",
			"https://cdn.example.org/360p/playlist.m3u8",
			"https://tv.example.org/live/180p.m3u8",
		]);
		expect(cheapestVariant(p.variants)?.url).toBe("https://cdn.example.org/360p/playlist.m3u8");
	});

	test("a media playlist (CRLF): segments, target duration, newest program date, live window", () => {
		const p = parsePlaylist(MEDIA, "https://tv.example.org/live/index.m3u8");
		expect(p).toEqual({
			kind: "media",
			segments: ["https://tv.example.org/live/seg1041.ts", "https://tv.example.org/live/seg1042.ts?token=a"],
			ended: false,
			targetDurationS: 6,
			lastProgramDateTime: Date.parse("2026-09-28T22:00:06.000Z"),
		});
	});

	test("ENDLIST marks a finished recording; an HTML page is not a playlist; a truncated last line is dropped", () => {
		const vod = parsePlaylist(`${MEDIA}#EXT-X-ENDLIST\n`, "https://x.example/a.m3u8");
		expect(vod.kind === "media" && vod.ended).toBe(true);
		expect(parsePlaylist("<html><body>404 Not Found</body></html>", "https://x.example/a.m3u8").kind).toBe(
			"invalid",
		);
		const cut = parsePlaylist(
			"#EXTM3U\n#EXTINF:6,\nseg1.ts\n#EXTINF:6,\nseg2.t",
			"https://x.example/a.m3u8",
			true,
		);
		expect(cut.kind === "media" && cut.segments).toEqual(["https://x.example/seg1.ts"]);
		expect(
			parsePlaylist(`${String.fromCharCode(0xfeff)}#EXTM3U\nseg.ts`, "https://x.example/a.m3u8").kind,
		).toBe("media");
	});

	test("only http(s) references are followed", () => {
		expect(resolveRef("https://x.example/a/b.m3u8", "javascript:alert(1)")).toBeNull();
		expect(resolveRef("https://x.example/a/b.m3u8", "../c.ts")).toBe("https://x.example/c.ts");
		expect(cheapestVariant([])).toBeNull();
	});
});

describe("sniffSegment", () => {
	test("recognises TS, fMP4, ADTS, MPEG audio and ID3; not text", () => {
		const ts = new Uint8Array(400);
		ts[0] = 0x47;
		ts[188] = 0x47;
		expect(sniffSegment(ts)).toBe("ts");
		const mp4 = new Uint8Array(16);
		mp4.set(new TextEncoder().encode("ftyp"), 4);
		expect(sniffSegment(mp4)).toBe("fmp4");
		expect(sniffSegment(new Uint8Array([0xff, 0xf1, 0x50, 0x80]))).toBe("aac");
		expect(sniffSegment(new Uint8Array([0xff, 0xfb, 0x90, 0x64]))).toBe("mp3");
		expect(sniffSegment(new TextEncoder().encode("ID3\u0004\u0000"))).toBe("id3");
		expect(sniffSegment(new TextEncoder().encode("<html>error</html>".repeat(20)))).toBe("unknown");
	});
});

const live: HlsProbe = {
	url: "https://tv.example.org/live/master.m3u8",
	at: 1_000_000,
	steps: [
		{ role: "playlist", origin: "https://tv.example.org", httpStatus: 200, bytes: 300, acao: "*" },
		{ role: "variant", origin: "https://tv.example.org", httpStatus: 200, bytes: 600, acao: "*" },
		{ role: "segment", origin: "https://cdn.example.org", httpStatus: 200, bytes: 2048, acao: "*" },
	],
	error: null,
	playlist: "media",
	ended: false,
	segments: 5,
	segmentKind: "ts",
	targetDurationS: 6,
	programDateAgeMs: 20_000,
	origins: ["https://cdn.example.org", "https://tv.example.org"],
	ms: 900,
};

describe("hlsState: the stated rule", () => {
	test("live when every step answers and the segment is media", () => {
		expect(hlsState(live)).toEqual({ state: "live", reason: null });
		expect(corsOpen(live)).toBe(true);
	});

	test("each failure has its reason", () => {
		const noAnswer: HlsProbe = {
			...live,
			steps: [{ role: "playlist", origin: "https://tv.example.org", httpStatus: null, bytes: 0, acao: null }],
			error: "timeout",
			playlist: null,
		};
		expect(hlsState(noAnswer)).toEqual({ state: "no-answer", reason: "timeout" });
		const notFound: HlsProbe = {
			...live,
			steps: [{ role: "playlist", origin: "https://tv.example.org", httpStatus: 404, bytes: 0, acao: null }],
			playlist: null,
		};
		expect(hlsState(notFound)).toEqual({ state: "not-live", reason: "http-404" });
		const segGone: HlsProbe = {
			...live,
			steps: [
				...live.steps.slice(0, 2),
				{ role: "segment", origin: "https://cdn.example.org", httpStatus: 502, bytes: 0, acao: null },
			],
			segmentKind: null,
		};
		expect(hlsState(segGone)).toEqual({ state: "not-live", reason: "segment-http-502" });
		const segTimeout: HlsProbe = {
			...segGone,
			steps: [
				...live.steps.slice(0, 2),
				{ ...(segGone.steps[2] as HlsProbe["steps"][number]), httpStatus: null },
			],
			error: "timeout",
		};
		expect(hlsState(segTimeout)).toEqual({ state: "not-live", reason: "segment-timeout" });
		expect(hlsState({ ...live, playlist: "invalid" })).toEqual({ state: "not-live", reason: "not-playlist" });
		expect(hlsState({ ...live, ended: true })).toEqual({ state: "not-live", reason: "ended" });
		expect(hlsState({ ...live, segments: 0 })).toEqual({ state: "not-live", reason: "empty" });
		expect(hlsState({ ...live, segmentKind: "unknown" })).toEqual({
			state: "not-live",
			reason: "segment-not-media",
		});
		expect(hlsState({ ...live, programDateAgeMs: STALE_PLAYLIST_MS + 1 })).toEqual({
			state: "not-live",
			reason: "stale-playlist",
		});
		// A server clock ahead of ours is not staleness.
		expect(hlsState({ ...live, programDateAgeMs: -1500 }).state).toBe("live");
	});

	test("CORS is open only when every response allowed any origin", () => {
		const closed: HlsProbe = {
			...live,
			steps: [...live.steps.slice(0, 2), { ...(live.steps[2] as HlsProbe["steps"][number]), acao: null }],
		};
		expect(corsOpen(closed)).toBe(false);
		expect(corsOpen({ ...live, steps: [] })).toBe(false);
	});
});
