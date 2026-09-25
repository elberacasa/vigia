import { useState } from "preact/hooks";
import { addStyles } from "../lib/css.ts";
import { now, panels } from "../lib/data.ts";
import { ago, int, num, stamp } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { PANEL_META } from "../lib/panel-meta.ts";
import panelsCss from "../styles/panels.css?inline";
import { Panel } from "../ui/Panel.tsx";
import { SourceTag } from "../ui/Source.tsx";

addStyles(panelsCss);

/* ------------------------------------------------------------------ Weather */

interface CapitalWeather {
	stateIso: string;
	stateName: string;
	capital: string;
	observedAt: number;
	temperatureC: number;
	apparentC: number;
	precipitationMmH: number;
	weatherCode: number;
	labelEs: string;
	gustsKmh: number;
	isDay: boolean;
	next24h: { minTempC: number | null; maxTempC: number | null; totalPrecipMm: number; stormHours: number };
}
interface WeatherNotable {
	rule: "storm" | "heavyRain" | "gale" | "heat";
	stateIso: string;
	stateName: string;
	capital: string;
	when: "now" | "next24h";
	firstAt: number;
	hours: number;
	peak: number;
	unit: "mm/h" | "km/h" | "°C" | "wmo";
	labelEs: string;
}
export interface WeatherView {
	capitals: CapitalWeather[];
	notable: WeatherNotable[];
	rules: { id: string; sourceEs: string }[];
	noteEs: string;
	feed: string;
	sourceUrl: string;
	newestObservedAt: number | null;
}

const RULE_LABEL: Record<WeatherNotable["rule"], { es: string; en: string; icon: string }> = {
	storm: { es: "Tormenta", en: "Thunderstorm", icon: "⚡" },
	heavyRain: { es: "Lluvia fuerte", en: "Heavy rain", icon: "☂" },
	gale: { es: "Ráfagas fuertes", en: "Strong gusts", icon: "≋" },
	heat: { es: "Calor peligroso", en: "Dangerous heat", icon: "☀" },
};

/** Most affected first: storm hours, then rain, then heat. */
function affected(c: CapitalWeather): number {
	return (
		c.next24h.stormHours * 100 + c.next24h.totalPrecipMm * 2 + Math.max(0, (c.next24h.maxTempC ?? 0) - 33)
	);
}

export function WeatherPanel() {
	const view = panels.value.weather as WeatherView | undefined;
	const [all, setAll] = useState(false);
	const l = lang.value;
	return (
		<Panel
			id="clima"
			title={PANEL_META.clima.title()}
			question={PANEL_META.clima.question()}
			feeds={PANEL_META.clima.feeds()}
			foot={view ? <span>{view.noteEs}</span> : null}
		>
			{!view ? (
				<p class="skeleton">…</p>
			) : (
				<>
					{view.notable.length ? (
						<ul class="notables">
							{(Object.keys(RULE_LABEL) as WeatherNotable["rule"][]).map((rule) => {
								const hits = view.notable.filter((n) => n.rule === rule);
								if (!hits.length) return null;
								const nowCount = hits.filter((n) => n.when === "now").length;
								const first = Math.min(...hits.map((n) => n.firstAt));
								return (
									<li key={rule} class={`notable notable--${rule}`}>
										<span class="notable__icon" aria-hidden="true">
											{RULE_LABEL[rule].icon}
										</span>
										<span>
											<strong>{RULE_LABEL[rule][l]}</strong>{" "}
											<span class="note">
												{nowCount
													? t(`ahora en ${nowCount}`, `now in ${nowCount}`)
													: `${t("pronóstico desde", "forecast from")} ${stamp(first, l)}`}{" "}
												· {hits.length}{" "}
												{hits.length === 1 ? t("capital", "capital") : t("capitales", "capitals")}
											</span>
											<span class="notable__places">
												{hits
													.map((n) =>
														n.unit === "wmo"
															? n.capital
															: `${n.capital} ${num(n.peak, n.unit === "mm/h" ? 1 : 0, l)} ${n.unit}`,
													)
													.join(" · ")}
											</span>
										</span>
									</li>
								);
							})}
						</ul>
					) : (
						<p class="note">
							{t(
								"Nada notable en las próximas 24 h según el modelo.",
								"Nothing notable in the next 24 h per the model.",
							)}
						</p>
					)}
					<ul class="capitals">
						{[...view.capitals]
							.sort((a, b) => affected(b) - affected(a))
							.slice(0, all ? 25 : 6)
							.map((c) => (
								<li key={c.stateIso} title={`${c.stateName}: ${c.labelEs}`}>
									<span class="capitals__name">{c.capital}</span>
									<span class="capitals__temp data">{num(c.temperatureC, 0, l)}°</span>
									<span class="capitals__label">
										{c.next24h.stormHours
											? t(`tormenta ${c.next24h.stormHours} h`, `storm ${c.next24h.stormHours} h`)
											: c.labelEs}
									</span>
								</li>
							))}
					</ul>
					<button type="button" class="link-button" onClick={() => setAll(!all)}>
						{all ? t("Ver menos", "Show fewer") : t("Ver las 24 capitales", "Show all 24 capitals")}
					</button>
					{view.newestObservedAt ? (
						<SourceTag
							source={{
								feed: view.feed,
								observedAt: view.newestObservedAt,
								url: view.sourceUrl,
								detail: t("Modelo meteorológico (no son estaciones).", "Weather model (not stations)."),
							}}
							label="Open-Meteo"
						/>
					) : null}
				</>
			)}
		</Panel>
	);
}

