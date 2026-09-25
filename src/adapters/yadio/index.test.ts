import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { yadio } from "./index.ts";

const raws = loadFixture(join(import.meta.dir, "fixtures", "2026-09-24"));
const raw = raws[0] as RawResponse;
const withBody = (body: string): RawResponse[] => [{ ...raw, body }];

test("normalises the recorded rate with Yadio's own timestamp", () => {
	const [o, ...rest] = yadio.normalise(raws);
	expect(rest.length).toBe(0);
	expect(o?.series).toBe("usd-ves");
	expect(o?.value.vesPerUsd).toBe(957.499994);
	expect(o?.observedAt).toBe(1790292913674);
	expect(o?.basis).toBe("quote");
	expect(o?.source).toBe("yadio");
	expect(o?.sourceUrl).toBe("https://yadio.io/");
	expect(o?.observedAt).toBeLessThanOrEqual(o?.fetchedAt ?? 0);
	// Measured: 17 s between Yadio's timestamp and our fetch.
	expect((o?.fetchedAt ?? 0) - (o?.observedAt ?? 0)).toBeLessThan(60_000);
});

test("an error body with HTTP 200 fails the run (recorded: currency not found)", () => {
	const errors = loadFixture(join(import.meta.dir, "fixtures", "error-200"));
	expect(errors[0]?.status).toBe(200);
	expect(() => yadio.normalise(errors)).toThrow("currency not found");
});

test("rejects non-JSON, a non-positive rate, a seconds timestamp and a far-future timestamp", () => {
	expect(() => yadio.normalise(withBody("<html>"))).toThrow("JSON");
	expect(() =>
		yadio.normalise(withBody('{"rate":0,"timestamp":1790292913674,"request":"rate:VES/USD"}')),
	).toThrow("Yadio /rate");
	expect(() =>
		yadio.normalise(withBody('{"rate":957.5,"timestamp":1790292913,"request":"rate:VES/USD"}')),
	).toThrow("Yadio /rate");
	const future = raw.fetchedAt + 10 * 60_000;
	expect(() =>
		yadio.normalise(withBody(`{"rate":957.5,"timestamp":${future},"request":"rate:VES/USD"}`)),
	).toThrow("futuro");
});

test("a timestamp slightly ahead of our clock is clamped to the fetch time", () => {
	const ahead = raw.fetchedAt + 60_000;
	const [o] = yadio.normalise(withBody(`{"rate":957.5,"timestamp":${ahead},"request":"rate:VES/USD"}`));
	expect(o?.observedAt).toBe(raw.fetchedAt);
});

test("rejects an answer for a different pair", () => {
	expect(() =>
		yadio.normalise(withBody('{"rate":1.1,"timestamp":1790292913674,"request":"rate:EUR/USD"}')),
	).toThrow("Yadio /rate");
});
