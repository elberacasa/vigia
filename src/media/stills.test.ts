import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchContext, HttpLike, RawResponse, RequestOptions } from "../core/types.ts";
import { HttpError } from "../core/types.ts";
import { lumaStats } from "../imaging/raster.ts";
import { decodeKeyframe, ffmpegArgs, findDecoder, resetDecoderCache } from "./decoder.ts";
import { FIRST_READ, grabKeyframe, MIN_READ, readSizeFor, resetReadSizes } from "./grab.ts";
import { useResolver } from "./public-host.ts";
import { firstKeyframe, nalTypes } from "./ts-keyframe.ts";

/** No DNS in tests: every *.example host is a public address, intranet.example a private one. */
useResolver(async (host) => (host.startsWith("intranet.") ? ["10.0.0.5"] : ["93.184.215.14"]));

/**
 * The TV-still pipeline: the pure demuxer against hand-built transport streams (every edge case measured on the live
 * streams, built here byte by byte), a synthetic H.264 fixture made by ffmpeg's own test pattern (testsrc2, no
 * broadcaster's content), the read-size rule, and the decoder's fixed, locked-down arguments.
 */

const FIXTURE = new Uint8Array(readFileSync(join(import.meta.dir, "fixtures", "testsrc2-high.m2ts")));

// ---- a tiny MPEG-TS writer (PAT, PMT, PES), enough to build each case ----

const VIDEO_PID = 0x100;
const PMT_PID = 0x1000;

function packet(pid: number, pusi: boolean, payload: Uint8Array): Uint8Array {
	const p = new Uint8Array(188).fill(0xff);
	p[0] = 0x47;
	p[1] = (pusi ? 0x40 : 0) | ((pid >> 8) & 0x1f);
	p[2] = pid & 0xff;
	const room = 184;
	if (payload.length >= room) {
		p[3] = 0x10;
		p.set(payload.subarray(0, room), 4);
	} else {
		// Adaptation field of stuffing, then the payload at the end of the packet.
		const stuffing = room - payload.length;
		p[3] = 0x30;
		p[4] = stuffing - 1;
		if (stuffing > 1) p[5] = 0x00;
		p.set(payload, 4 + stuffing);
	}
	return p;
}

function section(tableId: number, body: number[]): Uint8Array {
	const length = body.length + 5 + 4; // after the length field: 5 header bytes, body, CRC
	return new Uint8Array([
		0,
		tableId,
		0xb0 | ((length >> 8) & 0x0f),
		length & 0xff,
		0,
		1,
		0xc1,
		0,
		0,
		...body,
		0,
		0,
		0,
		0,
	]);
}

function pat(): Uint8Array {
	return packet(0, true, section(0x00, [0, 1, 0xe0 | (PMT_PID >> 8), PMT_PID & 0xff]));
}

function pmt(streamType: number): Uint8Array {
	return packet(
		PMT_PID,
		true,
		section(0x02, [
			0xe0 | (VIDEO_PID >> 8),
			VIDEO_PID & 0xff,
			0xf0,
			0,
			streamType,
			0xe0 | (VIDEO_PID >> 8),
			VIDEO_PID & 0xff,
			0xf0,
			0,
		]),
	);
}

function pts(value: number): number[] {
	return [
		0x21 | ((Math.floor(value / 2 ** 30) & 0x07) << 1),
		Math.floor(value / 2 ** 22) & 0xff,
		0x01 | ((Math.floor(value / 2 ** 15) & 0x7f) << 1),
		(value >> 7) & 0xff,
		0x01 | ((value & 0x7f) << 1),
	];
}

/** One PES packet (possibly several TS packets) carrying `es`, with a PTS when given. */
function pes(es: Uint8Array, time: number | null): Uint8Array[] {
	const header =
		time === null ? [0, 0, 1, 0xe0, 0, 0, 0x80, 0x00, 0] : [0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5, ...pts(time)];
	const all = new Uint8Array(header.length + es.length);
	all.set(header);
	all.set(es, header.length);
	const out: Uint8Array[] = [];
	for (let at = 0; at < all.length; at += 184)
		out.push(packet(VIDEO_PID, at === 0, all.subarray(at, at + 184)));
	return out;
}

