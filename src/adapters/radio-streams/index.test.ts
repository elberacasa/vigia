import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasFixture, loadFixture } from "../../core/fixtures.ts";
import type { FetchContext, HttpLike, RawResponse } from "../../core/types.ts";
import { HttpError } from "../../core/types.ts";
import {
	hasAudioFrames,
	PROBE_BYTES,
	PROBE_CONTENT_TYPE,
	type RadioProbe,
	radioState,
	radioStreams,
} from "./index.ts";
import { RADIO_STATIONS, streamOrigins } from "./stations.ts";

// Recorded 2026-09-24 ~20:59 UTC: one 16 KB probe of each of the 5 streams, all sending MP3.
// Recorded responses carry third-party content, so they are absent from the public repository (see hasFixture).
const FIXTURE = join(import.meta.dir, "fixtures", "2026-09-24");
const recorded = hasFixture(FIXTURE);
const raws = recorded ? loadFixture(FIXTURE) : [];
// The first 2 KB (about 0.1 s) of two real streams, joined mid-frame as a player would.
const bytes = (name: string) =>
	new Uint8Array(readFileSync(join(import.meta.dir, "fixtures", "bytes", name)));

test.skipIf(!recorded)("replays the recorded run: every station sends audio", () => {
	const obs = radioStreams.normalise(raws);
	expect(obs.map((o) => o.value.station)).toEqual(RADIO_STATIONS.map((s) => s.id));
	for (const o of obs) {
		expect(o.value).toMatchObject({
			state: "audio",
			httpStatus: 200,
			contentType: "audio/mpeg",
			bytes: PROBE_BYTES,
		});
		expect(o.source).toBe("radio-streams");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(o.sourceUrl.startsWith("https://")).toBe(true);
	}
	expect(obs.find((o) => o.value.station === "rnv-informativa")?.value.ms).toBe(606);
});

test.skipIf(!recorded)("finds audio frames in real stream bytes and none in text", () => {
	expect(hasAudioFrames(bytes("fya-2k.mp3"))).toBe(true);
	expect(hasAudioFrames(bytes("rnv-2k.mp3"))).toBe(true);
	expect(
		hasAudioFrames(new TextEncoder().encode("<html><body>Service unavailable</body></html>".repeat(40))),
	).toBe(false);
	expect(hasAudioFrames(new Uint8Array(4096))).toBe(false);
	expect(hasAudioFrames(new TextEncoder().encode("ID3\u0004rest"))).toBe(true);
	expect(hasAudioFrames(new TextEncoder().encode("OggS\u0000rest"))).toBe(true);
});

test("the rule: 2xx, audio type, at least 4 KB and frames; else not audio or no answer", () => {
	const base: RadioProbe = {
		station: "fya-nacional",
		at: 1,
		httpStatus: 200,
		contentType: "audio/mpeg",
		bytes: 16_384,
		audioFrames: true,
		ms: 300,
		error: null,
	};
	expect(radioState(base)).toBe("audio");
	expect(radioState({ ...base, contentType: "audio/aac" })).toBe("audio");
	expect(radioState({ ...base, contentType: "text/html; charset=utf-8" })).toBe("not-audio");
	expect(radioState({ ...base, audioFrames: false })).toBe("not-audio");
	expect(radioState({ ...base, bytes: 1_000 })).toBe("not-audio");
	expect(radioState({ ...base, httpStatus: null, error: "timeout", bytes: 0 })).toBe("no-answer");
});

test.skipIf(!recorded)("bad records are skipped; a run with none valid fails loudly", () => {
	const good = raws[0] as RawResponse;
	expect(
		radioStreams.normalise([good, { ...good, body: "nope" }, { ...good, body: '{"station":1}' }]).length,
	).toBe(1);
	expect(() => radioStreams.normalise([{ ...good, body: "nope" }])).toThrow("ningún registro");
});

test.skipIf(!recorded)(
	"fetch reads only the first bytes of each stream, once, and records failures",
	async () => {
		const asked: { url: string; readBytes: number | undefined; retries: number | undefined }[] = [];
		const audio = Buffer.from(bytes("fya-2k.mp3")).toString("base64");
		const http: HttpLike = {
			async request(url, options) {
				asked.push({ url, readBytes: options?.readBytes, retries: options?.retries });
				if (url.includes("tepuyserver")) throw new HttpError("HTTP 503 from guri.tepuyserver.net", 503, url);
				return { url, status: 200, contentType: "audio/mpeg", body: audio, fetchedAt: 9 };
			},
		};
		const ctx: FetchContext = {
			http,
			key: () => undefined,
			now: () => 9,
			signal: new AbortController().signal,
		};
		const out = await radioStreams.fetch(ctx);
		expect(asked.map((a) => a.url)).toEqual(RADIO_STATIONS.map((s) => s.streamUrl));
		expect(asked.every((a) => a.readBytes === PROBE_BYTES && a.retries === 0)).toBe(true);
		expect(out.every((r) => r.contentType === PROBE_CONTENT_TYPE)).toBe(true);
		const obs = radioStreams.normalise(out);
		// 2 KB is below the 4 KB floor: an answer, but not enough to call it a stream that plays.
		expect(obs[0]?.value.state).toBe("not-audio");
		expect(obs.find((o) => o.value.station === "rnv-informativa")?.value).toMatchObject({
			state: "no-answer",
			httpStatus: 503,
			error: "http-503",
		});
	},
);

test("stations: HTTPS only, unique ids; the CSP origins are exactly their hosts", () => {
	expect(new Set(RADIO_STATIONS.map((s) => s.id)).size).toBe(RADIO_STATIONS.length);
	for (const s of RADIO_STATIONS) expect(new URL(s.streamUrl).protocol).toBe("https:");
	expect(streamOrigins()).toEqual(["https://guri.tepuyserver.net", "https://tx.feyalegrianoticias.com"]);
});
