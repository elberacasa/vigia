import { useState } from "preact/hooks";
import { addStyles } from "../lib/css.ts";
import { panels } from "../lib/data.ts";
import { num } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { PANEL_META } from "../lib/panel-meta.ts";
import energyCss from "../styles/energy.css?inline";
import panelsCss from "../styles/panels.css?inline";
import { Panel } from "../ui/Panel.tsx";
import { SourceTag } from "../ui/Source.tsx";
import { type EnergyView, type FacilityRow, STATUS } from "./energy-view.ts";

addStyles(panelsCss);

addStyles(energyCss);

export type { EnergyView, FacilityRow };

const isPlant = (f: FacilityRow) => f.kind === "refinery" || f.kind === "complex";

/** 30 night cells: brightness is the night's radiative power relative to this facility's own brightest night. */
function NightStrip({ f }: { f: FacilityRow }) {
	const l = lang.value;
	const max = Math.max(0, ...f.nights30.map((n) => n.frpMW ?? 0));
	const withData = f.nights30.filter((n) => n.frpMW !== null);
	const lit = withData.filter((n) => (n.frpMW ?? 0) > 0).length;
	return (
		<span
			class="nights"
			role="img"
			aria-label={t(
				`${lit} de ${withData.length} noches con llama en los últimos 30 días con datos`,
				`${lit} of ${withData.length} nights with a flame in the last 30 days with data`,
			)}
		>
			{f.nights30.map((n) => {
				const title =
					n.frpMW === null
						? `${n.date}: ${t("sin datos", "no data")}`
						: `${n.date}: ${num(n.frpMW, 1, l)} MW`;
				if (n.frpMW === null) return <i key={n.date} class="nights__cell nights__cell--none" title={title} />;
				const level = max > 0 ? Math.sqrt(n.frpMW / max) : 0;
				return (
					<i
						key={n.date}
						class={`nights__cell${n.frpMW > 0 ? " nights__cell--lit" : ""}`}
						style={n.frpMW > 0 ? { opacity: (0.25 + 0.75 * level).toFixed(2) } : undefined}
						title={title}
					/>
				);
			})}
		</span>
	);
}

function FacilityItem({ f }: { f: FacilityRow }) {
	const l = lang.value;
	const s = STATUS[f.status];
	const mean = f.d7.meanNightFrpMW;
	return (
		<li class="facility">
			<div class="facility__head">
				<a class="facility__name" href={f.url} target="_blank" rel="noopener noreferrer">
					{l === "es" ? f.nameEs : f.nameEn}
				</a>
				{/* Before a baseline exists the headline says so once; rows stay quiet. */}
				<span class={`facility__status facility__status--${s.tone}`}>
					{f.status === "no-baseline" ? "" : s[l]}
					{f.ratio !== null && (f.status === "up" || f.status === "down" || f.status === "usual")
						? ` · ×${num(f.ratio, 1, l)}`
						: ""}
				</span>
			</div>
			<div class="facility__row">
				<NightStrip f={f} />
				<span
					class="facility__value data"
					title={t(
						"Potencia radiativa media por noche con datos, últimas 7 noches",
						"Mean radiative power per night with data, last 7 nights",
					)}
				>
					{mean === null ? "—" : num(mean, 1, l)}
					<span class="figure__unit">MW</span>
				</span>
			</div>
			<p class="facility__meta">
				{f.stateName ? `${f.stateName} · ` : ""}
				{t(
					`llama ${f.d7.activeNights} de ${f.d7.nightsWithData} noches`,
					`flame ${f.d7.activeNights} of ${f.d7.nightsWithData} nights`,
				)}
				{f.ggfr2025MillionM3 !== null && f.ggfr2025MillionM3 > 0
					? t(
							` · Banco Mundial: ${num(f.ggfr2025MillionM3, 0, l)} M m³ quemados en 2025`,
							` · World Bank: ${num(f.ggfr2025MillionM3, 0, l)} M m³ flared in 2025`,
						)
					: ""}
			</p>
			{f.noteEs ? <p class="facility__note">{f.noteEs}</p> : null}
		</li>
	);
}

