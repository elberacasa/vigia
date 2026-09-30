import { healthById, now, panels } from "../lib/data.ts";
import { ago, int } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { link } from "../lib/router.ts";
import type { EnergyView } from "../panels/energy-view.ts";
import type { LightningView } from "../panels/lightning-view.ts";
import {
	facilitiesShown,
	showCameras,
	showCrowd,
	showFacilities,
	showFlares,
	showFloods,
	showLightning,
	showPlumes,
	toggleCameras,
	toggleCrowd,
	toggleFacilities,
	toggleFlares,
	toggleFloods,
	toggleLightning,
	togglePlumes,
} from "./view.ts";

/*
 * Rows under "Encima" after quakes and heat spots (gas flares, lightning, facilities, public cameras, user reports,
 * flood cells, methane plumes): their own small chunk, so the phone's first load stays small; drawn once it arrives,
 * at the end of the list, each with its live count and age once its view is here.
 */

const FEED = "goes-glm";
const FLARES = "firms-flares";

/**
 * Its row under "Encima", the same shape as the quake and heat-spot rows: how many facilities showed a flame in
 * the last 7 nights (of those followed) and the age of the newest night of data. Off by default.
 */
export function FlareRow() {
	const view = panels.value.energy as EnergyView | undefined;
	const l = lang.value;
	const h = healthById.value.get(FLARES);
	const locked = h?.state === "locked";
	const on = showFlares.value;
	if (locked) {
		return (
			<li class="layer-row is-locked">
				<span class="layer-row__swatch layer-row__swatch--flare" aria-hidden="true" />
				<span class="layer-row__name">{t("Quemadores (gas)", "Gas flares")}</span>
				<a class="layer-row__unlock" {...link("guide")}>
					{t("necesita clave", "needs a key")} <span aria-hidden="true">→</span>
				</a>
			</li>
		);
	}
	// The feed's newest datum (as the other rows); before its health arrives, the newest detection in the view.
	const at =
		h?.lastSuccessAt && h.newestObservedAt !== null && h.newestObservedAt <= now.value
			? h.newestObservedAt
			: (h?.lastSuccessAt ?? view?.newestDetectionAt ?? null);
	return (
		<li class={`layer-row${on ? " is-on" : ""}`}>
			<label>
				<input type="checkbox" name="map-flares" checked={on} onChange={() => toggleFlares()} />
				<span class="layer-row__swatch layer-row__swatch--flare" aria-hidden="true" />
				<span class="layer-row__name">{t("Quemadores (gas)", "Gas flares")}</span>
				{view ? (
					<span
						class="layer-row__count data"
						title={t(
							`Con llama en las últimas 7 noches: ${view.lit7} de ${view.facilities.length} instalaciones`,
							`Flame in the last 7 nights: ${view.lit7} of ${view.facilities.length} facilities`,
						)}
					>
						{int(view.lit7, l)}/{int(view.facilities.length, l)}
					</span>
				) : null}
				{at ? <span class="layer-row__age">{ago(now.value - at, l)}</span> : null}
			</label>
		</li>
	);
}

/** Its row under "Encima": the last hour's flashes over Venezuela once the view is here, and the feed's age. */
export function LightningRow() {
	const view = panels.value.lightning as LightningView | undefined;
	const l = lang.value;
	const on = showLightning.value;
	const h = healthById.value.get(FEED);
	const at = h?.newestObservedAt ?? null;
	return (
		<li class={`layer-row${on ? " is-on" : ""}`}>
			<label>
				<input type="checkbox" name="map-lightning" checked={on} onChange={() => toggleLightning()} />
				<span class="layer-row__swatch layer-row__swatch--lightning" aria-hidden="true" />
				<span class="layer-row__name">{t("Rayos (1 h)", "Lightning (1 h)")}</span>
				{view?.lastHour ? (
					<span
						class="layer-row__count data"
						title={t(
							"Destellos detectados por GLM sobre Venezuela en la última hora (no todos los rayos)",
							"Flashes GLM detected over Venezuela in the last hour (not every strike)",
						)}
					>
						{int(view.lastHour.venezuela, l)}
					</span>
				) : null}
				{at !== null && at <= now.value ? <span class="layer-row__age">{ago(now.value - at, l)}</span> : null}
			</label>
		</li>
	);
}

