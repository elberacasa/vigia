import { useEffect, useMemo, useState } from "preact/hooks";
import { type CameraCard, type CameraImage, clientCard, currentStill, lastStill } from "../lib/cameras.ts";
import { addStyles } from "../lib/css.ts";
import { now, tick } from "../lib/data.ts";
import { ago, clock, stamp } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { useCameras } from "../panels/Cameras.tsx";
import camerasCss from "../styles/cameras.css?inline";
import { history } from "./history.ts";
import { project } from "./project.ts";
import { replaying, selectEntity, selectedEntity } from "./view.ts";

addStyles(camerasCss);

/*
 * "Cámaras públicas" on the map: each camera a small fan in the direction it looks (60°, from its heading; a dot when
 * the heading is unknown), drawn by state: filled while live with a picture, an outline when down or frozen, dashed
 * when it is only seen at its operator's. Under the map, the strip of their stills: the current ones, or, while the
 * time machine replays a past hour, each camera's still of that moment (`/api/v1/stills?at=`) when one was kept.
 * Its own chunk, loaded when the layer is switched on.
 */

const R = 40;
const HALF = (30 * Math.PI) / 180;

/** The fan's path around (0, 0): compass heading (0 = north, clockwise), in map units at full view. */
function fan(heading: number): string {
	const a = (heading * Math.PI) / 180;
	const p = (x: number) => [Math.sin(x) * R, -Math.cos(x) * R].map((v) => v.toFixed(2)).join(" ");
	return `M0 0L${p(a - HALF)}A${R} ${R} 0 0 1 ${p(a + HALF)}Z`;
}

function toneOf(c: CameraCard): string {
	if (c.status === "live") return "live";
	if (c.status === "down" || c.status === "frozen") return c.status;
	if (c.status === "no-stills") return "no-stills";
	return "muted";
}

function isoOf(c: CameraCard): string | null {
	return c.country === "VE" ? c.state : null;
}

