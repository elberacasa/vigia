/*
 * Pure helpers for the live TV wall and the radio list (panels/LiveTv.tsx): the TV and radio directory
 * (`/api/panels/mediadir`, src/panels/mediadir.ts) merged with the curated "En vivo" list (`livetv`,
 * src/panels/livetv.ts), what a play button can do in this browser, and which streams keep playing when one more
 * starts. No DOM here: every rule is tested in media.test.ts.
 */

import { failureWords, knownFailure } from "../../../src/media/reason-words.ts";
import type { TvImage } from "./cameras.ts";

/* ---------- Mirrors of the server's views (the server is the source of truth) ---------- */

export type DirState = "live" | "off" | "no-answer" | "stale" | "unmeasured";
export type Playable = "in-page" | "native-only" | "http-only";

export interface TvDirCard {
	key: string;
	channel: string;
	name: string;
	categories: string[];
	states: string[];
	statesWhy: string | null;
	statesFrom: "iptv-org" | "vigia" | null;
	ownership: "state" | "state-funded" | "other";
	quality: string | null;
	notAlways: boolean;
	geoBlocked: boolean;
	website: string | null;
	listing: string;
	state: DirState;
	detail: string | null;
	checkedAt: number | null;
	playable: Playable;
	play: { type: "hls"; url: string };
	latencyMs: number | null;
	/** The card's picture by the server's rule (src/panels/cardimage.ts); absent from an older server. */
	image?: TvImage;
}

/** The TV stills' round, for the wall's note and source line (`tv.stills`). */
export interface TvStills {
	frames: number;
	logos: number;
	none: number;
	/** ffmpeg's version on the computer Vigía runs on; null: no decoder, cards show logos. */
	decoder: string | null;
	round: { at: number; bytes: number; cpuMs: number; stills: number; attempted: number } | null;
	maxAgeMs: number;
	ruleEs: string;
	ruleEn: string;
}

export interface TvExcluded {
	key: string;
	channel: string;
	name: string;
	country: string;
	reason: string;
	reasonEs: string;
	reasonEn: string;
	detail: string | null;
}

export interface RadioDirCard {
	uuid: string;
	name: string;
	frequency: string | null;
	states: string[];
	statesFrom: "iso" | "geo" | "state-field" | "name" | null;
	ownership: "state" | "other";
	codec: string | null;
	bitrateKbps: number | null;
	homepage: string | null;
	listing: string;
	curated: boolean;
	curatedWhy: string | null;
	state: DirState;
	detail: string | null;
	checkedAt: number | null;
	playable: Playable;
	play: { type: "audio" | "hls"; url: string };
	latencyMs: number | null;
}

export interface RadioSummary {
	listed: number;
	broadcasters: number;
	webOnly: number;
	withHandle: number;
	duplicates: number;
}

