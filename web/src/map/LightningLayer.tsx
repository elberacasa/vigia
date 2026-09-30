import { useEffect } from "preact/hooks";
import { panels, wantPanel } from "../lib/data.ts";
import { clock, int } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { cellIntensities, type LightningView } from "../panels/lightning-view.ts";
import { project } from "./project.ts";

/**
 * "Rayos": the last hour's GLM flashes on the server's 0.25° grid, one square per cell with any flash, its opacity
 * the square root of its count over the busiest cell's. Static (nothing moves). The view is on demand: it is fetched
 * the first time the layer is switched on, never on a page that does not show it. Without a recent, consecutive hour
 * (the server gives no cells then) the layer draws nothing and its key says why, rather than an empty map that
 * would read as "no lightning". This file is its own chunk (loaded when the layer is on); the layer's row in the
 * list is in LayerRows.tsx, in the first load.
 */
const HALF = 0.125;

function useLightning(): LightningView | undefined {
	useEffect(() => {
		wantPanel("lightning").catch(() => {});
	}, []);
	return panels.value.lightning as LightningView | undefined;
}

export function LightningLayer() {
	const view = useLightning();
	const cells = view?.lastHour ? cellIntensities(view.cellsLastHour) : [];
	const l = lang.value;
	return (
		<g class="layer-lightning">
			{cells.map((c) => {
				const [x0, y0] = project(c.lon - HALF, c.lat + HALF);
				const [x1, y1] = project(c.lon + HALF, c.lat - HALF);
				return (
					<rect
						key={`${c.lat},${c.lon}`}
						class="lightning-cell"
						x={x0.toFixed(1)}
						y={y0.toFixed(1)}
						width={(x1 - x0).toFixed(1)}
						height={(y1 - y0).toFixed(1)}
						style={{ fillOpacity: (0.18 + 0.72 * c.w).toFixed(2) }}
					>
						<title>
							{t(
								`${int(c.n, l)} ${c.n === 1 ? "destello" : "destellos"} en la última hora (celda de 0,25°)`,
								`${int(c.n, l)} ${c.n === 1 ? "flash" : "flashes"} in the last hour (0.25° cell)`,
							)}
						</title>
					</rect>
				);
			})}
		</g>
	);
}

/** The layer's key while it is on: what a square is, what it does not count, and why the map may be empty. */
export function LightningLegend() {
	const view = panels.value.lightning as LightningView | undefined;
	const l = lang.value;
	const h = view?.lastHour ?? null;
	return (
		<div class="layers__lightning">
			<span class="lightning-key">
				<svg width="26" height="10" viewBox="0 0 26 10" aria-hidden="true">
					<rect x="0" y="0" width="8" height="10" class="lightning-cell" style={{ fillOpacity: 0.25 }} />
					<rect x="9" y="0" width="8" height="10" class="lightning-cell" style={{ fillOpacity: 0.55 }} />
					<rect x="18" y="0" width="8" height="10" class="lightning-cell" style={{ fillOpacity: 0.9 }} />
				</svg>
				{t("destellos por celda de 0,25°", "flashes per 0.25° cell")}
			</span>
			<span class="note">
				{!view
					? t("Cargando…", "Loading…")
					: h
						? t(
								`${clock(h.from, l)}–${clock(h.to, l)} · detectados por GLM, no todos los rayos`,
								`${clock(h.from, l)}–${clock(h.to, l)} · detected by GLM, not every strike`,
							)
						: t(
								"Sin una hora seguida y reciente leída: el mapa no muestra rayos (no significa que no haya).",
								"No recent consecutive hour read: the map shows no lightning (it does not mean there is none).",
							)}
			</span>
		</div>
	);
}