const nal = (type: number, size = 20) => [0, 0, 0, 1, type, ...new Array(size).fill(0x5a)];
const AU_KEY = new Uint8Array([...nal(9, 1), ...nal(7), ...nal(8), ...nal(5, 400)]);
const AU_NEXT = new Uint8Array([...nal(9, 1), ...nal(1, 100)]);

function ts(...parts: Uint8Array[][]): Uint8Array {
	const packets = parts.flat();
	const out = new Uint8Array(packets.length * 188);
	for (const [i, p] of packets.entries()) out.set(p, i * 188);
	return out;
}

test("demuxer: the first access unit ends where the next timestamped PES starts", () => {
	const bytes = ts([pat(), pmt(0x1b)], pes(AU_KEY, 90_000), pes(AU_NEXT, 93_600));
	const r = firstKeyframe(bytes);
	expect(r.ok).toBe(true);
	if (!r.ok) return;
	expect([...r.annexB]).toEqual([...AU_KEY]);
	expect(r.nalTypes).toEqual([9, 7, 8, 5]);
	expect(r.endOffset).toBe(188 * (2 + Math.ceil((AU_KEY.length + 14) / 184)));
});

test("demuxer: a keyframe split over PES packets with the same timestamp is joined (measured on 1080p streams)", () => {
	const half = AU_KEY.length / 2;
	const bytes = ts(
		[pat(), pmt(0x1b)],
		pes(AU_KEY.subarray(0, half), 90_000),
		pes(AU_KEY.subarray(half), 90_000),
		pes(AU_NEXT, 93_600),
	);
	const r = firstKeyframe(bytes);
	expect(r.ok && [...r.annexB]).toEqual([...AU_KEY]);
});

test("demuxer: a PES without a timestamp continues the unit; an access unit delimiter starts the next", () => {
	const rest = AU_KEY.subarray(100);
	const r = firstKeyframe(
		ts([pat(), pmt(0x1b)], pes(AU_KEY.subarray(0, 100), 90_000), pes(rest, null), pes(AU_NEXT, null)),
	);
	expect(r.ok && [...r.annexB]).toEqual([...AU_KEY]);
});

test("demuxer: incomplete, not a keyframe, other codecs, not TS", () => {
	// The read ended inside the first unit: read more.
	expect(firstKeyframe(ts([pat(), pmt(0x1b)], pes(AU_KEY, 90_000)))).toEqual({
		ok: false,
		reason: "incomplete",
	});
	// A unit without SPS/PPS/IDR (the segment did not start on a keyframe).
	expect(firstKeyframe(ts([pat(), pmt(0x1b)], pes(AU_NEXT, 90_000), pes(AU_NEXT, 93_600)))).toEqual({
		ok: false,
		reason: "not-keyframe",
	});
	// HEVC (0x24) is reported, never passed to the H.264 decoder.
	expect(firstKeyframe(ts([pat(), pmt(0x24)], pes(AU_KEY, 0)))).toEqual({
		ok: false,
		reason: "codec",
		streamType: 0x24,
	});
	// Fragmented MP4 and an HTML error page are not TS.
	const fmp4 = new Uint8Array(1024);
	fmp4.set([0, 0, 0, 24, 0x73, 0x74, 0x79, 0x70]);
	expect(firstKeyframe(fmp4)).toEqual({ ok: false, reason: "not-ts" });
	expect(firstKeyframe(new TextEncoder().encode("<html>404</html>".repeat(80)))).toEqual({
		ok: false,
		reason: "not-ts",
	});
});

test("demuxer: the synthetic fixture (ffmpeg testsrc2, H.264 High) yields a complete keyframe", () => {
	const r = firstKeyframe(FIXTURE);
	expect(r.ok).toBe(true);
	if (!r.ok) return;
	expect(r.nalTypes[0]).toBe(9);
	for (const t of [7, 8, 5]) expect(r.nalTypes).toContain(t);
	expect(nalTypes(r.annexB)).toEqual([...r.nalTypes]);
	expect(r.endOffset).toBeLessThan(FIXTURE.length);
});

