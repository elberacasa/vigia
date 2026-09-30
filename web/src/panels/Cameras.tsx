import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import {
	type CameraCard,
	type CameraImage,
	type CamerasView,
	camTone,
	clientCard,
	currentStill,
	lastStill,
	nightLine,
	playTarget,
	statusCounts,
	statusLine,
	stillLabel,
} from "../lib/cameras.ts";
import { muniChoices } from "../lib/crowd-places.ts";
import { addStyles } from "../lib/css.ts";
import { now, panels, skew, wantPanel } from "../lib/data.ts";
import { entityPath } from "../lib/entity-route.ts";
import { ago, clock, int, stamp } from "../lib/format.ts";
import { loadHls } from "../lib/hls-load.ts";
import { lang, t } from "../lib/i18n.ts";
import { embedUrl } from "../lib/livetv.ts";
import { PANEL_META } from "../lib/panel-meta.ts";
import { PLACES } from "../lib/places.gen.ts";
import { entityLink } from "../lib/router.ts";
import { stateName } from "../lib/states.ts";
import { registerSummary } from "../lib/summary.ts";
import camerasCss from "../styles/cameras.css?inline";
import { Panel } from "../ui/Panel.tsx";
import { SourceTag } from "../ui/Source.tsx";

addStyles(camerasCss);

/*
 * "Cámaras públicas": only cameras their operator publishes, each with its state in words and a shape
 * (en vivo, cámara caída, imagen congelada, sin revisar, solo en el sitio del operador), the still Vigía took at the
 * camera's own pace (only while live, and only within twice its interval plus 5 min; else the last one, dimmed, with
 * its time), and a press to watch it in the operator's own player where the page may frame it (YouTube's cookie-less
 * player, Windy's) or on the operator's page. Nothing plays by itself. The view is on demand.
 */

export function useCameras(): { view: CamerasView | undefined; failed: boolean } {
	const view = panels.value.cameras as CamerasView | undefined;
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		wantPanel("cameras").catch(() => setFailed(true));
	}, []);
	return { view, failed: failed && !view };
}

/** The one camera playing in the page (a player each would be too much for a slow connection). */
const playingCam = signal<string | null>(null);

/** Pictures that failed to load in this visit (past their 3-day retention): said as such, never a broken image. */
const broken = signal<ReadonlySet<string>>(new Set());
function markBroken(url: string): void {
	broken.value = new Set([...broken.value, url]);
}

function StatusMark({ c }: { c: CameraCard }) {
	const tone = camTone(c.status);
	return (
		<span class={`cam-state cam-state--${tone}`}>
			<svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">
				{tone === "live" ? (
					<circle cx="5" cy="5" r="3.4" />
				) : tone === "down" ? (
					<path d="M5 1 9.2 8.6H.8Z" />
				) : tone === "frozen" ? (
					<path d="M5 .8 9.2 5 5 9.2.8 5Z" />
				) : (
					<circle cx="5" cy="5" r="3" class="cam-state__ring" />
				)}
			</svg>
			{statusLine(c, lang.value, now.value)}
		</span>
	);
}

/** A still on the card: its own time always, "hace N min"; a dimmed last one says it is not current. */
export function Still({
	img,
	current,
	credit,
	eager = false,
}: {
	img: CameraImage;
	current: boolean;
	credit: string;
	eager?: boolean;
}) {
	const l = lang.value;
	const gone = broken.value.has(img.url);
	return (
		<figure class={`cam-still${current ? "" : " is-last"}`}>
			{gone ? (
				<span class="cam-still__gone" style={{ aspectRatio: `${img.width} / ${img.height}` }}>
					{t(
						`Imagen ya no guardada · ${clock(img.takenAt, l)}`,
						`Picture no longer kept · ${clock(img.takenAt, l)}`,
					)}
				</span>
			) : (
				<img
					src={img.url}
					width={img.width}
					height={img.height}
					loading={eager ? "eager" : "lazy"}
					decoding="async"
					alt=""
					onError={() => markBroken(img.url)}
				/>
			)}
			<figcaption class="cam-still__cap">
				{current ? (
					<>
						{stillLabel(img, l)} <span class="mono">· {ago(now.value - img.takenAt, l)}</span>
					</>
				) : (
					t(
						`Última imagen: ${stamp(img.takenAt, l, now.value)} (no es actual)`,
						`Last picture: ${stamp(img.takenAt, l, now.value)} (not current)`,
					)
				)}
				<span class="cam-still__credit">{credit}</span>
			</figcaption>
		</figure>
	);
}

