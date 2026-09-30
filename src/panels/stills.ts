import { type IptvEntry, iptvVe } from "../adapters/iptv-ve/index.ts";
import { type TvLogo, tvLogos } from "../adapters/tv-logos/index.ts";
import { type TvStillValue, tvStills } from "../adapters/tv-stills/index.ts";
import { TV_CHANNELS } from "../adapters/youtube-live/channels.ts";
import { type YoutubeLive, youtubeLive } from "../adapters/youtube-live/index.ts";
import { CAMERAS } from "../cameras/list.ts";
import type { CameraStill } from "../cameras/state.ts";
import type { Store, StoredObservation } from "../core/store.ts";
import type { Json } from "../core/types.ts";
import { type CameraCard, cameraCard } from "./cameras.ts";
import { STILL_MAX_AGE_MS, tvCardImage, youtubeCardImage } from "./cardimage.ts";

/**
 * The time machine's pictures: what the TV wall and the camera layer showed at a past moment, by the same rules as
 * now (cardimage.ts for TV cards, cameras.ts for cameras), evaluated at `at` on the archive. A still is only ever
 * shown for a moment within its budget after it was taken, never stretched to fill a gap, and every picture keeps
 * its own time. Stills older than their feed's retention (TV one day, cameras three days) are gone from the blob
 * store: the view still lists them (the numbers are archived) and the image URL answers 404, which the UI shows as
 * "imagen ya no guardada".
 */

export type StillImage = {
	url: string;
	width: number;
	height: number;
	takenAt: number;
	source: "tv-frame" | "youtube-thumbnail" | "youtube-cover" | "camera";
	labelEs: string;
	labelEn: string;
};

export type StillsView = {
	at: number;
	tv: { entry: string; channel: string; name: string; image: StillImage | null; whyEs: string | null }[];
	youtube: { channel: string; name: string; image: StillImage | null }[];
	cameras: {
		id: string;
		entity: string | null;
		name: { es: string; en: string };
		lat: number;
		lon: number;
		headingDeg: number | null;
		status: CameraCard["status"];
		image: StillImage | null;
		night: { status: string; ratio: number | null };
	}[];
	rulesEs: string;
	rulesEn: string;
};

const RULES_ES =
	"Cada imagen es la que la sala mostraba en ese momento, con su hora: un cuadro de TV o una miniatura tomada a lo sumo 45 minutos antes; la imagen de una cámara, a lo sumo dos veces su intervalo más 5 minutos antes (y fechada cuando Vigía vio esos bytes por primera vez). Sin imagen en ese lapso, no se muestra ninguna.";
const RULES_EN =
	"Each picture is the one the room showed at that moment, with its time: a TV frame or thumbnail taken at most 45 minutes before; a camera still at most twice its interval plus 5 minutes before (dated when Vigía first saw those bytes). With no picture in that span, none is shown.";

/** Newest observation per series in [from, to], from one window read. */
function newestPerSeries<V extends Json>(
	store: Store,
	source: string,
	from: number,
	to: number,
): Map<string, StoredObservation<V>> {
	const out = new Map<string, StoredObservation<V>>();
	for (const o of store.window<V>(source, from, to, 20_000)) {
		const prev = out.get(o.series);
		if (!prev || o.observedAt > prev.observedAt) out.set(o.series, o);
	}
	return out;
}

