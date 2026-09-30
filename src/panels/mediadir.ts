import { REASON_TEXT, regionWhy } from "../adapters/iptv-ve/catalog.ts";
import {
	channelPage,
	type IptvEntry,
	iptvVe,
	iptvVeProbe,
	type TvReading,
} from "../adapters/iptv-ve/index.ts";
import {
	type RadioDirectorySummary,
	type RadioDirReading,
	type RadioEntry,
	radioBrowser,
	radioBrowserProbe,
} from "../adapters/radio-browser/index.ts";
import { RADIO_STATIONS } from "../adapters/radio-streams/stations.ts";
import { type TvLogo, tvLogos } from "../adapters/tv-logos/index.ts";
import { type TvStill, type TvStillRound, type TvStillValue, tvStills } from "../adapters/tv-stills/index.ts";
import type { Store, StoredObservation } from "../core/store.ts";
import type { Json } from "../core/types.ts";
import type { Panel } from "../server/panels.ts";
import { type CardImage, STILL_MAX_AGE_MS, tvCardImage } from "./cardimage.ts";

/**
 * "Directorio: TV y radio en vivo": every free-to-air Venezuelan TV channel in iptv-org's list and every radio
 * broadcaster in Radio Browser, each with its measured state, the rule that let it in, and (for TV) the rule that
 * kept the others out. The curated "En vivo" panel (livetv.ts) stays the short list; this is the full directory.
 *
 * "EN VIVO" is only said for a probe younger than the budget (1.5 × the probe interval); older is "stale" with its
 * time; never probed is "unmeasured". Nothing plays until the viewer presses play, and it plays from the
 * broadcaster's own server (see `play` for what the page can and cannot do).
 */

const MIN = 60_000;
/** TV streams are probed every 30 min. */
export const TV_DIR_BUDGET_MS = 45 * MIN;
/** Radio streams are probed every hour. */
export const RADIO_DIR_BUDGET_MS = 90 * MIN;

export type DirState = "live" | "off" | "no-answer" | "stale" | "unmeasured";

/**
 * What the play button can do in this page. "in-page": an HTTPS stream the page may load (an <audio> element for
 * radio; for HLS every response allowed any origin, so hls.js can read it, and Safari plays it natively).
 * "native-only": HTTPS HLS without CORS, which only a browser with native HLS (Safari, iOS, most Android) plays.
 * "http-only": a plain-HTTP stream, blocked inside an HTTPS page (mixed content); it plays when Vigía runs locally
 * over http://localhost, else the UI offers the link for an external player.
 */
export type Playable = "in-page" | "native-only" | "http-only";

export type TvDirCard = {
	key: string;
	channel: string;
	name: string;
	categories: string[];
	states: string[];
	/** Why Vigía set the state, when iptv-org did not ("nombre del canal", "es.wikipedia: sede en …"). */
	statesWhy: string | null;
	statesFrom: "iptv-org" | "vigia" | null;
	ownership: "state" | "state-funded" | "other";
	quality: string | null;
	/** iptv-org's labels. */
	notAlways: boolean;
	geoBlocked: boolean;
	website: string | null;
	/** The channel on iptv-org's site (the listing this entry comes from). */
	listing: string;
	state: DirState;
	/** Why not live ("http-404", "segment-not-media", "stale-playlist", "timeout"…); for "stale", the last state. */
	detail: string | null;
	checkedAt: number | null;
	playable: Playable;
	play: { type: "hls"; url: string };
	/** Whole probe from this computer, when live. */
	latencyMs: number | null;
	/** The card's picture: a recent frame, else the channel's logo, else none (rules in cardimage.ts). */
	image: CardImage;
};

export type TvExcluded = {
	key: string;
	channel: string;
	name: string;
	country: string;
	reason: NonNullable<IptvEntry["reason"]>;
	reasonEs: string;
	reasonEn: string;
	/** The reference (pay channels) or the relay's host. */
	detail: string | null;
};

export type RadioDirCard = {
	uuid: string;
	name: string;
	frequency: string | null;
	states: string[];
	/** "iso" | "geo" | "state-field" | "name" ("por nombre": keyword placement, shown as such). */
	statesFrom: RadioEntry["statesFrom"];
	ownership: "state" | "other";
	codec: string | null;
	bitrateKbps: number | null;
	homepage: string | null;
	/** The station on Radio Browser (the listing this entry comes from). */
	listing: string;
	/** The same stream is one of the curated "En vivo" stations. */
	curated: boolean;
	/** Kept by Vigía's list of stations whose listing names no frequency: the reference ("según …"). */
	curatedWhy: string | null;
	state: DirState;
	detail: string | null;
	checkedAt: number | null;
	playable: Playable;
	play: { type: "audio" | "hls"; url: string };
	latencyMs: number | null;
};