/** The operator's player, after a press: YouTube's cookie-less player, Windy's, an HLS stream; else a link. */
function Player({ c }: { c: CameraCard }) {
	const kind = playTarget(c.play);
	const video = useRef<HTMLVideoElement>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		if (kind !== "hls" || c.play?.type !== "hls") return;
		const el = video.current;
		if (!el) return;
		let dead = false;
		let destroy = () => {};
		if (el.canPlayType("application/vnd.apple.mpegurl")) {
			el.src = c.play.url;
			el.play().catch(() => {});
		} else
			loadHls().then(
				(H) => {
					if (dead || c.play?.type !== "hls") return;
					if (!H.isSupported()) return setFailed(true);
					const h = new H({ enableWorker: false, maxBufferLength: 20 });
					h.on(H.Events.ERROR, (_e, d) => d.fatal && setFailed(true));
					h.loadSource(c.play.url);
					h.attachMedia(el);
					el.play().catch(() => {});
					destroy = () => h.destroy();
				},
				() => setFailed(true),
			);
		return () => {
			dead = true;
			destroy();
			el.pause();
			el.removeAttribute("src");
		};
	}, [kind]);
	const name = c.name[lang.value];
	if (kind === "youtube" && c.play?.type === "youtube") {
		const src = embedUrl({ channelId: c.play.channelId ?? "", videoId: c.play.videoId }, true);
		return src ? (
			<iframe
				class="cam-player"
				src={src}
				title={t(`${name}, reproductor de YouTube`, `${name}, YouTube player`)}
				allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
				allowFullScreen
				referrerpolicy="strict-origin"
				sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
			/>
		) : null;
	}
	if (kind === "embed" && c.play?.type === "embed")
		return (
			<iframe
				class="cam-player"
				src={c.play.url}
				title={t(`${name}, reproductor de Windy`, `${name}, Windy player`)}
				allow="fullscreen"
				allowFullScreen
				referrerpolicy="strict-origin"
				sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
			/>
		);
	if (kind === "hls")
		return failed ? (
			<p class="cam-fail">
				{t("La señal no respondió a este navegador.", "The stream did not answer this browser.")}
			</p>
		) : (
			<video ref={video} class="cam-player" muted playsInline controls aria-label={name} />
		);
	return null;
}

function playWords(c: CameraCard): { verb: string; note: string } | null {
	const kind = playTarget(c.play);
	if (kind === "youtube")
		return {
			verb: t("Ver en vivo (YouTube)", "Watch live (YouTube)"),
			note: t(
				"Reproductor oficial de YouTube (youtube-nocookie.com): tu navegador se conecta a YouTube.",
				"YouTube's official player (youtube-nocookie.com): your browser connects to YouTube.",
			),
		};
	if (kind === "embed")
		return {
			verb: t("Ver en el reproductor de Windy", "Watch in Windy's player"),
			note: t(
				"Reproductor de Windy (webcams.windy.com): tu navegador se conecta a Windy. Su imagen puede ir con retraso.",
				"Windy's player (webcams.windy.com): your browser connects to Windy. Its picture may lag.",
			),
		};
	if (kind === "hls")
		return {
			verb: t("Ver en vivo", "Watch live"),
			note: t(
				"Señal del operador: tu navegador se conecta a su servidor; Vigía no la retransmite.",
				"The operator's stream: your browser connects to its server; Vigía does not relay it.",
			),
		};
	return null;
}

let muniNames: Map<string, string> | null = null;
/** A municipality's name by its ontology id, from the page's names index. */
function muniName(id: string): string | null {
	muniNames ??= new Map(muniChoices(PLACES).map((m) => [m.id, m.name]));
	return muniNames.get(id) ?? null;
}

