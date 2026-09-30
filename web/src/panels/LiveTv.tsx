import { signal } from "@preact/signals";
import type Hls from "hls.js";
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { type TvPicture, tvPicture } from "../lib/cameras.ts";
import { addStyles } from "../lib/css.ts";
import { healthById, now, panels, tick, wantPanel } from "../lib/data.ts";
import { ago, clock } from "../lib/format.ts";
import { loadHls } from "../lib/hls-load.ts";
import { lang, t } from "../lib/i18n.ts";
import { viewport } from "../lib/layout.ts";
import {
	embedUrl,
	PLAYER_LISTEN,
	PLAYER_MUTE,
	PLAYER_ORIGIN,
	PLAYER_UNMUTE,
	plainTitle,
	playerAudible,
} from "../lib/livetv.ts";
import {
	type CuratedView,
	filterItems,
	type MediaDirView,
	type MediaItem,
	type PlayEnv,
	type PlayMode,
	playMode,
	radioItems,
	reasonText,
	type Scope,
	startPlaying,
	stateCounts,
	type TvStills,
	tvItems,
} from "../lib/media.ts";
import { PANEL_META } from "../lib/panel-meta.ts";
import { stateName } from "../lib/states.ts";
import { registerSummary } from "../lib/summary.ts";
import livetvCss from "../styles/livetv.css?inline";
import { Panel } from "../ui/Panel.tsx";
import { SourceTag } from "../ui/Source.tsx";

addStyles(livetvCss);

/*
 * "TV en vivo" and "Radio en vivo": every free-to-air channel and station Vigía knows, from its curated list
 * (official YouTube channels, verified radio streams: `livetv`) and the public directories (iptv-org, Radio
 * Browser: `mediadir`, fetched when the panel opens). On a desk the TV is a wall of posters; a press plays one with
 * sound, the others that play keep going muted at their lowest quality, at most four at a time. On a phone both are
 * plain lists, one stream at a time. Nothing plays until pressed, a poster is never a fake picture, and every
 * stream plays from the broadcaster's own server (Vigía relays nothing).
 */

export type { CuratedView as LiveTvView };

/** Streams a desk may play at once (each is ~1–3 Mb/s; muted ones ask for their lowest quality). */
const WALL_MAX = 4;

/** TV items playing, oldest first. */
const playing = signal<string[]>([]);
/** The one stream with sound: a TV tile or the radio. */
const audible = signal<string | null>(null);
/** The radio station playing (one at a time). */
const radioOn = signal<string | null>(null);
/** Said to screen readers when starting a stream stops another. */
const said = signal("");

let env: PlayEnv | null = null;
function playEnv(): PlayEnv {
	if (!env) {
		const v = document.createElement("video");
		env = {
			nativeHls: v.canPlayType("application/vnd.apple.mpegurl") !== "",
			mse: typeof MediaSource !== "undefined" || "ManagedMediaSource" in window,
			pageHttp: location.protocol === "http:",
		};
	}
	return env;
}

function startTv(item: MediaItem, max: number): void {
	if (failures.value.has(item.id)) {
		const f = new Map(failures.value);
		f.delete(item.id);
		failures.value = f;
	}
	const next = startPlaying(playing.value, item.id, max);
	playing.value = next.playing;
	audible.value = item.id;
	radioOn.value = null;
	said.value = next.stopped.length
		? t(
				`${item.name} con sonido. Se detuvo ${next.stopped.length === 1 ? "otra transmisión" : `${next.stopped.length} transmisiones`} para no pasar de ${max} a la vez.`,
				`${item.name} with sound. Stopped ${next.stopped.length === 1 ? "another stream" : `${next.stopped.length} streams`} to stay at ${max} at once.`,
			)
		: t(`${item.name} con sonido.`, `${item.name} with sound.`);
}

/** A stream that failed stops holding a slot (and the sound); its tile keeps saying why until it is pressed again. */
const failures = signal<ReadonlyMap<string, Failure>>(new Map());
function failTv(id: string, f: Failure): void {
	failures.value = new Map([...failures.value, [id, f]]);
	stopTv(id);
}

function stopTv(id: string): void {
	playing.value = playing.value.filter((p) => p !== id);
	if (audible.value === id) audible.value = null;
}

function toggleSound(id: string): void {
	if (audible.value === id) audible.value = null;
	else {
		audible.value = id;
		radioOn.value = null;
	}
}

/** Said to screen readers when a station starts or stops (the radio panel's own live region). */
const radioSaid = signal("");

function playRadio(item: MediaItem | null): void {
	const was = radioOn.value;
	radioOn.value = item?.id ?? null;
	audible.value = item?.id ?? null;
	// A phone plays one stream: the radio stops the TV (muting it would keep the video downloading).
	if (item && viewport.value !== "mid" && viewport.value !== "wide") playing.value = [];
	radioSaid.value = item
		? t(`${item.name}: sonando.`, `${item.name}: playing.`)
		: was
			? t("Radio detenida.", "Radio stopped.")
			: "";
}

/**
 * Streams belong to the panel on screen: when it leaves (another module, collapsed, moved), everything it played stops,
 * so nothing reconnects later without a press.
 */
function useStopOnLeave(kind: "tv" | "radio"): void {
	useEffect(
		() => () => {
			if (kind === "tv") {
				if (audible.peek()?.startsWith("tv:")) audible.value = null;
				playing.value = [];
			} else {
				if (audible.peek()?.startsWith("radio:")) audible.value = null;
				radioOn.value = null;
			}
		},
		[],
	);
}

/** Asks for the directory when the panel opens; says so if it cannot be fetched. */
function useDirectory(): { dir: MediaDirView | undefined; failed: boolean; retry: () => void } {
	const dir = panels.value.mediadir as MediaDirView | undefined;
	const [failed, setFailed] = useState(false);
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		let live = true;
		wantPanel("mediadir").catch(() => {
			if (live) setFailed(true);
		});
		return () => {
			live = false;
		};
	}, [attempt]);
	return {
		dir,
		failed: failed && !dir,
		retry: () => {
			setFailed(false);
			setAttempt((a) => a + 1);
		},
	};
}

/* ---------- Words ---------- */

type Tone = "live" | "soon" | "off" | "stale" | "muted";

function stateWord(item: MediaItem): { text: string; tone: Tone } {
	switch (item.state) {
		case "live":
			return item.kind === "tv"
				? { text: t("En vivo", "Live"), tone: "live" }
				: { text: t("Emite", "On air"), tone: "live" };
		case "upcoming":
			return { text: t("Programada", "Scheduled"), tone: "soon" };
		case "off":
			return { text: t("Sin señal", "No signal"), tone: "off" };
		case "no-answer":
			return { text: t("No responde", "Not answering"), tone: "off" };
		case "unknown":
			return { text: t("Desconocido", "Unknown"), tone: "muted" };
		case "stale":
			return { text: t("Desactualizado", "Out of date"), tone: "stale" };
		case "unmeasured":
			return { text: t("Sin medir", "Not measured"), tone: "muted" };
	}
}

