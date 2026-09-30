import { panels } from "../../lib/data.ts";
import { t } from "../../lib/i18n.ts";
import { wallFocus } from "../../lib/layout.ts";
import { later } from "../../lib/lazy.tsx";
import { usePared } from "../../lib/pared.ts";
import { moduleId, route } from "../../lib/router.ts";
import { connectivityFills } from "../../map/fills.ts";
import { VenezuelaMap } from "../../map/Map.tsx";
import { pickedPoint, selectedEntity, selectedState, selectState } from "../../map/view.ts";
import type { ConnectivityView } from "../../panels/Connectivity.tsx";
import { PanelSlot } from "../LazyPanel.tsx";
import { inspectorOpen, toggleInspector } from "./state.ts";

/** The entity chunk (view models, the API adapter and the view) loads the first time something is selected. */
const SelectionInspector = later(() =>
	import("../entity/EntityInspector.tsx").then((m) => m.SelectionInspector),
);

/** A small map in the inspector of the modules without the big one: the way to scope them to a place. */
function Minimap() {
	return (
		<div class="minimap">
			<p class="insp__label">{t("Elegir un lugar", "Pick a place")}</p>
			<VenezuelaMap
				fills={connectivityFills(panels.value.connectivity as ConnectivityView | undefined)}
				selected={selectedState.value}
				onSelect={selectState}
			/>
			<p class="minimap__note">
				{t(
					"Colores: internet por estado (IODA). Al elegir un estado, el inspector lo describe y Noticias y Sismos lo siguen.",
					"Colours: internet by state (IODA). Picking a state describes it here; News and Earthquakes follow it.",
				)}
			</p>
		</div>
	);
}

/**
 * The right column: whatever is selected, with every line's source and age. With nothing selected it holds the
 * incidents (the day's clearest signal); on a wall display (Pared) it rotates among the panels not normal.
 */
export function Inspector() {
	const iso = selectedState.value;
	const picked = Boolean(iso || selectedEntity.value || pickedPoint.value);
	const pared = usePared();
	const situation = route.value === "wall" && moduleId.value === "situacion";
	const focus = pared.on && !picked ? wallFocus.value : null;
	return (
		<aside class="insp" aria-label={t("Inspector", "Inspector")}>
			<header class="insp__head">
				<h2 class="insp__title">{t("Inspector", "Inspector")}</h2>
				<span class="insp__sub">
					{picked
						? t("selección", "selection")
						: pared.on
							? pared.count
								? t(
										`rota entre ${pared.count} paneles fuera de lo normal`,
										`rotating ${pared.count} panels out of the ordinary`,
									)
								: t("todo normal: nada rota", "all normal: nothing rotates")
							: t("sin selección", "nothing selected")}
				</span>
				<button
					type="button"
					class="icon-btn"
					onClick={() => toggleInspector(false)}
					aria-label={t("Ocultar el inspector (I)", "Hide the inspector (I)")}
					title={t("Ocultar (I)", "Hide (I)")}
				>
					<svg class="ico" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
						<path d="M3.5 2 6.5 5 3.5 8" />
					</svg>
				</button>
			</header>
			<div class="insp__body">
				{picked ? (
					<SelectionInspector />
				) : (
					<>
						{situation ? (
							<p class="insp__hint">
								{t(
									"Elige un estado en el mapa, en el registro o con / para verlo aquí con cada fuente y su edad.",
									"Pick a state on the map, in the log or with / to see it here with every source and its age.",
								)}
							</p>
						) : (
							<Minimap />
						)}
						<PanelSlot id={focus ?? "incidentes"} />
						{focus ? null : <PanelSlot id="inusual" />}
					</>
				)}
			</div>
		</aside>
	);
}

/** The folded inspector: a thin tab on the right edge that brings it back. */
export function InspectorTab() {
	if (inspectorOpen.value) return null;
	return (
		<button
			type="button"
			class="insp-tab"
			onClick={() => toggleInspector(true)}
			aria-label={t("Mostrar el inspector (I)", "Show the inspector (I)")}
			title={t("Mostrar el inspector (I)", "Show the inspector (I)")}
		>
			<span>{t("Inspector", "Inspector")}</span>
		</button>
	);
}
