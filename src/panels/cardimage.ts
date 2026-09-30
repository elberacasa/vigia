import type { TvLogo } from "../adapters/tv-logos/index.ts";
import type { TvStill } from "../adapters/tv-stills/index.ts";
import type { YoutubeThumb } from "../adapters/youtube-live/index.ts";
import type { StoredObservation } from "../core/store.ts";
import { hamming } from "../imaging/raster.ts";
import { failureWords } from "../media/reason-words.ts";

/**
 * The picture on a TV card, by one stated rule, so a card (and the TV wall) always shows something real and says
 * what it is, and never looks broken:
 *
 * 1. "still": a frame Vigía took of the channel (tv-stills) or YouTube's live thumbnail read by Vigía
 *    (youtube-live), no older than STILL_MAX_AGE_MS, and not one flat colour. Labelled with its time:
 *    "Cuadro de las 14:05" (the UI adds "hace 12 min" from `takenAt`).
 * 2. "logo": the channel's logo (tv-logos) with "Sin cuadro reciente" and why (the signal did not answer, no
 *    decoder on this computer, the frame was black…).
 * 3. "none": neither exists; the UI draws the channel's name (never an empty or broken image).
 *
 * A still older than the budget is never shown as the card's picture, however it is labelled. Every URL is on
 * Vigía's own origin (/api/blobs/…). The time machine asks the same rule at a past moment (stills.ts).
 */

const MIN = 60_000;
/** A still counts for 1.5 × the 30-minute round, like the "EN VIVO" state it sits next to. */
export const STILL_MAX_AGE_MS = 45 * MIN;
/** A frame whose hash has not changed for this long (two rounds and more) is not shown as the channel's picture. */
export const FROZEN_MS = 50 * MIN;

export type CardImage =
	| {
			kind: "still";
			/** Same-origin image URL. */
			url: string;
			width: number;
			height: number;
			/** When the frame was taken (tv-frame) or read from YouTube (youtube-thumbnail), epoch ms. */
			takenAt: number;
			/**
			 * "tv-frame": a frame of the signal; "youtube-thumbnail": YouTube's live thumbnail, changing between reads;
			 * "youtube-cover": the same thumbnail an hour apart, i.e. the channel's fixed cover image, not a live frame.
			 */
			source: "tv-frame" | "youtube-thumbnail" | "youtube-cover";
			/** "Cuadro de las 14:05" / "Miniatura de YouTube de las 14:05" (Venezuelan time). */
			labelEs: string;
			labelEn: string;
			creditEs: string;
			/**
			 * The channel's logo, when it has one: the picture a page falls back to once this still passes the 45-min
			 * budget on its own clock (the panel is cached until new data), instead of the channel's name.
			 */
			logo: CardLogo | null;
	  }
	| {
			kind: "logo";
			url: string;
			width: number;
			height: number;
			labelEs: string;
			labelEn: string;
			/** Why there is no recent frame, when known. */
			whyEs: string | null;
			whyEn: string | null;
			creditEs: string;
	  }
	| { kind: "none"; labelEs: string; labelEn: string; whyEs: string | null; whyEn: string | null };

/** A channel's logo as a fallback picture. */
export type CardLogo = { url: string; width: number; height: number; creditEs: string };

