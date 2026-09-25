import { signal } from "@preact/signals";
import { Fragment } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { healthById, now } from "../lib/data.ts";
import { ago, clock } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { viewport } from "../lib/layout.ts";
import {
	embedUrl,
	PLAYER_LISTEN,
	PLAYER_MUTE,
	PLAYER_ORIGIN,
	plainTitle,
	playerAudible,
} from "../lib/livetv.ts";
import { link } from "../lib/router.ts";
import { SourceTag } from "../ui/Source.tsx";
import { type LiveCard, type LiveTvView, RADIO_FEED, TV_FEED } from "./LiveTv.tsx";

/* The body of "En vivo: TV y radio", in its own chunk: loaded only when the panel is open. */

/** The one stream playing in the list (the 2×2 wall has its own, muted, tiles). */
const playing = signal<string | null>(null);

function stateText(c: LiveCard): { text: string; tone: "live" | "soon" | "off" | "muted" | "old" } {
	switch (c.state) {
		case "live":
			return { text: t("EN VIVO ahora", "LIVE now"), tone: "live" };
		case "upcoming":
			return { text: t("Programada", "Scheduled"), tone: "soon" };
		case "off":
			return c.detail === "no-answer"
				? { text: t("La señal no responde", "Stream not answering"), tone: "off" }
				: c.detail === "not-audio"
					? { text: t("Responde sin audio", "Answers, no audio"), tone: "off" }
					: { text: t("Sin transmisión ahora", "Not live now"), tone: "off" };
		case "unknown":
			return { text: t("Estado desconocido", "State unknown"), tone: "muted" };
		case "stale":
			return { text: t("Sin revisión reciente", "No recent check"), tone: "old" };
		case "unmeasured":
			return { text: t("Sin medir", "Not measured"), tone: "muted" };
	}
}

/** "revisado hace 4 min" / "revisado a las 14:05 (hace 2 h)". */
function checked(c: LiveCard): string | null {
	if (c.checkedAt === null) return null;
	const l = lang.value;
	const age = ago(now.value - c.checkedAt, l);
	if (c.state === "stale") {
		const was =
			c.detail === "live"
				? t(", entonces en vivo", ", live then")
				: c.detail === "offline"
					? t(", entonces sin transmisión", ", not live then")
					: "";
		return t(
			`última revisión ${clock(c.checkedAt, l)} (${age})${was}`,
			`last checked ${clock(c.checkedAt, l)} (${age})${was}`,
		);
	}
	return t(`revisado ${age}`, `checked ${age}`);
}

function unknownWhy(detail: string | null): string {
	switch (detail) {
		case "consent":
			return t("YouTube pidió aceptar cookies", "YouTube asked for cookie consent");
		case "other-channel":
			return t("la página era de otro canal", "the page belonged to another channel");
		case "unexpected-page":
			return t("la página cambió de forma", "the page changed shape");
		case "timeout":
			return t("YouTube no respondió a tiempo", "YouTube timed out");
		default:
			return detail?.startsWith("http-")
				? t(`YouTube respondió ${detail.slice(5)}`, `YouTube answered ${detail.slice(5)}`)
				: t("YouTube no respondió como se esperaba", "YouTube did not answer as expected");
	}
}

