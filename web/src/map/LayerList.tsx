import type { ComponentChildren } from "preact";
import { type FeedState, healthById, now, panels } from "../lib/data.ts";
import { ago, int } from "../lib/format.ts";
import { internetWord, isLive } from "../lib/fresh.ts";
import { lang, t } from "../lib/i18n.ts";
import { link } from "../lib/router.ts";
import type { ConnectivityView } from "../panels/Connectivity.tsx";
import type { FiresView } from "../panels/Earth.tsx";
import type { SatelliteView } from "../panels/Imagery.tsx";
import type { NewsView } from "../panels/News.tsx";
import type { QuakesView } from "../panels/Quakes.tsx";
import { FlareLegend, FlareRow } from "./FlareLayer.tsx";
import { QuakeLegend } from "./QuakeLayer.tsx";
import {
	type Shading,
	setLayer,
	shading,
	showFires,
	showFlares,
	showQuakes,
	toggleFires,
	toggleQuakes,
} from "./view.ts";

/** Newest datum of a feed (or last check for event feeds), as "hace 18 min"; null when never fetched. */
function feedAge(feed: string): string | null {
	const h = healthById.value.get(feed);
	if (!h?.lastSuccessAt) return null;
	const at =
		h.newestObservedAt !== null && h.newestObservedAt <= now.value ? h.newestObservedAt : h.lastSuccessAt;
	return ago(now.value - at, lang.value);
}

function feedState(feed: string): FeedState {
	return healthById.value.get(feed)?.state ?? "pending";
}

export interface LayerInfo {
	id: Shading;
	name: string;
	feed: string | null;
	/** Right-aligned live figure, computed by the server ("1 caída", "82 focos"). */
	count: string | null;
	age: string | null;
	/** Locked behind a free key (or an off AI section): shown dimmed with a link to unlock it. */
	locked: { text: string; href: "guide" | "ai" } | null;
	swatch: string;
}

/** Every shading layer with its current count and age. Exported so the palette can list the same rows. */
export function layerInfo(): LayerInfo[] {
	const p = panels.value;
	const l = lang.value;
	const conn = p.connectivity as ConnectivityView | undefined;
	const fires = p.fires as FiresView | undefined;
	const news = p.news as NewsView | undefined;
	const sat = p.satellite as SatelliteView | undefined;
	const ai = p.ai as { backend?: string; model?: string | null } | undefined;
	// "sin caídas" only with the server's all-clear (≥ 20 states with fresh data) and a live IODA feed (review 3, H5).
	const internet = internetWord(conn, isLive(feedState("ioda-states")), l);
	const firesLocked = feedState("firms-fires") === "locked";
	return [
		{
			id: "connectivity",
			name: t("Internet", "Internet"),
			feed: "ioda-states",
			count: internet?.short ?? null,
			age: feedAge("ioda-states"),
			locked: null,
			swatch: "internet",
		},
		{
			id: "nightlights",
			name: t("Luces de noche", "Night lights"),
			feed: "gibs-nightlights",
			count: null,
			age: feedAge("gibs-nightlights"),
			locked: null,
			swatch: "light",
		},
		{
			id: "satellite",
			name: t("Satélite", "Satellite"),
			feed: "goes-nsa",
			count: sat?.frames.length ? t(`${sat.frames.length} imágenes`, `${sat.frames.length} frames`) : null,
			age: feedAge("goes-nsa"),
			locked: null,
			swatch: "sat",
		},
		{
			id: "reports",
			name: t("Titulares", "Headlines"),
			feed: null,
			count: news ? int(news.items24h, l) : null,
			age: news ? "24 h" : null,
			locked: null,
			swatch: "signal",
		},
		{
			id: "fires",
			name: t("Incendios", "Fires"),
			feed: "firms-fires",
			// Likely fires (persistent industrial heat removed): the same figure as the tile and the panel.
			count: fires && !firesLocked ? int(fires.venezuela.last24h - fires.venezuela.persistent24h, l) : null,
			age: firesLocked ? null : feedAge("firms-fires"),
			locked: firesLocked ? { text: t("necesita clave", "needs a key"), href: "guide" } : null,
			swatch: "signal",
		},
		{
			id: "aiBlackouts",
			name: t("Apagones · IA", "Blackouts · AI"),
			feed: null,
			count: null,
			age: ai?.model ?? null,
			locked:
				(ai?.backend ?? "off") === "off" ? { text: t("activar la IA", "turn on AI"), href: "ai" } : null,
			swatch: "signal",
		},
	];
}