export function stillsView(store: Store, at: number): StillsView {
	const from = at - STILL_MAX_AGE_MS;
	// TV: the directory's names, the stills of the budget before `at`, the logos as they are now.
	const names = new Map(
		store.latestPerSeries<IptvEntry>(iptvVe.id, 0, 5_000).map((o) => [o.value.key, o.value] as const),
	);
	const stills = newestPerSeries<TvStillValue>(store, tvStills.id, from, at);
	const logos = new Map(
		store.latestPerSeries<TvLogo>(tvLogos.id, 0, 5_000).map((o) => [o.value.channel, o] as const),
	);
	const round = stills.get("round");
	const decoderMissing = round?.value.kind === "round" && round.value.decoder === null;
	const tv: StillsView["tv"] = [];
	for (const o of stills.values()) {
		if (o.value.kind !== "still") continue;
		const entry = o.value.entry;
		const img = tvCardImage(
			o as StoredObservation<Extract<TvStillValue, { kind: "still" }>>,
			logos.get(o.value.channel),
			at,
			decoderMissing,
		);
		tv.push({
			entry,
			channel: o.value.channel,
			name: names.get(entry)?.name ?? o.value.channel,
			image:
				img.kind === "still"
					? {
							url: img.url,
							width: img.width,
							height: img.height,
							takenAt: img.takenAt,
							source: img.source,
							labelEs: img.labelEs,
							labelEn: img.labelEn,
						}
					: null,
			whyEs: img.kind === "still" ? null : img.whyEs,
		});
	}
	tv.sort(
		(a, b) => Number(b.image !== null) - Number(a.image !== null) || a.name.localeCompare(b.name, "es"),
	);

	// YouTube: the curated channels' thumbnails read within the budget before `at`.
	const yt = newestPerSeries<YoutubeLive>(store, youtubeLive.id, from, at);
	const youtube = TV_CHANNELS.map((c) => {
		const o = yt.get(`yt:${c.id}`);
		const earlier = store
			.history<YoutubeLive>(youtubeLive.id, `yt:${c.id}`, at - 3 * 60 * 60_000, at, 12)
			.flatMap((x) => (x.value.thumb ? [x.value.thumb] : []));
		const img = youtubeCardImage(o?.value.thumb ?? null, o?.value.state === "live", null, at, earlier);
		return {
			channel: c.id,
			name: c.name,
			image:
				img.kind === "still"
					? {
							url: img.url,
							width: img.width,
							height: img.height,
							takenAt: img.takenAt,
							source: img.source,
							labelEs: img.labelEs,
							labelEn: img.labelEn,
						}
					: null,
		};
	});

	// Cameras: each card at `at`, by the camera layer's own rules.
	const cameras = CAMERAS.map((spec) => {
		const card = cameraCard(store, spec, at);
		return {
			id: card.id,
			entity: card.entity,
			name: card.name,
			lat: card.lat,
			lon: card.lon,
			headingDeg: card.headingDeg,
			status: card.status,
			image: card.image
				? {
						url: card.image.url,
						width: card.image.width,
						height: card.image.height,
						takenAt: card.image.takenAt,
						source: "camera" as const,
						labelEs: card.image.labelEs,
						labelEn: card.image.labelEn,
					}
				: null,
			night: { status: card.night.status, ratio: card.night.ratio },
		};
	});
	return { at, tv, youtube, cameras, rulesEs: RULES_ES, rulesEn: RULES_EN };
}

/** One camera's stills in a window, oldest first (a strip to scrub through), with their numbers. */
export function cameraStrip(
	store: Store,
	id: string,
	from: number,
	to: number,
	limit: number,
): {
	camera: string;
	stills: {
		url: string | null;
		takenAt: number;
		reason: string | null;
		night: boolean;
		lit: number | null;
		lumaMean: number | null;
	}[];
	truncated: boolean;
} | null {
	if (!CAMERAS.some((c) => c.id === id)) return null;
	// Newest first under the cap, then oldest first: a truncated strip drops the oldest stills.
	const rows = store.recent<CameraStill>("public-cams", `cam:${id}`, from, to, limit + 1);
	return {
		camera: id,
		truncated: rows.length > limit,
		stills: rows
			.slice(0, limit)
			.reverse()
			.map((o) => ({
				url: o.value.blob ? `/api/blobs/public-cams/${o.value.blob}` : null,
				takenAt: o.observedAt,
				reason: o.value.reason,
				night: o.value.night,
				lit: o.value.lightsBright,
				lumaMean: o.value.lumaMean,
			})),
	};
}