/** HH:MM in Venezuelan time (UTC−4, no daylight saving). */
export function hhmmVet(ms: number): string {
	const d = new Date(ms - 4 * 3_600_000);
	return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

const WHY: Record<string, { es: string; en: string }> = {
	"no-decoder": {
		es: "este equipo no tiene decodificador de video (ffmpeg)",
		en: "this computer has no video decoder (ffmpeg)",
	},
	flat: {
		es: "el último cuadro era de un solo color (pantalla negra)",
		en: "the last frame was one flat colour",
	},
	old: { es: "el último cuadro tiene más de 45 min", en: "the last frame is over 45 min old" },
	"not-live": { es: "el canal no transmite en vivo ahora", en: "the channel is not live now" },
	"not-ts": { es: "formato de video sin cuadro (fMP4)", en: "video format without a frame (fMP4)" },
	codec: { es: "códec de video no compatible", en: "unsupported video codec" },
	"never-taken": { es: "aún no se ha tomado un cuadro", en: "no frame taken yet" },
};

/** Why a card has no recent frame, in words (every probe and decoder code: src/media/reason-words.ts). */
export function why(code: string | null): { whyEs: string | null; whyEn: string | null } {
	if (code === null) return { whyEs: null, whyEn: null };
	const w = (Object.hasOwn(WHY, code) ? WHY[code] : undefined) ?? failureWords(code);
	return { whyEs: w.es, whyEn: w.en };
}

const LOGO_CREDIT = "Logo: iptv-org (lista pública); marca de su canal";

function logoOf(logo: StoredObservation<TvLogo> | null | undefined): CardLogo | null {
	const v = logo?.value;
	return v?.blob && v.width && v.height
		? { url: `/api/blobs/tv-logos/${v.blob}`, width: v.width, height: v.height, creditEs: LOGO_CREDIT }
		: null;
}

function logoOrNone(
	logo: StoredObservation<TvLogo> | null | undefined,
	code: string | null,
): Extract<CardImage, { kind: "logo" | "none" }> {
	const w = why(code);
	const l = logoOf(logo);
	if (l)
		return {
			kind: "logo",
			url: l.url,
			width: l.width,
			height: l.height,
			labelEs: "Sin cuadro reciente",
			labelEn: "No recent frame",
			...w,
			creditEs: l.creditEs,
		};
	return { kind: "none", labelEs: "Sin cuadro reciente", labelEn: "No recent frame", ...w };
}

/** Pure: a directory card's picture from its latest still (tv-stills) and logo (tv-logos). */
export function tvCardImage(
	still: StoredObservation<TvStill> | null | undefined,
	logo: StoredObservation<TvLogo> | null | undefined,
	now: number,
	decoderMissing: boolean,
): CardImage {
	const v = still?.value;
	if (still && v?.blob && v.width && v.height) {
		const age = now - still.observedAt;
		// Rows stored before this field existed have none: treated as changing.
		const unchangedSince = v.unchangedSince ?? null;
		const frozenFor = unchangedSince !== null ? still.observedAt - unchangedSince : 0;
		if (age >= 0 && age <= STILL_MAX_AGE_MS && !v.flat && unchangedSince !== null && frozenFor >= FROZEN_MS) {
			const w = logoOrNone(logo, null);
			const since = hhmmVet(unchangedSince);
			return {
				...w,
				whyEs: `la imagen no cambia desde las ${since} (señal congelada o pantalla fija)`,
				whyEn: `the picture has not changed since ${since} (frozen signal or a still screen)`,
			};
		}
		if (age >= 0 && age <= STILL_MAX_AGE_MS && !v.flat) {
			const t = hhmmVet(still.observedAt);
			return {
				kind: "still",
				url: `/api/blobs/tv-stills/${v.blob}`,
				width: v.width,
				height: v.height,
				takenAt: still.observedAt,
				source: "tv-frame",
				labelEs: `Cuadro de las ${t}`,
				labelEn: `Frame at ${t} (Venezuela)`,
				creditEs: "Imagen: señal de la televisora; cuadro tomado por Vigía",
				logo: logoOf(logo),
			};
		}
		return logoOrNone(logo, v.flat && age <= STILL_MAX_AGE_MS ? "flat" : "old");
	}
	if (still && v) return logoOrNone(logo, now - still.observedAt <= STILL_MAX_AGE_MS ? v.reason : "old");
	return logoOrNone(logo, decoderMissing ? "no-decoder" : "never-taken");
}

/** Two thumbnails at least this far apart with (almost) the same hash: a fixed cover, not a live frame. */
export const COVER_GAP_MS = 50 * MIN;
export const COVER_MAX_BITS = 2;

/**
 * Pure: whether `thumb` is the channel's fixed cover image: an earlier thumbnail of the same channel, read at
 * least COVER_GAP_MS before, has (almost) the same difference hash.
 */
export function isCover(thumb: YoutubeThumb, earlier: readonly YoutubeThumb[]): boolean {
	return earlier.some(
		(e) => thumb.readAt - e.readAt >= COVER_GAP_MS && hamming(e.hash, thumb.hash) <= COVER_MAX_BITS,
	);
}

/** Pure: a curated YouTube card's picture from its latest reading's thumbnail, or the channel's logo. */
export function youtubeCardImage(
	thumb: YoutubeThumb | null,
	live: boolean,
	logo: StoredObservation<TvLogo> | null | undefined,
	now: number,
	earlier: readonly YoutubeThumb[] = [],
): CardImage {
	if (live && thumb) {
		const age = now - thumb.readAt;
		if (age >= 0 && age <= STILL_MAX_AGE_MS) {
			const t = hhmmVet(thumb.readAt);
			const cover = isCover(thumb, earlier);
			return {
				kind: "still",
				url: `/api/blobs/youtube-live/${thumb.blob}`,
				width: thumb.width,
				height: thumb.height,
				takenAt: thumb.readAt,
				source: cover ? "youtube-cover" : "youtube-thumbnail",
				labelEs: cover
					? "Portada fija de la transmisión en YouTube (no es un cuadro en vivo)"
					: `Miniatura de YouTube de las ${t}`,
				labelEn: cover
					? "The stream's fixed cover on YouTube (not a live frame)"
					: `YouTube thumbnail at ${t} (Venezuela)`,
				creditEs: "Imagen: miniatura de YouTube de la transmisión, leída por Vigía",
				logo: logoOf(logo),
			};
		}
		return logoOrNone(logo, "old");
	}
	return logoOrNone(logo, live ? "never-taken" : "not-live");
}
