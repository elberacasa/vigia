import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { connection, healthById, metaById, now } from "../lib/data.ts";
import { panelFreshness } from "../lib/fresh.ts";
import { lang, t } from "../lib/i18n.ts";
import {
	announcement,
	columnOf,
	hidePanel,
	isCollapsed,
	isPanelId,
	movePanel,
	moveToColumn,
	type PanelId,
	positionOf,
	setCollapsed,
	viewport,
} from "../lib/layout.ts";
import { link } from "../lib/router.ts";
import { dataKey, panelReady, summarize } from "../lib/summary.ts";
import { openMethod } from "./Source.tsx";

/** The panel's badge and band come from one verdict (lib/fresh.ts), so they can never disagree (review 3, M9). */
function useFreshness(feeds: readonly string[]) {
	return panelFreshness(feeds, healthById.value, metaById.value, now.value, lang.value);
}

/**
 * The panel's freshness in words: the age of its newest datum for data feeds ("hace 2 d" for a daily figure), or
 * when it was last checked for event feeds, where silence is normal ("revisado hace 2 min"). Neutral while every
 * source is inside its budget, "Parcial" when some are late, "Desactualizado" when all are, "Sin conexión" when the
 * source is unreachable. Never "live" for data that is days old.
 */
function Freshness({ feeds, whenWaiting }: { feeds: readonly string[]; whenWaiting?: string | undefined }) {
	const f = useFreshness(feeds);
	const badge = f.waiting && whenWaiting ? { text: whenWaiting, tone: "muted" as const } : f.badge;
	return (
		<span
			class={`badge badge--age badge--${badge.tone}`}
			title={t(
				"Edad del dato, medida contra el plazo propio de cada fuente (detalles en «?»)",
				"Age of the data, measured against each source's own budget (details under “?”)",
			)}
		>
			{badge.text}
		</span>
	);
}

/** The band under the header when the panel is not fully current: the same verdict as the badge, in a sentence. */
function StateBand({ feeds }: { feeds: readonly string[] }) {
	const { band } = useFreshness(feeds);
	return band ? <p class={`band band--${band.tone}`}>{band.text}</p> : null;
}

/** Loading: bars shaped like content, faded in only after 160 ms so a fast load never flashes them. */
function Loading() {
	if (connection.value === "offline")
		return (
			<p class="empty">
				{t(
					"Sin conexión, y este dispositivo aún no tiene datos guardados de este panel.",
					"No connection, and this device has no saved data for this panel yet.",
				)}
			</p>
		);
	return (
		<div class="panel-skel" role="status">
			<span class="sr-only">{t("Cargando", "Loading")}</span>
			<i style={{ width: "46%" }} />
			<i class="panel-skel__big" style={{ width: "34%" }} />
			<i style={{ width: "92%" }} />
			<i style={{ width: "78%" }} />
			<i style={{ width: "85%" }} />
		</div>
	);
}

/** Every source needs a key the user has not set: a quiet silhouette of the panel and the way to unlock it. */
function Locked({ feeds }: { feeds: readonly string[] }) {
	const providers = [...new Set(feeds.map((id) => metaById.value.get(id)?.provider ?? id))].join(", ");
	return (
		<div class="locked">
			<div class="locked__ghost" aria-hidden="true">
				<i style={{ width: "40%" }} />
				<i class="panel-skel__big" style={{ width: "28%" }} />
				<i style={{ width: "90%" }} />
				<i style={{ width: "70%" }} />
			</div>
			<div class="locked__cta">
				<p>
					{t(
						`Este panel se activa con una clave de ${providers}. La guía dice cuánto cuesta y cómo obtenerla.`,
						`This panel turns on with a ${providers} key. The guide says what it costs and how to get it.`,
					)}
				</p>
				<a class="button button--primary" {...link("guide")}>
					{t("Desbloquear", "Unlock")} →
				</a>
			</div>
		</div>
	);
}

const openMenu = signal<string | null>(null);