export function EnergyPanel() {
	const view = panels.value.energy as EnergyView | undefined;
	const [all, setAll] = useState(false);
	const l = lang.value;
	const plants = view?.facilities.filter(isPlant) ?? [];
	const fields = view?.facilities.filter((f) => !isPlant(f)) ?? [];
	const shownFields = all ? fields : fields.slice(0, 5);
	const ve = view?.venezuela;
	return (
		<Panel
			id="energia"
			title={PANEL_META.energia.title()}
			question={PANEL_META.energia.question()}
			feeds={PANEL_META.energia.feeds()}
			method={
				view ? (
					<>
						<p>{l === "es" ? view.rules.es : view.rules.en}</p>
						<p>{l === "es" ? view.caveatEs : view.caveatEn}</p>
						<p>{view.facilityRule}</p>
						<p>
							{t(
								"Cada celda es una noche (UTC) de los últimos 30 días: más brillante, más potencia esa noche respecto a la noche más intensa de la instalación; con rayas, noche sin datos de FIRMS.",
								"Each cell is one night (UTC) of the last 30 days: brighter means more power that night relative to the facility's brightest night; hatched, a night without FIRMS data.",
							)}
						</p>
						<p>
							{t("Instalaciones: ", "Facilities: ")}
							{view.facilitySources.map((s, i) => (
								<span key={s.url}>
									{i ? " · " : ""}
									<a href={s.url} target="_blank" rel="noopener noreferrer">
										{s.label}
									</a>
								</span>
							))}
						</p>
					</>
				) : null
			}
		>
			{!view || !ve ? null : (
				<div class="energy">
					<div class="stat-row">
						<div class="figure">
							<span class="figure__label">{t("Llama media, 7 noches", "Mean flame, 7 nights")}</span>
							<span class="figure__value">
								{ve.d7.meanNightFrpMW === null ? "—" : num(ve.d7.meanNightFrpMW, 0, l)}
								<span class="figure__unit">MW</span>
							</span>
							<span class="note">{t("todas las instalaciones", "all facilities")}</span>
						</div>
						<div class="figure">
							<span class="figure__label">{t("Con llama", "Lit")}</span>
							<span class="figure__value">
								{view.lit7}
								<span class="figure__unit">
									{t(`de ${view.facilities.length}`, `of ${view.facilities.length}`)}
								</span>
							</span>
							<span class="note">{t("en las últimas 7 noches", "in the last 7 nights")}</span>
						</div>
						<div class="figure">
							<span class="figure__label">{t("Frente a lo habitual", "Against usual")}</span>
							<span
								class={`figure__value figure__value--${STATUS[ve.status].tone === "muted" ? "muted" : "plain"}`}
							>
								{ve.ratio !== null ? `×${num(ve.ratio, 1, l)}` : "—"}
							</span>
							<span class="note">
								{ve.status === "no-baseline"
									? t(
											`línea base: ${view.nightsWithData90} de ${view.rules.minBaselineNights + 7} noches`,
											`baseline: ${view.nightsWithData90} of ${view.rules.minBaselineNights + 7} nights`,
										)
									: STATUS[ve.status][l]}
							</span>
						</div>
					</div>
					<h3 class="energy__h caps">{t("Refinerías y mejoradores", "Refineries and upgraders")}</h3>
					<ul class="facilities">
						{plants.map((f) => (
							<FacilityItem key={f.id} f={f} />
						))}
					</ul>
					<h3 class="energy__h caps">{t("Campos: quema de gas", "Fields: gas flaring")}</h3>
					<ul class="facilities">
						{shownFields.map((f) => (
							<FacilityItem key={f.id} f={f} />
						))}
					</ul>
					{fields.length > 5 ? (
						<button type="button" class="link-button" onClick={() => setAll(!all)}>
							{all
								? t("Ver menos", "Show fewer")
								: t(`Ver los ${fields.length} campos`, `Show all ${fields.length} fields`)}
						</button>
					) : null}
					<p class="note">{l === "es" ? view.caveatEs : view.caveatEn}</p>
					{view.newestDetectionAt ? (
						<div class="sources-row">
							<SourceTag
								source={{
									feed: "firms-flares",
									observedAt: view.newestDetectionAt,
									url: view.sourceUrl,
									detail: t(
										`VIIRS (NOAA-20), detecciones nocturnas; noches ${view.firstNight ?? "—"} a ${view.latestNight ?? "—"} (UTC).`,
										`VIIRS (NOAA-20), night detections; nights ${view.firstNight ?? "—"} to ${view.latestNight ?? "—"} (UTC).`,
									),
								}}
								label="NASA FIRMS"
							/>
							{view.latestNight ? (
								<span class="note data">
									{t("última noche", "latest night")} {view.latestNight}
								</span>
							) : null}
						</div>
					) : null}
				</div>
			)}
		</Panel>
	);
}