export type MediaDirView = {
	tv: {
		cards: TvDirCard[];
		excluded: TvExcluded[];
		/** Streams in the list for Venezuela, on and excluded. */
		listed: number;
		live: number;
		measured: number;
		/** When iptv-org's list was last changed (its Last-Modified), and when the probe last ran. */
		listAt: number | null;
		checkedAt: number | null;
		byReason: Partial<Record<NonNullable<IptvEntry["reason"]>, number>>;
		byState: Record<string, number>;
		/** Pictures on the cards: how many show a frame, a logo, nothing; and the last stills round. */
		stills: StillsSummary;
	};
	radio: {
		cards: RadioDirCard[];
		/** Relayed through a third-party proxy, or listed without a stream: not played. */
		excluded: { uuid: string; name: string; reason: string; detail: string | null }[];
		/** Radio Browser's day: listed, broadcasters kept, web-only and handle-bearing listings counted, duplicates. */
		summary: RadioDirectorySummary | null;
		live: number;
		measured: number;
		listAt: number | null;
		checkedAt: number | null;
		byState: Record<string, number>;
	};
	budgets: { tvMs: number; radioMs: number };
	ruleEs: string;
	ruleEn: string;
	vantageEs: string;
	vantageEn: string;
};

export type StillsSummary = {
	frames: number;
	logos: number;
	none: number;
	/** The ffmpeg that made the last round's stills, or null: no decoder here (cards show logos). */
	decoder: string | null;
	/** The last round: when, network bytes, CPU, stills made of channels tried; null before the first. */
	round: { at: number; bytes: number; cpuMs: number; stills: number; attempted: number } | null;
	maxAgeMs: number;
	ruleEs: string;
	ruleEn: string;
};

export const STILLS_RULE_ES =
	"Imagen de cada canal: un cuadro de su señal tomado por Vigía cada 30 minutos (el primer fotograma completo del " +
	"segmento más reciente, reducido a 480 px), si tiene menos de 45 minutos y no es de un solo color; si no, el logo " +
	"del canal con «sin cuadro reciente» y el motivo. La hora del cuadro se muestra siempre. Nada se analiza en la " +
	"imagen, salvo su brillo medio (pantallas negras) y una huella visual de 64 bits comparada con la ronda anterior " +
	"(una imagen que no cambia en 50 minutos se muestra como tal, no como el cuadro del canal).";
export const STILLS_RULE_EN =
	"Each channel's picture: a frame of its stream taken by Vigía every 30 minutes (the first complete picture of the " +
	"newest segment, reduced to 480 px), if under 45 minutes old and not one flat colour; otherwise the channel's logo " +
	"with “no recent frame” and why. The frame's time is always shown. Nothing in the picture is analysed except its " +
	"mean brightness (black screens) and a 64-bit visual hash compared with the previous round (a picture unchanged " +
	"for 50 minutes is shown as such, not as the channel's frame).";

/** The newest list version of a directory: the rows stored at its latest observedAt (older rows left the list). */
function currentList<V extends Json>(store: Store, source: string, skip?: string): StoredObservation<V>[] {
	const rows = store.latestPerSeries<V>(source, 0, 5_000).filter((o) => o.series !== skip);
	const newest = rows.reduce((m, o) => Math.max(m, o.observedAt), Number.NEGATIVE_INFINITY);
	return rows.filter((o) => o.observedAt === newest);
}

function readings<V extends Json>(
	store: Store,
	source: string,
	now: number,
): Map<string, StoredObservation<V>> {
	// Probes older than a day say nothing about now; a day of history is enough to say "stale since …".
	return new Map(store.latestPerSeries<V>(source, now - 24 * 60 * MIN, 5_000).map((o) => [o.series, o]));
}

function stateOf(
	obs: StoredObservation<{ state: string; reason: string | null }> | undefined,
	now: number,
	budget: number,
): { state: DirState; detail: string | null; fresh: boolean } {
	if (!obs) return { state: "unmeasured", detail: null, fresh: false };
	const v = obs.value;
	if (now - obs.observedAt > budget) return { state: "stale", detail: v.state, fresh: false };
	if (v.state === "live") return { state: "live", detail: null, fresh: true };
	if (v.state === "no-answer") return { state: "no-answer", detail: v.reason, fresh: true };
	return { state: "off", detail: v.reason, fresh: true };
}

const STATE_ORDER: Record<DirState, number> = { live: 0, off: 1, "no-answer": 2, stale: 3, unmeasured: 4 };

function count(into: Record<string, number>, keys: readonly string[]): void {
	for (const k of keys) into[k] = (into[k] ?? 0) + 1;
}