/** "revisado hace 4 min"; for an old check, when it was and what it said then. */
function checkedText(item: MediaItem): string | null {
	if (item.checkedAt === null) return null;
	const l = lang.value;
	const age = ago(now.value - item.checkedAt, l);
	if (item.state !== "stale") return t(`revisado ${age}`, `checked ${age}`);
	const was =
		item.detail === "live"
			? t(", entonces en vivo", ", live then")
			: item.detail === "not-live" || item.detail === "offline"
				? t(", entonces sin señal", ", no signal then")
				: "";
	return t(
		`última revisión ${clock(item.checkedAt, l)} (${age})${was}`,
		`last checked ${clock(item.checkedAt, l)} (${age})${was}`,
	);
}

function whyOff(item: MediaItem): string | null {
	if (item.state !== "off" && item.state !== "no-answer") return null;
	return reasonText(item.detail, lang.value);
}

function placeText(item: MediaItem): string | null {
	if (item.states.length)
		return item.states.length > 2
			? t(`${item.states.length} estados`, `${item.states.length} states`)
			: item.states.map((s) => stateName(s)).join(", ");
	return item.sub;
}

function placeNote(item: MediaItem): string | null {
	if (item.statesNote === "name") return t("ubicación por nombre", "placed by name");
	if (item.statesNote === "allowlist" || !item.statesNote) return null;
	return t(`ubicado por Vigía: ${item.statesNote}`, `placed by Vigía: ${item.statesNote}`);
}

function ownerText(item: MediaItem): string | null {
	return lang.value === "es" ? item.ownerEs : item.ownerEn;
}

type Why = Extract<PlayMode, { mode: "external" }>["why"];

const EXTERNAL_WHY: Record<Why, () => string> = {
	http: () =>
		t(
			"Señal http:// sin cifrar: una página segura no puede reproducirla. Ábrela en un reproductor como VLC.",
			"Unencrypted http:// stream: a secure page cannot play it. Open it in a player such as VLC.",
		),
	"no-cors": () =>
		t(
			"Su servidor no deja que otra página la lea, y este navegador no reproduce HLS por sí solo (Safari, iPhone y Android sí). Ábrela en un reproductor como VLC.",
			"Its server does not let another page read it, and this browser does not play HLS by itself (Safari, iPhone and Android do). Open it in a player such as VLC.",
		),
	"no-hls": () =>
		t(
			"Este navegador no puede reproducir señales HLS. Ábrela en un reproductor como VLC.",
			"This browser cannot play HLS streams. Open it in a player such as VLC.",
		),
};

const WHY_SHORT: Record<Why, () => string> = {
	http: () => t("señal http://", "http:// stream"),
	"no-cors": () => t("este navegador no la abre", "this browser cannot open it"),
	"no-hls": () => t("este navegador no reproduce HLS", "this browser does not play HLS"),
};

function StateMark({ item, overlay = false }: { item: MediaItem; overlay?: boolean }) {
	const w = stateWord(item);
	// Over a picture, "en vivo" is the signal's state, not the picture's: said so.
	const s = overlay && item.state === "live" ? { ...w, text: t("Señal en vivo", "Live signal") } : w;
	const when = checkedText(item);
	return (
		<span class={`lm-state lm-state--${s.tone}`}>
			<span class="lm-state__word">
				<i aria-hidden="true" />
				{s.text}
			</span>
			{when ? <span class="lm-state__when">{when}</span> : null}
		</span>
	);
}

/* ---------- Players ---------- */

type Failure = "network" | "media" | "load" | "no-hls";

function failureText(f: Failure): string {
	switch (f) {
		case "network":
			return t(
				"La señal no respondió a este navegador (puede estar caída, o bloqueada desde aquí).",
				"The stream did not answer this browser (it may be down, or blocked from here).",
			);
		case "media":
			return t("Este navegador no pudo decodificar la señal.", "This browser could not decode the stream.");
		case "load":
			return t(
				"No se pudo cargar el reproductor (¿sin conexión?).",
				"The player could not be loaded (offline?).",
			);
		case "no-hls":
			return EXTERNAL_WHY["no-hls"]();
	}
}

/**
 * A video or audio element on an HLS or plain stream: native playback where the browser has it, else hls.js loaded
 * on this press. Muted players ask hls.js for the lowest quality. A refused unmuted start (Safari without a fresh
 * press) starts muted and gives the sound back.
 */
function StreamMedia(props: {
	id: string;
	url: string;
	mode: "native-hls" | "hls.js" | "audio";
	kind: "video" | "audio";
	muted: boolean;
	label: string;
	controls?: boolean | undefined;
	onFail: (f: Failure) => void;
}) {
	const { id, url, mode, muted, onFail } = props;
	const video = useRef<HTMLVideoElement>(null);
	const audio = useRef<HTMLAudioElement>(null);
	const hls = useRef<Hls | null>(null);
	const media = (): HTMLMediaElement | null => video.current ?? audio.current;
	useEffect(() => {
		const el = media();
		if (!el) return;
		let dead = false;
		el.muted = audible.peek() !== id;
		const go = () => {
			el.play().catch((err: unknown) => {
				if (dead || (err as { name?: string }).name !== "NotAllowedError" || el.muted) return;
				el.muted = true;
				if (audible.peek() === id) audible.value = null;
				el.play().catch(() => {});
			});
		};
		if (mode !== "hls.js") {
			el.src = url;
			go();
		} else {
			loadHls().then(
				(H) => {
					if (dead) return;
					if (!H.isSupported()) {
						onFail("no-hls");
						return;
					}
					// No worker: the page's policy allows scripts from itself only, not from blob: URLs.
					const h = new H({
						enableWorker: false,
						capLevelToPlayerSize: true,
						startLevel: el.muted ? 0 : -1,
						maxBufferLength: 20,
						backBufferLength: 20,
					});
					hls.current = h;
					if (el.muted) h.autoLevelCapping = 0;
					h.on(H.Events.ERROR, (_e, data) => {
						if (!data.fatal || dead) return;
						onFail(data.type === H.ErrorTypes.MEDIA_ERROR ? "media" : "network");
						h.destroy();
						hls.current = null;
					});
					h.loadSource(url);
					h.attachMedia(el);
					go();
				},
				() => {
					if (!dead) onFail("load");
				},
			);
		}
		return () => {
			dead = true;
			hls.current?.destroy();
			hls.current = null;
			el.pause();
			el.removeAttribute("src");
			el.load();
		};
	}, [url, mode]);
	useEffect(() => {
		const el = media();
		if (!el) return;
		el.muted = muted;
		if (!muted && el.paused) el.play().catch(() => {});
		if (hls.current) hls.current.autoLevelCapping = muted ? 0 : -1;
	}, [muted]);
	// Sound turned on from the element's own controls takes the sound from everything else.
	const onVolume = () => {
		const el = media();
		if (el && !el.muted && el.volume > 0 && audible.peek() !== id) {
			audible.value = id;
			if (props.kind === "video") radioOn.value = null;
		}
	};
	const onError = () => {
		if (mode !== "hls.js") onFail("network");
	};
	return props.kind === "audio" ? (
		// biome-ignore lint/a11y/useMediaCaption: a live radio stream has no caption track to offer.
		<audio
			ref={audio}
			class="lm-audio"
			controls
			preload="none"
			aria-label={props.label}
			onVolumeChange={onVolume}
			onError={onError}
		/>
	) : (
		// biome-ignore lint/a11y/useMediaCaption: free-to-air live streams carry no caption track.
		<video
			ref={video}
			class="lm-video"
			playsInline
			controls={props.controls ?? false}
			preload="none"
			aria-label={props.label}
			onVolumeChange={onVolume}
			onError={onError}
		/>
	);
}