function placeOf(c: CameraCard): { text: string; id: string | null } {
	const l = lang.value;
	if (c.country !== "VE") {
		const country: Record<string, [string, string]> = {
			BQ: ["Bonaire", "Bonaire"],
			CW: ["Curazao", "Curaçao"],
			AW: ["Aruba", "Aruba"],
			TT: ["Trinidad y Tobago", "Trinidad and Tobago"],
			CO: ["Colombia", "Colombia"],
			BR: ["Brasil", "Brazil"],
			GY: ["Guyana", "Guyana"],
		};
		const w = country[c.country];
		return { text: w ? (l === "es" ? w[0] : w[1]) : c.country, id: null };
	}
	const muni = c.municipality ? muniName(c.municipality) : null;
	if (c.municipality && muni) return { text: `${muni}, ${stateName(c.state)}`, id: c.municipality };
	return { text: stateName(c.state), id: null };
}

/** One camera: picture, state, what it shows, where, who publishes it, and a press to watch it where allowed. */
export function CameraCardView({ c: card, page = false }: { c: CameraCard; page?: boolean }) {
	const l = lang.value;
	const n = now.value;
	const c = clientCard(card, n);
	const cur = currentStill(c, n);
	const last = lastStill(c, n);
	const on = playingCam.value === c.id;
	const kind = playTarget(c.play);
	const words = playWords(c);
	const place = placeOf(c);
	const night = nightLine(c.night, l);
	const pagePath = entityPath(c.entity);
	return (
		<article
			class={`cam cam--${camTone(c.status)}${on ? " is-on" : ""}`}
			{...(page ? { "aria-label": c.name[l] } : { "aria-labelledby": `cam-${c.id}` })}
		>
			<div class="cam__media">
				{on ? (
					<Player c={c} />
				) : cur ? (
					<Still img={cur} current credit={c.creditEs} eager={page} />
				) : last ? (
					<Still img={last} current={false} credit={c.creditEs} eager={page} />
				) : (
					<p class="cam__none">
						{c.status === "no-stills"
							? t(
									"Esta cámara se ve solo en el reproductor o el sitio de su operador; Vigía no guarda su imagen.",
									"This camera is only seen in its operator's player or site; Vigía keeps no picture of it.",
								)
							: t("Sin imagen guardada todavía.", "No picture kept yet.")}
					</p>
				)}
			</div>
			<div class="cam__body">
				<header class="cam__head">
					{page ? null : (
						<h3 class="cam__name" id={`cam-${c.id}`}>
							{pagePath ? <a {...entityLink(c.entity)}>{c.name[l]}</a> : c.name[l]}
						</h3>
					)}
					<StatusMark c={c} />
				</header>
				<p class="cam__view">{c.view[l]}</p>
				<p class="cam__meta">
					{place.id ? <a {...entityLink(place.id)}>{place.text}</a> : <span>{place.text}</span>}
					<span>
						{t("Operador", "Operator")}:{" "}
						{c.operator.url && /^https?:\/\//.test(c.operator.url) ? (
							<a href={c.operator.url} target="_blank" rel="noopener noreferrer">
								{c.operator.name}
							</a>
						) : (
							c.operator.name
						)}
					</span>
				</p>
				{night ? <p class="cam__night">{night}</p> : null}
				<div class="cam__actions">
					{kind && kind !== "link" && words ? (
						<button
							type="button"
							class="btn"
							aria-pressed={on}
							onClick={() => (playingCam.value = on ? null : c.id)}
						>
							{on ? t("Detener", "Stop") : words.verb}
						</button>
					) : null}
					{c.page && /^https?:\/\//.test(c.page) ? (
						<a class="btn btn--quiet" href={c.page} target="_blank" rel="noopener noreferrer">
							{t("Sitio del operador", "Operator's site")} <span aria-hidden="true">↗</span>
						</a>
					) : null}
				</div>
				{on && words ? <p class="cam__note">{words.note}</p> : null}
				{c.terms || c.verified ? (
					<details class="cam__details">
						<summary>{t("Términos y verificación", "Terms and verification")}</summary>
						{c.terms ? <p>{c.terms.note}</p> : null}
						{c.verified ? (
							<p>
								{t("Verificado", "Verified")}: {c.verified}
							</p>
						) : null}
					</details>
				) : null}
			</div>
		</article>
	);
}

