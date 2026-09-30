import { afterEach, expect, test } from "bun:test";
import type { FetchContext, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { resetDecoderCache } from "../../media/decoder.ts";
import { ROUND_CONTENT_TYPE, STILL_CONTENT_TYPE, stillName, tvStills } from "./index.ts";

/** Synthetic records in the adapter's own format (invented channels and numbers). */
const record = (over: Record<string, unknown>): RawResponse => ({
	url: "tv-stills:x",
	status: 200,
	contentType: STILL_CONTENT_TYPE,
	body: JSON.stringify({
		entry: "CanalEjemplo.ve/SD/abc",
		channel: "CanalEjemplo.ve",
		website: "https://canal.example/",
		at: 1_000,
		blob: {
			key: "s1-2-0123456789abcdef",
			width: 480,
			height: 270,
			bytes: 21_000,
			lumaMean: 96.5,
			lumaSd: 51.2,
			hash: "0f0f0f0f0f0f0f0f",
		},
		reason: null,
		bytes: 70_000,
		ms: 800,
		cpuMs: 40,
		...over,
	}),
	fetchedAt: 2_000,
});
const round = (over: Record<string, unknown> = {}): RawResponse => ({
	url: "tv-stills:round",
	status: 200,
	contentType: ROUND_CONTENT_TYPE,
	body: JSON.stringify({
		at: 1_500,
		decoder: "n9.0.1",
		attempted: 2,
		stills: 1,
		bytes: 90_000,
		cpuMs: 60,
		ms: 3_000,
		reasons: { "http-404": 1 },
		...over,
	}),
	fetchedAt: 2_000,
});

afterEach(() => {
	delete process.env.VIGIA_FFMPEG;
	resetDecoderCache();
});

test("normalise: one observation per channel and one per round, flat frames flagged, bad records skipped", () => {
	const obs = tvStills.normalise([
		record({}),
		record({
			entry: "Negro.ve/SD/x",
			channel: "Negro.ve",
			blob: {
				key: "s2-2-0123456789abcdef",
				width: 480,
				height: 270,
				bytes: 3_000,
				lumaMean: 1,
				lumaSd: 0.4,
				hash: "0000000000000000",
			},
		}),
		record({
			entry: "Caido.ve/SD/y",
			channel: "Caido.ve",
			blob: null,
			reason: "http-404",
			website: "javascript:alert(1)",
		}),
		record({
			blob: {
				key: "../../etc/passwd",
				width: 480,
				height: 270,
				bytes: 1,
				lumaMean: 1,
				lumaSd: 1,
				hash: "0000000000000000",
			},
		}),
		round(),
	]);
	expect(obs).toHaveLength(4);
	const by = new Map(obs.map((o) => [o.series, o]));
	expect(by.get("still:CanalEjemplo.ve/SD/abc")).toMatchObject({
		source: "tv-stills",
		observedAt: 1_000,
		fetchedAt: 2_000,
		sourceUrl: "https://canal.example/",
		basis: "measurement",
		value: { kind: "still", blob: "s1-2-0123456789abcdef", flat: false, reason: null, jpegBytes: 21_000 },
	});
	expect(by.get("still:Negro.ve/SD/x")?.value).toMatchObject({ flat: true });
	// No still: the reason; an unsafe website is never used as the link.
	expect(by.get("still:Caido.ve/SD/y")).toMatchObject({
		value: { blob: null, reason: "http-404", flat: false },
		sourceUrl: "https://iptv-org.github.io/channels/ve/Caido",
	});
	expect(by.get("round")?.value).toMatchObject({
		kind: "round",
		decoder: "n9.0.1",
		stills: 1,
		bytes: 90_000,
	});
	for (const o of obs) expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
});

test("normalise: a round without its summary is a failed run", () => {
	expect(() => tvStills.normalise([record({})])).toThrow(SchemaError);
	expect(tvStills.normalise([])).toEqual([]);
});

test("without a decoder nothing is fetched: the round says so", async () => {
	process.env.VIGIA_FFMPEG = "0";
	resetDecoderCache();
	const asked: string[] = [];
	const ctx: FetchContext = {
		http: {
			async request(url) {
				asked.push(url);
				throw new Error("no network in this test");
			},
		},
		key: () => undefined,
		now: () => 5_000,
		signal: new AbortController().signal,
	};
	const raws = await tvStills.fetch(ctx);
	expect(asked).toEqual([]);
	const obs = tvStills.normalise(raws);
	expect(obs).toHaveLength(1);
	expect(obs[0]?.value).toMatchObject({ kind: "round", decoder: null, attempted: 0, stills: 0, bytes: 0 });
});

test("blob names: letters, digits and dashes only, one per channel and minute", () => {
	const a = stillName("Canal/SD/ab+c", 60_000 * 1_000);
	expect(a).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
	expect(stillName("Canal/SD/ab+c", 60_000 * 1_000 + 59_000)).toBe(a);
	expect(stillName("Canal/SD/ab+c", 60_000 * 1_001)).not.toBe(a);
	expect(stillName("Otro", 60_000 * 1_000)).not.toBe(a);
	// Retention: a day of stills, capped in entries and bytes.
	expect(tvStills.blobs).toEqual({
		maxEntries: 4_000,
		maxBytes: 160 * 1024 * 1024,
		maxAgeMs: 24 * 3_600_000,
	});
});