// ---- the decoder: optional, locked down ----

test("decoder: fixed arguments with no network, one codec, one frame, one thread, capped output", () => {
	const args = ffmpegArgs(480);
	const joined = args.join(" ");
	expect(joined).toContain("-protocol_whitelist pipe");
	expect(joined).toContain("-f h264 -c:v h264 -i pipe:0");
	expect(joined).toContain("-frames:v 1");
	expect(joined).toContain("-threads 1");
	expect(joined).toContain("-max_alloc");
	expect(joined).toContain("-f image2pipe pipe:1");
	expect(joined).not.toMatch(/https?:|file:/);
	// The width is clamped to 16..480.
	expect(ffmpegArgs(4_000).join(" ")).toContain("scale=480:");
	expect(ffmpegArgs(3).join(" ")).toContain("scale=16:");
});

test("decoder: VIGIA_FFMPEG=0 turns it off; a missing binary is no decoder", () => {
	resetDecoderCache();
	expect(findDecoder({ VIGIA_FFMPEG: "0" }, 1)).toBeNull();
	resetDecoderCache();
	expect(findDecoder({ VIGIA_FFMPEG: "/nonexistent/ffmpeg" }, 1)).toBeNull();
	resetDecoderCache();
});

const decoder = (() => {
	resetDecoderCache();
	const d = findDecoder(process.env, 0);
	resetDecoderCache();
	return d;
})();

test.skipIf(decoder === null)(
	"decoder: the fixture's keyframe becomes a 480 px still of the test pattern",
	async () => {
		const r = firstKeyframe(FIXTURE);
		if (!r.ok || !decoder) throw new Error("fixture");
		const out = await decodeKeyframe(decoder, r.annexB, 480);
		expect(out.ok).toBe(true);
		if (!out.ok) return;
		expect(out.image.width).toBe(480);
		expect(out.image.height).toBe(270);
		// testsrc2 is colourful, never flat.
		expect(lumaStats(out.image).sd).toBeGreaterThan(20);
		// Garbage in: an error, never a picture.
		const junk = await decodeKeyframe(decoder, new Uint8Array([0, 0, 0, 1, 0x65, 1, 2, 3]), 480);
		expect(junk.ok).toBe(false);
	},
);

// ---- the network half ----

type Route = (url: string, options: RequestOptions) => RawResponse | Error;

function ctxWith(route: Route, asked: { url: string; readBytes?: number | undefined }[] = []): FetchContext {
	const http: HttpLike = {
		async request(url, options = {}) {
			asked.push({ url, readBytes: options.readBytes });
			const r = route(url, options);
			if (r instanceof Error) throw r;
			return r;
		},
	};
	return { http, key: () => undefined, now: () => 1_000, signal: new AbortController().signal };
}

const text = (url: string, body: string): RawResponse => ({
	url,
	status: 200,
	contentType: "application/vnd.apple.mpegurl",
	body,
	fetchedAt: 1_000,
});
const bin = (url: string, bytes: Uint8Array, readBytes = bytes.length): RawResponse => ({
	url,
	status: 200,
	contentType: "video/mp2t",
	body: Buffer.from(bytes.subarray(0, readBytes)).toString("base64"),
	fetchedAt: 1_000,
});

beforeEach(() => resetReadSizes());
afterEach(() => resetReadSizes());