/** ⋯ menu: move and hide, the same actions as Alt+↑/↓ on the header, reachable by touch. */
function PanelMenu({ id, title }: { id: PanelId; title: string }) {
	const open = openMenu.value === id;
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		ref.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus();
		const close = (e: Event) => {
			if (!ref.current?.contains(e.target as Node)) openMenu.value = null;
		};
		const key = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			openMenu.value = null;
			ref.current?.querySelector<HTMLButtonElement>(".panel__more")?.focus();
		};
		document.addEventListener("pointerdown", close);
		document.addEventListener("keydown", key);
		return () => {
			document.removeEventListener("pointerdown", close);
			document.removeEventListener("keydown", key);
		};
	}, [open]);
	const pos = positionOf(id);
	const vp = viewport.value;
	const col = columnOf(id);
	const act = (fn: () => void) => () => {
		openMenu.value = null;
		fn();
		requestAnimationFrame(() => document.getElementById(`${id}-toggle`)?.focus({ preventScroll: true }));
	};
	const onMenuKey = (e: KeyboardEvent) => {
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
		e.preventDefault();
		const items = [
			...(ref.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") ?? []),
		];
		const i = items.indexOf(document.activeElement as HTMLButtonElement);
		items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
	};
	return (
		<div class="panel__menu-wrap" ref={ref}>
			<button
				type="button"
				class="panel__icon panel__more"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label={t(`Opciones del panel ${title}`, `${title} panel options`)}
				onClick={() => {
					openMenu.value = open ? null : id;
				}}
			>
				<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
					<circle cx="3.5" cy="8" r="1.4" />
					<circle cx="8" cy="8" r="1.4" />
					<circle cx="12.5" cy="8" r="1.4" />
				</svg>
			</button>
			{open ? (
				<div class="panel__menu" role="menu" tabIndex={-1} aria-label={title} onKeyDown={onMenuKey}>
					<button type="button" role="menuitem" disabled={pos.at <= 1} onClick={act(() => movePanel(id, -1))}>
						{t("Subir", "Move up")}
						<kbd>Alt ↑</kbd>
					</button>
					<button
						type="button"
						role="menuitem"
						disabled={pos.at >= pos.of}
						onClick={act(() => movePanel(id, 1))}
					>
						{t("Bajar", "Move down")}
						<kbd>Alt ↓</kbd>
					</button>
					{vp === "wide" || vp === "mid" ? (
						<button
							type="button"
							role="menuitem"
							onClick={act(() => moveToColumn(id, col === "left" ? "right" : "left"))}
						>
							{vp === "mid"
								? col === "left"
									? t("Llevar junto al mapa", "Move beside the map")
									: t("Llevar debajo del mapa", "Move below the map")
								: col === "left"
									? t("Llevar a la columna derecha", "Move to the right column")
									: t("Llevar a la columna izquierda", "Move to the left column")}
						</button>
					) : null}
					<a
						role="menuitem"
						class="panel__menu-link"
						href={`/api/evidence?panel=${encodeURIComponent(dataKey(id))}`}
						download
						onClick={() => {
							openMenu.value = null;
						}}
					>
						{t("Guardar evidencia", "Save evidence")}
					</a>
					<a
						role="menuitem"
						class="panel__menu-link"
						href={`/api/v1/panels/${encodeURIComponent(dataKey(id))}/figures?format=csv`}
						download
						onClick={() => {
							openMenu.value = null;
						}}
					>
						{t("Descargar cifras (CSV)", "Download figures (CSV)")}
					</a>
					<button
						type="button"
						role="menuitem"
						onClick={() => {
							openMenu.value = null;
							hidePanel(id);
							announcement.value = t(
								`${title} oculto. Puedes mostrarlo de nuevo en «Paneles ocultos».`,
								`${title} hidden. You can show it again under “Hidden panels”.`,
							);
						}}
					>
						{t("Ocultar panel", "Hide panel")}
					</button>
				</div>
			) : null}
		</div>
	);
}

