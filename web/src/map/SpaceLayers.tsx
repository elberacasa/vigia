import { useEffect } from "preact/hooks";
import { addStyles } from "../lib/css.ts";
import { now, panels, wantPanel } from "../lib/data.ts";
import { int, stamp } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { type FloodsView, km2, type MethaneView, plumeRate, unseenWord } from "../lib/space-view.ts";
import spaceCss from "../styles/space.css?inline";
import { project } from "./project.ts";
import { replaying } from "./view.ts";

addStyles(spaceCss);

/*
 * Two map layers from space, each its own chunk loaded when switched on, with its view fetched on demand:
 * "Inundación (NASA MODIS)": the newest day's 0.1° cells with flood (accent, stronger with more km²) or only
 * recurring flood (grey); "Plumas de metano": each plume of the last year as a hollow triangle where Carbon Mapper
 * placed it, filled when it is within 3 km of a facility. Never a total of emissions.
 */

const CELL = 0.1;

function useView<T>(id: string): T | undefined {
	useEffect(() => {
		wantPanel(id).catch(() => {});
	}, [id]);
	return panels.value[id] as T | undefined;
}

export function FloodLayer() {
	const v = useView<FloodsView>("floods");
	const cells = v?.day?.cells ?? [];
	const max = Math.max(0.1, ...cells.map((c) => c[2]));
	const l = lang.value;
	return (
		<g class="layer-floods">
			{cells.map(([lat, lon, flood, recurring]) => {
				const [x0, y0] = project(lon, lat + CELL);
				const [x1, y1] = project(lon + CELL, lat);
				return (
					<rect
						key={`${lat},${lon}`}
						x={x0.toFixed(1)}
						y={y0.toFixed(1)}
						width={(x1 - x0).toFixed(1)}
						height={(y1 - y0).toFixed(1)}
						class={flood > 0 ? "flood-cell" : "flood-cell flood-cell--recurring"}
						style={{ fillOpacity: (flood > 0 ? 0.3 + 0.65 * Math.sqrt(flood / max) : 0.35).toFixed(2) }}
					>
						<title>
							{t(
								`${km2(flood, l)} de inundación, ${km2(recurring, l)} recurrente (celda de 0,1°)`,
								`${km2(flood, l)} of flood, ${km2(recurring, l)} recurring (0.1° cell)`,
							)}
						</title>
					</rect>
				);
			})}
		</g>
	);
}

export function FloodLegend() {
	const v = panels.value.floods as FloodsView | undefined;
	const d = v?.day ?? null;
	const l = lang.value;
	if (replaying.value !== null)
		return (
			<div class="space-key">
				<span class="note">
					{t(
						"Inundación: solo en vivo (el día más reciente leído no es la hora que muestra el mapa).",
						"Flood: live only (the newest day read is not the hour the map shows).",
					)}
				</span>
			</div>
		);
	return (
		<div class="space-key">
			<span>
				<svg width="26" height="10" viewBox="0 0 26 10" aria-hidden="true">
					<rect x="0" y="0" width="12" height="10" class="flood-cell" style={{ fillOpacity: 0.8 }} />
					<rect
						x="14"
						y="0"
						width="12"
						height="10"
						class="flood-cell flood-cell--recurring"
						style={{ fillOpacity: 0.35 }}
					/>
				</svg>
				{t("inundación vista · solo recurrente (celdas de 0,1°)", "flood seen · recurring only (0.1° cells)")}
			</span>
			<span class="note">
				{d
					? t(
							`NASA MODIS, ${d.date} · ${unseenWord(d.venezuela.unseenPct, l)}: bajo nubes el satélite no ve el suelo`,
							`NASA MODIS, ${d.date} · ${unseenWord(d.venezuela.unseenPct, l)}: under clouds the satellite cannot see the ground`,
						)
					: v
						? t("Aún no se ha leído ningún día.", "No day read yet.")
						: t("Cargando…", "Loading…")}
			</span>
		</div>
	);
}

/** `before`: while the map replays the past, only the plumes seen by then. */
export function PlumeLayer({ before = null }: { before?: number | null }) {
	const v = useView<MethaneView>("methane");
	const l = lang.value;
	return (
		<g class="layer-plumes">
			{(v?.plumes ?? [])
				.filter((p) => before === null || p.observedAt < before)
				.map((p) => {
					const [x, y] = project(p.lon, p.lat);
					return (
						<g
							key={p.plumeId}
							style={{ transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(var(--zk, 1))` }}
						>
							<path d="M0 6 6-5H-6Z" class={`plume-mark${p.facilityName ? " plume-mark--fac" : ""}`}>
								<title>
									{`${stamp(p.observedAt, l, now.value)} · ${p.facilityName ?? p.municipalityName ?? p.stateName} · ${plumeRate(p, l)} · ${p.instrumentEs}`}
								</title>
							</path>
						</g>
					);
				})}
		</g>
	);
}

export function PlumeLegend() {
	const v = panels.value.methane as MethaneView | undefined;
	const l = lang.value;
	return (
		<div class="space-key">
			<span>
				<svg width="26" height="12" viewBox="-7 -6 26 12" aria-hidden="true">
					<path d="M0 6 6-5H-6Z" class="plume-mark" />
					<path d="M12 6 18-5H6Z" class="plume-mark plume-mark--fac" />
				</svg>
				{t(
					"pluma captada · a menos de 3 km de una instalación",
					"plume captured · within 3 km of a facility",
				)}
			</span>
			<span class="note">
				{v
					? t(
							`${int(v.plumes.length, l)} en 12 meses (Carbon Mapper). Una pluma es un paso del satélite: sin plumas no significa sin emisiones.`,
							`${int(v.plumes.length, l)} in 12 months (Carbon Mapper). A plume is one satellite pass: no plume does not mean no emissions.`,
						)
					: t("Cargando…", "Loading…")}
			</span>
		</div>
	);
}