/* ------------------------------------------------------------------ Fires */

interface FireCounts {
	last24h: number;
	last48h: number;
	persistent24h: number;
	lowConfidence24h: number;
}
interface FireStateRow extends FireCounts {
	stateIso: string;
	stateName: string;
	likelyFires24h: number;
}
interface FirePoint {
	at: number;
	lat: number;
	lon: number;
	stateIso: string | null;
	placeEs: string;
	frpMW: number;
	url: string;
}
export interface FiresView {
	venezuela: FireCounts;
	byState: FireStateRow[];
	topStates: FireStateRow[];
	strongest: FirePoint[];
	file: { product: string; spanHours: number; noteEs: string } | null;
	persistent: { count: number; noteEs: string };
	newestDetectionAt: number | null;
	feed: string;
	sourceUrl: string;
	attribution: string;
}

export function FiresPanel() {
	const view = panels.value.fires as FiresView | undefined;
	const l = lang.value;
	const v = view?.venezuela;
	return (
		<Panel
			id="incendios"
			title={PANEL_META.incendios.title()}
			question={PANEL_META.incendios.question()}
			feeds={PANEL_META.incendios.feeds()}
			foot={
				view ? (
					<>
						<span>{view.attribution}</span>
						<span>{view.persistent.noteEs}</span>
					</>
				) : null
			}
		>
			{!view || !v ? (
				<p class="skeleton">…</p>
			) : (
				<>
					<div class="stat-row">
						<div class="figure">
							<span class="figure__label">{t("Probables incendios, 24 h", "Likely fires, 24 h")}</span>
							<span class="figure__value">{int(v.last24h - v.persistent24h, l)}</span>
						</div>
						<div class="figure">
							<span class="figure__label">{t("Fuentes persistentes", "Persistent sources")}</span>
							<span class="figure__value figure__value--muted">{int(v.persistent24h, l)}</span>
							<span class="note">{t("mecheros, industria", "flares, industry")}</span>
						</div>
						<div class="figure">
							<span class="figure__label">{t("Todas, 48 h", "All, 48 h")}</span>
							<span class="figure__value figure__value--muted">{int(v.last48h, l)}</span>
							<span class="note">{t("incluye persistentes", "incl. persistent")}</span>
						</div>
					</div>
					<ul class="bars">
						{view.topStates.map((s) => {
							const max = view.topStates[0]?.likelyFires24h || 1;
							return (
								<li key={s.stateIso}>
									<span class="bars__label">{s.stateName}</span>
									<span class="bars__track">
										<span class="bars__fill" style={{ width: `${(s.likelyFires24h / max) * 100}%` }} />
									</span>
									<span class="bars__value data">{int(s.likelyFires24h, l)}</span>
								</li>
							);
						})}
					</ul>
					{view.file ? <p class="note">{view.file.noteEs}</p> : null}
					{view.newestDetectionAt ? (
						<SourceTag
							source={{
								feed: view.feed,
								observedAt: view.newestDetectionAt,
								url: view.sourceUrl,
								detail: t(
									"Detecciones térmicas VIIRS (NOAA-20). Una detección no confirma un incendio.",
									"VIIRS (NOAA-20) thermal detections. A detection does not confirm a fire.",
								),
							}}
							label="NASA FIRMS"
						/>
					) : null}
				</>
			)}
		</Panel>
	);
}

/* ------------------------------------------------------------------ Hazards */

