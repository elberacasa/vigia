import { expect, test } from "bun:test";
import { Store } from "../core/store.ts";
import type { Json, Observation } from "../core/types.ts";
import {
	MAX_CSP_BYTES,
	MAX_ORIGINS,
	MAX_ORIGINS_PER_READING,
	mediaOrigins,
	pageCsp,
	pageCspSource,
	STATIC_CSP,
} from "./media-csp.ts";

test("the static policy is the one every response had before the directories", () => {
	expect(STATIC_CSP).toBe(
		"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; " +
			"connect-src 'self'; font-src 'self'; frame-src https://www.youtube-nocookie.com; media-src 'self' " +
			"https://guri.tepuyserver.net https://tx.feyalegrianoticias.com; frame-ancestors 'none'; base-uri 'none'; " +
			"form-action 'self'",
	);
});

const NOW = Date.parse("2026-09-28T22:00:00Z");
const obs = (source: string, series: string, value: Json, at = NOW - 60_000): Observation => ({
	source,
	series,
	sourceUrl: "https://example.org/",
	fetchedAt: at,
	observedAt: at,
	licence: "x",
	value,
	confidence: 1,
	basis: "measurement",
});

test("origins: HLS with open CORS may be fetched, without it only played; a day-old probe and a crafted value are ignored", () => {
	const store = new Store(":memory:");
	store.insert([
		obs("iptv-ve-probe", "tv:a", {
			https: true,
			cors: true,
			origins: ["https://a.example.org"],
			state: "live",
		}),
		obs("iptv-ve-probe", "tv:b", {
			https: true,
			cors: false,
			origins: ["https://B.example.org:8443"],
			state: "live",
		}),
		obs("iptv-ve-probe", "tv:c", {
			https: false,
			cors: true,
			origins: ["http://45.173.198.59:8080"],
			state: "live",
		}),
		obs(
			"iptv-ve-probe",
			"tv:old",
			{ https: true, cors: true, origins: ["https://old.example.org"] },
			NOW - 25 * 3_600_000,
		),
		obs("iptv-ve-probe", "tv:evil", {
			https: true,
			cors: true,
			origins: ["https://x.example.org; script-src *", "javascript:alert(1)", "*"],
		}),
		obs("radio-browser-probe", "rbp:1", {
			kind: "audio",
			https: true,
			cors: null,
			origins: ["https://radio.example.net"],
			state: "live",
		}),
		obs("radio-browser-probe", "rbp:2", {
			kind: "hls",
			https: true,
			cors: true,
			origins: ["https://hls.example.net"],
			state: "live",
		}),
	]);
	expect(mediaOrigins(store, NOW)).toEqual({
		media: [
			"http://45.173.198.59:8080",
			"https://a.example.org",
			"https://b.example.org:8443",
			"https://hls.example.net",
			"https://radio.example.net",
		],
		connect: ["http://45.173.198.59:8080", "https://a.example.org", "https://hls.example.net"],
	});
	const csp = pageCsp(mediaOrigins(store, NOW));
	expect(csp).not.toMatch(/\*|old\.example|javascript/);
	expect(csp).toContain("script-src 'self';");
	expect(csp).toContain(
		"media-src 'self' https://guri.tepuyserver.net https://tx.feyalegrianoticias.com blob: http://45",
	);
});

test("no probes: the page policy is the static one plus Windy's player; recomputed at most once a minute", () => {
	const store = new Store(":memory:");
	const page = STATIC_CSP.replace(
		"frame-src https://www.youtube-nocookie.com;",
		"frame-src https://www.youtube-nocookie.com https://webcams.windy.com/webcams/public/embed/player/;",
	);
	expect(pageCsp(mediaOrigins(store, NOW))).toBe(page);
	let t = NOW;
	const source = pageCspSource(store, () => t);
	expect(source()).toBe(page);
	store.insert([
		obs("iptv-ve-probe", "tv:a", {
			https: true,
			cors: true,
			origins: ["https://a.example.org"],
			state: "live",
		}),
	]);
	t += 30_000;
	expect(source()).toBe(page);
	t += 31_000;
	expect(source()).toContain("https://a.example.org");
});

test("one listing cannot take the page down: private hosts, dead readings and floods of origins are kept out (review B2)", () => {
	const store = new Store(":memory:");
	const flood = Array.from({ length: 3_723 }, (_, i) => `https://v${i}.example.org`);
	store.insert([
		obs("iptv-ve-probe", "tv:private", {
			https: false,
			cors: true,
			origins: ["http://127.0.0.1:9000", "http://169.254.169.254", "http://10.0.0.5", "https://cam.local"],
			state: "live",
		}),
		obs("iptv-ve-probe", "tv:dead", {
			https: true,
			cors: true,
			origins: ["https://dead.example.org"],
			state: "not-live",
		}),
		...Array.from({ length: 3 }, (_, i) =>
			obs("radio-browser-probe", `rbp:flood${i}`, {
				kind: "hls",
				https: true,
				cors: true,
				origins: flood,
				state: "live",
			}),
		),
	]);
	const o = mediaOrigins(store, NOW);
	expect(o.media.join(" ")).not.toMatch(/127\.0\.0\.1|169\.254|10\.0\.0\.5|\.local|dead\.example/);
	// Three readings of the same 3,723 hosts: at most 4 each.
	expect(o.media.length).toBeLessThanOrEqual(MAX_ORIGINS_PER_READING);
	expect(Buffer.byteLength(pageCsp(o))).toBeLessThan(MAX_CSP_BYTES);

	// Even a store full of distinct live readings stays under the total cap and the byte limit.
	const many = new Store(":memory:");
	many.insert(
		Array.from({ length: 1_000 }, (_, i) =>
			obs("iptv-ve-probe", `tv:${i}`, {
				https: true,
				cors: true,
				origins: [`https://host-${i}-with-a-long-name.example.org`],
				state: "live",
			}),
		),
	);
	const m = mediaOrigins(many, NOW);
	expect(m.media.length).toBe(MAX_ORIGINS);
	const csp = pageCsp(m);
	expect(Buffer.byteLength(csp)).toBeLessThanOrEqual(MAX_CSP_BYTES);
	expect(csp).toContain("script-src 'self';");
});
