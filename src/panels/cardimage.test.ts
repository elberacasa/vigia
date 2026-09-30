import { expect, test } from "bun:test";
import type { TvLogo } from "../adapters/tv-logos/index.ts";
import type { TvStill } from "../adapters/tv-stills/index.ts";
import { trimThumb, type YoutubeThumb } from "../adapters/youtube-live/index.ts";
import type { StoredObservation } from "../core/store.ts";
import type { Json } from "../core/types.ts";
import type { Rgba } from "../imaging/raster.ts";
import { FAILURE_CODES, failureWords, knownFailure } from "../media/reason-words.ts";
import {
	COVER_GAP_MS,
	hhmmVet,
	isCover,
	STILL_MAX_AGE_MS,
	tvCardImage,
	why,
	youtubeCardImage,
} from "./cardimage.ts";

const T = Date.UTC(2026, 8, 29, 18, 5); // 14:05 in Venezuela
const MIN = 60_000;

function stored<V extends Json>(value: V, observedAt: number): StoredObservation<V> {
	return {
		id: 1,
		source: "x",
		series: "s",
		sourceUrl: "https://x.example",
		fetchedAt: observedAt,
		observedAt,
		licence: "l",
		value,
		confidence: 1,
		basis: "measurement",
	} as unknown as StoredObservation<V>;
}
const still = (over: Partial<TvStill> = {}, at = T): StoredObservation<TvStill> =>
	stored<TvStill>(
		{
			kind: "still",
			entry: "e",
			channel: "C.ve",
			blob: "s1-a-0123456789abcdef",
			width: 480,
			height: 270,
			jpegBytes: 20_000,
			reason: null,
			lumaMean: 90,
			lumaSd: 50,
			flat: false,
			hash: "0123456789abcdef",
			unchangedSince: null,
			bytes: 70_000,
			ms: 900,
			cpuMs: 40,
			...over,
		},
		at,
	);
const logo = stored<TvLogo>(
	{
		channel: "C.ve",
		blob: "l1-0123456789abcdef",
		width: 256,
		height: 128,
		url: "https://img.example/c.png",
		reason: null,
	},
	T - 86_400_000,
);

test("a fresh frame is the picture, labelled with its Venezuelan time", () => {
	expect(hhmmVet(T)).toBe("14:05");
	const img = tvCardImage(still(), logo, T + 12 * MIN, false);
	expect(img).toMatchObject({
		kind: "still",
		url: "/api/blobs/tv-stills/s1-a-0123456789abcdef",
		takenAt: T,
		source: "tv-frame",
		labelEs: "Cuadro de las 14:05",
	});
});

test("never a stale, black or missing frame as the picture: the logo says why, else the name", () => {
	expect(tvCardImage(still(), logo, T + STILL_MAX_AGE_MS + 1, false)).toMatchObject({
		kind: "logo",
		labelEs: "Sin cuadro reciente",
		whyEs: "el último cuadro tiene más de 45 min",
		url: "/api/blobs/tv-logos/l1-0123456789abcdef",
	});
	expect(tvCardImage(still({ flat: true }), logo, T + MIN, false)).toMatchObject({
		kind: "logo",
		whyEs: expect.stringContaining("un solo color"),
	});
	expect(
		tvCardImage(still({ blob: null, width: null, height: null, reason: "http-404" }), logo, T + MIN, false),
	).toMatchObject({ kind: "logo", whyEs: "la dirección de la señal ya no existe (404)" });
	expect(tvCardImage(null, logo, T, true)).toMatchObject({
		kind: "logo",
		whyEs: expect.stringContaining("ffmpeg"),
	});
	expect(tvCardImage(null, null, T, false)).toEqual({
		kind: "none",
		labelEs: "Sin cuadro reciente",
		labelEn: "No recent frame",
		whyEs: "aún no se ha tomado un cuadro",
		whyEn: "no frame taken yet",
	});
	// A frame from the future (clock skew) is not shown either.
	expect(tvCardImage(still({}, T + 10 * MIN), logo, T, false).kind).toBe("logo");
});

const thumb = (readAt: number, hash = "00ff00ff00ff00ff"): YoutubeThumb => ({
	blob: "y1-a-0123456789abcdef",
	width: 480,
	height: 270,
	readAt,
	hash,
});