export interface MediaDirView {
	tv: {
		cards: TvDirCard[];
		excluded: TvExcluded[];
		listed: number;
		live: number;
		measured: number;
		listAt: number | null;
		checkedAt: number | null;
		byReason: Record<string, number>;
		byState: Record<string, number>;
		stills?: TvStills;
	};
	radio: {
		cards: RadioDirCard[];
		excluded: { uuid: string; name: string; reason: string; detail: string | null }[];
		summary: RadioSummary | null;
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
}

/** The curated list's card (src/panels/livetv.ts). */
export type CuratedState = "live" | "upcoming" | "off" | "unknown" | "stale" | "unmeasured";
export interface CuratedCard {
	id: string;
	kind: "tv" | "radio";
	name: string;
	where: string | null;
	labelEs: string;
	labelEn: string;
	ownership: string;
	lang: string;
	homepage: string;
	verified: string;
	state: CuratedState;
	detail: string | null;
	checkedAt: number | null;
	sourceUrl: string;
	title: string | null;
	startedAt: number | null;
	playability: string | null;
	playabilityReason: string | null;
	play: { type: "youtube"; channelId: string; videoId: string | null } | { type: "audio"; url: string };
	latencyMs: number | null;
	/** TV only: the card's picture by the server's rule; null for radio. */
	image?: TvImage | null;
}
export interface CuratedView {
	cards: CuratedCard[];
	tv: { live: number; measured: number; total: number; checkedAt: number | null };
	radio: { live: number; measured: number; total: number; checkedAt: number | null };
	ruleEs: string;
	ruleEn: string;
	vantageEs: string;
	vantageEn: string;
	budgets: { tvMs: number; radioMs: number };
}

/* ---------- One list of channels, one of stations ---------- */

export type ItemState = DirState | "upcoming" | "unknown";
export type Play =
	| { kind: "youtube"; channelId: string; videoId: string | null }
	| { kind: "audio" | "hls"; url: string; playable: Playable };

/** "state": Venezuelan state media; "state-funded": funded by the Venezuelan state; "foreign-gov": another state's. */
export type Owner = "state" | "state-funded" | "foreign-gov" | "other";

export interface MediaItem {
	/** "tv:yt:…", "tv:iptv:…", "radio:cur:…", "radio:rb:…": also the key of what is playing. */
	id: string;
	kind: "tv" | "radio";
	/** Where the entry comes from: Vigía's curated list (official YouTube channels, verified radio streams) or a directory. */
	origin: "curated" | "iptv-org" | "radio-browser";
	name: string;
	/** Frequency for radio ("88.1 FM"); the curated list's "where" line. */
	sub: string | null;
	/** ISO 3166-2 codes (VE-V…); empty when no state is known. */
	states: string[];
	/** How the state was set when it is not the listing's own: "nombre del canal", "ubicación por nombre"… */
	statesNote: string | null;
	owner: Owner;
	/** The label a reader sees for ownership, when there is one to say (state media always). */
	ownerEs: string | null;
	ownerEn: string | null;
	state: ItemState;
	detail: string | null;
	checkedAt: number | null;
	quality: string | null;
	notAlways: boolean;
	geoBlocked: boolean;
	/** The live broadcast's title (YouTube), shown as a link. */
	title: string | null;
	/** The channel's page or its listing (where the entry came from). */
	link: string;
	/** Other streams of the same channel in the directory (they are not shown as separate tiles). */
	alternates: number;
	play: Play;
	/** The card's picture by the server's rule (TV only; re-checked against the page's clock where it is drawn). */
	image: TvImage | null;
}

const DIR_OWNER: Record<string, { es: string; en: string } | null> = {
	state: { es: "Medio estatal", en: "State media" },
	"state-funded": { es: "Financiado por el Estado venezolano", en: "Funded by the Venezuelan state" },
	other: null,
};

function curatedOwner(o: string): Owner {
	if (o === "state") return "state";
	if (o === "state-funded") return "state-funded";
	if (o === "government-foreign") return "foreign-gov";
	return "other";
}

const PLAYABLE_ORDER: Record<Playable, number> = { "in-page": 0, "native-only": 1, "http-only": 2 };
const STATE_ORDER: Record<ItemState, number> = {
	live: 0,
	upcoming: 1,
	off: 2,
	"no-answer": 3,
	unknown: 4,
	stale: 5,
	unmeasured: 6,
};

function qualityRank(q: string | null): number {
	const m = /^(\d+)/.exec(q ?? "");
	return m ? Number(m[1]) : 0;
}

/**
 * Every TV channel once: the curated official YouTube channels, then the directory's free-to-air channels, one tile
 * per channel (a channel listed with several streams keeps the best: live first, then one the page can play, then
 * the highest quality; the others are counted as alternates). Ordered live first, then by name.
 */
export function tvItems(curated: CuratedView | undefined, dir: MediaDirView | undefined): MediaItem[] {
	const out: MediaItem[] = [];
	for (const c of curated?.cards ?? []) {
		if (c.kind !== "tv" || c.play.type !== "youtube") continue;
		const owner = curatedOwner(c.ownership);
		out.push({
			id: `tv:yt:${c.id}`,
			kind: "tv",
			origin: "curated",
			name: c.name,
			sub: c.where,
			states: [],
			statesNote: null,
			owner,
			ownerEs: c.labelEs,
			ownerEn: c.labelEn,
			state: c.state,
			detail: c.detail,
			checkedAt: c.checkedAt,
			quality: null,
			notAlways: false,
			geoBlocked: false,
			title: c.title,
			link: c.sourceUrl,
			alternates: 0,
			play: { kind: "youtube", channelId: c.play.channelId, videoId: c.play.videoId },
			image: c.image ?? null,
		});
	}
	const byChannel = new Map<string, TvDirCard[]>();
	for (const c of dir?.tv.cards ?? []) {
		const list = byChannel.get(c.channel);
		if (list) list.push(c);
		else byChannel.set(c.channel, [c]);
	}
	for (const cards of byChannel.values()) {
		const [best] = [...cards].sort(
			(a, b) =>
				STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
				PLAYABLE_ORDER[a.playable] - PLAYABLE_ORDER[b.playable] ||
				qualityRank(b.quality) - qualityRank(a.quality) ||
				a.key.localeCompare(b.key),
		);
		if (!best) continue;
		const label = DIR_OWNER[best.ownership] ?? null;
		out.push({
			id: `tv:iptv:${best.key}`,
			kind: "tv",
			origin: "iptv-org",
			name: best.name,
			sub: null,
			states: [...best.states],
			statesNote: best.statesWhy,
			owner: best.ownership === "other" ? "other" : best.ownership,
			ownerEs: label?.es ?? null,
			ownerEn: label?.en ?? null,
			state: best.state,
			detail: best.detail,
			checkedAt: best.checkedAt,
			quality: best.quality,
			notAlways: best.notAlways,
			geoBlocked: best.geoBlocked,
			title: null,
			link: best.website ?? best.listing,
			alternates: cards.length - 1,
			play: { kind: "hls", url: best.play.url, playable: best.playable },
			// The picture of the stream shown, else of another stream of the same channel that has one.
			image: best.image ?? cards.find((c) => c.image?.kind === "still")?.image ?? null,
		});
	}
	return out.sort(byStateThenName);
}

/**
 * Every radio station once: Vigía's curated stations (verified streams), then the directory's broadcasters that are
 * not the same stream as a curated one (`curated` on the directory card). Live first, then by name.
 */
export function radioItems(curated: CuratedView | undefined, dir: MediaDirView | undefined): MediaItem[] {
	const out: MediaItem[] = [];
	for (const c of curated?.cards ?? []) {
		if (c.kind !== "radio" || c.play.type !== "audio") continue;
		out.push({
			id: `radio:cur:${c.id}`,
			kind: "radio",
			origin: "curated",
			name: c.name,
			sub: c.where,
			states: [],
			statesNote: null,
			owner: curatedOwner(c.ownership),
			ownerEs: c.labelEs,
			ownerEn: c.labelEn,
			state: c.state,
			detail: c.detail,
			checkedAt: c.checkedAt,
			quality: null,
			notAlways: false,
			geoBlocked: false,
			title: null,
			link: c.homepage,
			alternates: 0,
			play: {
				kind: "audio",
				url: c.play.url,
				playable: c.play.url.startsWith("https:") ? "in-page" : "http-only",
			},
			image: null,
		});
	}
	for (const c of dir?.radio.cards ?? []) {
		if (c.curated) continue;
		const label = DIR_OWNER[c.ownership] ?? null;
		out.push({
			id: `radio:rb:${c.uuid}`,
			kind: "radio",
			origin: "radio-browser",
			name: c.name,
			sub: c.frequency,
			states: [...c.states],
			statesNote: c.statesFrom === "name" ? "name" : c.curatedWhy ? "allowlist" : null,
			owner: c.ownership === "state" ? "state" : "other",
			ownerEs: label?.es ?? null,
			ownerEn: label?.en ?? null,
			state: c.state,
			detail: c.detail,
			checkedAt: c.checkedAt,
			quality: c.codec ? `${c.codec}${c.bitrateKbps ? ` ${c.bitrateKbps} kb/s` : ""}` : null,
			notAlways: false,
			geoBlocked: false,
			title: c.curatedWhy,
			link: c.homepage ?? c.listing,
			alternates: 0,
			play: { kind: c.play.type, url: c.play.url, playable: c.playable },
			image: null,
		});
	}
	return out.sort(byStateThenName);
}

function byStateThenName(a: MediaItem, b: MediaItem): number {
	return STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.name.localeCompare(b.name, "es");
}

/* ---------- Filters ---------- */

/** "regional": placed in a state; "national": no state (national, international, or not placed); "state": state media. */
export type Scope = "all" | "regional" | "national" | "state";

export function inScope(item: MediaItem, scope: Scope): boolean {
	switch (scope) {
		case "all":
			return true;
		case "regional":
			return item.states.length > 0;
		case "national":
			return item.states.length === 0;
		case "state":
			return item.owner === "state" || item.owner === "state-funded";
	}
}

export function filterItems(items: readonly MediaItem[], scope: Scope, state: string | null): MediaItem[] {
	return items.filter((i) => inScope(i, scope) && (!state || i.states.includes(state)));
}

/** States that have at least one item, with their counts, most first then by code. */
export function stateCounts(items: readonly MediaItem[]): { iso: string; n: number }[] {
	const counts = new Map<string, number>();
	for (const i of items) for (const s of i.states) counts.set(s, (counts.get(s) ?? 0) + 1);
	return [...counts].map(([iso, n]) => ({ iso, n })).sort((a, b) => b.n - a.n || a.iso.localeCompare(b.iso));
}

/* ---------- What the play button does here ---------- */

export interface PlayEnv {
	/** The browser plays HLS by itself (`canPlayType('application/vnd.apple.mpegurl')`: Safari, iOS, most Android). */
	nativeHls: boolean;
	/** Media Source Extensions, which hls.js needs. */
	mse: boolean;
	/** The page itself is http:// (a local Vigía): plain-HTTP streams are not blocked as mixed content. */
	pageHttp: boolean;
}

export type PlayMode =
	| { mode: "youtube" }
	| { mode: "audio" }
	| { mode: "native-hls" }
	| { mode: "hls.js" }
	| { mode: "external"; why: "http" | "no-cors" | "no-hls" };

/**
 * How a stream plays in this browser. The directory says what the page may do (`playable`, from the probe); the
 * browser says what it can. A stream the page cannot play is never faked: it is offered as a link for an external
 * player (VLC…), with the reason.
 */
export function playMode(play: Play, env: PlayEnv): PlayMode {
	if (play.kind === "youtube") return { mode: "youtube" };
	if (play.playable === "http-only" && !env.pageHttp) return { mode: "external", why: "http" };
	if (play.kind === "audio") return { mode: "audio" };
	if (env.nativeHls) return { mode: "native-hls" };
	if (play.playable === "native-only") return { mode: "external", why: "no-cors" };
	return env.mse ? { mode: "hls.js" } : { mode: "external", why: "no-hls" };
}

/**
 * The wall's players: `playing` is oldest first. Starting one that plays already moves it to the newest; starting a
 * new one past `max` stops the oldest (a slow connection cannot carry many streams: each is ~1–3 Mb/s).
 */
export function startPlaying(
	playing: readonly string[],
	id: string,
	max: number,
): { playing: string[]; stopped: string[] } {
	const next = [...playing.filter((p) => p !== id), id];
	const stopped: string[] = [];
	while (next.length > Math.max(1, max)) stopped.push(next.shift() as string);
	return { playing: next, stopped };
}

/* ---------- Words ---------- */

/** Why a probe said "not live", in words (src/media/probe.ts reasons). */
export function reasonText(detail: string | null, lang: "es" | "en"): string | null {
	if (!detail) return null;
	const es = lang === "es";
	// "la dirección de la señal ya no existe (404)", "el servidor del video falló (error 502)".
	if (/^(segment-)?http-\d{3}$/.test(detail)) return failureWords(detail)[lang];
	switch (detail) {
		case "timeout":
		case "segment-timeout":
			return es ? "no respondió a tiempo" : "timed out";
		case "dns":
			return es ? "el servidor no existe (DNS)" : "the server does not resolve (DNS)";
		case "tls":
			return es ? "certificado inválido" : "invalid certificate";
		case "stale-playlist":
			return es ? "la lista no avanza" : "the playlist is not moving";
		case "segment-not-media":
		case "segment-unread":
			return es ? "responde sin video" : "answers without video";
		case "not-playlist":
		case "no-variant":
			return es ? "no es una señal HLS válida" : "not a valid HLS stream";
		case "no-audio-frames":
		case "not-audio-type":
		case "not-audio":
			return es ? "responde sin audio" : "answers without audio";
		case "no-stream":
			return es ? "sin transmisión" : "not streaming";
		default:
			// Every other probe code in the shared words (never the code itself); an unknown one says nothing.
			return knownFailure(detail) ? failureWords(detail)[lang] : null;
	}
}

/**
 * The shared words of a fact-check and a story, as the reader would write them: the server compares stems
 * ("flor" for "Flores"), so each stem is shown as the first word of the check's own headline that starts with it
 * (accents ignored), else as the stem itself.
 */
export function readableWords(stems: readonly string[], headline: string): string[] {
	const words = headline.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
	const fold = (w: string) => w.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
	return stems.map((s) => words.find((w) => fold(w).startsWith(s)) ?? s);
}
