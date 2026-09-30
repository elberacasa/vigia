import { expect, test } from "bun:test";
import type { FetchContext, HttpLike, RequestOptions } from "../core/types.ts";
import { probeAudio, probeHls } from "./probe.ts";
import { useResolver } from "./public-host.ts";

// "intranet.example.org" resolves to a private address, everything else to a public one; no network is used.
useResolver(async (host) => (host.startsWith("intranet.") ? ["10.0.0.5"] : ["93.184.215.14"]));

/** A client that records every URL it is asked for and answers from `routes` (a redirect when given a Location). */
function harness(routes: Record<string, { status: number; body?: string; location?: string }>) {
	const asked: string[] = [];
	const http: HttpLike = {
		async request(url: string, options?: RequestOptions) {
			asked.push(url);
			const r = routes[url] ?? { status: 404 };
			if (r.status >= 400) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
			return {
				url,
				status: r.status,
				contentType: "application/vnd.apple.mpegurl",
				body: r.body ?? "",
				fetchedAt: 1,
				headers: { ...(r.location ? { location: r.location } : {}) },
				...(options?.binary ? {} : {}),
			};
		},
	};
	const ctx: FetchContext = {
		http,
		key: () => undefined,
		now: () => 1,
		signal: new AbortController().signal,
	};
	return { asked, ctx };
}

// Whole-release review, M7: a listed stream on file:, a private or link-local address, or one that redirects there,
// was fetched and its content type and size published. None of these is ever asked for now.
test("probes never ask a file:, private, loopback or link-local URL, directly or through a redirect", async () => {
	for (const url of [
		"file:///etc/hostname",
		"http://127.0.0.1:8080/live.m3u8",
		"http://169.254.169.254/latest/meta-data/",
		"http://10.0.0.5/stream.m3u8",
		"http://intranet.example.org/live.m3u8",
		"http://0x7f.1/live.m3u8",
	]) {
		const h = harness({});
		const tv = await probeHls(url, h.ctx);
		expect({ url, asked: h.asked, error: tv.error }).toEqual({ url, asked: [], error: "private-host" });
		expect(tv.origins).toEqual([]);
		const radio = await probeAudio(url, h.ctx);
		expect({ url, asked: h.asked, error: radio.error }).toEqual({ url, asked: [], error: "private-host" });
	}
	const redirected = harness({
		"https://cdn.example.org/live.m3u8": { status: 302, location: "http://127.0.0.1:9000/internal-admin" },
	});
	const r = await probeHls("https://cdn.example.org/live.m3u8", redirected.ctx);
	expect(redirected.asked).toEqual(["https://cdn.example.org/live.m3u8"]);
	expect(r.error).toBe("private-host");
});

test("only origins actually fetched are recorded, not every variant a master playlist lists (review B2)", async () => {
	const variants = Array.from(
		{ length: 50 },
		(_, i) => `#EXT-X-STREAM-INF:BANDWIDTH=${(i + 1) * 100_000}\nhttps://v${i}.example.org/${i}.m3u8`,
	).join("\n");
	const h = harness({
		"https://cdn.example.org/master.m3u8": { status: 200, body: `#EXTM3U\n${variants}` },
	});
	const probe = await probeHls("https://cdn.example.org/master.m3u8", h.ctx);
	// The master and the cheapest variant were asked (the variant 404s here); nothing else is recorded.
	expect(probe.origins.length).toBeLessThanOrEqual(2);
	expect(probe.origins).toContain("https://cdn.example.org");
});
