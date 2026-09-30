/**
 * Public cameras and TV card pictures, the page's side of the server's image rules (src/panels/cameras.ts,
 * src/panels/cardimage.ts), pure and tested (cameras.test.ts). Panels are cached until new data, so the page
 * re-checks a picture's age against its own clock: a still older than its budget is never shown as the current
 * picture, whatever its label says. Every picture is on Vigía's own origin (/api/blobs/…).
 */
import { clock, type Lang, stamp } from "./format.ts";

const tr = (l: Lang, es: string, en: string) => (l === "es" ? es : en);
const MIN = 60_000;

/* ---------- Cameras (`/api/panels/cameras`) ---------- */

export type CameraStatus = "live" | "down" | "frozen" | "stale" | "unmeasured" | "no-stills" | "locked";

export interface CameraImage {
	url: string;
	width: number;
	height: number;
	takenAt: number;
	labelEs: string;
	labelEn: string;
}

export type CameraPlay =
	| { type: "youtube"; channelId?: string; videoId: string | null }
	| { type: "embed"; url: string }
	| { type: "hls"; url: string }
	| { type: "link"; url: string };

export interface CameraNight {
	status: string;
	current: number | null;
	baseline: number | null;
	ratio: number | null;
	nights: number;
	statusEs: string;
}

export interface CameraCard {
	id: string;
	entity: string;
	origin: "census" | "windy";
	name: { es: string; en: string };
	kind: string;
	operator: { name: string; url: string | null };
	page: string | null;
	lat: number;
	lon: number;
	headingDeg: number | null;
	country: string;
	state: string | null;
	municipality: string | null;
	view: { es: string; en: string };
	play: CameraPlay | null;
	status: CameraStatus;
	statusEs: string;
	statusEn: string;
	since: number | null;
	detail: string | null;
	image: CameraImage | null;
	last: CameraImage | null;
	cadenceMs: number;
	night: CameraNight | null;
	terms: { url: string | null; note: string } | null;
	verified: string | null;
	creditEs: string;
	creditUrl: string | null;
}

export interface CamerasView {
	cameras: CameraCard[];
	counts: Record<string, number>;
	dark: string[];
	rules: { es: string[]; en: string[] };
	limits: { es: string; en: string };
	source: { id: string; licence: string; attribution: string };
}

/** The picture shown as the camera's current one: only while live, and only within 2 × its cadence + 5 min. */
export function currentStill(
	c: Pick<CameraCard, "status" | "image" | "cadenceMs">,
	now: number,
): CameraImage | null {
	if (c.status !== "live" || !c.image) return null;
	return now - c.image.takenAt <= 2 * c.cadenceMs + 5 * MIN ? c.image : null;
}

/** The last picture kept, shown dimmed as "Última imagen: 14:05" when there is no current one (never as current). */
export function lastStill(
	c: Pick<CameraCard, "status" | "image" | "last" | "cadenceMs">,
	now: number,
): CameraImage | null {
	if (currentStill(c, now)) return null;
	return c.last ?? c.image ?? null;
}

export type CamTone = "live" | "down" | "frozen" | "muted" | "outside";

/** The state word's shape and tone: live, down and frozen are status words; the rest are quiet. */
export function camTone(s: CameraStatus): CamTone {
	if (s === "live") return "live";
	if (s === "down") return "down";
	if (s === "frozen") return "frozen";
	if (s === "no-stills") return "outside";
	return "muted";
}

/** "Cámara caída desde las 14:05" (a start over 20 h ago says its date): the server's word, with when it began. */
export function statusLine(
	c: Pick<CameraCard, "statusEs" | "statusEn" | "since">,
	l: Lang,
	now: number = Date.now(),
): string {
	const word = l === "es" ? c.statusEs : c.statusEn;
	if (!c.since) return word;
	const when = now - c.since > 20 * 3_600_000 ? stamp(c.since, l, now) : clock(c.since, l);
	return now - c.since > 20 * 3_600_000
		? tr(l, `${word} desde el ${when}`, `${word} since ${when}`)
		: tr(l, `${word} desde las ${when}`, `${word} since ${when}`);
}

/**
 * The card as the page shows it now: a camera the server called live whose picture has aged past its budget on this
 * clock (the view is cached until new data) reads "Sin imagen reciente", not "En vivo", and drops its night reading.
 */
export function clientCard<
	C extends Pick<CameraCard, "status" | "statusEs" | "statusEn" | "image" | "cadenceMs" | "night">,
>(c: C, now: number): C {
	if (c.status !== "live" || currentStill(c, now)) return c;
	return {
		...c,
		status: "stale",
		statusEs: "Sin imagen reciente",
		statusEn: "No recent picture",
		night: null,
	};
}

/** How many cameras are in each state as shown (after `clientCard`). */
export function statusCounts(cards: readonly Pick<CameraCard, "status">[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const c of cards) out[c.status] = (out[c.status] ?? 0) + 1;
	return out;
}

