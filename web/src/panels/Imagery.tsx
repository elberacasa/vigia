import { useState } from "preact/hooks";
import { addStyles } from "../lib/css.ts";
import { panels } from "../lib/data.ts";
import { num, pct } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { PANEL_META } from "../lib/panel-meta.ts";
import { SatelliteControls } from "../map/underlays.tsx";
import panelsCss from "../styles/panels.css?inline";
import { Panel } from "../ui/Panel.tsx";
import { SourceTag } from "../ui/Source.tsx";

addStyles(panelsCss);

/** Mirrors src/panels/satellite.ts and src/panels/nightlights.ts. */
export interface Bounds {
	west: number;
	east: number;
	south: number;
	north: number;
}
interface Frame {
	key: string;
	url: string;
	observedAt: number;
	lighting: "day" | "night" | "mixed";
	staticCityLights: boolean;
	sourceUrl: string;
}
export interface SatelliteView {
	feed: string;
	product: string;
	attribution: string;
	homepage: string;
	bounds: Bounds | null;
	frames: Frame[];
	newest: Frame | null;
	nightNote: string | null;
}
export interface NightRegion {
	iso: string;
	name: string;
	radianceIndex: number | null;
	baseline: number | null;
	baselineNights: number;
	pctChange: number | null;
	comparable: boolean;
	clearFraction: number | null;
	quality: "clear" | "partly" | "cloudy" | "unknown";
	qualityNote: string;
}
export interface NightlightsView {
	feed: string;
	product: string;
	attribution: string;
	acknowledgement: string;
	date: string | null;
	observedAt: number | null;
	sourceUrl: string | null;
	image: { key: string; url: string; bounds: Bounds; width: number; height: number } | null;
	national: NightRegion | null;
	states: NightRegion[];
	caveats: string[];
}

export function SatellitePanel() {
	const view = panels.value.satellite as SatelliteView | undefined;
	return (
		<Panel
			id="satelite"
			title={PANEL_META.satelite.title()}
			question={PANEL_META.satelite.question()}
			feeds={PANEL_META.satelite.feeds()}
			foot={view ? <span>{view.attribution}</span> : null}
		>
			{!view?.newest ? (
				<p class="skeleton">…</p>
			) : (
				<>
					<p class="note">
						{t(
							"Imagen GeoColor del GOES-19 sobre el mapa (capa «Satélite»). Muévela con el control o dale a reproducir para ver las últimas horas.",
							"GOES-19 GeoColor image on the map (“Satellite” layer). Scrub with the control or press play to see the last hours.",
						)}
					</p>
					<SatelliteControls />
					{view.nightNote ? <p class="note warn-text">{view.nightNote}</p> : null}
					<SourceTag
						source={{
							feed: view.feed,
							observedAt: view.newest.observedAt,
							url: view.newest.sourceUrl,
							detail: view.product,
						}}
						label="NOAA GOES-19"
					/>
				</>
			)}
		</Panel>
	);
}

export function NightlightsPanel() {
	const view = panels.value.nightlights as NightlightsView | undefined;
	const [all, setAll] = useState(false);
	const l = lang.value;
	const rows = (view?.states ?? []).filter((s) => all || s.comparable).slice(0, all ? 25 : 8);
	return (
		<Panel
			id="luces"
			title={PANEL_META.luces.title()}
			question={PANEL_META.luces.question()}
			feeds={PANEL_META.luces.feeds()}
			foot={
				view ? (
					<>
						<span>{view.attribution}</span>
						{view.caveats.map((c) => (
							<span key={c}>{c}</span>
						))}
					</>
				) : null
			}
		>
			{!view?.date ? (
				<p class="skeleton">…</p>
			) : (
				<>
					<p class="note">
						{t("Noche del", "Night of")} {view.date} ·{" "}
						{t(
							"índice de luz por estado frente a la mediana de las noches anteriores. Solo se comparan estados con cielo mayormente despejado.",
							"light index per state against the median of previous nights. Only mostly clear-sky states are compared.",
						)}
					</p>
					{view.national ? (
						<p class="state-block__figure">
							{t("Venezuela", "Venezuela")}:{" "}
							<strong class="data">
								{view.national.pctChange !== null ? pct(view.national.pctChange, 0, l) : "—"}
							</strong>{" "}
							<span class="note">{view.national.qualityNote}</span>
						</p>
					) : null}
					<ul class="bars bars--diverging">
						{rows.map((s) => (
							<li key={s.iso} class={s.comparable ? "" : "is-muted"}>
								<span class="bars__label">{s.name}</span>
								<span class="bars__track">
									{s.pctChange !== null ? (
										<span
											class={`bars__fill ${s.pctChange < 0 ? "bars__fill--down" : "bars__fill--up"}`}
											style={{
												width: `${Math.min(50, Math.abs(s.pctChange) / 2)}%`,
												marginLeft:
													s.pctChange < 0 ? `${50 - Math.min(50, Math.abs(s.pctChange) / 2)}%` : "50%",
											}}
										/>
									) : null}
								</span>
								<span class="bars__value data" title={s.qualityNote}>
									{s.pctChange !== null
										? pct(s.pctChange, 0, l)
										: s.quality === "cloudy"
											? t("nubes", "clouds")
											: "—"}
								</span>
							</li>
						))}
					</ul>
					<button type="button" class="link-button" onClick={() => setAll(!all)}>
						{all ? t("Solo comparables", "Comparable only") : t("Ver los 25 estados", "Show all 25 states")}
					</button>
					{view.observedAt ? (
						<SourceTag
							source={{
								feed: view.feed,
								observedAt: view.observedAt,
								url: view.sourceUrl ?? undefined,
								detail: `${view.product}. ${view.acknowledgement}`,
							}}
							label="NASA GIBS"
						/>
					) : null}
					<p class="note">
						{t("Índice", "Index")}: {num(view.national?.radianceIndex ?? 0, 3, l)}
					</p>
				</>
			)}
		</Panel>
	);
}