export function CamerasPanel() {
	const { view, failed } = useCameras();
	const l = lang.value;
	const meta = PANEL_META.camaras;
	useEffect(
		() => () => {
			playingCam.value = null;
		},
		[],
	);
	const cams = (view?.cameras ?? []).map((c) => clientCard(c, now.value));
	// Cameras with a picture first (live, then the rest), then those only at their operator's.
	const order = (c: CameraCard) => (c.status === "live" ? 0 : c.status === "no-stills" ? 2 : 1);
	const sorted = [...cams].sort((a, b) => order(a) - order(b));
	const counts = statusCounts(cams);
	const newest = cams.reduce((m, c) => Math.max(m, c.image?.takenAt ?? c.last?.takenAt ?? 0), 0);
	return (
		<Panel
			id="camaras"
			title={meta.title()}
			question={meta.question()}
			feeds={meta.feeds()}
			ready={failed || view !== undefined}
			method={
				view ? (
					<>
						{view.rules[l].map((r) => (
							<p key={r}>{r}</p>
						))}
						<p>{view.limits[l]}</p>
					</>
				) : undefined
			}
		>
			{failed ? (
				<p class="empty">
					{t(
						"No se pudo cargar la lista de cámaras (se pide al abrir este panel).",
						"The camera list could not be loaded (it is fetched when this panel opens).",
					)}
				</p>
			) : null}
			{view ? (
				<div class="cams">
					<p class="cams__lead">
						{t(
							`${int(cams.length, l)} cámaras que su operador publica: ${int(counts.live ?? 0, l)} en vivo, ${int(counts.down ?? 0, l)} caídas, ${int(counts.frozen ?? 0, l)} congeladas, ${int((counts.stale ?? 0) + (counts.unmeasured ?? 0), l)} sin imagen reciente o sin revisar, ${int(counts["no-stills"] ?? 0, l)} solo en el sitio del operador.`,
							`${int(cams.length, l)} cameras their operator publishes: ${int(counts.live ?? 0, l)} live, ${int(counts.down ?? 0, l)} down, ${int(counts.frozen ?? 0, l)} frozen, ${int((counts.stale ?? 0) + (counts.unmeasured ?? 0), l)} without a recent picture or not checked, ${int(counts["no-stills"] ?? 0, l)} only at the operator's site.`,
						)}
					</p>
					{view.dark.length ? (
						<p class="cams__lead">
							{t(
								`Luces por debajo de la mitad de lo habitual en ${view.dark.length} ${view.dark.length === 1 ? "cámara" : "cámaras"}: un indicio que se suma a otras fuentes, nunca un apagón por sí solo.`,
								`Lights below half their usual on ${view.dark.length} ${view.dark.length === 1 ? "camera" : "cameras"}: a hint that adds to other sources, never a blackout on its own.`,
							)}
						</p>
					) : null}
					<div class="cams__grid">
						{sorted.map((c) => (
							<CameraCardView key={c.id} c={c} />
						))}
					</div>
					<p class="cams__lead">{view.limits[l]}</p>
					<div class="sources-row">
						{newest ? (
							<SourceTag
								source={{ feed: "public-cams", observedAt: newest }}
								label={t(
									"Imágenes: cada operador; tomadas por Vigía",
									"Pictures: each operator; taken by Vigía",
								)}
							/>
						) : null}
					</div>
				</div>
			) : null}
		</Panel>
	);
}

registerSummary("camaras", () => {
	const v = panels.value.cameras as CamerasView | undefined;
	if (!v) return null;
	const l = lang.value;
	const live = statusCounts(v.cameras.map((c) => clientCard(c, now.value))).live ?? 0;
	return {
		text: t(
			`${int(live, l)} de ${int(v.cameras.length, l)} cámaras en vivo`,
			`${int(live, l)} of ${int(v.cameras.length, l)} cameras live`,
		),
		tone: "normal",
	};
});

/** A camera's card on its entity page or in the inspector, from the cameras view (fetched on demand). */
export function CameraBlock({ entity, page = false }: { entity: string; page?: boolean }) {
	const { view, failed } = useCameras();
	useEffect(
		() => () => {
			playingCam.value = null;
		},
		[],
	);
	const c = view?.cameras.find((x) => x.entity === entity);
	if (failed)
		return (
			<p class="esec__empty">
				{t("No se pudo cargar el estado de la cámara.", "The camera's state could not be loaded.")}
			</p>
		);
	if (!view) return <p class="esec__empty">{t("Cargando la cámara…", "Loading the camera…")}</p>;
	if (!c)
		return (
			<p class="esec__empty">
				{t("Esta cámara ya no está en el censo de Vigía.", "This camera is no longer in Vigía's census.")}
			</p>
		);
	return (
		<div class={page ? "cam-page" : "cam-insp"}>
			<CameraCardView c={c} page={page} />
		</div>
	);
}