interface HazardEvent {
	id: string;
	typeEs: string;
	name: string;
	alertLevel: "green" | "orange" | "red";
	fromAt: number;
	modifiedAt: number;
	stateName: string | null;
	countries?: string[];
	url: string;
}

/** GDACS titles are English only ("Drought in Brazil, …"); in Spanish the row is built from its type and countries. */
const COUNTRY_ES: Record<string, string> = {
	VEN: "Venezuela",
	COL: "Colombia",
	BRA: "Brasil",
	GUY: "Guyana",
	SUR: "Surinam",
	PAN: "Panamá",
	CRI: "Costa Rica",
	TTO: "Trinidad y Tobago",
	ABW: "Aruba",
	CUW: "Curazao",
	ECU: "Ecuador",
	PER: "Perú",
	BOL: "Bolivia",
	NIC: "Nicaragua",
	HND: "Honduras",
	DOM: "República Dominicana",
	HTI: "Haití",
	JAM: "Jamaica",
	CUB: "Cuba",
	PRI: "Puerto Rico",
	GRD: "Granada",
	BRB: "Barbados",
	MEX: "México",
	USA: "Estados Unidos",
};

export function hazardTitle(
	e: Pick<HazardEvent, "typeEs" | "name" | "countries" | "stateName">,
	es: boolean,
): string {
	if (!es) return e.name;
	const names = (e.countries ?? []).map((c) => COUNTRY_ES[c] ?? c);
	const ve = names.indexOf("Venezuela");
	if (ve > 0) names.unshift(...names.splice(ve, 1));
	const where =
		names.length > 3 ? `${names.slice(0, 3).join(", ")} y ${names.length - 3} más` : names.join(", ");
	const state = e.stateName ? ` (${e.stateName})` : "";
	return where ? `${e.typeEs} en ${where}${state}` : e.typeEs;
}

interface HazardStorm {
	id: string;
	name: string;
	classificationEs: string;
	windKmh: number;
	distanceKm: number;
	directionFromVenezuelaEs: string;
	threat: boolean;
	reasonEs: string;
	advisoryAt: number;
	url: string;
}
export interface HazardsView {
	gdacs: {
		events: HazardEvent[];
		counts: { red: number; orange: number; green: number };
		checkedAt: number | null;
		noteEs: string;
	};
	storms: {
		active: HazardStorm[];
		threats: number;
		checkedAt: number | null;
		statusEs: string;
		rule: { noteEs: string };
	};
}

export function HazardsPanel() {
	const view = panels.value.hazards as HazardsView | undefined;
	const l = lang.value;
	return (
		<Panel
			id="alertas"
			title={PANEL_META.alertas.title()}
			question={PANEL_META.alertas.question()}
			feeds={PANEL_META.alertas.feeds()}
		>
			{!view ? (
				<p class="skeleton">…</p>
			) : (
				<>
					<p class={`hazard-status${view.storms.threats ? " is-threat" : ""}`}>{view.storms.statusEs}</p>
					{view.storms.active.length ? (
						<ul class="state-block__list">
							{view.storms.active.map((s) => (
								<li key={s.id}>
									<a href={s.url} target="_blank" rel="noopener noreferrer">
										<strong>{s.name}</strong> · {s.classificationEs} · {int(s.windKmh, l)} km/h
									</a>
									<span class="note">
										{" "}
										· {int(s.distanceKm, l)} km {s.directionFromVenezuelaEs} · {s.reasonEs}
									</span>
								</li>
							))}
						</ul>
					) : null}
					<p class="note">{view.storms.rule.noteEs}</p>
					{view.gdacs.events.length ? (
						<ul class="state-block__list">
							{view.gdacs.events.slice(0, 5).map((e) => (
								<li key={e.id}>
									<span class={`alert-level alert-level--${e.alertLevel}`} />
									<a href={e.url} target="_blank" rel="noopener noreferrer" title={`GDACS: ${e.name}`}>
										{hazardTitle(e, l === "es")}
									</a>
									<span class="note data"> {ago(now.value - e.modifiedAt, l)}</span>
								</li>
							))}
						</ul>
					) : null}
					<div class="sources-row">
						{view.storms.checkedAt ? (
							<SourceTag
								source={{ feed: "nhc-storms", observedAt: view.storms.checkedAt }}
								label="NOAA NHC"
							/>
						) : null}
						{view.gdacs.checkedAt ? (
							<SourceTag source={{ feed: "gdacs-events", observedAt: view.gdacs.checkedAt }} label="GDACS" />
						) : null}
					</div>
				</>
			)}
		</Panel>
	);
}