export function Panel(props: {
	id: string;
	title: string;
	question?: string;
	feeds: readonly string[];
	children?: ComponentChildren;
	/** The body's code is still loading (ui/LazyPanel.tsx): show the loading state even when the data is here. */
	loading?: boolean;
	/** How to read the panel: its rules and caveats, shown in the "?" sheet (never as grey text under the panel). */
	method?: ComponentChildren;
	/** @deprecated Same as `method`; kept so panels written before the "?" sheet keep working. */
	foot?: ComponentChildren;
	/** Extra header items before the age badge, e.g. an "N nuevos" pill. */
	extra?: ComponentChildren;
	/**
	 * The badge while no feed has answered yet, for a body that shows something anyway (transcribed figures with their
	 * own date, a directory not measured yet): "Esperando datos" above data reads as a contradiction (review 4, L9).
	 */
	whenWaiting?: string | undefined;
	class?: string;
}) {
	const { id, title, feeds } = props;
	const managed = isPanelId(id);
	const collapsed = managed && isCollapsed(id);
	const summary = managed ? summarize(id) : null;
	const ready = panelReady(id);
	const state = feeds.length
		? panelFreshness(feeds, healthById.value, metaById.value, now.value, lang.value).state
		: "ok";
	const locked = feeds.length > 0 && feeds.every((f) => healthById.value.get(f)?.state === "locked");
	const method = props.method ?? props.foot;
	const figures = collapsed && viewport.value === "phone" ? summary?.figures : undefined;
	const [opening, setOpening] = useState(false);
	const toggle = () => {
		if (!managed) return;
		setOpening(collapsed);
		setCollapsed(id, !collapsed);
	};
	const onKey = (e: KeyboardEvent) => {
		if (!managed || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
		e.preventDefault();
		const moved = movePanel(id, e.key === "ArrowUp" ? -1 : 1);
		const pos = positionOf(id);
		announcement.value = moved
			? t(`${title}: posición ${pos.at} de ${pos.of}`, `${title}: position ${pos.at} of ${pos.of}`)
			: t(`${title} ya está en el extremo`, `${title} is already at the end`);
		requestAnimationFrame(() => document.getElementById(`${id}-toggle`)?.focus());
	};
	const tone = summary?.tone ?? "normal";
	const cls = [
		"panel",
		props.class ?? "",
		collapsed ? "panel--collapsed" : "",
		state === "stale" || state === "failing" ? `panel--${state}` : "",
		tone !== "normal" ? `panel--tone-${tone}` : "",
	]
		.filter(Boolean)
		.join(" ");
	const headline = collapsed && summary ? summary.text : props.question;
	return (
		<section class={cls} aria-labelledby={`${id}-title`} id={id}>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: Alt+↑/↓ pressed on the header's own buttons moves the panel. */}
			<header class="panel__head" onKeyDown={onKey}>
				<h2 class="panel__title" id={`${id}-title`}>
					{managed ? (
						<button
							type="button"
							id={`${id}-toggle`}
							class="panel__toggle"
							aria-expanded={!collapsed}
							aria-controls={`${id}-body`}
							title={collapsed ? props.question : undefined}
							onClick={toggle}
						>
							<svg class="panel__chev" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
								<path d="M3.5 1.5L7 5L3.5 8.5" />
							</svg>
							<span class="panel__eyebrow">{title}</span>
							{figures ? (
								<span class="panel__figures">
									{figures.map((f) => (
										<span class="panel__figure" key={f.label}>
											<span class="panel__figure-label">{f.label}</span>
											<span class="panel__figure-value data">
												{f.value}
												{f.unit ? <span class="figure__unit">{f.unit}</span> : null}
											</span>
										</span>
									))}
								</span>
							) : headline ? (
								<span class={`panel__question${collapsed ? ` panel__question--${tone}` : ""}`}>
									{headline}
								</span>
							) : null}
						</button>
					) : (
						<span class="panel__static">
							{props.question ? <span class="panel__eyebrow">{title}</span> : null}
							<span class="panel__question">{props.question ?? title}</span>
						</span>
					)}
				</h2>
				<div class="panel__tools">
					{props.extra}
					{feeds.length ? <Freshness feeds={feeds} whenWaiting={props.whenWaiting} /> : null}
					{!collapsed ? (
						<button
							type="button"
							class="panel__icon panel__help"
							aria-label={t(`Cómo leer ${title} y sus fuentes`, `How to read ${title}, and its sources`)}
							title={t("Cómo se lee y de dónde sale", "How to read it and where it comes from")}
							onClick={() => {
								openMethod.value = { title, question: props.question, feeds, body: method };
							}}
						>
							?
						</button>
					) : null}
					{managed ? <PanelMenu id={id} title={title} /> : null}
				</div>
			</header>
			{collapsed ? null : (
				<>
					{ready && !locked ? <StateBand feeds={feeds} /> : null}
					<div
						class={`panel__body${opening ? " panel__body--enter" : ""}`}
						id={`${id}-body`}
						onAnimationEnd={() => setOpening(false)}
					>
						{locked ? <Locked feeds={feeds} /> : ready && !props.loading ? props.children : <Loading />}
					</div>
				</>
			)}
		</section>
	);
}