/** Its row under "Encima": how many facilities are drawn once their data is here. */
export function FacilityRow() {
	const on = showFacilities.value;
	const n = facilitiesShown.value;
	return (
		<li class={`layer-row${on ? " is-on" : ""}`}>
			<label>
				<input type="checkbox" name="map-facilities" checked={on} onChange={() => toggleFacilities()} />
				<span class="layer-row__swatch layer-row__swatch--facility" aria-hidden="true" />
				<span class="layer-row__name">{t("Instalaciones", "Facilities")}</span>
				{on && n !== null ? (
					<span
						class="layer-row__count data"
						title={t(
							"Instalaciones dibujadas de los grupos elegidos (OpenStreetMap, OurAirports, IMF PortWatch)",
							"Facilities drawn from the chosen groups (OpenStreetMap, OurAirports, IMF PortWatch)",
						)}
					>
						{int(n, lang.value)}
					</span>
				) : null}
			</label>
		</li>
	);
}

/** A plain on/off row under "Encima", with its live count once the layer's view is here. */
function OnRow(props: { id: string; on: boolean; toggle: () => void; name: string; count: string | null }) {
	return (
		<li class={`layer-row${props.on ? " is-on" : ""}`}>
			<label>
				<input type="checkbox" name={`map-${props.id}`} checked={props.on} onChange={props.toggle} />
				<span class={`layer-row__swatch layer-row__swatch--${props.id}`} aria-hidden="true" />
				<span class="layer-row__name">{props.name}</span>
				{props.on && props.count ? <span class="layer-row__count data">{props.count}</span> : null}
			</label>
		</li>
	);
}

/** Cameras live of those listed (the legend says what the fans mean). */
export function CameraRow() {
	const v = panels.value.cameras as { cameras: unknown[]; counts: Record<string, number> } | undefined;
	return (
		<OnRow
			id="camera"
			on={showCameras.value}
			toggle={() => toggleCameras()}
			name={t("Cámaras públicas", "Public cameras")}
			count={v ? `${v.counts.live ?? 0}/${v.cameras.length}` : null}
		/>
	);
}

/** Municipalities with user reports in the last two hours (the legend says they are reports, not measurements). */
export function CrowdRow() {
	const v = panels.value.crowd as { counts: { municipalities: number } } | undefined;
	return (
		<OnRow
			id="crowd"
			on={showCrowd.value}
			toggle={() => toggleCrowd()}
			name={t("Reportes de usuarios", "User reports")}
			count={v ? String(v.counts.municipalities) : null}
		/>
	);
}

export function FloodRow() {
	const v = panels.value.floods as { day: { venezuela: { floodKm2: number } } | null } | undefined;
	return (
		<OnRow
			id="flood"
			on={showFloods.value}
			toggle={() => toggleFloods()}
			name={t("Inundación (NASA MODIS)", "Flood (NASA MODIS)")}
			count={v?.day ? `${Math.round(v.day.venezuela.floodKm2)} km²` : null}
		/>
	);
}

export function PlumeRow() {
	const v = panels.value.methane as { plumes: unknown[] } | undefined;
	return (
		<OnRow
			id="plume"
			on={showPlumes.value}
			toggle={() => togglePlumes()}
			name={t("Plumas de metano", "Methane plumes")}
			count={v ? String(v.plumes.length) : null}
		/>
	);
}

export function MoreRows() {
	return (
		<>
			<FlareRow />
			<LightningRow />
			<FacilityRow />
			<CameraRow />
			<CrowdRow />
			<FloodRow />
			<PlumeRow />
		</>
	);
}
