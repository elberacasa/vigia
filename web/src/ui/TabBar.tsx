import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../lib/i18n.ts";
import { hiddenPanels, type PanelId, reveal, visibleOrder } from "../lib/layout.ts";
import { link, type Route } from "../lib/router.ts";
import { freshCount } from "../lib/seen.ts";
import { panelName, summarize } from "../lib/summary.ts";

const moreOpen = signal(false);

type Tab = "ahora" | "mapa" | "dinero" | "noticias";

function still(): boolean {
	return matchMedia("(prefers-reduced-motion: reduce)").matches || !!document.documentElement.dataset.motion;
}

/** Which section the reader is in: the tracked section whose top most recently passed the upper third. */
function useSpy(): Tab | null {
	const [tab, setTab] = useState<Tab | null>("ahora");
	useEffect(() => {
		let frame = 0;
		const measure = () => {
			frame = 0;
			// The page order follows the reader's layout, so pick the tracked section closest above the line.
			// Every panel counts, so reading Red or Energía (below News) lights no tab instead of "Noticias".
			const best = [...document.querySelectorAll<HTMLElement>("section.panel[id]")]
				.map((el) => ({ id: el.id, top: el.getBoundingClientRect().top }))
				.filter((x) => x.top < innerHeight / 3)
				.sort((a, b) => b.top - a.top)[0];
			const tracked = (id: string): id is Tab => id === "dinero" || id === "mapa" || id === "noticias";
			setTab(scrollY < 80 || !best ? "ahora" : tracked(best.id) ? best.id : null);
		};
		const onScroll = () => {
			if (!frame) frame = requestAnimationFrame(measure);
		};
		addEventListener("scroll", onScroll, { passive: true });
		measure();
		return () => {
			removeEventListener("scroll", onScroll);
			if (frame) cancelAnimationFrame(frame);
		};
	}, []);
	return tab;
}

/** An amber dot on a tab whose section has rows that just arrived (lib/seen.ts): News, or a panel under "Más". */
function NewDot({ tab }: { tab: Tab | "mas" }) {
	const n =
		tab === "noticias"
			? freshCount("news")
			: tab === "mas"
				? freshCount("quakes") + freshCount("outages")
				: 0;
	if (!n) return null;
	return <span class="tabbar__new" title={t("Hay novedades", "Something new")} />;
}

const ICONS: Record<Tab | "mas", string> = {
	// Stroked 20×20 glyphs drawn for Vigía: a pulse line, a map pin, a coin, a page, a grid.
	ahora: "M2 11h3.5l2-5 3 9 2.2-6 1.3 2H18",
	mapa: "M10 18s-5.5-5.2-5.5-9.3a5.5 5.5 0 0 1 11 0C15.5 12.8 10 18 10 18Zm0-7.3a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
	dinero:
		"M10 2.5v15M13.6 5.6c-.7-1-2-1.6-3.6-1.6-2.1 0-3.6 1.1-3.6 2.8 0 4 7.4 2.1 7.4 6.3 0 1.8-1.6 2.9-3.8 2.9-1.7 0-3.1-.7-3.9-1.8",
	noticias: "M4 3.5h9.5L16 6v10.5H4Zm3 5h6M7 11.5h6M7 14h4",
	mas: "M3.5 3.5h5v5h-5Zm8 0h5v5h-5Zm-8 8h5v5h-5Zm8 0h5v5h-5Z",
};

/** Phone: the bottom tab bar. Ahora · Mapa · Dólar · Noticias · Más (a sheet with every other panel). */
export function TabBar() {
	const tab = useSpy();
	const go = (id: Tab) => {
		if (id === "ahora") scrollTo({ top: 0, behavior: still() ? "auto" : "smooth" });
		else if (id === "mapa")
			document
				.getElementById("mapa")
				?.scrollIntoView({ block: "start", behavior: still() ? "auto" : "smooth" });
		else reveal(id);
	};
	const items: { id: Tab; label: string }[] = [
		{ id: "ahora", label: t("Ahora", "Now") },
		{ id: "mapa", label: t("Mapa", "Map") },
		{ id: "dinero", label: t("Dólar", "Dollar") },
		{ id: "noticias", label: t("Noticias", "News") },
	];
	return (
		<>
			<nav class="tabbar" aria-label={t("Secciones", "Sections")}>
				{items.map((it) => (
					<button
						type="button"
						key={it.id}
						class="tabbar__tab"
						aria-current={tab === it.id && !moreOpen.value ? "true" : undefined}
						onClick={() => go(it.id)}
					>
						<svg viewBox="0 0 20 20" width="22" height="22" aria-hidden="true">
							<path d={ICONS[it.id]} />
						</svg>
						<NewDot tab={it.id} />
						<span>{it.label}</span>
					</button>
				))}
				<button
					type="button"
					class="tabbar__tab"
					aria-haspopup="dialog"
					aria-expanded={moreOpen.value}
					onClick={() => {
						moreOpen.value = true;
					}}
				>
					<svg viewBox="0 0 20 20" width="22" height="22" aria-hidden="true">
						<path d={ICONS.mas} />
					</svg>
					<NewDot tab="mas" />
					<span>{t("Más", "More")}</span>
				</button>
			</nav>
			<MoreSheet />
		</>
	);
}