function Row(props: {
	type: "radio" | "checkbox";
	name: string;
	checked: boolean;
	onChange: () => void;
	label: string;
	swatch: string;
	count: string | null;
	age: string | null;
	locked: LayerInfo["locked"];
	children?: ComponentChildren;
}) {
	if (props.locked) {
		return (
			<li class="layer-row is-locked">
				<span class={`layer-row__swatch layer-row__swatch--${props.swatch}`} aria-hidden="true" />
				<span class="layer-row__name">{props.label}</span>
				<a class="layer-row__unlock" {...link(props.locked.href === "ai" ? "ai" : "guide")}>
					{props.locked.text} <span aria-hidden="true">→</span>
				</a>
			</li>
		);
	}
	return (
		<li class={`layer-row${props.checked ? " is-on" : ""}`}>
			<label>
				<input type={props.type} name={props.name} checked={props.checked} onChange={props.onChange} />
				<span class={`layer-row__swatch layer-row__swatch--${props.swatch}`} aria-hidden="true" />
				<span class="layer-row__name">{props.label}</span>
				{props.count ? <span class="layer-row__count data">{props.count}</span> : null}
				{props.age ? <span class="layer-row__age">{props.age}</span> : null}
			</label>
			{props.children}
		</li>
	);
}

/**
 * The layer control, docked beside the map on wide screens and under it on phones (controls never cover the data):
 * "Colorear estados por" (one choropleth) and "Encima" (points), each row with its live count and age.
 */
export function LayerList(props: { legend: ComponentChildren; unit: number; footer?: ComponentChildren }) {
	const mode = shading.value;
	const p = panels.value;
	const l = lang.value;
	const quakes = p.quakes as QuakesView | undefined;
	const fires = p.fires as FiresView | undefined;
	const firesLocked = feedState("firms-fires") === "locked";
	const newestQuake = quakes?.items.reduce<number | null>(
		(m, q) => (m === null || q.at > m ? q.at : m),
		null,
	);
	return (
		<nav class="layers" aria-label={t("Capas del mapa", "Map layers")}>
			<fieldset class="layers__group">
				<legend class="layers__title">{t("Colorear estados por", "Colour states by")}</legend>
				<ul>
					{layerInfo().map((info) => (
						<Row
							key={info.id}
							type="radio"
							name="map-shading"
							checked={mode === info.id}
							onChange={() => setLayer(info.id)}
							label={info.name}
							swatch={info.swatch}
							count={info.count}
							age={info.age}
							locked={info.locked}
						/>
					))}
				</ul>
			</fieldset>
			<fieldset class="layers__group">
				<legend class="layers__title">{t("Encima", "On top")}</legend>
				<ul>
					<Row
						type="checkbox"
						name="map-quakes"
						checked={showQuakes.value}
						onChange={() => toggleQuakes()}
						label={t("Sismos", "Earthquakes")}
						swatch="quakes"
						count={quakes ? `${int(quakes.counts.month, l)} · 30 d` : null}
						age={newestQuake ? ago(now.value - newestQuake, l) : null}
						locked={null}
					/>
					<Row
						type="checkbox"
						name="map-fires"
						checked={showFires.value}
						onChange={() => toggleFires()}
						label={t("Focos más intensos", "Strongest heat spots")}
						swatch="fire"
						count={fires && !firesLocked ? int(fires.strongest.length, l) : null}
						age={firesLocked ? null : feedAge("firms-fires")}
						locked={firesLocked ? { text: t("necesita clave", "needs a key"), href: "guide" } : null}
					/>
					<FlareRow />
				</ul>
			</fieldset>
			<div class="layers__legend">
				{props.legend}
				{showQuakes.value ? (
					<div class="layers__quakes">
						<QuakeLegend unit={props.unit} />
						<span class="note">{t("borde más tenue = más antiguo", "fainter outline = older")}</span>
					</div>
				) : null}
				{showFlares.value ? <FlareLegend /> : null}
			</div>
			{props.footer}
		</nav>
	);
}