function Player({ card, onStop, inline }: { card: LiveCard; onStop: () => void; inline?: boolean }) {
	const [audioFailed, setAudioFailed] = useState(false);
	const src = card.play.type === "youtube" ? embedUrl(card.play, false) : card.play.url;
	return (
		<section class="ltv-player" aria-label={t(`Reproduciendo ${card.name}`, `Playing ${card.name}`)}>
			{card.play.type === "youtube" && src ? (
				<div class="ltv-player__frame">
					<iframe
						src={src}
						title={t(`${card.name}, reproductor de YouTube`, `${card.name}, YouTube player`)}
						allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
						allowFullScreen
						// YouTube's player refuses to start without the embedding origin (error 153); only the origin is sent.
						referrerpolicy="strict-origin"
						sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
					/>
				</div>
			) : card.play.type === "audio" ? (
				// biome-ignore lint/a11y/useMediaCaption: a live radio stream has no caption track to offer.
				<audio
					class="ltv-player__audio"
					src={card.play.url}
					controls
					autoPlay
					preload="none"
					onError={() => setAudioFailed(true)}
				/>
			) : null}
			{inline ? null : (
				<div class="ltv-player__bar">
					<span class="ltv-player__name">{card.name}</span>
					<button type="button" class="button" onClick={onStop}>
						{t("Detener", "Stop")}
					</button>
				</div>
			)}
			<p class="note">
				{audioFailed
					? t(
							"Este navegador no pudo reproducir la señal (puede estar caída o bloqueada desde aquí).",
							"This browser could not play the stream (it may be down or blocked from here).",
						)
					: card.play.type === "youtube"
						? t(
								"Reproductor oficial de YouTube (youtube-nocookie.com): al pulsar, tu navegador se conecta a YouTube.",
								"YouTube's official player (youtube-nocookie.com): pressing play connects your browser to YouTube.",
							)
						: t(
								`Señal oficial de la emisora (${new URL(card.play.url).host}): tu navegador se conecta a su servidor.`,
								`The station's official stream (${new URL(card.play.url).host}): your browser connects to its server.`,
							)}
				{card.playability ? (
					<>
						{" "}
						{t(
							`Desde este equipo, YouTube marcó esta transmisión como «${card.playabilityReason ?? card.playability}».`,
							`From this computer, YouTube marked this stream “${card.playabilityReason ?? card.playability}”.`,
						)}
					</>
				) : null}
			</p>
		</section>
	);
}

function Card({ card }: { card: LiveCard }) {
	const l = lang.value;
	const s = stateText(card);
	const on = playing.value === card.id;
	const when = checked(card);
	return (
		<li class={`ltv-card ltv-card--${s.tone}${on ? " is-playing" : ""}`}>
			<div class="ltv-card__main">
				<span
					class="ltv-card__name"
					title={t(`Canal oficial: ${card.verified}`, `Official channel: ${card.verified}`)}
				>
					{card.name}
				</span>
				<span class="ltv-card__meta">
					<span class="ltv-card__kind">{card.kind === "tv" ? "TV" : "Radio"}</span>
					{card.where ? <span>{card.where}</span> : null}
					<span class={card.ownership === "private" ? "" : "ltv-card__owner"}>
						{l === "es" ? card.labelEs : card.labelEn}
					</span>
					<span class="ltv-card__lang">{card.lang.toUpperCase()}</span>
				</span>
				<span class={`ltv-state ltv-state--${s.tone}`}>
					<span class="ltv-state__label">{s.text}</span>
					{when ? <span class="ltv-state__when mono">{when}</span> : null}
				</span>
				{card.state === "unknown" ? <span class="note">{unknownWhy(card.detail)}</span> : null}
				{card.playability ? (
					<span class="note ltv-card__warn">
						{t(
							`Desde este equipo YouTube dice: «${card.playabilityReason ?? card.playability}»`,
							`From this computer YouTube says: “${card.playabilityReason ?? card.playability}”`,
						)}
					</span>
				) : null}
				{card.title && (card.state === "live" || card.state === "upcoming") ? (
					<a class="ltv-card__title" href={card.sourceUrl} target="_blank" rel="noopener noreferrer">
						{plainTitle(card.title)}
					</a>
				) : null}
				{card.startedAt !== null ? (
					<span class="note mono">
						{t(
							`transmisión iniciada ${ago(now.value - card.startedAt, l)}`,
							`stream started ${ago(now.value - card.startedAt, l)}`,
						)}
					</span>
				) : null}
			</div>
			<button
				type="button"
				class={`ltv-play${on ? " is-on" : ""}`}
				aria-pressed={on}
				onClick={() => {
					playing.value = on ? null : card.id;
				}}
			>
				<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
					{on ? <path d="M2 2h3v8H2zM7 2h3v8H7z" /> : <path d="M3 1.5v9l7.5-4.5z" />}
				</svg>
				<span>
					{on ? t("Detener", "Stop") : card.kind === "tv" ? t("Ver", "Watch") : t("Escuchar", "Listen")}
				</span>
				<span class="sr-only">{card.name}</span>
			</button>
		</li>
	);
}