export function CameraLayer() {
	const { view } = useCameras();
	const l = lang.value;
	const sel = selectedEntity.value;
	// While the map replays the past, the fans say where cameras are, not their state now.
	const past = replaying.value !== null;
	const cams = (view?.cameras ?? []).map((c) => clientCard(c, tick.value));
	return (
		<g class="layer-cameras">
			{cams.map((c) => {
				const [x, y] = project(c.lon, c.lat);
				const tone = past ? "muted" : toneOf(c);
				return (
					// biome-ignore lint/a11y/noStaticElementInteractions: a pointer shortcut; the cameras panel (En vivo) lists every camera with its page.
					<g
						key={c.id}
						class={`cam-mark cam-mark--${tone}${sel === c.entity ? " is-selected" : ""}`}
						style={{ transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(var(--zk, 1))` }}
						onClick={(e) => {
							e.stopPropagation();
							selectEntity(c.entity, isoOf(c));
						}}
					>
						<title>
							{past
								? `${c.name[l]} · ${t("su estado de ese momento no se guarda: ver sus imágenes abajo", "its state at that time is not kept: see its pictures below")}`
								: `${c.name[l]} · ${l === "es" ? c.statusEs : c.statusEn}`}
						</title>
						{c.headingDeg !== null ? <path d={fan(c.headingDeg)} class="cam-fan" /> : null}
						<circle r={16} class="cam-hit" />
						<circle r={4.5} class="cam-dot" />
						{tone === "down" ? <path d="M-7-7 7 7M7-7-7 7" class="cam-x" /> : null}
					</g>
				);
			})}
		</g>
	);
}

/** The layer's key: what a fan means and what the outlines say. */
export function CameraLegend() {
	return (
		<div class="cam-key">
			<span>
				<svg width="16" height="12" viewBox="-8 -10 16 12" aria-hidden="true">
					<path d={fan(0)} class="cam-fan" transform="scale(0.8)" />
					<circle r="2" class="cam-dot" />
				</svg>
				{t("hacia dónde mira (60°)", "where it looks (60°)")}
			</span>
			<span>{t("relleno: en vivo con imagen", "filled: live with a picture")}</span>
			<span>{t("contorno: caída o congelada", "outline: down or frozen")}</span>
			<span>
				{t(
					"trazos: solo en el sitio del operador, sin revisar, sin imagen reciente o al ver el pasado",
					"dashed: only at the operator's site, not checked, no recent picture, or when viewing the past",
				)}
			</span>
		</div>
	);
}

type AtStill = {
	id: string;
	entity: string;
	name: { es: string; en: string };
	status: string;
	image: CameraImage | null;
};

/** Each camera's still at a past moment (`/api/v1/stills?at=`), fetched 250 ms after the slider stops. */
function useStillsAt(at: number | null): { at: number; cams: AtStill[] } | "loading" | "error" | null {
	const [got, setGot] = useState<{ at: number; cams: AtStill[] } | "loading" | "error" | null>(null);
	useEffect(() => {
		if (at === null) {
			setGot(null);
			return;
		}
		setGot("loading");
		const ctrl = new AbortController();
		const timer = setTimeout(() => {
			fetch(`/api/v1/stills?at=${Math.round(at)}`, {
				signal: ctrl.signal,
				headers: { accept: "application/json" },
			})
				.then((r) =>
					r.ok
						? (r.json() as Promise<{ at: number; cameras: AtStill[] }>)
						: Promise.reject(new Error(String(r.status))),
				)
				.then((d) => setGot({ at: d.at, cams: d.cameras }))
				.catch((err: Error) => {
					if (err.name !== "AbortError") setGot("error");
				});
		}, 250);
		return () => {
			clearTimeout(timer);
			ctrl.abort();
		};
	}, [at]);
	return got;
}

function StripItem({
	name,
	entity,
	iso,
	img,
	current,
	missing,
	at = null,
}: {
	name: string;
	entity: string;
	iso: string | null;
	img: CameraImage | null;
	current: boolean;
	missing: string;
	/** The replayed moment: the picture's time is said against it, not against now. */
	at?: number | null;
}) {
	const l = lang.value;
	const [gone, setGone] = useState(false);
	return (
		<li class="cam-strip__item">
			<button
				type="button"
				onClick={() => selectEntity(entity, iso)}
				title={t(`Seleccionar ${name}`, `Select ${name}`)}
			>
				<span class="cam-strip__pic">
					{img && !gone ? (
						<img
							src={img.url}
							width={img.width}
							height={img.height}
							loading="lazy"
							decoding="async"
							alt=""
							onError={() => setGone(true)}
						/>
					) : (
						<span class="cam-strip__none">
							{img
								? t(
										`imagen ya no guardada · ${clock(img.takenAt, l)}`,
										`picture no longer kept · ${clock(img.takenAt, l)}`,
									)
								: missing}
						</span>
					)}
				</span>
				<span class="cam-strip__name">{name}</span>
				<span class="cam-strip__time">
					{img
						? at !== null
							? t(
									`${clock(img.takenAt, l)} · ${Math.max(0, Math.round((at - img.takenAt) / 60_000))} min antes`,
									`${clock(img.takenAt, l)} · ${Math.max(0, Math.round((at - img.takenAt) / 60_000))} min before`,
								)
							: current
								? `${clock(img.takenAt, l)} · ${ago(now.value - img.takenAt, l)}`
								: t(
										`última: ${stamp(img.takenAt, l, now.value)}`,
										`last: ${stamp(img.takenAt, l, now.value)}`,
									)
						: "—"}
				</span>
			</button>
		</li>
	);
}

/**
 * Under the map while the layer is on: the cameras' stills now, or at the replayed moment (the close of the hour the
 * time machine shows). A camera without a still at that moment says so; nothing is interpolated.
 */
export function CameraStrip() {
	const { view } = useCameras();
	const l = lang.value;
	const step = replaying.value;
	const h = history.value;
	// The close of the replayed step, never past the server's present (to the minute, so a re-render does not refetch).
	const minute = Math.floor(tick.value / 60_000) * 60_000;
	const at = useMemo(
		() => (step !== null && h ? Math.min(step + h.stepMs, minute) : null),
		[step, h?.stepMs, minute],
	);
	const past = useStillsAt(at);
	const cams = (view?.cameras ?? []).map((c) => clientCard(c, now.value));
	const withPictures = cams.filter((c) => c.status !== "no-stills");
	const outside = cams.length - withPictures.length;
	return (
		<section class="cam-strip" aria-label={t("Imágenes de las cámaras públicas", "Public camera pictures")}>
			<p class="cam-strip__head">
				<span class="cam-strip__title">{t("Cámaras", "Cameras")}</span>
				<span>
					{at !== null
						? t(
								`${stamp(at, l, now.value)}: la imagen de cada una en ese momento`,
								`${stamp(at, l, now.value)}: each one's picture at that moment`,
							)
						: t(
								"imágenes actuales, tomadas por Vigía a su ritmo",
								"current pictures, taken by Vigía at their pace",
							)}
				</span>
				{outside ? (
					<span>
						{t(
							`${outside} se ven solo en el sitio de su operador`,
							`${outside} only seen at their operator's site`,
						)}
					</span>
				) : null}
				{past === "loading" ? <span>{t("cargando…", "loading…")}</span> : null}
				{past === "error" ? (
					<span>
						{t("no se pudieron pedir las imágenes de ese momento", "could not fetch that moment's pictures")}
					</span>
				) : null}
			</p>
			<ol class="cam-strip__list">
				{at !== null && past && typeof past === "object"
					? past.cams
							.filter((c) => c.status !== "no-stills")
							.map((c) => {
								const card = cams.find((x) => x.id === c.id);
								return (
									<StripItem
										key={c.id}
										name={c.name[l]}
										entity={c.entity}
										iso={card ? isoOf(card) : null}
										img={c.image}
										current
										at={past.at}
										missing={t("sin imagen en ese momento", "no picture at that moment")}
									/>
								);
							})
					: withPictures.map((c) => {
							const cur = currentStill(c, now.value);
							return (
								<StripItem
									key={c.id}
									name={c.name[l]}
									entity={c.entity}
									iso={isoOf(c)}
									img={cur ?? lastStill(c, now.value)}
									current={cur !== null}
									missing={t("sin imagen guardada", "no picture kept")}
								/>
							);
						})}
			</ol>
		</section>
	);
}
