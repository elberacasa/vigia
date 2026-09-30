import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "../../core/blobs.ts";
import { loadFixture } from "../../core/fixtures.ts";
import type { FetchContext, RawResponse } from "../../core/types.ts";
import { encodePng } from "../../imaging/raster.ts";
import { useResolver } from "../../media/public-host.ts";
import { LOGO_BOX, logoName, pickLogo, tvLogos } from "./index.ts";

/** No DNS in tests: every *.example host is a public address, intranet.example a private one. */
useResolver(async (host) => (host.startsWith("intranet.") ? ["10.0.0.5"] : ["93.184.215.14"]));

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const logo = (over: Record<string, unknown>) => ({
	channel: "CanalEjemplo.ve",
	feed: null,
	in_use: true,
	tags: [],
	width: 512,
	height: 512,
	format: "PNG",
	url: "https://img.example/a.png",
	...over,
});

test("pickLogo: in use, the channel's own, PNG or JPEG over HTTPS, nearest 256 px wide", () => {
	const logos = [
		logo({ url: "https://img.example/feed.png", feed: "HD", width: 256 }),
		logo({ url: "https://img.example/old.png", in_use: false, width: 256 }),
		logo({ url: "https://img.example/logo.svg", format: "SVG", width: 256 }),
		logo({ url: "http://img.example/plain.png", width: 256 }),
		logo({ url: "https://img.example/big.png", width: 1024 }),
		logo({ url: "https://img.example/right.jpg", format: "JPEG", width: 300 }),
		logo({ channel: "Otro.ve", url: "https://img.example/other.png", width: 256 }),
	].map((l) => ({ ...l, feed: l.feed as string | null, format: l.format as string | null }));
	expect(pickLogo(logos, "CanalEjemplo.ve")?.url).toBe("https://img.example/right.jpg");
	expect(pickLogo(logos, "Nadie.ve")).toBeNull();
});

test("fetch: each logo is downloaded once, re-encoded by Vigía within 256 × 144, and served from our store", async () => {
	const dir = mkdtempSync(join(tmpdir(), "vigia-logos-"));
	dirs.push(dir);
	const store = new BlobStore(dir);
	const blobs = store.scope("tv-logos", tvLogos.blobs ?? { maxEntries: 1, maxBytes: 1, maxAgeMs: null });
	const catalog = loadFixture(join(import.meta.dir, "..", "iptv-ve", "fixtures", "2026-09-28"));
	// A 600 × 300 red image with a remote-only trailer after its end, which must not survive.
	const img = { width: 600, height: 300, data: new Uint8Array(600 * 300 * 4).fill(200) };
	const remote = new Uint8Array([...encodePng(img), ...new TextEncoder().encode("<script>x</script>")]);
	const asked: string[] = [];
	const ctx: FetchContext = {
		http: {
			async request(url, options = {}) {
				asked.push(url);
				const file = catalog.find((r) => r.url === url);
				if (file) return file;
				if (url.endsWith("/logos.json")) {
					const channels = JSON.parse(
						catalog.find((r) => r.url.endsWith("/channels.json"))?.body ?? "[]",
					) as {
						id: string;
					}[];
					const list = channels.map((c) => logo({ channel: c.id, url: `https://img.example/${c.id}.png` }));
					if (options.headers?.["if-none-match"])
						return { url, status: 304, contentType: "", body: "", fetchedAt: 1 } satisfies RawResponse;
					return {
						url,
						status: 200,
						contentType: "application/json",
						body: JSON.stringify(list),
						etag: "W/1",
						fetchedAt: 1,
					};
				}
				return {
					url,
					status: 200,
					contentType: "image/png",
					body: Buffer.from(remote).toString("base64"),
					fetchedAt: 1,
				};
			},
		},
		key: () => undefined,
		now: () => 10_000,
		signal: new AbortController().signal,
		blobs,
	};
	const first = tvLogos.normalise(await tvLogos.fetch(ctx));
	const images = asked.filter((u) => u.startsWith("https://img.example/"));
	expect(images.length).toBeGreaterThan(20);
	expect(first.length).toBe(images.length);
	const one = first[0];
	expect(one?.value.blob).toBeTruthy();
	expect(one?.value.width).toBe(LOGO_BOX.width);
	expect(one?.value.height).toBe(128);
	const stored = store.read("tv-logos", one?.value.blob ?? "");
	const bytes = new Uint8Array(await Bun.file(stored?.path ?? "").arrayBuffer());
	expect(new TextDecoder().decode(bytes)).not.toContain("<script>");
	expect(stored?.meta.name).toBe(logoName(one?.value.channel ?? ""));

	// Second run: logos.json answers 304, no image is downloaded again, the observations are identical.
	asked.length = 0;
	const second = tvLogos.normalise(await tvLogos.fetch(ctx));
	expect(asked.filter((u) => u.startsWith("https://img.example/"))).toEqual([]);
	expect(second.map((o) => [o.series, o.observedAt, o.value])).toEqual(
		first.map((o) => [o.series, o.observedAt, o.value]),
	);
});
