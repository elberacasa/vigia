import { signal } from "@preact/signals";
import type { ComponentType } from "preact";
import { useEffect } from "preact/hooks";
import { t } from "../lib/i18n.ts";
import { isCollapsed, type PanelId } from "../lib/layout.ts";
import { PANEL_META } from "../lib/panel-meta.ts";
import { useFresh } from "../lib/seen.ts";
import { recoverFromChunkError } from "../lib/update.ts";
import { NewPill } from "./Digits.tsx";
import { Panel } from "./Panel.tsx";

/**
 * Each wall panel's body is its own chunk, fetched only when the panel is open and near the screen. Until then
 * its frame is drawn from lib/panel-meta.ts (title, question, freshness badge) and, when collapsed, the summary
 * row from lib/summary.ts, so a phone that keeps every panel as a one-line row never downloads their bodies.
 * On a wider screen the open panels further down (or further down a scrolling column) load once the page is idle.
 */
const LOADERS: Record<PanelId, () => Promise<ComponentType>> = {
	incidentes: () => import("../panels/Incidents.tsx").then((m) => m.IncidentsPanel),
	dinero: () => import("../panels/Money.tsx").then((m) => m.MoneyPanel),
	bolsillo: () => import("../panels/Daily.tsx").then((m) => m.PocketPanel),
	servicios: () => import("../panels/Daily.tsx").then((m) => m.ServicesPanel),
	gaceta: () => import("../panels/Daily.tsx").then((m) => m.GazettePanel),
	conectividad: () => import("../panels/Connectivity.tsx").then((m) => m.ConnectivityPanel),
	noticias: () => import("../panels/News.tsx").then((m) => m.NewsPanel),
	sismos: () => import("../panels/Quakes.tsx").then((m) => m.QuakesPanel),
	clima: () => import("../panels/Earth.tsx").then((m) => m.WeatherPanel),
	luces: () => import("../panels/Imagery.tsx").then((m) => m.NightlightsPanel),
	incendios: () => import("../panels/Earth.tsx").then((m) => m.FiresPanel),
	alertas: () => import("../panels/Earth.tsx").then((m) => m.HazardsPanel),
	satelite: () => import("../panels/Imagery.tsx").then((m) => m.SatellitePanel),
	petroleo: () => import("../panels/Money.tsx").then((m) => m.OilPanel),
	mercados: () => import("../panels/Markets.tsx").then((m) => m.MarketsPanel),
	tv: () => import("../panels/LiveTv.tsx").then((m) => m.LiveTvPanel),
	censura: () => import("../panels/Censorship.tsx").then((m) => m.CensorshipPanel),
	red: () => import("../panels/Netwatch.tsx").then((m) => m.NetwatchPanel),
	energia: () => import("../panels/Energy.tsx").then((m) => m.EnergyPanel),
	"espacio-aereo": () => import("../panels/Airspace.tsx").then((m) => m.AirspacePanel),
	atencion: () => import("../panels/Attention.tsx").then((m) => m.AttentionPanel),
	humanitario: () => import("../panels/Humanitarian.tsx").then((m) => m.HumanitarianPanel),
};

const loaded = signal<Partial<Record<PanelId, ComponentType>>>({});
/** Panels whose chunk could not be fetched (offline before it was ever cached); a retry clears the mark. */
const failed = signal<ReadonlySet<PanelId>>(new Set());
const inflight = new Map<PanelId, Promise<void>>();

export function loadPanel(id: PanelId): Promise<void> {
	if (loaded.peek()[id]) return Promise.resolve();
	let pending = inflight.get(id);
	if (!pending) {
		pending = LOADERS[id]().then(
			(C) => {
				// The frame is replaced by the real panel; keep the focus where it was (e.g. on its toggle).
				const focused = document.activeElement?.id;
				loaded.value = { ...loaded.value, [id]: C };
				if (focused?.startsWith(`${id}-`))
					requestAnimationFrame(() => document.getElementById(focused)?.focus({ preventScroll: true }));
			},
			(err) => {
				inflight.delete(id);
				// A chunk of the previous build that is gone (after an upgrade): reload onto the new one.
				if (recoverFromChunkError(err)) return;
				failed.value = new Set([...failed.value, id]);
			},
		);
		inflight.set(id, pending);
	}
	return pending;
}

function retry(id: PanelId): void {
	const next = new Set(failed.value);
	next.delete(id);
	failed.value = next;
	void loadPanel(id);
}

/** Loads the bodies of the given open panels one after another (idle prefetch on wide screens). */
export async function prefetchPanels(ids: readonly PanelId[]): Promise<void> {
	for (const id of ids) {
		if (!isCollapsed(id) && !failed.peek().has(id)) await loadPanel(id);
	}
}

/** The frame of a panel whose body has not loaded: the same header, badge and summary row as the real one. */
function PanelFrame({ id }: { id: PanelId }) {
	const meta = PANEL_META[id];
	const collapsed = isCollapsed(id);
	const didFail = failed.value.has(id);
	// Arrivals keep being observed while the body is not here, so "N nuevos" and the tab bar's badge stay true.
	useFresh(meta.fresh?.scope ?? "", meta.fresh ? meta.fresh.ids() : []);
	useEffect(() => {
		if (collapsed || didFail) return;
		const el = document.getElementById(id);
		if (!el || typeof IntersectionObserver === "undefined") {
			void loadPanel(id);
			return;
		}
		const io = new IntersectionObserver(
			(entries) => {
				if (!entries.some((e) => e.isIntersecting)) return;
				io.disconnect();
				void loadPanel(id);
			},
			{ rootMargin: "600px 0px" },
		);
		io.observe(el);
		return () => io.disconnect();
	}, [id, collapsed, didFail]);
	return (
		<Panel
			id={id}
			title={meta.title()}
			question={meta.question()}
			feeds={meta.feeds()}
			extra={meta.fresh ? <NewPill scope={meta.fresh.scope} panel={id} /> : undefined}
			loading={!didFail}
		>
			{didFail ? (
				<p class="empty">
					{t("No se pudo cargar este panel.", "Could not load this panel.")}{" "}
					<button type="button" class="link-button" onClick={() => retry(id)}>
						{t("Reintentar", "Retry")}
					</button>
				</p>
			) : null}
		</Panel>
	);
}

export function PanelSlot({ id }: { id: PanelId }) {
	const Body = loaded.value[id];
	return Body ? <Body /> : <PanelFrame id={id} />;
}