type Kept = {
	url: string | null;
	takenAt: number;
	reason: string | null;
	night: boolean;
	lit: number | null;
};

/**
 * A camera's timeline: the stills Vigía kept of it (3 days at most, newest first), each with its time; a round
 * without a picture says why. `/api/v1/cameras/{id}/stills`.
 */
export function CameraFilm({ entity }: { entity: string }) {
	const id = entity.replace(/^cam\./, "");
	const l = lang.value;
	const [hours, setHours] = useState(6);
	const [got, setGot] = useState<{ stills: Kept[]; truncated: boolean } | "loading" | "error">("loading");
	useEffect(() => {
		const ctrl = new AbortController();
		const to = Date.now() + skew.peek();
		setGot("loading");
		fetch(
			`/api/v1/cameras/${encodeURIComponent(id)}/stills?from=${to - hours * 3_600_000}&to=${to}&limit=200`,
			{
				signal: ctrl.signal,
				headers: { accept: "application/json" },
			},
		)
			.then((r) =>
				r.ok
					? (r.json() as Promise<{ stills: Kept[]; truncated: boolean }>)
					: Promise.reject(new Error(String(r.status))),
			)
			.then((d) =>
				setGot({ stills: [...d.stills].sort((a, b) => b.takenAt - a.takenAt), truncated: d.truncated }),
			)
			.catch((err: Error) => {
				if (err.name !== "AbortError") setGot("error");
			});
		return () => ctrl.abort();
	}, [id, hours]);
	return (
		<section class="esec esec--camfilm" aria-labelledby="cam-film-title">
			<header class="esec__head">
				<h2 class="esec__title" id="cam-film-title">
					{t("Imágenes guardadas", "Kept pictures")}
				</h2>
				{typeof got === "object" ? <span class="esec__count mono">{int(got.stills.length, l)}</span> : null}
				<fieldset class="segmented">
					<legend class="sr-only">{t("Rango", "Range")}</legend>
					{[6, 24, 72].map((h) => (
						<button type="button" key={h} aria-pressed={hours === h} onClick={() => setHours(h)}>
							{h === 72 ? t("3 días", "3 days") : `${h} h`}
						</button>
					))}
				</fieldset>
			</header>
			<p class="esec__note esec__note--top">
				{t(
					"La cronología de una cámara son sus imágenes: una por ronda, a su ritmo, guardadas 3 días; una ronda sin imagen dice por qué.",
					"A camera's timeline is its pictures: one per round, at its pace, kept 3 days; a round without a picture says why.",
				)}
			</p>
			{got === "loading" ? (
				<p class="esec__empty">{t("Cargando…", "Loading…")}</p>
			) : got === "error" ? (
				<p class="esec__empty">
					{t("No se pudieron pedir sus imágenes.", "Its pictures could not be fetched.")}
				</p>
			) : got.stills.length ? (
				<ol class="cam-film">
					{got.stills.map((s) => (
						<li key={`${s.takenAt}`}>
							{s.url && !broken.value.has(s.url) ? (
								<img
									src={s.url}
									width={480}
									height={360}
									loading="lazy"
									decoding="async"
									alt=""
									onError={() => s.url && markBroken(s.url)}
								/>
							) : (
								<span class="cam-film__none">
									{s.url
										? t("imagen ya no guardada", "picture no longer kept")
										: (s.reason ?? t("sin imagen", "no picture"))}
								</span>
							)}
							<span>
								<span class="mono">{stamp(s.takenAt, l, now.value)}</span>
								{s.night ? ` · ${t("noche", "night")}` : ""}
							</span>
						</li>
					))}
				</ol>
			) : (
				<p class="esec__empty">
					{t("Ninguna imagen guardada en este rango.", "No picture kept in this range.")}
				</p>
			)}
			{typeof got === "object" && got.truncated ? (
				<p class="esec__note">{t("Se muestran las 200 más recientes.", "The 200 newest are shown.")}</p>
			) : null}
		</section>
	);
}