/** A camera's still became "the camera at that moment" in the time machine: the label says its own time. */
export function stillLabel(img: Pick<CameraImage, "labelEs" | "labelEn">, l: Lang): string {
	return l === "es" ? img.labelEs : img.labelEn;
}

/** Night brightness, when measured against a baseline: "Luces: 42 % de su mediana a esta hora, 9 noches". */
export function nightLine(n: CameraNight | null, l: Lang): string | null {
	if (!n) return null;
	if (typeof n.ratio === "number")
		return tr(
			l,
			`Luces: ${Math.round(n.ratio * 100)} % de su mediana a esta hora, ${n.nights} noches (calculado por Vigía)`,
			`Lights: ${Math.round(n.ratio * 100)} % of its median at this hour, ${n.nights} nights (computed by Vigía)`,
		);
	return n.statusEs ? tr(l, `Brillo nocturno: ${n.statusEs}`, `Night brightness: ${n.statusEs}`) : null;
}

/** Where a press on "play" goes: in the page (YouTube's cookie-less player, the operator's embed, HLS) or out. */
export function playTarget(p: CameraPlay | null): "youtube" | "embed" | "hls" | "link" | null {
	if (!p) return null;
	if (p.type === "youtube") return p.videoId ? "youtube" : null;
	if (p.type === "embed")
		return /^https:\/\/webcams\.windy\.com\/webcams\/public\/embed\/player\//.test(p.url) ? "embed" : "link";
	return p.type;
}

/* ---------- TV card pictures (`tv.cards[].image`, `cards[].image`) ---------- */

export type TvImage =
	| {
			kind: "still";
			url: string;
			width: number;
			height: number;
			takenAt: number;
			source: "tv-frame" | "youtube-thumbnail" | "youtube-cover";
			labelEs: string;
			labelEn: string;
			creditEs: string;
			/** The channel's logo, the fallback once the still ages past the budget (absent from an older server). */
			logo?: { url: string; width: number; height: number; creditEs: string } | null;
	  }
	| {
			kind: "logo";
			url: string;
			width: number;
			height: number;
			labelEs: string;
			labelEn: string;
			whyEs: string | null;
			whyEn: string | null;
			creditEs: string;
	  }
	| { kind: "none"; labelEs: string; labelEn: string; whyEs: string | null; whyEn: string | null };

export type TvPicture =
	| {
			kind: "still";
			url: string;
			width: number;
			height: number;
			takenAt: number;
			cover: boolean;
			label: string;
			credit: string;
	  }
	| {
			kind: "logo";
			url: string;
			width: number;
			height: number;
			label: string;
			why: string | null;
			credit: string;
	  }
	| { kind: "name"; label: string; why: string | null };

/**
 * What a TV card shows, by the server's rule re-checked on this clock: a still no older than `maxAgeMs` (45 min),
 * else the logo with "Sin cuadro reciente", else the channel's name. A still the server sent carries the channel's
 * logo (`img.logo`), so one that ages past the budget on this clock falls back to the logo, not the name; `logo`
 * overrides it. A fixed YouTube cover is a picture, never a frame.
 */
export function tvPicture(
	img: TvImage | null | undefined,
	now: number,
	maxAgeMs: number,
	l: Lang,
	override: { url: string; width: number; height: number; creditEs: string } | null = null,
): TvPicture {
	const noRecent = tr(l, "Sin cuadro reciente", "No recent frame");
	if (img?.kind === "still") {
		if (now - img.takenAt <= maxAgeMs && img.takenAt <= now + MIN)
			return {
				kind: "still",
				url: img.url,
				width: img.width,
				height: img.height,
				takenAt: img.takenAt,
				cover: img.source === "youtube-cover",
				label: l === "es" ? img.labelEs : img.labelEn,
				credit: img.creditEs,
			};
		const why = tr(
			l,
			`el último cuadro es de las ${clock(img.takenAt, l)}`,
			`the last frame is from ${clock(img.takenAt, l)}`,
		);
		const logo = override ?? img.logo ?? null;
		return logo
			? {
					kind: "logo",
					url: logo.url,
					width: logo.width,
					height: logo.height,
					label: noRecent,
					why,
					credit: logo.creditEs,
				}
			: { kind: "name", label: noRecent, why };
	}
	if (img?.kind === "logo")
		return {
			kind: "logo",
			url: img.url,
			width: img.width,
			height: img.height,
			label: l === "es" ? img.labelEs : img.labelEn,
			why: l === "es" ? img.whyEs : img.whyEn,
			credit: img.creditEs,
		};
	if (img?.kind === "none")
		return {
			kind: "name",
			label: l === "es" ? img.labelEs : img.labelEn,
			why: l === "es" ? img.whyEs : img.whyEn,
		};
	return { kind: "name", label: noRecent, why: null };
}
