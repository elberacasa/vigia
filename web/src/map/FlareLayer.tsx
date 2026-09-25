import { healthById, now, panels } from "../lib/data.ts";
import { ago, int } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { link } from "../lib/router.ts";
import { type EnergyView, energyPoints } from "../panels/energy-view.ts";
import { project } from "./project.ts";
import { showFlares, toggleFlares } from "./view.ts";

/**
 * "Quemadores (gas)": one diamond per refinery or field the energy panel follows, at its centroid. Size is the
 * facility's mean radiative power per night over 7 nights (square root, relative to the brightest facility, from
 * energyPoints: the server computes every figure); colour is its status against its own history: amber above or
 * below the usual, hollow red when no flame was seen, grey without data. Static: nothing moves.
 */
const FEED = "firms-flares";

/** Side of the diamond in map units at full view (it keeps its screen size while zooming, like the quakes). */
export function flareSize(weight: number): number {
	return 11 + 10 * Math.max(0, Math.min(1, weight));
}

export function FlareLayer({ view }: { view: EnergyView | undefined }) {
	return (
		<g class="layer-flares">
			{energyPoints(view).map((f) => {
				const [x, y] = project(f.lon, f.lat);
				const s = flareSize(f.weight);
				return (
					<g
						key={f.id}
						class={`flare-mark flare-mark--${f.tone}`}
						style={{ transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(var(--zk, 1))` }}
					>
						<title>{f.label}</title>
						<rect x={-s / 2} y={-s / 2} width={s} height={s} class="flare" transform="rotate(45)" />
					</g>
				);
			})}
		</g>
	);
}

/**
 * Its row under "Encima", the same shape as the quake and heat-spot rows: how many facilities showed a flame in
 * the last 7 nights (of those followed) and the age of the newest night of data. Off by default.
 */
export function FlareRow() {
	const view = panels.value.energy as EnergyView | undefined;
	const l = lang.value;
	const h = healthById.value.get(FEED);
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
			{on ? (
				<p class="layer-row__note note">
					{t(
						"Cifra: con llama en las últimas 7 noches, de las instalaciones seguidas. Tamaño: potencia media por noche. Ámbar: fuera de lo habitual; hueco rojo: sin llama; gris: sin datos o sin línea base aún.",
						"Figure: lit in the last 7 nights, of the facilities followed. Size: mean power per night. Amber: unusual; hollow red: no flame; grey: no data or no baseline yet.",
					)}
				</p>
			) : null}
		</li>
	);
}
