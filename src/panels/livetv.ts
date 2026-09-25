import { type RadioReading, radioStreams } from "../adapters/radio-streams/index.ts";
import { RADIO_STATIONS } from "../adapters/radio-streams/stations.ts";
import { TV_CHANNELS } from "../adapters/youtube-live/channels.ts";
import { type YoutubeLive, youtubeLive } from "../adapters/youtube-live/index.ts";
import type { Store } from "../core/store.ts";
import type { Panel } from "../server/panels.ts";

/**
 * "En vivo: TV y radio": the official channels, each with its measured state. "EN VIVO" is only ever said for a
 * measurement younger than the budget (1.5 × the check interval); an older one is shown as "stale" with its
 * time, and a channel never checked (the YouTube check is opt-in) as "unmeasured", never as off air.
 */

const MIN = 60_000;
/** YouTube is checked every 30 min: a "live" reading counts for 45 min. */
export const TV_BUDGET_MS = 45 * MIN;
/** Radio is probed every 10 min: an "audio" reading counts for 15 min. */
export const RADIO_BUDGET_MS = 15 * MIN;

export type CardState = "live" | "upcoming" | "off" | "unknown" | "stale" | "unmeasured";

export type LiveCard = {
	id: string;
	kind: "tv" | "radio";
	name: string;
	/** Frequency and city for a radio transmitter. */
	where: string | null;
	labelEs: string;
	labelEn: string;
	ownership: string;
	lang: string;
	homepage: string;
	/** How the channel was verified as the broadcaster's own. */
	verified: string;
	state: CardState;
	/** Why: "no-stream" | "not-audio" | "no-answer" | YouTube "unknown" codes; for "stale", the last state. */
	detail: string | null;
	checkedAt: number | null;
	/** Link a person can open to check the state (the watch page, the channel's /live page, the station page). */
	sourceUrl: string;
	title: string | null;
	startedAt: number | null;
	/** YouTube's playability from this computer when not "OK" (e.g. "UNPLAYABLE"), and its reason. */
	playability: string | null;
	playabilityReason: string | null;
	/** What the play button loads, only after a press. */
	play: { type: "youtube"; channelId: string; videoId: string | null } | { type: "audio"; url: string };
	/** Radio: time to the first 16 KB from this computer. */
	latencyMs: number | null;
};

export type LiveTvView = {
	cards: LiveCard[];
	tv: { live: number; measured: number; total: number; checkedAt: number | null };
	radio: { live: number; measured: number; total: number; checkedAt: number | null };
	ruleEs: string;
	ruleEn: string;
	vantageEs: string;
	vantageEn: string;
	budgets: { tvMs: number; radioMs: number };
};

function tvCard(store: Store, now: number, channel: (typeof TV_CHANNELS)[number]): LiveCard {
	const obs = store.latest<YoutubeLive>(youtubeLive.id, `yt:${channel.id}`);
	const v = obs?.value;
	const fresh = obs !== null && now - obs.observedAt <= TV_BUDGET_MS;
	let state: CardState = "unmeasured";
	let detail: string | null = null;
	if (obs && v) {
		if (!fresh) {
			state = "stale";
			detail = v.state;
		} else if (v.state === "live" || v.state === "upcoming") state = v.state;
		else if (v.state === "offline") {
			state = "off";
			detail = "no-stream";
		} else {
			state = "unknown";
			detail = v.why;
		}
	}
	const current = fresh && v && (v.state === "live" || v.state === "upcoming");
	return {
		id: channel.id,
		kind: "tv",
		name: channel.name,
		where: null,
		labelEs: channel.labelEs,
		labelEn: channel.labelEn,
		ownership: channel.ownership,
		lang: channel.lang,
		homepage: channel.homepage,
		verified: channel.verified,
		state,
		detail,
		checkedAt: obs?.observedAt ?? null,
		sourceUrl: obs?.sourceUrl ?? `https://www.youtube.com/channel/${channel.channelId}/live`,
		title: current ? (v?.title ?? null) : null,
		startedAt: current && v?.state === "live" ? v.startedAt : null,
		playability: current && v?.playability && v.playability !== "OK" ? v.playability : null,
		playabilityReason: current && v?.playability && v.playability !== "OK" ? v.playabilityReason : null,
		// A fresh live reading names the video; otherwise the player resolves the channel's live stream itself.
		play: {
			type: "youtube",
			channelId: channel.channelId,
			videoId: fresh && v?.state === "live" ? v.videoId : null,
		},
		latencyMs: null,
	};
}

