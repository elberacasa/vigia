import { expect, test } from "bun:test";
import type { RawResponse } from "../../core/types.ts";
import { MissingKeyError, SchemaError } from "../../core/types.ts";
import { DAHITI_API, dahitiGuri, GURI_PAGE, GURI_SERIES } from "./index.ts";

// Synthetic: the API needs a DAHITI key, so no live response has been recorded yet. The payload follows the
// documented download-water-level format (checked 2026-09-24); the values are invented.
const FETCHED = Date.UTC(2026, 8, 24, 12);
const payload = (data: unknown[], id: unknown = "67") =>
	JSON.stringify({
		code: 200,
		message: "Request successful!",
		target: { id, target_name: "Guri, Lake", country: "Venezuela", points: data.length, software: "8.0" },
		data,
	});
const raw = (body: string): RawResponse => ({
	url: DAHITI_API,
	status: 200,
	contentType: "application/json",
	body,
	fetchedAt: FETCHED,
});

const POINTS = [
	{ date: "2026-07-27T22:57:23", wse: 261.5, wse_u: 0.047, data: "sentinel6a 219 110" },
	{ date: "2026-08-06T20:55:54", wse: 262.25, wse_u: 0.003, data: "sentinel6a 219 111" },
	{ date: "2026-08-16T18:54:26", wse: 262.75, wse_u: 0.002, data: "sentinel6a 219 112" },
];

test("normalises every point as a measurement of one series, dates read as UTC", () => {
	const obs = dahitiGuri.normalise([raw(payload(POINTS))]);
	expect(obs).toHaveLength(3);
	const last = obs[2];
	expect(last?.series).toBe(GURI_SERIES);
	expect(last?.observedAt).toBe(Date.UTC(2026, 7, 16, 18, 54, 26));
	expect(last?.value).toEqual({ wseM: 262.75, uncertaintyM: 0.002, mission: "sentinel6a 219 112" });
	expect(last?.basis).toBe("measurement");
	expect(last?.location?.state).toBe("VE-F");
	for (const o of obs) {
		expect(o.source).toBe("dahiti-guri");
		expect(o.sourceUrl).toBe(GURI_PAGE);
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(o.sourceUrl).not.toContain("api_key");
	}
});

test("skips a malformed point, an implausible height and a future date", () => {
	const obs = dahitiGuri.normalise([
		raw(
			payload([
				...POINTS,
				{ date: "2026-08-26", wse: 263, wse_u: 0.01 },
				{ date: "2026-08-20T00:00:00", wse: 9999, wse_u: 0.01 },
				{ date: "2026-12-01T00:00:00", wse: 263, wse_u: 0.01 },
				{ date: "2026-08-21T00:00:00", wse: "263", wse_u: 0.01 },
			]),
		),
	]);
	expect(obs).toHaveLength(3);
});

test("a bad envelope, an error answer or another target throws SchemaError", () => {
	expect(() => dahitiGuri.normalise([raw("<html>")])).toThrow(SchemaError);
	expect(() =>
		dahitiGuri.normalise([
			raw(JSON.stringify({ code: 403, message: "Permission Denied (Invalid format of `api_key`!)!" })),
		]),
	).toThrow(SchemaError);
	expect(() => dahitiGuri.normalise([raw(payload(POINTS, 8813))])).toThrow(SchemaError);
});

test("without the key the feed is locked; with it the key travels only in the POST body", async () => {
	const ctx = (key: string | undefined, calls: { url: string; body?: string }[]) => ({
		http: {
			async request(url: string, opts?: { body?: string }) {
				calls.push({ url, ...(opts?.body !== undefined ? { body: opts.body } : {}) });
				return raw(payload(POINTS));
			},
		},
		key: () => key,
		now: () => FETCHED,
		signal: new AbortController().signal,
	});
	await expect(dahitiGuri.fetch(ctx(undefined, []))).rejects.toBeInstanceOf(MissingKeyError);
	const calls: { url: string; body?: string }[] = [];
	await dahitiGuri.fetch(ctx("abcdef123456", calls));
	expect(calls).toHaveLength(1);
	expect(calls[0]?.url).toBe(DAHITI_API);
	expect(calls[0]?.url).not.toContain("abcdef123456");
	expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
		api_key: "abcdef123456",
		dahiti_id: 67,
		format: "json",
	});
});
