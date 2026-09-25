import { describe, expect, test } from "bun:test";
import { decodeText, HttpClient, parseRetryAfter, USER_AGENT } from "./http.ts";
import { HttpError } from "./types.ts";

function fakeFetch(responses: Array<Response | Error>, seen: Request[] = []): typeof fetch {
	let i = 0;
	const impl = async (input: string | URL | Request, init?: RequestInit) => {
		seen.push(new Request(input, init));
		const next = responses[Math.min(i++, responses.length - 1)];
		if (next instanceof Error) throw next;
		return (next as Response).clone();
	};
	return impl as typeof fetch;
}

const noSleep = async () => {};

describe("HttpClient", () => {
	test("sends the project identity and nothing personal", async () => {
		const seen: Request[] = [];
		const http = new HttpClient({
			fetchImpl: fakeFetch([new Response("ok")], seen),
			sleep: noSleep,
			defaultHostGapMs: 0,
		});
		const raw = await http.request("https://example.org/a");
		expect(raw.body).toBe("ok");
		expect(seen[0]?.headers.get("user-agent")).toBe(USER_AGENT);
		expect(USER_AGENT).toMatch(/^Vigia\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/elberacasa\)$/);
		expect(USER_AGENT).not.toMatch(/@/);
	});

	test("passes the ETag through, and a 304 when the caller accepts it", async () => {
		const http = new HttpClient({
			fetchImpl: fakeFetch([
				new Response("a,b", { headers: { etag: '"abc"', "last-modified": "Thu, 24 Sep 2026 22:54:26 GMT" } }),
				new Response(null, { status: 304 }),
				new Response("x"),
			]),
			sleep: noSleep,
			defaultHostGapMs: 0,
		});
		const first = await http.request("https://example.org/f.csv");
		expect(first.etag).toBe('"abc"');
		expect(first.lastModified).toBe("Thu, 24 Sep 2026 22:54:26 GMT");
		const notModified = await http.request("https://example.org/f.csv", { okStatuses: [304] });
		expect(notModified.status).toBe(304);
		expect(notModified.body).toBe("");
		const plain = await http.request("https://example.org/g");
		expect("etag" in plain || "lastModified" in plain).toBe(false);
	});

	test("retries 503 then succeeds", async () => {
		const http = new HttpClient({
			fetchImpl: fakeFetch([new Response("", { status: 503 }), new Response("fine")]),
			sleep: noSleep,
			defaultHostGapMs: 0,
		});
		expect((await http.request("https://example.org/")).body).toBe("fine");
	});

	test("does not retry 404 and reports the status", async () => {
		const seen: Request[] = [];
		const http = new HttpClient({
			fetchImpl: fakeFetch([new Response("", { status: 404 })], seen),
			sleep: noSleep,
			defaultHostGapMs: 0,
		});
		const error = await http.request("https://example.org/").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(HttpError);
		expect((error as HttpError).status).toBe(404);
		expect(seen.length).toBe(1);
	});

	test("gives up after the retry budget on network errors", async () => {
		const seen: Request[] = [];
		const http = new HttpClient({
			fetchImpl: fakeFetch([new Error("ECONNRESET")], seen),
			sleep: noSleep,
			defaultHostGapMs: 0,
		});
		await expect(http.request("https://example.org/", { retries: 2 })).rejects.toThrow("network");
		expect(seen.length).toBe(3);
	});

	test("refuses bodies over the byte cap", async () => {
		const http = new HttpClient({
			fetchImpl: fakeFetch([new Response("x".repeat(100))]),
			sleep: noSleep,
			defaultHostGapMs: 0,
		});
		await expect(http.request("https://example.org/", { maxBytes: 10 })).rejects.toThrow("exceeded");
	});

	test("readBytes returns the first bytes of an endless body and stops reading", async () => {
		let pulled = 0;
		const endless = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled++;
				controller.enqueue(new Uint8Array(1_000).fill(0xff));
			},
		});
		const http = new HttpClient({
			fetchImpl: (async () =>
				new Response(endless, { headers: { "content-type": "audio/mpeg" } })) as unknown as typeof fetch,
			sleep: noSleep,
			defaultHostGapMs: 0,
		});
		const raw = await http.request("https://radio.example/stream", { readBytes: 2_500, binary: true });
		expect(Buffer.from(raw.body, "base64").byteLength).toBe(2_500);
		expect(raw.contentType).toBe("audio/mpeg");
		expect(pulled).toBeLessThan(6);
	});

	test("paces requests to the same host", async () => {
		const http = new HttpClient({ fetchImpl: fakeFetch([new Response("a")]), defaultHostGapMs: 60 });
		const t0 = performance.now();
		await Promise.all([
			http.request("https://a.org/1"),
			http.request("https://a.org/2"),
			http.request("https://a.org/3"),
		]);
		expect(performance.now() - t0).toBeGreaterThanOrEqual(110);
	});

	test("different hosts are not paced against each other", async () => {
		const http = new HttpClient({ fetchImpl: fakeFetch([new Response("a")]), defaultHostGapMs: 500 });
		const t0 = performance.now();
		await Promise.all([http.request("https://a.org/"), http.request("https://b.org/")]);
		expect(performance.now() - t0).toBeLessThan(300);
	});

	test("a pace key gives requests to the same host their own queue", async () => {
		const http = new HttpClient({ fetchImpl: fakeFetch([new Response("a")]), defaultHostGapMs: 500 });
		const t0 = performance.now();
		await Promise.all([
			http.request("https://a.org/1"),
			http.request("https://a.org/2", { paceKey: "live" }),
		]);
		expect(performance.now() - t0).toBeLessThan(300);
	});
});

describe("decodeText", () => {
	test("decodes ISO-8859-1 declared in the header", () => {
		const bytes = new Uint8Array([0x4d, 0xe9, 0x72, 0x69, 0x64, 0x61]);
		const text = decodeText(
			bytes,
			new Response(null, { headers: { "content-type": "text/xml; charset=ISO-8859-1" } }),
		);
		expect(text).toBe("Mérida");
	});
	test("falls back to the XML declaration", () => {
		const xml = '<?xml version="1.0" encoding="ISO-8859-1"?><a>\xe1</a>';
		const bytes = Uint8Array.from(xml, (c) => c.charCodeAt(0));
		expect(decodeText(bytes, new Response(null))).toContain("<a>á</a>");
	});
	test("defaults to UTF-8", () => {
		const bytes = new TextEncoder().encode("Táchira");
		expect(decodeText(bytes, new Response(null))).toBe("Táchira");
	});
});

describe("parseRetryAfter", () => {
	test("seconds and dates", () => {
		expect(parseRetryAfter("5", 0)).toBe(5000);
		expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
		expect(parseRetryAfter("soon", 0)).toBeNull();
		expect(parseRetryAfter(null, 0)).toBeNull();
	});
});