function radioCard(store: Store, now: number, station: (typeof RADIO_STATIONS)[number]): LiveCard {
	const obs = store.latest<RadioReading>(radioStreams.id, `radio:${station.id}`);
	const v = obs?.value;
	const fresh = obs !== null && now - obs.observedAt <= RADIO_BUDGET_MS;
	let state: CardState = "unmeasured";
	let detail: string | null = null;
	if (obs && v) {
		if (!fresh) {
			state = "stale";
			detail = v.state === "audio" ? "live" : v.state;
		} else if (v.state === "audio") state = "live";
		else {
			state = "off";
			detail = v.state;
		}
	}
	return {
		id: station.id,
		kind: "radio",
		name: station.name,
		where: station.where,
		labelEs: station.labelEs,
		labelEn: station.labelEn,
		ownership: station.ownership,
		lang: station.lang,
		homepage: station.homepage,
		verified: station.verified,
		state,
		detail,
		checkedAt: obs?.observedAt ?? null,
		sourceUrl: station.homepage,
		title: null,
		startedAt: null,
		playability: null,
		playabilityReason: null,
		play: { type: "audio", url: station.streamUrl },
		latencyMs: fresh && v?.state === "audio" ? v.ms : null,
	};
}

function tally(cards: readonly LiveCard[]) {
	const measured = cards.filter((c) => c.state !== "unmeasured" && c.state !== "stale");
	const checked = cards.map((c) => c.checkedAt).filter((t): t is number => t !== null);
	return {
		live: cards.filter((c) => c.state === "live").length,
		measured: measured.length,
		total: cards.length,
		checkedAt: checked.length ? Math.max(...checked) : null,
	};
}

export function computeLiveTv(store: Store, now: number): LiveTvView {
	const tv = TV_CHANNELS.map((c) => tvCard(store, now, c));
	const radio = RADIO_STATIONS.map((s) => radioCard(store, now, s));
	return {
		cards: [...tv, ...radio],
		tv: tally(tv),
		radio: tally(radio),
		ruleEs:
			"TV: «en vivo» cuando la página «/live» del canal en YouTube es una transmisión en curso de ese mismo canal " +
			"(isLive en los datos del reproductor), revisada hace menos de 45 min; «programada» si YouTube la anuncia sin " +
			"empezar. Radio: «emite» cuando la señal oficial responde con audio (HTTP 2xx, tipo audio, ≥ 4 KB con tramas " +
			"MP3/AAC en los primeros 16 KB), medida hace menos de 15 min. Más viejo: se muestra la hora de la última revisión.",
		ruleEn:
			"TV: “live” when the channel's YouTube “/live” page is a stream in progress by that same channel (isLive in the " +
			"player data), checked less than 45 min ago; “scheduled” when YouTube announces one not yet started. Radio: " +
			"“on air” when the official stream answers with audio (HTTP 2xx, audio type, ≥ 4 KB with MP3/AAC frames in the " +
			"first 16 KB), measured less than 15 min ago. Older: the time of the last check is shown.",
		vantageEs:
			"Medido desde este equipo: una transmisión puede verse aquí y no en Venezuela (o al revés), y YouTube puede " +
			"restringirla por país.",
		vantageEn:
			"Measured from this computer: a stream may play here and not in Venezuela (or the other way round), and YouTube " +
			"may restrict it by country.",
		budgets: { tvMs: TV_BUDGET_MS, radioMs: RADIO_BUDGET_MS },
	};
}

export const liveTvPanel: Panel<LiveTvView> = {
	id: "livetv",
	sources: [youtubeLive.id, radioStreams.id],
	compute: (store, now) => computeLiveTv(store, now),
};
