import type { Region } from "../imaging/raster.ts";

/**
 * A public camera Vigía watches: one its operator publishes for anyone to see (a tourism board's beach cam, a city's
 * skyline cam on the operator's own YouTube channel, a public body's traffic snapshot). Never an unsecured or
 * private camera found by scanning, never a re-stream by someone who is not the operator (the project's hard line on access controls).
 *
 * What Vigía takes from it: one modest still (at most 480 px wide) at a stated cadence, its capture time, a 64-bit
 * difference hash, and the mean brightness of a fixed region of city lights. Never faces, never people, never
 * zoom (the project's hard line on private individuals).
 */

/** How the operator publishes it, which decides how a still is taken (or that none may be). */
export type CameraAccess =
	/** A snapshot URL the operator serves (refreshed by the operator every N seconds). */
	| { readonly type: "jpeg"; readonly url: string }
	/** An HLS stream the operator publishes openly (no key, no Referer, no cookie). */
	| { readonly type: "hls"; readonly url: string }
	/** The operator's own 24/7 stream on YouTube: played in YouTube's embedded player; no still is taken. */
	| { readonly type: "youtube"; readonly channelId: string; readonly videoId: string }
	/** Plays only in the operator's page or player: shown with a link, no still is taken. */
	| { readonly type: "embed"; readonly url: string }
	/** Listed on Windy Webcams: needs the user's own free Windy key (locked without it). */
	| { readonly type: "windy"; readonly id: string };

export type CameraKind =
	| "skyline"
	| "beach"
	| "border"
	| "port"
	| "airport"
	| "traffic"
	| "weather"
	| "sky"
	| "nature"
	| "other";

export type CameraSpec = {
	/** Stable slug: the entity is `cam.<id>`, the series `cam:<id>`. */
	readonly id: string;
	readonly name: { readonly es: string; readonly en: string };
	readonly kind: CameraKind;
	/** Who publishes it (an organisation; never a private person). */
	readonly operator: { readonly name: string; readonly url: string };
	/** A page a person can open to see the camera at its operator. */
	readonly page: string;
	readonly lat: number;
	readonly lon: number;
	/** How the position was established ("operator's page", "landmarks in view: …"). */
	readonly positionFrom: string;
	/** Compass direction the camera faces (0 = north), or null when unknown. */
	readonly headingDeg: number | null;
	readonly headingFrom: string | null;
	/** What it shows, in a sentence. */
	readonly view: { readonly es: string; readonly en: string };
	/** ISO 3166-1 alpha-2 of the country the camera is in. */
	readonly country: string;
	readonly access: CameraAccess;
	/** How often a still is taken; never faster than the operator refreshes it. */
	readonly stillEveryMs: number;
	/** The operator's terms as read on the day it was added, and whether they let Vigía keep a still. */
	readonly terms: { readonly url: string; readonly note: string; readonly stills: boolean };
	/**
	 * The part of the view that is city lights at night (fractions of the image), measured for the "cámaras
	 * públicas" brightness signal; null when the view has none worth measuring (sea, sky, a lit-up bridge).
	 */
	readonly lights: { readonly region: Region; readonly what: string } | null;
	/** How it was verified live, with the date. */
	readonly verified: string;
};