const PAGES: { route: Route; es: string; en: string }[] = [
	{ route: "brief", es: "Resumen del día", en: "Daily brief" },
	{ route: "status", es: "Estado de las fuentes", en: "Feed status" },
	{ route: "sources", es: "Fuentes y licencias", en: "Sources and licences" },
	{ route: "guide", es: "Configurar y claves", en: "Set up and keys" },
	{ route: "ai", es: "Capa IA", en: "AI layer" },
];

/** "Más": every panel with its one-line summary, the hidden ones, and the other pages. */
function MoreSheet() {
	const ref = useRef<HTMLDialogElement>(null);
	const drag = useRef<{ y: number; dy: number } | null>(null);
	const open = moreOpen.value;
	useEffect(() => {
		const d = ref.current;
		if (!d) return;
		if (open && !d.open) d.showModal();
		if (!open && d.open) d.close();
	}, [open]);
	const close = () => {
		moreOpen.value = false;
	};
	const pick = (id: PanelId) => {
		// Close the dialog now, not in the effect after the next render: its closing hands the focus back to "Más",
		// and done later that undid reveal's move of the focus onto the picked panel.
		ref.current?.close();
		close();
		reveal(id, true);
	};
	const hidden = hiddenPanels();
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a mouse shortcut; Escape closes the dialog natively.
		<dialog
			ref={ref}
			class="sheet sheet--more"
			aria-label={t("Más secciones", "More sections")}
			onClose={close}
			onClick={(e) => {
				if (e.target === ref.current) close();
			}}
		>
			{open ? (
				<div class="sheet__inner">
					<div
						class="sheet__handle"
						aria-hidden="true"
						onPointerDown={(e) => {
							drag.current = { y: e.clientY, dy: 0 };
							(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
						}}
						onPointerMove={(e) => {
							if (!drag.current || !ref.current) return;
							drag.current.dy = Math.max(0, e.clientY - drag.current.y);
							ref.current.style.transform = `translateY(${drag.current.dy}px)`;
						}}
						onPointerUp={() => {
							if (ref.current) ref.current.style.transform = "";
							if ((drag.current?.dy ?? 0) > 80) close();
							drag.current = null;
						}}
					/>
					<header class="sheet__head">
						<h2 class="sheet__title sheet__title--sm">{t("Todos los paneles", "All panels")}</h2>
						<button type="button" class="sheet__close" onClick={close}>
							<span aria-hidden="true">✕</span>
							<span class="sr-only">{t("Cerrar", "Close")}</span>
						</button>
					</header>
					<ul class="more-list">
						{visibleOrder.value.map((id) => {
							const s = summarize(id);
							return (
								<li key={id}>
									<button type="button" class="more-list__row" onClick={() => pick(id)}>
										<span
											class={`more-list__dot more-list__dot--${s?.tone ?? "normal"}`}
											aria-hidden="true"
										/>
										<span class="more-list__text">
											<span class="more-list__name">{panelName(id)}</span>
											<span class="more-list__sum">{s?.text ?? t("Cargando…", "Loading…")}</span>
										</span>
										<span aria-hidden="true" class="more-list__go">
											›
										</span>
									</button>
								</li>
							);
						})}
					</ul>
					{hidden.length ? (
						<>
							<h3 class="caps more-h">{t("Ocultos", "Hidden")}</h3>
							<ul class="more-list">
								{hidden.map((id) => (
									<li key={id}>
										<button type="button" class="more-list__row" onClick={() => pick(id)}>
											<span class="more-list__text">
												<span class="more-list__name">{panelName(id)}</span>
												<span class="more-list__sum">{t("Toca para mostrarlo", "Tap to show it")}</span>
											</span>
											<span aria-hidden="true" class="more-list__go">
												+
											</span>
										</button>
									</li>
								))}
							</ul>
						</>
					) : null}
					<h3 class="caps more-h">{t("Páginas", "Pages")}</h3>
					<ul class="more-pages">
						{PAGES.map((p) => {
							const l = link(p.route);
							return (
								<li key={p.route}>
									<a
										href={l.href}
										onClick={(e) => {
											close();
											l.onClick(e);
										}}
									>
										{t(p.es, p.en)}
									</a>
								</li>
							);
						})}
					</ul>
				</div>
			) : null}
		</dialog>
	);
}
