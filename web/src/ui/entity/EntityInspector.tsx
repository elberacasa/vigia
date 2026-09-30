import { useEffect, useState } from "preact/hooks";
import { isoOfPlace, type LocateView, locate } from "../../lib/entity-api.ts";
import { entityPath } from "../../lib/entity-route.ts";
import { kindWord, TYPE_WORD } from "../../lib/entity-words.ts";
import { num } from "../../lib/format.ts";
import { lang, t } from "../../lib/i18n.ts";
import { STATE_SLUG, stateName } from "../../lib/states.ts";
import {
	clearEntity,
	highlightedMunicipality,
	pickedPoint,
	selectEntity,
	selectedEntity,
	selectedState,
	selectState,
} from "../../map/view.ts";
import { EntityProblem, EntitySkeleton, EntityView } from "./EntityView.tsx";
import { useEntity, useEntityModel } from "./useEntity.ts";

/**
 * The inspector's selection (the desk's right column; on a phone, the block after the map): the entity selected on
 * the map, in the palette or in a list, drawn from the server's linked view, and "what is here" for the point last
 * pressed on the map (/api/v1/locate: parish, municipality, state and facilities near it).
 */

/** The id the inspector shows: the finer selection, else the selected state's. */
export function inspectedId(): string | null {
	const e = selectedEntity.value;
	if (e) return e;
	const iso = selectedState.value;
	const slug = iso ? STATE_SLUG.get(iso) : undefined;
	return slug ? `ve.${slug}` : null;
}

export function EntityInspector({ id, onClose }: { id: string; onClose: () => void }) {
	const load = useEntity(id);
	const model = useEntityModel(id, load);
	// Linked selection, the other way: a municipality or parish shown here is outlined on the map.
	const muni = model?.map?.muni ?? null;
	useEffect(() => {
		if (muni && highlightedMunicipality.value !== muni) highlightedMunicipality.value = muni;
	}, [muni]);
	if (model)
		return (
			<EntityView
				key={model.ref.id}
				model={model}
				variant="inspector"
				onClose={onClose}
				offline={load.offline}
				pending={load.pending}
				serverError={load.serverError}
				savedAt={load.savedAt}
			/>
		);
	if (load.status === "loading") return <EntitySkeleton variant="inspector" label={labelFor(id)} />;
	return (
		<EntityProblem
			kind={load.status === "missing" ? "missing" : navigator.onLine ? "error" : "offline"}
			retry={load.retry}
		/>
	);
}

/** A readable placeholder while an id loads ("zulia › maracaibo"). */
function labelFor(id: string): string {
	const iso = isoOfPlace(id);
	if (iso && id.split(".").length === 2) return stateName(iso);
	return (id.split(".").at(-1) ?? id).replace(/-/g, " ");
}

/** What is at the pressed point: chips for its parish, municipality and state, and the facilities near it. */
export function LocateChips() {
	const p = pickedPoint.value;
	const l = lang.value;
	const [view, setView] = useState<LocateView | null>(null);
	const [status, setStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");
	useEffect(() => {
		if (!p) {
			setView(null);
			setStatus("idle");
			return;
		}
		const ctrl = new AbortController();
		setStatus("loading");
		locate(p.lat, p.lon, ctrl.signal)
			.then((v) => {
				setView(v);
				setStatus(v ? "ok" : "error");
			})
			.catch((err: Error) => {
				if (err.name !== "AbortError") setStatus("error");
			});
		return () => ctrl.abort();
	}, [p?.lat, p?.lon]);
	if (!p) return null;
	const places = (view?.places ?? []).filter((x) => x.type !== "country");
	const current = selectedEntity.value;
	return (
		<section class="locate" aria-label={t("Lo que hay en el punto", "What is at the point")}>
			<header class="locate__head">
				<span class="insp__label">{t("En el punto", "At the point")}</span>
				<span class="mono locate__coord">
					{num(p.lat, 3, l)}, {num(p.lon, 3, l)}
				</span>
				<button
					type="button"
					class="icon-btn"
					onClick={() => {
						pickedPoint.value = null;
					}}
					aria-label={t("Olvidar el punto", "Forget the point")}
					title={t("Olvidar el punto", "Forget the point")}
				>
					<svg class="ico" viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">
						<path d="M2 2l6 6M8 2 2 8" />
					</svg>
				</button>
			</header>
			{status === "loading" && !view ? (
				<p class="locate__note">
					{t("Preguntando al servidor qué hay aquí…", "Asking the server what is here…")}
				</p>
			) : status === "error" ? (
				<p class="locate__note">{t("No se pudo ubicar el punto.", "Could not place the point.")}</p>
			) : view && !places.length ? (
				<p class="locate__note">
					{t("Fuera de los límites de Venezuela (COD-AB).", "Outside Venezuela's boundaries (COD-AB).")}
				</p>
			) : (
				<>
					{/* biome-ignore lint/a11y/useSemanticElements: a row of toggle buttons. */}
					<div class="locate__chips" role="group" aria-label={t("Lugares", "Places")}>
						{places.map((x) => {
							const iso = isoOfPlace(x.id);
							const on = x.type === "state" ? !current && selectedState.value === iso : current === x.id;
							return (
								<button
									key={x.id}
									type="button"
									class="loc-chip"
									aria-pressed={on}
									onClick={() => {
										if (x.type === "state") selectState(iso);
										else selectEntity(x.id, iso);
									}}
								>
									<span class="loc-chip__type">{TYPE_WORD[x.type]?.[l] ?? x.type}</span>
									<span class="loc-chip__name">{x.name[l]}</span>
								</button>
							);
						})}
					</div>
					{view?.how === "lake" ? (
						<p class="locate__note">
							{t(
								"El punto cae en el Lago de Maracaibo: se asignó al municipio más cercano.",
								"The point is on Lake Maracaibo: assigned to the nearest municipality.",
							)}
						</p>
					) : null}
					{view?.near.length ? (
						<ul class="locate__near">
							{view.near.slice(0, 4).map((n) => (
								<li key={n.entity.id}>
									<button
										type="button"
										class="link-button"
										disabled={!entityPath(n.entity.id)}
										onClick={() => selectEntity(n.entity.id, isoOfPlace(places[0]?.id ?? ""))}
									>
										{n.entity.name[l]}
									</button>
									<span class="locate__kind">{kindWord(n.entity.type, n.entity.kind, l)}</span>
									<span class="mono">{num(n.km, 1, l)} km</span>
								</li>
							))}
						</ul>
					) : view ? (
						<p class="locate__note">
							{t(
								`Ninguna instalación a menos de ${view.radiusKm} km.`,
								`No facility within ${view.radiusKm} km.`,
							)}
						</p>
					) : null}
				</>
			)}
		</section>
	);
}

/** The selection as the inspector (desk) and the phone's block after the map show it. */
export function SelectionInspector() {
	const id = inspectedId();
	return (
		<>
			<LocateChips />
			{id ? (
				<EntityInspector
					key={id}
					id={id}
					onClose={() => {
						if (selectedEntity.value) clearEntity();
						else selectState(null);
					}}
				/>
			) : null}
		</>
	);
}