/**
 * The official YouTube player (cookie-less domain), started muted or not by the press that opened it; sound moves
 * between players through YouTube's message API, and a player unmuted from its own controls takes the sound.
 */
function YouTubeFrame({ item, muted }: { item: MediaItem; muted: boolean }) {
	const frame = useRef<HTMLIFrameElement>(null);
	const heard = useRef(false);
	const src = useMemo(
		() =>
			item.play.kind === "youtube" ? embedUrl(item.play, audible.peek() !== item.id, location.origin) : null,
		[item.id],
	);
	useEffect(() => {
		const onMessage = (e: MessageEvent) => {
			if (e.origin !== PLAYER_ORIGIN || e.source !== frame.current?.contentWindow) return;
			heard.current = true;
			if (playerAudible(e.data) === true && audible.peek() !== item.id) {
				audible.value = item.id;
				radioOn.value = null;
			}
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [item.id]);
	useEffect(() => {
		// The player may not be ready yet: say it a few times.
		const say = () =>
			frame.current?.contentWindow?.postMessage(muted ? PLAYER_MUTE : PLAYER_UNMUTE, PLAYER_ORIGIN);
		const timers = [0, 600, 1800].map((ms) => setTimeout(say, ms));
		return () => {
			for (const x of timers) clearTimeout(x);
		};
	}, [muted]);
	if (!src) return null;
	return (
		<iframe
			ref={frame}
			class="lm-video"
			src={src}
			title={t(`${item.name}, reproductor de YouTube`, `${item.name}, YouTube player`)}
			allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
			allowFullScreen
			// YouTube's player refuses to start without the embedding origin (error 153); only the origin is sent.
			referrerpolicy="strict-origin"
			sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
			onLoad={(e) => {
				heard.current = false;
				const el = e.currentTarget as HTMLIFrameElement;
				let tries = 0;
				const hello = () => {
					if (heard.current || tries++ > 40 || frame.current !== el) return;
					el.contentWindow?.postMessage(PLAYER_LISTEN(1), PLAYER_ORIGIN);
					setTimeout(hello, 500);
				};
				hello();
			}}
		/>
	);
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/** What the reader's press connects them to, said under a playing stream. */
function PrivacyNote({ item }: { item: MediaItem }) {
	return (
		<p class="lm-note">
			{item.play.kind === "youtube"
				? t(
						"Reproductor oficial de YouTube (youtube-nocookie.com): tu navegador se conecta a YouTube.",
						"YouTube's official player (youtube-nocookie.com): your browser connects to YouTube.",
					)
				: t(
						`Señal de la emisora (${hostOf(item.play.url)}): tu navegador se conecta a su servidor; Vigía no la retransmite.`,
						`The broadcaster's stream (${hostOf(item.play.url)}): your browser connects to its server; Vigía does not relay it.`,
					)}
		</p>
	);
}

function External({ item, why }: { item: MediaItem; why: Why }) {
	if (item.play.kind === "youtube") return null;
	return (
		<p class="lm-fail">
			{EXTERNAL_WHY[why]()}{" "}
			<a href={item.play.url} target="_blank" rel="noopener noreferrer">
				{t("Abrir la señal", "Open the stream")} ↗
			</a>
		</p>
	);
}

/** The media of a TV item that plays: YouTube's player, or the stream in a video element. */
function TvMedia({ item, muted, controls }: { item: MediaItem; muted: boolean; controls?: boolean }) {
	if (item.play.kind === "youtube") return <YouTubeFrame item={item} muted={muted} />;
	const mode = playMode(item.play, playEnv());
	if (mode.mode === "external") return <External item={item} why={mode.why} />;
	if (mode.mode === "youtube" || mode.mode === "audio")
		return (
			<p class="lm-fail" role="status">
				<a href={item.play.url} target="_blank" rel="noopener noreferrer">
					{t("Abrir la señal", "Open the stream")} ↗
				</a>
			</p>
		);
	return (
		<StreamMedia
			id={item.id}
			url={item.play.url}
			mode={mode.mode}
			kind="video"
			muted={muted}
			controls={controls}
			label={t(`${item.name}, en vivo`, `${item.name}, live`)}
			onFail={(f) => failTv(item.id, f)}
		/>
	);
}

/** Why the last press on this stream did not play, with the link to try it elsewhere. */
function FailNote({ item }: { item: MediaItem }) {
	const f = failures.value.get(item.id);
	if (!f || item.play.kind === "youtube") return null;
	return (
		<p class="lm-fail lm-fail--note" role="status">
			{failureText(f)}{" "}
			<a href={item.play.url} target="_blank" rel="noopener noreferrer">
				{t("Abrir la señal", "Open the stream")} ↗
			</a>
		</p>
	);
}

/* ---------- Icons ---------- */

const PLAY = <path d="M4 2.5v11l9-5.5z" />;
const STOP = <path d="M3.5 3.5h9v9h-9z" />;
function SoundIcon({ on }: { on: boolean }) {
	return (
		<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" class="ico">
			<path d="M2.5 6h2.5l3.5-3v10l-3.5-3H2.5z" />
			{on ? <path d="M11 5.5c1 .7 1.5 1.5 1.5 2.5s-.5 1.8-1.5 2.5" /> : <path d="M11 6l3 4M14 6l-3 4" />}
		</svg>
	);
}

/* ---------- The desk's wall ---------- */

/** A still is shown for 45 min at most (the server's budget, re-checked here: panels are cached until new data). */
const STILL_MAX_AGE_MS = 45 * 60_000;
/** Pictures that failed to load in this visit (a blob past its retention): the card falls back, never a broken image. */
const brokenPictures = signal<ReadonlySet<string>>(new Set());

/** The card's picture by the server's rule, on this clock, with an image that failed falling back to the name. */
function pictureOf(item: MediaItem, n: number, maxAgeMs: number): TvPicture {
	const pic = tvPicture(item.image, n, maxAgeMs, lang.value);
	if ((pic.kind === "still" || pic.kind === "logo") && brokenPictures.value.has(pic.url))
		return {
			kind: "name",
			label: t("Sin cuadro reciente", "No recent frame"),
			why: t("la imagen ya no está guardada", "the picture is no longer kept"),
		};
	return pic;
}

/** Rank on the wall: a card with a current frame first, then a logo, then the name alone. */
function pictureRank(item: MediaItem, n: number, maxAgeMs: number): number {
	const k = pictureOf(item, n, maxAgeMs).kind;
	return k === "still" ? 0 : k === "logo" ? 1 : 2;
}

/**
 * The poster's picture: a frame Vigía took ("Cuadro de las 14:05 · hace 12 min"), YouTube's live thumbnail, a fixed
 * cover said as such, the channel's logo with "Sin cuadro reciente" and why, or the channel's name set large. Every
 * picture is served by Vigía; the overlay is always dark, so its words read on any picture in either theme.
 */
function Picture({ item, pic }: { item: MediaItem; pic: TvPicture }) {
	const l = lang.value;
	const fail = (url: string) => () => {
		brokenPictures.value = new Set([...brokenPictures.value, url]);
	};
	return (
		<span
			class={`lm-pic lm-pic--${pic.kind}${pic.kind === "still" && pic.cover ? " lm-pic--cover" : ""}`}
			aria-hidden="true"
		>
			{pic.kind === "still" ? (
				<img
					class="lm-pic__img"
					src={pic.url}
					width={pic.width}
					height={pic.height}
					loading="lazy"
					decoding="async"
					alt=""
					title={pic.credit}
					onError={fail(pic.url)}
				/>
			) : pic.kind === "logo" ? (
				<img
					class="lm-pic__logo"
					src={pic.url}
					width={pic.width}
					height={pic.height}
					loading="lazy"
					decoding="async"
					alt=""
					title={pic.credit}
					onError={fail(pic.url)}
				/>
			) : (
				<span class="lm-pic__name">{item.name}</span>
			)}
			<span class="lm-pic__cap">
				<span class="lm-pic__label">
					{pic.label}
					{pic.kind === "still" ? <span class="mono"> · {ago(now.value - pic.takenAt, l)}</span> : null}
				</span>
				{pic.kind !== "still" && pic.why ? <span class="lm-pic__why">{pic.why}</span> : null}
			</span>
		</span>
	);
}

function Tile({
	item,
	tab,
	onFocusTile,
	maxAgeMs,
}: {
	item: MediaItem;
	tab: boolean;
	onFocusTile: () => void;
	maxAgeMs: number;
}) {
	const on = playing.value.includes(item.id);
	const withSound = audible.value === item.id;
	const box = useRef<HTMLLIElement>(null);
	const mode = playMode(item.play, playEnv());
	const owner = ownerText(item);
	const why = whyOff(item);
	const meta = [placeText(item), item.quality, item.origin === "curated" ? "YouTube" : null]
		.filter(Boolean)
		.join(" · ");
	const pic = on ? null : pictureOf(item, now.value, maxAgeMs);
	return (
		<li
			ref={box}
			class={`lm-tile lm-tile--${stateWord(item).tone}${on ? " is-on" : ""}${withSound ? " is-audible" : ""}`}
		>
			<div class="lm-tile__media">
				{on ? (
					<TvMedia item={item} muted={!withSound} />
				) : mode.mode === "external" ? (
					<a
						class="lm-tile__poster has-pic"
						data-tile
						tabIndex={tab ? 0 : -1}
						onFocus={onFocusTile}
						href={item.play.kind === "youtube" ? item.link : item.play.url}
						target="_blank"
						rel="noopener noreferrer"
						title={EXTERNAL_WHY[mode.why]()}
						aria-label={t(
							`${item.name}: abrir la señal fuera de Vigía (${WHY_SHORT[mode.why]()})`,
							`${item.name}: open the stream outside Vigía (${WHY_SHORT[mode.why]()})`,
						)}
					>
						{pic ? <Picture item={item} pic={pic} /> : null}
						<span class="lm-over">
							<StateMark item={item} overlay />
							<span class="lm-tile__cta lm-tile__cta--ext">{t("Abrir fuera", "Open outside")} ↗</span>
							<span class="lm-tile__why">{WHY_SHORT[mode.why]()}</span>
						</span>
					</a>
				) : (
					<button
						type="button"
						class="lm-tile__poster has-pic"
						data-tile
						tabIndex={tab ? 0 : -1}
						onFocus={onFocusTile}
						onClick={() => {
							startTv(item, WALL_MAX);
							// The poster gives way to the player: keep the keyboard on this tile (its sound button).
							requestAnimationFrame(() =>
								box.current?.querySelector<HTMLButtonElement>(".lm-tile__tools button")?.focus(),
							);
						}}
						aria-label={t(`Ver ${item.name} con sonido`, `Watch ${item.name} with sound`)}
					>
						{pic ? <Picture item={item} pic={pic} /> : null}
						<span class="lm-over">
							<StateMark item={item} overlay />
							<span class="lm-tile__cta" aria-hidden="true">
								<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
									{PLAY}
								</svg>
							</span>
							{why ? <span class="lm-tile__why">{why}</span> : null}
						</span>
					</button>
				)}
			</div>
			<div class="lm-tile__cap">
				<div class="lm-tile__id">
					<span
						class="lm-tile__name"
						title={
							item.alternates
								? t(
										`y ${item.alternates} señales más del mismo canal en la lista`,
										`and ${item.alternates} more streams of this channel in the list`,
									)
								: undefined
						}
					>
						{item.name}
					</span>
					{meta ? <span class="lm-tile__meta">{meta}</span> : null}
					{owner && item.owner !== "other" ? <span class="lm-owner">{owner}</span> : null}
				</div>
				{on ? (
					<div class="lm-tile__tools">
						<button
							type="button"
							class="icon-btn"
							aria-pressed={withSound}
							aria-label={t(`Sonido: ${item.name}`, `Sound: ${item.name}`)}
							title={withSound ? t("Silenciar", "Mute") : t("Escuchar este", "Listen to this one")}
							onClick={() => toggleSound(item.id)}
						>
							<SoundIcon on={withSound} />
						</button>
						<button
							type="button"
							class="icon-btn"
							aria-label={t(`Pantalla completa: ${item.name}`, `Full screen: ${item.name}`)}
							title={t("Pantalla completa", "Full screen")}
							onClick={() => box.current?.querySelector(".lm-tile__media")?.requestFullscreen?.()}
						>
							<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" class="ico">
								<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />
							</svg>
						</button>
						<button
							type="button"
							class="icon-btn"
							aria-label={t(`Detener ${item.name}`, `Stop ${item.name}`)}
							title={t("Detener", "Stop")}
							onClick={() => {
								stopTv(item.id);
								requestAnimationFrame(() => box.current?.querySelector<HTMLElement>("[data-tile]")?.focus());
							}}
						>
							<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
								{STOP}
							</svg>
						</button>
					</div>
				) : null}
			</div>
			<FailNote item={item} />
			{item.title && item.state === "live" ? (
				<a class="lm-tile__title" href={item.link} target="_blank" rel="noopener noreferrer">
					{plainTitle(item.title)}
				</a>
			) : null}
		</li>
	);
}

/** Under the wall: where its pictures come from, counted, and when this computer cannot take frames. */
function StillsNote({ stills }: { stills: TvStills }) {
	const l = lang.value;
	const total = stills.frames + stills.logos + stills.none;
	return (
		<p class="lm-note">
			{stills.decoder === null
				? `${t("Este equipo no tiene ffmpeg: se muestran logos.", "This computer has no ffmpeg: logos are shown.")} `
				: ""}
			{t(
				`Imágenes de las ${total} señales del directorio: ${stills.frames} con un cuadro tomado por Vigía (cada 30 min), ${stills.logos} con su logo (iptv-org), ${stills.none} con su nombre; los canales de YouTube, con su miniatura en vivo leída por Vigía. Todas se sirven desde Vigía y cada una dice su hora.`,
				`Pictures of the directory's ${total} streams: ${stills.frames} with a frame Vigía took (every 30 min), ${stills.logos} with their logo (iptv-org), ${stills.none} with their name; YouTube channels, with their live thumbnail read by Vigía. All are served by Vigía and each says its time.`,
			)}
			{stills.round
				? t(
						` Última ronda: ${clock(stills.round.at, l)}, ${stills.round.stills} de ${stills.round.attempted} señales.`,
						` Last round: ${clock(stills.round.at, l)}, ${stills.round.stills} of ${stills.round.attempted} streams.`,
					)
				: ""}
		</p>
	);
}

/** Arrow keys move between posters (one tab stop for the whole wall); Home and End go to the ends. */
function useRovingGrid(count: number) {
	const [focus, setFocus] = useState(0);
	const grid = useRef<HTMLOListElement>(null);
	const at = Math.min(focus, Math.max(0, count - 1));
	const onKeyDown = (e: KeyboardEvent) => {
		const keys = ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"];
		if (!keys.includes(e.key) || !(e.target as HTMLElement).matches("[data-tile]")) return;
		const tiles = [...(grid.current?.querySelectorAll<HTMLElement>("[data-tile]") ?? [])];
		const i = tiles.indexOf(e.target as HTMLElement);
		if (i === -1) return;
		const lefts = new Set(tiles.map((x) => Math.round(x.getBoundingClientRect().left)));
		const perRow = Math.max(1, lefts.size);
		const next =
			e.key === "ArrowRight"
				? i + 1
				: e.key === "ArrowLeft"
					? i - 1
					: e.key === "ArrowDown"
						? i + perRow
						: e.key === "ArrowUp"
							? i - perRow
							: e.key === "Home"
								? 0
								: tiles.length - 1;
		const target = tiles[Math.max(0, Math.min(tiles.length - 1, next))];
		if (!target) return;
		e.preventDefault();
		target.focus();
	};
	return { grid, at, setFocus, onKeyDown };
}

function Wall({
	items,
	all,
	stills,
}: {
	items: MediaItem[];
	all: MediaItem[];
	stills: TvStills | undefined;
}) {
	// Live channels in the filter, then whatever plays (whatever the filter: a stream never plays unseen); among the
	// live ones, a card with a current frame first, then a logo, then the name (the order is stable within each).
	const on = playing.value;
	const maxAgeMs = stills?.maxAgeMs ?? STILL_MAX_AGE_MS;
	// Ranked on the 15 s tick, not the 1 s clock: tiles do not jump under the reader's focus every second.
	const n = tick.value;
	const playingNow = all.filter((i) => on.includes(i.id) && !items.includes(i));
	const live = items.filter((i) => i.state === "live" || on.includes(i.id));
	const rank = new Map(live.map((i) => [i.id, pictureRank(i, n, maxAgeMs)]));
	const wall = [...playingNow, ...live.sort((a, b) => (rank.get(a.id) ?? 2) - (rank.get(b.id) ?? 2))];
	const rest = items.filter((i) => !wall.includes(i));
	const posters = wall.filter((i) => !on.includes(i.id));
	const { grid, at, setFocus, onKeyDown } = useRovingGrid(posters.length);
	let p = -1;
	return (
		<>
			<p class="lm-note">
				{t(
					`Pulsa un canal para verlo con sonido; los que ya se ven siguen en silencio (a su menor calidad cuando el reproductor lo permite), hasta ${WALL_MAX} a la vez (cada señal usa ~1–3 Mb/s). Flechas: moverse entre canales.`,
					`Press a channel to watch it with sound; those already playing carry on muted (at their lowest quality when the player allows it), up to ${WALL_MAX} at once (each stream uses ~1–3 Mb/s). Arrow keys move between channels.`,
				)}
			</p>
			{wall.length ? (
				<ol
					class="lm-wall"
					ref={grid}
					onKeyDown={onKeyDown}
					aria-label={t("Canales en vivo", "Live channels")}
				>
					{wall.map((item) => {
						const isPoster = !on.includes(item.id);
						if (isPoster) p++;
						const idx = p;
						return (
							<Tile
								key={item.id}
								item={item}
								tab={isPoster && idx === at}
								onFocusTile={() => setFocus(idx)}
								maxAgeMs={maxAgeMs}
							/>
						);
					})}
				</ol>
			) : (
				<p class="lm-empty">
					{t("Ningún canal en vivo con este filtro.", "No live channel with this filter.")}
				</p>
			)}
			{stills ? <StillsNote stills={stills} /> : null}
			{rest.length ? (
				<details class="lm-rest">
					<summary>
						{t(
							"Sin señal en la última revisión, o sin medir",
							"No signal at the last check, or not measured",
						)}{" "}
						<span class="mono">({rest.length})</span>
					</summary>
					<ul class="lm-list">
						{rest.map((item) => (
							<Row key={item.id} item={item} onPlay={() => startTv(item, WALL_MAX)} />
						))}
					</ul>
				</details>
			) : null}
		</>
	);
}

/* ---------- Lists (phone TV, and radio everywhere) ---------- */

function Row({
	item,
	onPlay,
	playingNow,
	onStop,
	children,
}: {
	item: MediaItem;
	onPlay: () => void;
	playingNow?: boolean;
	onStop?: () => void;
	children?: ComponentChildren;
}) {
	const mode = playMode(item.play, playEnv());
	const place = placeText(item);
	const note = placeNote(item);
	const owner = ownerText(item);
	const why = whyOff(item);
	const on = playingNow === true;
	const verb = item.kind === "tv" ? t("Ver", "Watch") : t("Escuchar", "Listen");
	return (
		<li class={`lm-row lm-row--${stateWord(item).tone}${on ? " is-on" : ""}`}>
			<div class="lm-row__main">
				<span class="lm-row__name">{item.name}</span>
				<span class="lm-row__meta">
					{place ? <span>{place}</span> : null}
					{note ? <span class="lm-row__basis">{note}</span> : null}
					{owner && item.owner !== "other" ? (
						<span class="lm-owner">{owner}</span>
					) : owner ? (
						<span>{owner}</span>
					) : null}
					{item.quality ? <span class="mono">{item.quality}</span> : null}
					{item.notAlways ? <span>{t("no emite 24/7", "not 24/7")}</span> : null}
					{item.geoBlocked ? <span>{t("puede estar bloqueado por país", "may be geo-blocked")}</span> : null}
				</span>
				<StateMark item={item} />
				{why ? <span class="lm-row__why">{why}</span> : null}
				{item.kind === "tv" ? <FailNote item={item} /> : null}
				{item.origin === "radio-browser" && item.title ? (
					<span class="lm-row__why">
						{t(`en la lista de Vigía: ${item.title}`, `on Vigía's list: ${item.title}`)}
					</span>
				) : null}
				{item.kind === "tv" && item.title && item.state === "live" ? (
					<a class="lm-row__title" href={item.link} target="_blank" rel="noopener noreferrer">
						{plainTitle(item.title)}
					</a>
				) : null}
			</div>
			{mode.mode === "external" ? (
				<a
					class="lm-play lm-play--ext"
					href={item.play.kind === "youtube" ? item.link : item.play.url}
					target="_blank"
					rel="noopener noreferrer"
					title={EXTERNAL_WHY[mode.why]()}
				>
					{t("Abrir", "Open")} ↗<span class="sr-only">{`${item.name} (${WHY_SHORT[mode.why]()})`}</span>
				</a>
			) : (
				<button
					type="button"
					class={`lm-play${on ? " is-on" : ""}`}
					aria-pressed={on}
					onClick={on ? onStop : onPlay}
				>
					<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
						{on ? STOP : PLAY}
					</svg>
					<span>{on ? t("Detener", "Stop") : verb}</span>
					<span class="sr-only">{item.name}</span>
				</button>
			)}
			{children ? <div class="lm-row__player">{children}</div> : null}
		</li>
	);
}

/** Long lists show their first rows and a button for the rest (124 stations on a phone is a long scroll). */
const CAP = 25;
function useCap(n: number): { shown: number; more: ComponentChildren } {
	const [all, setAll] = useState(false);
	const shown = all ? n : Math.min(n, CAP);
	return {
		shown,
		more:
			n > shown ? (
				<button type="button" class="lm-more" onClick={() => setAll(true)}>
					{t(`Mostrar los ${n - shown} restantes`, `Show the other ${n - shown}`)}
				</button>
			) : null,
	};
}

/* ---------- Filters ---------- */

const SCOPE_HINT: Record<Scope, () => string> = {
	all: () => t("Todos los canales", "Every channel"),
	regional: () => t("Con un estado asignado", "With a state assigned"),
	national: () =>
		t(
			"Sin estado asignado: nacionales, internacionales o sin ubicar en la lista",
			"No state assigned: national, international, or not placed in the list",
		),
	state: () =>
		t("Medios del Estado venezolano y los que él financia", "Venezuelan state media, and media it funds"),
};

function Filters(props: {
	items: MediaItem[];
	scope: Scope;
	setScope: (s: Scope) => void;
	state: string | null;
	setState: (s: string | null) => void;
	id: string;
}) {
	const counts = stateCounts(props.items);
	const scopes: [Scope, string][] = [
		["all", t("Todos", "All")],
		["regional", t("Regionales", "Regional")],
		["national", t("Sin estado", "No state")],
		["state", t("Estatales", "State media")],
	];
	return (
		<div class="lm-filters">
			<fieldset class="segmented">
				<legend class="sr-only">{t("Tipo", "Kind")}</legend>
				{scopes.map(([s, label]) => (
					<button
						type="button"
						key={s}
						aria-pressed={props.scope === s}
						title={SCOPE_HINT[s]()}
						onClick={() => props.setScope(s)}
					>
						{label}
					</button>
				))}
			</fieldset>
			<label class="lm-select">
				<span class="sr-only">{t("Estado", "State")}</span>
				<select
					id={`${props.id}-state`}
					value={props.state ?? ""}
					onChange={(e) => props.setState((e.target as HTMLSelectElement).value || null)}
				>
					<option value="">{t("Todos los estados", "All states")}</option>
					{counts.map((c) => (
						<option key={c.iso} value={c.iso}>
							{stateName(c.iso)} ({c.n})
						</option>
					))}
				</select>
			</label>
		</div>
	);
}

/* ---------- Figures and credits ---------- */

interface Cell {
	label: string;
	value: string;
	of?: string;
	note?: string;
}

function Figures({ cells }: { cells: Cell[] }) {
	return (
		<dl class="lm-figs">
			{cells.map((c) => (
				<div class="lm-fig" key={c.label}>
					<dt>{c.label}</dt>
					<dd>
						<span class="lm-fig__v">{c.value}</span>
						{c.of ? <span class="lm-fig__of"> {c.of}</span> : null}
						{c.note ? <span class="lm-fig__note">{c.note}</span> : null}
					</dd>
				</div>
			))}
		</dl>
	);
}

function DirectoryFailed({ retry }: { retry: () => void }) {
	return (
		<p class="lm-empty">
			{t(
				"No se pudo cargar el directorio de canales y emisoras (se pide al abrir este panel).",
				"The directory of channels and stations could not be loaded (it is fetched when this panel opens).",
			)}{" "}
			<button type="button" class="link-button" onClick={retry}>
				{t("Reintentar", "Retry")}
			</button>
		</p>
	);
}

const tally = (items: MediaItem[]) => ({
	live: items.filter((i) => i.state === "live").length,
	total: items.length,
});

/* ---------- Television ---------- */

function OutOfList({ dir }: { dir: MediaDirView }) {
	const l = lang.value;
	const groups = new Map<string, { label: string; rows: MediaDirView["tv"]["excluded"] }>();
	for (const x of dir.tv.excluded) {
		const g = groups.get(x.reason) ?? { label: l === "es" ? x.reasonEs : x.reasonEn, rows: [] };
		g.rows.push(x);
		groups.set(x.reason, g);
	}
	if (!groups.size) return null;
	return (
		<details class="lm-out">
			<summary>
				{t("Fuera de la lista", "Left out")} <span class="mono">({dir.tv.excluded.length})</span>
				<span class="lm-out__hint">
					{t(
						"señales de la lista pública que Vigía no reproduce, y por qué",
						"streams in the public list Vigía does not play, and why",
					)}
				</span>
			</summary>
			{[...groups.values()].map((g) => (
				<section class="lm-out__group" key={g.label}>
					<h4>
						{g.label} <span class="mono">({g.rows.length})</span>
					</h4>
					<p class="lm-out__names">
						{[...new Set(g.rows.map((r) => (r.detail ? `${r.name} (${r.detail})` : r.name)))].join(" · ")}
					</p>
				</section>
			))}
		</details>
	);
}

/** Whether a liveness probe's last run is current (ok or degraded): only then do its counts answer "how many now". */
function probeCurrent(feed: string): boolean {
	const st = healthById.value.get(feed)?.state;
	return st === "ok" || st === "degraded";
}

export function TvPanel() {
	useStopOnLeave("tv");
	const l = lang.value;
	const curated = panels.value.livetv as CuratedView | undefined;
	const { dir, failed, retry } = useDirectory();
	const [scope, setScope] = useState<Scope>("all");
	const [state, setState] = useState<string | null>(null);
	const desk = viewport.value === "mid" || viewport.value === "wide";
	const all = useMemo(() => tvItems(curated, dir), [curated, dir]);
	const items = filterItems(all, scope, state);
	const ytOff = healthById.value.get("youtube-live")?.state === "off";
	const n = tally(all);
	const phoneOn = playing.value.at(-1) ?? null;
	const cap = useCap(items.length);
	const meta = PANEL_META.tv;
	return (
		<Panel
			id="tv"
			class="panel--live"
			title={meta.title()}
			question={meta.question()}
			feeds={meta.feeds()}
			ready={failed || dir !== undefined}
			method={
				<>
					{dir ? <p>{l === "es" ? dir.ruleEs : dir.ruleEn}</p> : null}
					{curated ? <p>{l === "es" ? curated.ruleEs : curated.ruleEn}</p> : null}
					{dir ? <p>{l === "es" ? dir.vantageEs : dir.vantageEn}</p> : null}
					{dir?.tv.stills ? <p>{l === "es" ? dir.tv.stills.ruleEs : dir.tv.stills.ruleEn}</p> : null}
					<p>
						{t(
							"Las imágenes de las tarjetas las sirve Vigía desde su propio servidor, re-codificadas: un cuadro que toma de cada señal, la miniatura en vivo de YouTube o el logo de la lista de iptv-org; tu navegador no se conecta a terceros para verlas. Una imagen de más de 45 minutos nunca se muestra como la del canal. En un teléfono la lista no carga imágenes (ahorra datos).",
							"The cards' pictures are served by Vigía from its own server, re-encoded: a frame it takes of each stream, YouTube's live thumbnail or the logo from iptv-org's list; your browser connects to no third party to see them. A picture older than 45 minutes is never shown as the channel's. On a phone the list loads no pictures (it saves data).",
						)}
					</p>
					<p>
						{t(
							"Nada se reproduce solo: cada señal carga al pulsarla, desde el servidor de la emisora (Vigía no retransmite nada). En el escritorio suena una a la vez; las demás que se ven siguen en silencio, hasta cuatro a la vez, y piden su menor calidad cuando el reproductor lo permite (hls.js sí; YouTube y el HLS nativo de Safari eligen la suya). Los medios del Estado y los financiados por gobiernos llevan su etiqueta. Un canal con varias señales en la lista se muestra una vez, con la mejor (en vivo, reproducible aquí, mayor calidad).",
							"Nothing autoplays: each stream loads when pressed, from the broadcaster's server (Vigía relays nothing). On a desk one plays with sound; the others on screen carry on muted, up to four at once, asking for their lowest quality when the player allows it (hls.js does; YouTube and Safari's native HLS choose their own). State and government-funded media carry their label. A channel with several streams in the list is shown once, with the best (live, playable here, highest quality).",
						)}
					</p>
				</>
			}
		>
			{failed ? <DirectoryFailed retry={retry} /> : null}
			<div class="lm">
				<Figures
					cells={[
						{
							label: t("En vivo", "Live"),
							// A count from an out-of-date check is not an answer: "—", never "0 de 72" (review minor).
							value: probeCurrent("iptv-ve-probe") ? String(n.live) : "—",
							of: t(`de ${n.total} canales`, `of ${n.total} channels`),
						},
						{
							label: t("Revisión de señales", "Stream check"),
							value: dir?.tv.checkedAt ? ago(now.value - dir.tv.checkedAt, l) : "—",
							note: t(
								"cada 30 min, desde el equipo donde corre Vigía",
								"every 30 min, from the computer Vigía runs on",
							),
						},
						{
							label: t("Fuera de la lista", "Left out"),
							value: dir ? String(dir.tv.excluded.length) : "—",
							of: t("señales", "streams"),
							note: t("de pago o retransmitidas", "pay or relayed"),
						},
					]}
				/>
				{ytOff ? (
					<p class="lm-note">
						{t(
							"La revisión de los canales de YouTube está apagada: se pueden ver igual; su estado envejece con su hora.",
							"The YouTube channel check is off: they still play; their state ages with its time.",
						)}
					</p>
				) : null}
				<Filters items={all} scope={scope} setScope={setScope} state={state} setState={setState} id="tv" />
				{desk ? (
					<Wall items={items} all={all} stills={dir?.tv.stills} />
				) : items.length ? (
					<ul class="lm-list">
						{items.slice(0, cap.shown).map((item) => (
							<Row
								key={item.id}
								item={item}
								playingNow={phoneOn === item.id}
								onPlay={() => startTv(item, 1)}
								onStop={() => stopTv(item.id)}
							>
								{phoneOn === item.id ? (
									<>
										<div class="lm-row__frame">
											<TvMedia item={item} muted={audible.value !== item.id} controls />
										</div>
										<PrivacyNote item={item} />
									</>
								) : null}
							</Row>
						))}
					</ul>
				) : (
					<p class="lm-empty">{t("Ningún canal con este filtro.", "No channel with this filter.")}</p>
				)}
				{desk ? null : cap.more}
				{dir ? <OutOfList dir={dir} /> : null}
				<div class="sources-row">
					{dir?.tv.listAt ? (
						<SourceTag
							source={{ feed: "iptv-ve", observedAt: dir.tv.listAt }}
							label={t("Lista: iptv-org (dominio público)", "List: iptv-org (public domain)")}
						/>
					) : null}
					{dir?.tv.checkedAt ? (
						<SourceTag
							source={{
								feed: "iptv-ve-probe",
								observedAt: dir.tv.checkedAt,
								detail: l === "es" ? dir.vantageEs : dir.vantageEn,
							}}
							label={t("Medición: Vigía", "Measured by Vigía")}
						/>
					) : null}
					{curated?.tv.checkedAt ? (
						<SourceTag
							source={{ feed: "youtube-live", observedAt: curated.tv.checkedAt }}
							label={t("Revisión de YouTube", "YouTube check")}
						/>
					) : null}
					{desk && dir?.tv.stills?.round ? (
						<SourceTag
							source={{ feed: "tv-stills", observedAt: dir.tv.stills.round.at }}
							label={t("Cuadros: Vigía", "Frames: Vigía")}
						/>
					) : null}
				</div>
			</div>
			<p class="sr-only" aria-live="polite">
				{said.value}
			</p>
		</Panel>
	);
}

/* ---------- Radio ---------- */

function RadioPlayer({ item }: { item: MediaItem }) {
	const [fail, setFail] = useState<Failure | null>(null);
	if (item.play.kind === "youtube") return null;
	const mode = playMode(item.play, playEnv());
	if (mode.mode === "external") return <External item={item} why={mode.why} />;
	if (mode.mode === "youtube") return null;
	return (
		<>
			{fail ? (
				<p class="lm-fail" role="status">
					{failureText(fail)}{" "}
					<a href={item.play.url} target="_blank" rel="noopener noreferrer">
						{t("Abrir la señal", "Open the stream")} ↗
					</a>
				</p>
			) : (
				<StreamMedia
					id={item.id}
					url={item.play.url}
					mode={mode.mode}
					kind="audio"
					muted={audible.value !== item.id}
					label={t(`${item.name}, en vivo`, `${item.name}, live`)}
					onFail={setFail}
				/>
			)}
			<PrivacyNote item={item} />
		</>
	);
}

export function RadioPanel() {
	useStopOnLeave("radio");
	const l = lang.value;
	const curated = panels.value.livetv as CuratedView | undefined;
	const { dir, failed, retry } = useDirectory();
	const [scope, setScope] = useState<Scope>("all");
	const [state, setState] = useState<string | null>(null);
	const all = useMemo(() => radioItems(curated, dir), [curated, dir]);
	const items = filterItems(all, scope, state);
	const n = tally(all);
	const s = dir?.radio.summary ?? null;
	const on = radioOn.value;
	const cap = useCap(items.length);
	const meta = PANEL_META.radio;
	return (
		<Panel
			id="radio"
			class="panel--live"
			title={meta.title()}
			question={meta.question()}
			feeds={meta.feeds()}
			ready={failed || dir !== undefined}
			method={
				<>
					{dir ? <p>{l === "es" ? dir.ruleEs : dir.ruleEn}</p> : null}
					{dir ? <p>{l === "es" ? dir.vantageEs : dir.vantageEn}</p> : null}
					<p>
						{t(
							"Las emisoras de la lista de Vigía van primero, con su señal verificada; una emisora del directorio que es la misma señal no se repite. «Ubicación por nombre»: el estado sale del nombre de la emisora, no de un dato de ubicación. Suena una a la vez, y al darle sonido a un canal de TV la radio se detiene.",
							"Stations on Vigía's list come first, with their verified stream; a directory station with the same stream is not repeated. “Placed by name”: the state comes from the station's name, not from location data. One plays at a time, and giving sound to a TV channel stops the radio.",
						)}
					</p>
				</>
			}
		>
			{failed ? <DirectoryFailed retry={retry} /> : null}
			<div class="lm">
				<Figures
					cells={[
						{
							label: t("Emiten", "On air"),
							value: probeCurrent("radio-browser-probe") ? String(n.live) : "—",
							of: t(`de ${n.total} emisoras`, `of ${n.total} stations`),
						},
						{
							label: t("Revisión de señales", "Stream check"),
							value: dir?.radio.checkedAt ? ago(now.value - dir.radio.checkedAt, l) : "—",
							note: t(
								"cada hora, desde el equipo donde corre Vigía",
								"hourly, from the computer Vigía runs on",
							),
						},
					]}
				/>
				{s ? (
					<p class="lm-note">
						{t(
							`De ${s.listed} emisoras listadas en Radio Browser, ${s.broadcasters} son radio abierta (AM/FM o del Estado); ${s.webOnly} radios solo por internet no se incluyen${s.withHandle ? `, ni ${s.withHandle} con nombres de personas` : ""}.`,
							`Of ${s.listed} stations listed on Radio Browser, ${s.broadcasters} are broadcasters (AM/FM or state); ${s.webOnly} internet-only radios are not included${s.withHandle ? `, nor ${s.withHandle} named after people` : ""}.`,
						)}
					</p>
				) : null}
				<Filters items={all} scope={scope} setScope={setScope} state={state} setState={setState} id="radio" />
				{items.length ? (
					<ul class="lm-list">
						{items.slice(0, cap.shown).map((item) => (
							<Row
								key={item.id}
								item={item}
								playingNow={on === item.id}
								onPlay={() => playRadio(item)}
								onStop={() => playRadio(null)}
							>
								{on === item.id ? <RadioPlayer item={item} /> : null}
							</Row>
						))}
					</ul>
				) : (
					<p class="lm-empty">{t("Ninguna emisora con este filtro.", "No station with this filter.")}</p>
				)}
				{cap.more}
				<div class="sources-row">
					{dir?.radio.listAt ? (
						<SourceTag
							source={{ feed: "radio-browser", observedAt: dir.radio.listAt }}
							label={t("Directorio: Radio Browser", "Directory: Radio Browser")}
						/>
					) : null}
					{dir?.radio.checkedAt ? (
						<SourceTag
							source={{ feed: "radio-browser-probe", observedAt: dir.radio.checkedAt }}
							label={t("Medición: Vigía", "Measured by Vigía")}
						/>
					) : null}
					{curated?.radio.checkedAt ? (
						<SourceTag
							source={{ feed: "radio-streams", observedAt: curated.radio.checkedAt }}
							label={t("Lista de Vigía", "Vigía's list")}
						/>
					) : null}
				</div>
			</div>
			<p class="sr-only" aria-live="polite">
				{radioSaid.value}
			</p>
		</Panel>
	);
}

// The collapsed row's line once the directory is here (the same merge as the panel, so the numbers agree).
registerSummary("tv", () => {
	const d = panels.value.mediadir as MediaDirView | undefined;
	if (!d) return null;
	const n = tally(tvItems(panels.value.livetv as CuratedView | undefined, d));
	return {
		text: t(`${n.live} de ${n.total} canales en vivo`, `${n.live} of ${n.total} channels live`),
		tone: "normal",
	};
});
registerSummary("radio", () => {
	const d = panels.value.mediadir as MediaDirView | undefined;
	if (!d) return null;
	const n = tally(radioItems(panels.value.livetv as CuratedView | undefined, d));
	return {
		text: t(`${n.live} de ${n.total} emisoras emiten`, `${n.live} of ${n.total} stations on air`),
		tone: "normal",
	};
});