test("grab: master → cheapest variant → the newest segment's first bytes → the keyframe; the size is learned", async () => {
	const big = ts([pat(), pmt(0x1b)], pes(AU_KEY, 90_000), pes(AU_NEXT, 93_600), pes(AU_NEXT, 97_200));
	const asked: { url: string; readBytes?: number | undefined }[] = [];
	const route: Route = (url, o) => {
		if (url === "https://tv.example/live.m3u8")
			return text(
				url,
				"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nhi.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=400000\nlo.m3u8\n",
			);
		if (url === "https://tv.example/lo.m3u8")
			return text(url, "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\na.ts\n#EXTINF:6,\nb.ts\n");
		if (url === "https://tv.example/b.ts") return bin(url, big, o.readBytes);
		return new HttpError("HTTP 404", 404, url);
	};
	const r = await grabKeyframe("https://tv.example/live.m3u8", "k", ctxWith(route, asked));
	expect(r.ok).toBe(true);
	expect(asked.map((a) => a.url)).toEqual([
		"https://tv.example/live.m3u8",
		"https://tv.example/lo.m3u8",
		"https://tv.example/b.ts",
	]);
	expect(asked[2]?.readBytes).toBe(FIRST_READ);
	// Next time: 1.5 × what the keyframe needed, never under 48 KB.
	expect(readSizeFor("k")).toBe(MIN_READ);
});

test("grab: a keyframe larger than the read is read again at twice the size; failures are short codes", async () => {
	const huge = new Uint8Array([...nal(9, 1), ...nal(7), ...nal(8), ...nal(5, 200_000)]);
	const seg = ts([pat(), pmt(0x1b)], pes(huge, 0), pes(AU_NEXT, 3_600));
	const asked: { url: string; readBytes?: number | undefined }[] = [];
	const route: Route = (url, o) =>
		url.endsWith(".m3u8") ? text(url, "#EXTM3U\n#EXTINF:6,\ns.ts\n") : bin(url, seg, o.readBytes);
	const r = await grabKeyframe("https://tv.example/x.m3u8", "big", ctxWith(route, asked));
	expect(r.ok).toBe(true);
	expect(asked.slice(1).map((a) => a.readBytes)).toEqual([FIRST_READ, 2 * FIRST_READ]);

	const dead = await grabKeyframe(
		"https://tv.example/gone.m3u8",
		"d",
		ctxWith((u) => new HttpError("x", 404, u)),
	);
	expect(dead).toMatchObject({ ok: false, reason: "http-404" });
	const vod = await grabKeyframe(
		"https://tv.example/vod.m3u8",
		"v",
		ctxWith((u) => text(u, "#EXTM3U\n#EXTINF:6,\na.ts\n#EXT-X-ENDLIST\n")),
	);
	expect(vod).toMatchObject({ ok: false, reason: "ended" });
	const page = await grabKeyframe(
		"https://tv.example/p.m3u8",
		"p",
		ctxWith((u) => text(u, "<html></html>")),
	);
	expect(page).toMatchObject({ ok: false, reason: "not-playlist" });
});

test("grab: a stream on a private host, or one that redirects inside the network, is never read into a picture", async () => {
	const asked: { url: string; readBytes?: number | undefined }[] = [];
	const inside = await grabKeyframe(
		"http://192.168.1.10/live.m3u8",
		"p1",
		ctxWith((u) => text(u, "#EXTM3U\n"), asked),
	);
	expect(inside).toMatchObject({ ok: false, reason: "private-host" });
	expect(asked).toEqual([]);
	for (const url of [
		"http://localhost:7722/x.m3u8",
		"http://cam.local/x.m3u8",
		"https://intranet.example/x.m3u8",
	])
		expect(
			await grabKeyframe(
				url,
				url,
				ctxWith((u) => text(u, "#EXTM3U\n")),
			),
		).toMatchObject({
			reason: "private-host",
		});
	// A public playlist whose server redirects to a private address: the private hop is never asked for.
	const hops: { url: string; readBytes?: number | undefined }[] = [];
	const redirected = await grabKeyframe(
		"https://tv.example/r.m3u8",
		"r",
		ctxWith(
			(u) => ({
				url: u,
				status: 302,
				contentType: "text/html",
				body: "",
				fetchedAt: 1,
				headers: { location: "http://10.0.0.8/r.m3u8" },
			}),
			hops,
		),
	);
	expect(redirected).toMatchObject({ ok: false, reason: "private-host" });
	expect(hops.map((h) => h.url)).toEqual(["https://tv.example/r.m3u8"]);
});