test("YouTube: a live thumbnail is the picture; the same one an hour apart is a fixed cover, said so", () => {
	expect(youtubeCardImage(thumb(T), true, logo, T + MIN)).toMatchObject({
		kind: "still",
		source: "youtube-thumbnail",
		labelEs: "Miniatura de YouTube de las 14:05",
	});
	const earlier = [thumb(T - COVER_GAP_MS, "00ff00ff00ff00fe")];
	expect(isCover(thumb(T), earlier)).toBe(true);
	expect(youtubeCardImage(thumb(T), true, logo, T + MIN, earlier)).toMatchObject({
		kind: "still",
		source: "youtube-cover",
		labelEs: expect.stringContaining("no es un cuadro en vivo"),
	});
	// Changed thumbnails, or the same one only minutes apart, are frames.
	expect(isCover(thumb(T), [thumb(T - COVER_GAP_MS, "ff00ff00ff00ff00")])).toBe(false);
	expect(isCover(thumb(T), [thumb(T - 10 * MIN)])).toBe(false);
	expect(youtubeCardImage(null, false, logo, T)).toMatchObject({
		kind: "logo",
		whyEs: "el canal no transmite en vivo ahora",
	});
	expect(youtubeCardImage(thumb(T), true, null, T + STILL_MAX_AGE_MS + 1).kind).toBe("none");
});

test("YouTube's 4:3 thumbnail loses its black bars; a full 4:3 picture is kept whole", () => {
	const make = (bars: boolean): Rgba => {
		const data = new Uint8Array(640 * 480 * 4);
		for (let y = 0; y < 480; y++)
			for (let x = 0; x < 640; x++) {
				const bar = bars && (y < 60 || y >= 420);
				data.set(bar ? [0, 0, 0, 255] : [(x * 7) % 256, (y * 3) % 256, 120, 255], (y * 640 + x) * 4);
			}
		return { width: 640, height: 480, data };
	};
	expect([trimThumb(make(true)).width, trimThumb(make(true)).height]).toEqual([480, 270]);
	expect([trimThumb(make(false)).width, trimThumb(make(false)).height]).toEqual([480, 360]);
});

test("a frame unchanged for 50 min or more is not the picture: the logo says since when", () => {
	const img = tvCardImage(still({ unchangedSince: T - 60 * MIN }), logo, T + MIN, false);
	expect(img).toMatchObject({ kind: "logo", whyEs: expect.stringContaining("no cambia desde las 13:05") });
	expect(tvCardImage(still({ unchangedSince: T - 30 * MIN }), logo, T + MIN, false).kind).toBe("still");
});

test("a still carries the channel's logo, the picture a page falls back to once the still ages past 45 min", () => {
	expect(tvCardImage(still(), logo, T + MIN, false)).toMatchObject({
		kind: "still",
		logo: { url: "/api/blobs/tv-logos/l1-0123456789abcdef", width: 256, height: 128 },
	});
	expect(tvCardImage(still(), null, T + MIN, false)).toMatchObject({ kind: "still", logo: null });
	expect(youtubeCardImage(thumb(T), true, logo, T + MIN)).toMatchObject({
		kind: "still",
		logo: { url: "/api/blobs/tv-logos/l1-0123456789abcdef" },
	});
});

test("every probe and decoder code is said in words, never echoed raw (es and en)", () => {
	const seen = [
		...FAILURE_CODES,
		"http-403",
		"http-404",
		"http-502",
		"http-530",
		"segment-http-502",
		"something-new",
		// Keys every plain object inherits are codes like any other: words, never a function.
		"constructor",
		"toString",
		"__proto__",
	];
	for (const code of seen) {
		const w = why(code);
		for (const text of [w.whyEs, w.whyEn]) {
			expect(text).toBeTruthy();
			// No code of the table (nor the one asked about) appears in the words.
			for (const c of seen.filter((x) => x.includes("-"))) expect(text).not.toContain(c);
			expect(text).not.toContain(`(${code})`);
		}
	}
	expect(why("private-host").whyEs).toBe(
		"la señal apunta a una dirección privada o no pública, que Vigía no abre",
	);
	expect(why("ended").whyEn).toBe("the broadcast ended (its playlist is closed)");
	expect(why("http-404").whyEs).toContain("ya no existe (404)");
	expect(why("segment-http-502").whyEs).toBe("el servidor del video falló (error 502)");
	expect(failureWords("something-new")).toEqual({
		es: "no se pudo tomar un cuadro",
		en: "no frame could be taken",
	});
	expect(knownFailure("tls")).toBe(true);
	expect(knownFailure("something-new")).toBe(false);
	expect(why(null)).toEqual({ whyEs: null, whyEn: null });
});