/** Desk only: four muted players side by side, each loaded by its own press, each channel chosen from a list. */
function MiniWall({ cards }: { cards: LiveCard[] }) {
	const tv = cards.filter((c) => c.kind === "tv");
	const initial = [...tv.filter((c) => c.state === "live"), ...tv.filter((c) => c.state !== "live")]
		.slice(0, 4)
		.map((c) => c.id);
	const [picks, setPicks] = useState<string[]>(initial);
	const [loaded, setLoaded] = useState<boolean[]>([false, false, false, false]);
	const frames = useRef<(HTMLIFrameElement | null)[]>([null, null, null, null]);
	const audible = useRef<number | null>(null);
	const heard = useRef<boolean[]>([false, false, false, false]);
	/** The player answers only once it is ready: say "listening" every half second until it does (at most 20 s). */
	const listen = (i: number, frame: HTMLIFrameElement) => {
		heard.current[i] = false;
		let tries = 0;
		const say = () => {
			if (heard.current[i] || tries++ > 40 || frames.current[i] !== frame) return;
			frame.contentWindow?.postMessage(PLAYER_LISTEN(i), PLAYER_ORIGIN);
			setTimeout(say, 500);
		};
		say();
	};
	// One tile audible at a time (review 4, L13: each player's own unmute button made four sound at once): when a
	// player reports sound on, every other loaded player is muted through YouTube's message API, and the list's
	// player (TV or radio) stops.
	useEffect(() => {
		const onMessage = (e: MessageEvent) => {
			if (e.origin !== PLAYER_ORIGIN) return;
			const i = frames.current.findIndex((f) => f?.contentWindow === e.source);
			if (i === -1) return;
			heard.current[i] = true;
			if (playerAudible(e.data) !== true || audible.current === i) return;
			audible.current = i;
			playing.value = null;
			frames.current.forEach((f, j) => {
				if (j !== i) f?.contentWindow?.postMessage(PLAYER_MUTE, PLAYER_ORIGIN);
			});
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, []);
	return (
		<>
			<p class="note">
				{t(
					"Cuatro reproductores sin sonido; cada uno carga solo al pulsarlo (cada transmisión consume datos: unos 1–3 Mb/s). Al activar el sonido de uno, los demás se silencian.",
					"Four muted players; each loads only when pressed (every stream uses data: about 1–3 Mb/s). Turning one's sound on mutes the others.",
				)}
			</p>
			<div class="ltv-wall">
				{[0, 1, 2, 3].map((i) => {
					const card = tv.find((c) => c.id === picks[i]);
					const src =
						card && card.play.type === "youtube" ? embedUrl(card.play, true, location.origin) : null;
					return (
						<div class="ltv-tile" key={i}>
							<div class="ltv-tile__head">
								<select
									aria-label={t(`Canal del recuadro ${i + 1}`, `Channel for tile ${i + 1}`)}
									value={picks[i] ?? ""}
									onChange={(e) => {
										const next = [...picks];
										next[i] = (e.target as HTMLSelectElement).value;
										setPicks(next);
										setLoaded(loaded.map((v, j) => (j === i ? false : v)));
									}}
								>
									{tv.map((c) => (
										<option key={c.id} value={c.id}>
											{c.name}
											{c.state === "live" ? ` · ${t("en vivo", "live")}` : ""}
										</option>
									))}
								</select>
							</div>
							<div class="ltv-tile__frame">
								{loaded[i] && src ? (
									<iframe
										ref={(el) => {
											frames.current[i] = el;
										}}
										onLoad={(e) => {
											if (audible.current === i) audible.current = null;
											listen(i, e.currentTarget as HTMLIFrameElement);
										}}
										src={src}
										title={t(`${card?.name}, reproductor de YouTube`, `${card?.name}, YouTube player`)}
										allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
										allowFullScreen
										referrerpolicy="strict-origin"
										sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
									/>
								) : (
									<button
										type="button"
										class="ltv-tile__load"
										onClick={() => {
											playing.value = null;
											setLoaded(loaded.map((v, j) => (j === i ? true : v)));
										}}
									>
										<svg viewBox="0 0 12 12" width="18" height="18" aria-hidden="true">
											<path d="M3 1.5v9l7.5-4.5z" />
										</svg>
										<span>{card ? card.name : "—"}</span>
										{card ? <span class="note">{stateText(card).text}</span> : null}
									</button>
								)}
							</div>
						</div>
					);
				})}
			</div>
		</>
	);
}

type Filter = "all" | "tv" | "radio";

export function LiveTvBody({ view }: { view: LiveTvView }) {
	const l = lang.value;
	const [filter, setFilter] = useState<Filter>("all");
	const [wall, setWall] = useState(false);
	const desk = viewport.value !== "phone";
	const ytOff = healthById.value.get(TV_FEED)?.state === "off";
	const cards = view.cards.filter((c) => filter === "all" || c.kind === filter);
	const current = view.cards.find((c) => c.id === playing.value) ?? null;
	const stop = () => {
		playing.value = null;
	};
	const showWall = wall && desk;
	return (
		<div class="ltv">
			<div class="stat-row stat-row--two">
				<div class="figure">
					<span class="figure__label">{t("TV en vivo", "TV live")}</span>
					<span class={`figure__value${view.tv.measured ? "" : " figure__value--muted"}`}>
						{view.tv.measured ? (
							<>
								{view.tv.live}
								<span class="figure__unit"> / {view.tv.total}</span>
							</>
						) : (
							"—"
						)}
					</span>
					<span class="note">
						{view.tv.measured
							? t("canales oficiales en YouTube", "official YouTube channels")
							: t("sin medir", "not measured")}
					</span>
				</div>
				<div class="figure">
					<span class="figure__label">{t("Radio emitiendo", "Radio on air")}</span>
					<span class={`figure__value${view.radio.measured ? "" : " figure__value--muted"}`}>
						{view.radio.measured ? (
							<>
								{view.radio.live}
								<span class="figure__unit"> / {view.radio.total}</span>
							</>
						) : (
							"—"
						)}
					</span>
					<span class="note">{t("señales oficiales con audio", "official streams with audio")}</span>
				</div>
			</div>
			{ytOff ? (
				<div class="ltv-optin">
					<p>
						{t(
							"La comprobación de qué canales de TV transmiten está apagada (abriría cada 30 min la página «/live» de 12 canales de YouTube, ~150 MB al día). Los canales se pueden ver igual; las lecturas anteriores, si las hay, envejecen con su hora.",
							"The check of which TV channels are live is off (every 30 min it would open the “/live” page of 12 YouTube channels, ~150 MB a day). The channels still play; earlier readings, if any, age with their time.",
						)}
					</p>
					<a class="button" {...link("guide")}>
						{t("Activarla en la guía", "Turn it on in the guide")} →
					</a>
				</div>
			) : null}
			<div class="ltv-controls">
				<fieldset class="segmented">
					<legend class="sr-only">{t("Mostrar", "Show")}</legend>
					{(["all", "tv", "radio"] as const).map((f) => (
						<button type="button" key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
							{f === "all" ? t("Todo", "All") : f === "tv" ? "TV" : "Radio"}
						</button>
					))}
				</fieldset>
				{desk ? (
					<fieldset class="segmented">
						<legend class="sr-only">{t("Vista", "View")}</legend>
						<button type="button" aria-pressed={!wall} onClick={() => setWall(false)}>
							{t("Lista", "List")}
						</button>
						<button
							type="button"
							aria-pressed={wall}
							onClick={() => {
								playing.value = null;
								setWall(true);
							}}
						>
							{t("Pared 2×2", "2×2 wall")}
						</button>
					</fieldset>
				) : null}
			</div>
			{showWall ? (
				<MiniWall cards={view.cards} />
			) : (
				<>
					{/* The player opens under its own card; above the list only when a filter hides that card. */}
					{current && !cards.includes(current) ? (
						<Player key={current.id} card={current} onStop={stop} />
					) : null}
					<ul class="ltv-list">
						{cards.map((c) => (
							<Fragment key={c.id}>
								<Card card={c} />
								{c === current ? (
									<li class="ltv-inline">
										<Player card={c} onStop={stop} inline />
									</li>
								) : null}
							</Fragment>
						))}
					</ul>
				</>
			)}
			<div class="sources-row">
				{view.radio.checkedAt !== null ? (
					<SourceTag
						source={{
							feed: RADIO_FEED,
							observedAt: view.radio.checkedAt,
							detail: l === "es" ? view.vantageEs : view.vantageEn,
						}}
						label={t("Sondeo de radio", "Radio probe")}
					/>
				) : null}
				{view.tv.checkedAt !== null ? (
					<SourceTag
						source={{
							feed: TV_FEED,
							observedAt: view.tv.checkedAt,
							detail: l === "es" ? view.vantageEs : view.vantageEn,
						}}
						label={t("Revisión de YouTube", "YouTube check")}
					/>
				) : null}
			</div>
		</div>
	);
}
