import { addStyles } from "../lib/css.ts";
import { now, panels } from "../lib/data.ts";
import { ago, num } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { stateName } from "../lib/states.ts";
import { TOPICS, type Topic } from "../lib/topics.ts";
import { levelLabel } from "../map/fills.ts";
import { selectedState } from "../map/view.ts";
import panelsCss from "../styles/panels.css?inline";
import type { ConnectivityView } from "./Connectivity.tsx";
import type { FiresView, WeatherView } from "./Earth.tsx";
import type { NewsView, Story } from "./News.tsx";
import type { QuakesView } from "./Quakes.tsx";

addStyles(panelsCss);

/**
 * Everything Vigía knows about one state, from every layer, each line with its own source. Shown when a state is
 * selected on the map. Layers add their section as they come online.
 */
export function StatePanel() {
	const iso = selectedState.value;
	if (!iso) return null;
	const l = lang.value;
	const news = panels.value.news as NewsView | undefined;
	const quakes = (panels.value.quakes as QuakesView | undefined)?.items ?? [];
	const conn = (panels.value.connectivity as ConnectivityView | undefined)?.states.find((p) => p.id === iso);
	const weather = (panels.value.weather as WeatherView | undefined)?.capitals.find((c) => c.stateIso === iso);
	const fires = (panels.value.fires as FiresView | undefined)?.byState.find((f) => f.stateIso === iso);
	const stateNews = news?.byState[iso];
	const stories = (stateNews?.top ?? [])
		.map((id) => news?.stories[id])
		.filter((s): s is Story => s !== undefined)
		.slice(0, 5);
	const localQuakes = quakes.filter((q) => q.state === iso).slice(0, 3);
	const topics = stateNews
		? (Object.entries(stateNews.topics) as [Topic, number][]).sort((a, b) => b[1] - a[1]).slice(0, 5)
		: [];
	return (
		<section class="panel state-panel" aria-labelledby="state-title">
			<header class="panel__head">
				<h2 class="panel__title" id="state-title">
					{stateName(iso)}
					<span class="panel__question">{t("ahora", "now")}</span>
				</h2>
				<button type="button" class="sheet__close" onClick={() => (selectedState.value = null)}>
					<span aria-hidden="true">✕</span>
					<span class="sr-only">{t("Cerrar", "Close")}</span>
				</button>
			</header>
			<div class="panel__body state-panel__body">
				{conn ? (
					<div class="state-block">
						<h3 class="caps state-block__title">{t("Internet (IODA)", "Internet (IODA)")}</h3>
						<p class={`state-block__figure level-text--${conn.level}`}>
							<span class={`level-dot level-dot--${conn.level}`} aria-hidden="true" />{" "}
							{levelLabel(conn.level)}
						</p>
						<p class="note">{conn.headline}</p>
					</div>
				) : null}
				{weather ? (
					<div class="state-block">
						<h3 class="caps state-block__title">
							{t("Clima en", "Weather in")} {weather.capital}
						</h3>
						<p class="state-block__figure">
							<span class="data">{num(weather.temperatureC, 0, l)}°</span> {weather.labelEs}
						</p>
						<p class="note">
							{t("Próximas 24 h", "Next 24 h")}: {num(weather.next24h.totalPrecipMm, 1, l)} mm
							{weather.next24h.stormHours
								? ` · ${weather.next24h.stormHours} h ${t("con tormenta", "of storms")}`
								: ""}{" "}
							· {t("modelo Open-Meteo", "Open-Meteo model")}
						</p>
					</div>
				) : null}
				{fires && fires.last24h > 0 ? (
					<div class="state-block">
						<h3 class="caps state-block__title">{t("Focos de calor, 24 h", "Heat spots, 24 h")}</h3>
						<p class="state-block__figure">
							<span class="data">{fires.likelyFires24h}</span> {t("probables incendios", "likely fires")}
							{fires.persistent24h ? (
								<span class="note">
									{" "}
									· {fires.persistent24h} {t("en fuentes persistentes", "at persistent sources")}
								</span>
							) : null}
						</p>
					</div>
				) : null}
				<div class="state-block">
					<h3 class="caps state-block__title">{t("Noticias, 24 h", "News, 24 h")}</h3>
					{stateNews ? (
						<>
							<p class="state-block__figure">
								<span class="data">{stateNews.items}</span> {t("titulares", "headlines")} ·{" "}
								<span class="data">{stateNews.stories}</span> {t("historias", "stories")}
							</p>
							<p class="note">{topics.map(([k, n]) => `${TOPICS[k][l]} ${n}`).join(" · ")}</p>
							<ul class="state-block__list">
								{stories.map((s) => (
									<li key={s.id}>
										<a href={s.url} target="_blank" rel="noopener noreferrer">
											{s.title}
										</a>
										<span class="note data">
											{" "}
											{ago(now.value - s.at, l)} · {s.outletCount} {t("medios", "outlets")}
										</span>
									</li>
								))}
							</ul>
						</>
					) : (
						<p class="note">
							{t("Ningún titular ubicado aquí en 24 h.", "No headline located here in 24 h.")}
						</p>
					)}
					<p class="note">{t("Ubicación por palabra clave.", "Location by keyword.")}</p>
				</div>
				<div class="state-block">
					<h3 class="caps state-block__title">{t("Sismos, 30 días", "Earthquakes, 30 days")}</h3>
					{localQuakes.length ? (
						<ul class="state-block__list">
							{localQuakes.map((q) => (
								<li key={q.id}>
									<a href={(q.usgs ?? q.funvisis)?.url} target="_blank" rel="noopener noreferrer">
										M{num(q.maxMag, 1, l)} · {q.placeEs}
									</a>
									<span class="note data"> {ago(now.value - q.at, l)}</span>
								</li>
							))}
						</ul>
					) : (
						<p class="note">
							{t(
								"Ninguno registrado por USGS con epicentro aquí.",
								"None recorded by USGS with an epicentre here.",
							)}
						</p>
					)}
				</div>
			</div>
		</section>
	);
}