export function computeMediaDir(store: Store, now: number): MediaDirView {
	// TV
	const tvList = currentList<IptvEntry>(store, iptvVe.id);
	const tvProbes = readings<TvReading>(store, iptvVeProbe.id, now);
	const stillRows = store.latestPerSeries<TvStillValue>(tvStills.id, now - 24 * 60 * MIN, 5_000);
	const stills = new Map<string, StoredObservation<TvStill>>();
	let lastRound: StoredObservation<TvStillRound> | null = null;
	for (const o of stillRows) {
		if (o.observedAt > now) continue;
		if (o.value.kind === "still") stills.set(o.series, o as StoredObservation<TvStill>);
		else if (!lastRound || o.observedAt > lastRound.observedAt)
			lastRound = o as StoredObservation<TvStillRound>;
	}
	const logos = new Map(
		store.latestPerSeries<TvLogo>(tvLogos.id, 0, 5_000).map((o) => [o.value.channel, o] as const),
	);
	const decoderMissing = lastRound !== null && lastRound.value.decoder === null;
	const tvCards: TvDirCard[] = [];
	const excluded: TvExcluded[] = [];
	const byReason: MediaDirView["tv"]["byReason"] = {};
	const tvByState: Record<string, number> = {};
	for (const { value: e } of tvList) {
		if (e.status !== "on" || e.reason !== null) {
			const reason = e.reason ?? "closed";
			byReason[reason] = (byReason[reason] ?? 0) + 1;
			excluded.push({
				key: e.key,
				channel: e.channel,
				name: e.name,
				country: e.country,
				reason,
				reasonEs: REASON_TEXT[reason].es,
				reasonEn: REASON_TEXT[reason].en,
				detail: e.reasonDetail,
			});
			continue;
		}
		const obs = tvProbes.get(`tv:${e.key}`);
		const { state, detail, fresh } = stateOf(obs, now, TV_DIR_BUDGET_MS);
		const r = obs?.value;
		// The probe's view of CORS when there is one; without a probe the page cannot know, so only native HLS is promised.
		const playable: Playable = !e.https ? "http-only" : r?.cors ? "in-page" : "native-only";
		count(tvByState, e.states);
		tvCards.push({
			key: e.key,
			channel: e.channel,
			name: e.name,
			categories: [...e.categories],
			states: [...e.states],
			statesWhy: e.statesFrom === "vigia" ? regionWhy(e.channel) : null,
			statesFrom: e.statesFrom,
			ownership: e.ownership,
			quality: e.quality,
			notAlways: e.notAlways,
			geoBlocked: e.geoBlocked,
			website: e.website,
			listing: channelPage(e.channel),
			state,
			detail,
			checkedAt: obs?.observedAt ?? null,
			playable,
			play: { type: "hls", url: e.url },
			latencyMs: fresh && state === "live" ? (r?.ms ?? null) : null,
			image: tvCardImage(stills.get(`still:${e.key}`), logos.get(e.channel), now, decoderMissing),
		});
	}
	tvCards.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.name.localeCompare(b.name, "es"));
	excluded.sort((a, b) => a.reason.localeCompare(b.reason) || a.name.localeCompare(b.name, "es"));

	// Radio
	const rbRows = store.latestPerSeries<RadioEntry | RadioDirectorySummary>(radioBrowser.id, 0, 5_000);
	const summaryRow = rbRows
		.filter((o) => o.series === "rb:summary")
		.sort((a, b) => b.observedAt - a.observedAt)[0];
	const radioList = currentList<RadioEntry>(store, radioBrowser.id, "rb:summary");
	const radioProbes = readings<RadioDirReading>(store, radioBrowserProbe.id, now);
	const curatedUrls = new Set(RADIO_STATIONS.map((s) => s.streamUrl.toLowerCase()));
	const radioCards: RadioDirCard[] = [];
	const radioExcluded: MediaDirView["radio"]["excluded"] = [];
	const radioByState: Record<string, number> = {};
	for (const { value: e } of radioList) {
		if (e.status !== "on") {
			radioExcluded.push({
				uuid: e.uuid,
				name: e.name,
				reason: e.reason ?? "no-stream",
				detail: e.reasonDetail,
			});
			continue;
		}
		const obs = radioProbes.get(`rbp:${e.uuid}`);
		const { state, detail, fresh } = stateOf(obs, now, RADIO_DIR_BUDGET_MS);
		const r = obs?.value;
		const playable: Playable = !e.https ? "http-only" : e.hls && !r?.cors ? "native-only" : "in-page";
		count(radioByState, e.states);
		radioCards.push({
			uuid: e.uuid,
			name: e.name,
			frequency: e.frequency,
			states: [...e.states],
			statesFrom: e.statesFrom,
			ownership: e.ownership,
			codec: e.codec,
			bitrateKbps: e.bitrateKbps,
			homepage: e.homepage,
			listing: `https://www.radio-browser.info/history/${e.uuid}`,
			curated: curatedUrls.has(e.url.toLowerCase()),
			curatedWhy: e.curatedWhy ?? null,
			state,
			detail,
			checkedAt: obs?.observedAt ?? null,
			playable,
			play: { type: e.hls ? "hls" : "audio", url: e.url },
			latencyMs: fresh && state === "live" ? (r?.ms ?? null) : null,
		});
	}
	radioCards.sort(
		(a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.name.localeCompare(b.name, "es"),
	);

	const tally = (cards: readonly { state: DirState; checkedAt: number | null }[]) => {
		const checked = cards.map((c) => c.checkedAt).filter((t): t is number => t !== null);
		return {
			live: cards.filter((c) => c.state === "live").length,
			measured: cards.filter((c) => c.state !== "stale" && c.state !== "unmeasured").length,
			checkedAt: checked.length ? Math.max(...checked) : null,
		};
	};
	return {
		tv: {
			cards: tvCards,
			excluded,
			listed: tvList.length,
			...tally(tvCards),
			listAt: tvList[0]?.observedAt ?? null,
			byReason,
			byState: tvByState,
			stills: {
				frames: tvCards.filter((c) => c.image.kind === "still").length,
				logos: tvCards.filter((c) => c.image.kind === "logo").length,
				none: tvCards.filter((c) => c.image.kind === "none").length,
				decoder: lastRound?.value.decoder ?? null,
				round: lastRound
					? {
							at: lastRound.observedAt,
							bytes: lastRound.value.bytes,
							cpuMs: lastRound.value.cpuMs,
							stills: lastRound.value.stills,
							attempted: lastRound.value.attempted,
						}
					: null,
				maxAgeMs: STILL_MAX_AGE_MS,
				ruleEs: STILLS_RULE_ES,
				ruleEn: STILLS_RULE_EN,
			},
		},
		radio: {
			cards: radioCards,
			excluded: radioExcluded,
			summary: summaryRow ? (summaryRow.value as RadioDirectorySummary) : null,
			...tally(radioCards),
			listAt: radioList[0]?.observedAt ?? null,
			byState: radioByState,
		},
		budgets: { tvMs: TV_DIR_BUDGET_MS, radioMs: RADIO_DIR_BUDGET_MS },
		ruleEs:
			"TV: canales venezolanos de la lista pública de iptv-org. Quedan fuera los canales de pago (extranjeros que " +
			"llegan por cable o satélite y los venezolanos por suscripción), las retransmisiones desde servidores que " +
			"reemiten canales de varios países o canales de pago, y las señales que exigen simular otro sitio. «En vivo»: " +
			"la lista de reproducción responde, es una ventana en directo y su segmento más reciente trae video o audio, " +
			"revisado hace menos de 45 min. Radio: emisoras de Radio Browser con frecuencia AM/FM en su nombre, o emisoras " +
			"del Estado; las radios solo por internet se cuentan, no se listan. «Emite»: la señal responde con audio en " +
			"sus primeros 8 KB, revisada hace menos de 90 min. Nada suena hasta que lo pulsas, y suena desde el servidor " +
			"de cada emisora.",
		ruleEn:
			"TV: Venezuelan channels in iptv-org's public list. Pay channels (foreign ones carried by cable or satellite, " +
			"Venezuelan subscription ones), re-broadcasts from servers that relay several countries' channels or pay " +
			"channels, and streams that need to pretend to be another site are left out. “Live”: the playlist answers, is " +
			"a live window and its newest segment carries video or audio, checked less than 45 min ago. Radio: Radio " +
			"Browser stations with an AM/FM frequency in their name, or state broadcasters; internet-only radios are " +
			"counted, not listed. “On air”: the stream answers with audio in its first 8 KB, checked less than 90 min " +
			"ago. Nothing plays until you press it, and it plays from each broadcaster's own server.",
		vantageEs:
			"Medido desde este equipo: una señal puede verse aquí y no en Venezuela (o al revés). Las listas son " +
			"comunitarias: un canal o emisora puede faltar o estar mal ubicado.",
		vantageEn:
			"Measured from this computer: a stream may play here and not in Venezuela (or the other way round). Both " +
			"lists are community-kept: a channel or station may be missing or misplaced.",
	};
}

export const mediaDirPanel: Panel<MediaDirView> = {
	id: "mediadir",
	sources: [iptvVe.id, iptvVeProbe.id, tvStills.id, tvLogos.id, radioBrowser.id, radioBrowserProbe.id],
	onDemand: true,
	compute: (store, now) => computeMediaDir(store, now),
};
