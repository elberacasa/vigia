import { afterAll, describe, expect, test } from "bun:test";
import { brotliCompressSync, constants, deflateRawSync, deflateSync, gzipSync } from "node:zlib";
import { SafeHttp } from "../userfeeds/net.ts";
import { BodyError, codingOf, readBody } from "./body.ts";
import { HttpClient } from "./http.ts";

/* Review 4 H2: bombs, served by a real server to the real fetch, so Bun's own decoding is what is being tested. */

const DECODED_MB = 64;
const CAP = 1024 * 1024;
const zeros = Buffer.alloc(DECODED_MB * 1024 * 1024);
const BOMBS: Record<string, Uint8Array<ArrayBuffer>> = {
	zstd: new Uint8Array(Bun.zstdCompressSync(zeros, { level: 19 })),
	br: brotliCompressSync(zeros, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }),
	gzip: gzipSync(zeros, { level: 9 }),
	deflate: deflateSync(zeros, { level: 9 }),
};
const seenEncodings: string[] = [];
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch(req) {
		seenEncodings.push(req.headers.get("accept-encoding") ?? "");
		const coding = new URL(req.url).pathname.slice(1);
		const body = BOMBS[coding];
		if (!body) return new Response("<rss/>", { headers: { "content-type": "application/rss+xml" } });
		return new Response(body, { headers: { "content-encoding": coding } });
	},
});
afterAll(() => server.stop(true));
const base = `http://127.0.0.1:${server.port}`;

/** Peak resident-set rise while `run` executes, sampled every 2 ms. */
async function peakRise(run: () => Promise<unknown>): Promise<number> {
	Bun.gc(true);
	const before = process.memoryUsage().rss;
	let peak = before;
	const timer = setInterval(() => {
		peak = Math.max(peak, process.memoryUsage().rss);
	}, 2);
	try {
		await run();
	} finally {
		clearInterval(timer);
	}
	return Math.max(peak, process.memoryUsage().rss) - before;
}

const MB = 1024 * 1024;

describe("decompression bombs (review 4 H2)", () => {
	test("the bombs really are bombs: tiny bodies, 64 MB decoded", () => {
		expect(BOMBS.zstd?.byteLength).toBeLessThan(64 * 1024);
		expect(BOMBS.br?.byteLength).toBeLessThan(256 * 1024);
		expect(BOMBS.gzip?.byteLength).toBeLessThan(CAP);
	});

	test("HttpClient refuses zstd and brotli without decoding them, and advertises only gzip and deflate", async () => {
		const http = new HttpClient({ defaultHostGapMs: 0 });
		for (const coding of ["zstd", "br"]) {
			let error: unknown;
			const rise = await peakRise(() =>
				http.request(`${base}/${coding}`, { retries: 0, maxBytes: CAP }).catch((e: unknown) => {
					error = e;
				}),
			);
			expect(String(error)).toContain(`unsupported content-encoding: ${coding}`);
			expect(rise).toBeLessThan(24 * MB);
		}
		expect(seenEncodings.at(-1)).toBe("gzip, deflate");
	});

	test("HttpClient stops a gzip or deflate bomb as soon as the decoded size passes the cap", async () => {
		const http = new HttpClient({ defaultHostGapMs: 0 });
		for (const coding of ["gzip", "deflate"]) {
			let error: unknown;
			const rise = await peakRise(() =>
				http.request(`${base}/${coding}`, { retries: 0, maxBytes: CAP }).catch((e: unknown) => {
					error = e;
				}),
			);
			expect(String(error)).toContain(`exceeded ${CAP} bytes`);
			expect(rise).toBeLessThan(24 * MB);
		}
	});

	test("SafeHttp (user feeds) refuses zstd and brotli and caps gzip, with Spanish errors and bounded memory", async () => {
		const fetchImpl = ((url: string, init: RequestInit) => {
			const u = new URL(url);
			u.hostname = "127.0.0.1";
			u.port = String(server.port);
			u.protocol = "http:";
			return fetch(u.toString(), init);
		}) as typeof fetch;
		const http = new SafeHttp({
			fetchImpl,
			resolve: async () => ["93.184.215.14"],
			hostGapMs: 0,
			maxBytes: CAP,
		});
		for (const [coding, message] of [
			["zstd", /compresión no admitida/],
			["br", /compresión no admitida/],
			["gzip", /pesa más/],
			["deflate", /pesa más/],
		] as const) {
			let error: unknown;
			const rise = await peakRise(() =>
				http.get(`http://feeds.example/${coding}`).catch((e: unknown) => {
					error = e;
				}),
			);
			expect(String(error)).toMatch(message);
			expect(rise).toBeLessThan(24 * MB);
		}
		expect(seenEncodings.at(-1)).toBe("gzip, deflate");
		expect((await http.get("http://feeds.example/plain")).body).toBe("<rss/>");
	});
});

describe("readBody", () => {
	const text = "Hola, Venezuela. ".repeat(500);
	const bytes = new TextEncoder().encode(text);
	const decode = (b: Uint8Array) => new TextDecoder().decode(b);
	const res = (body: Uint8Array<ArrayBuffer> | string, coding?: string) =>
		new Response(body, coding ? { headers: { "content-encoding": coding } } : {});

	test("decodes gzip, x-gzip, zlib deflate and raw deflate", async () => {
		expect(decode(await readBody(res(gzipSync(bytes), "gzip"), { maxBytes: CAP }))).toBe(text);
		expect(decode(await readBody(res(gzipSync(bytes), "x-gzip"), { maxBytes: CAP }))).toBe(text);
		expect(decode(await readBody(res(deflateSync(bytes), "deflate"), { maxBytes: CAP }))).toBe(text);
		expect(decode(await readBody(res(deflateRawSync(bytes), "deflate"), { maxBytes: CAP }))).toBe(text);
		expect(decode(await readBody(res(bytes, "identity"), { maxBytes: CAP }))).toBe(text);
	});

	test("a corrupt compressed body is a clean error", async () => {
		const error = await readBody(res("definitely not gzip", "gzip"), { maxBytes: CAP }).catch(
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(BodyError);
		expect((error as BodyError).kind).toBe("corrupt");
	});

	test("truncate returns exactly the first bytes, decoded", async () => {
		const out = await readBody(res(gzipSync(bytes), "gzip"), { maxBytes: 100, truncate: true });
		expect(decode(out)).toBe(text.slice(0, 100));
	});

	test("codingOf refuses stacked and unknown codings", () => {
		expect(codingOf(null)).toBe("identity");
		expect(codingOf("GZIP")).toBe("gzip");
		expect(() => codingOf("gzip, gzip")).toThrow(BodyError);
		expect(() => codingOf("zstd")).toThrow(/zstd/);
		expect(() => codingOf("compress")).toThrow(BodyError);
	});
});
