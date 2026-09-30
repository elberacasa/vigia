import { useEffect, useState } from "preact/hooks";
import { addStyles } from "../lib/css.ts";
import { now, panels, wantPanel } from "../lib/data.ts";
import { clock, int, stamp } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { PANEL_META } from "../lib/panel-meta.ts";
import { stateName } from "../lib/states.ts";
import { registerSummary } from "../lib/summary.ts";
import { FRAME, STATES } from "../map/geometry.gen.ts";
import { selectedState, selectState } from "../map/view.ts";
import newsxCss from "../styles/newsx.css?inline";
import { Panel } from "../ui/Panel.tsx";
import { SourceTag } from "../ui/Source.tsx";

addStyles(newsxCss);

/* Mirrors src/panels/gdelt.ts (the server sums the batches; the browser only formats). */

type Label = { es: string; en: string };
interface GdeltItem {
	url: string;
	domain: string;
	at: number;
	stream: "en" | "tr";
	state: string | null;
	placedBy: "point" | "adm1" | "country" | "none";
	place: string;
	roots: string[];
	quads: number[];
	events: number;
	tone: number | null;
}
export interface GdeltView {
	from: number;
	to: number;
	events: number;
	national: number;
	droppedHomonym: number;
	byState: Record<string, { events: number; protestArticles: number; materialConflictArticles: number }>;
	byRoot: Record<string, number>;
	byQuad: Record<string, number>;
	/** `batches`: 15-minute batches read in that hour (0: not read; absent in an older server's view). */
	hourly: { at: number; events: number; batches?: number }[];
	batches: { received: number; missing: number; expected: number; newestAt: number | null };
	latest: GdeltItem[];
	topDomains: { domain: string; articles: number }[];
	articles24h: number;
	roots: Record<string, Label>;
	quads: Record<string, Label>;
	methodEs: string;
	methodEn: string;
}

const PLACED: Record<GdeltItem["placedBy"], Label> = {
	point: { es: "punto de GDELT", en: "GDELT's point" },
	adm1: { es: "estado según GDELT", en: "state per GDELT" },
	country: { es: "solo el país", en: "country only" },
	none: { es: "sin lugar", en: "no place" },
};

/** Events per state as a flat choropleth: the accent, graded by the square root of the share of the busiest state. */
function StateMap({ view }: { view: GdeltView }) {
	const sel = selectedState.value;
	const max = Math.max(1, ...Object.values(view.byState).map((s) => s.events));
	return (
		<svg
			class="gd-map"
			viewBox={`0 0 ${FRAME.width} ${FRAME.height}`}
			role="img"
			aria-label={t(
				"Mapa de eventos por estado; la lista al lado dice las mismas cifras.",
				"Map of events by state; the list beside it gives the same figures.",
			)}
		>
			{STATES.map((s) => {
				const n = view.byState[s.iso]?.events ?? 0;
				return (
					// biome-ignore lint/a11y/noStaticElementInteractions: a pointer shortcut; the table beside the map is the keyboard route to the same selection.
					<path
						key={s.iso}
						d={s.d}
						class={`gd-map__state${n ? " has-data" : ""}${sel === s.iso ? " is-sel" : ""}`}
						style={n ? { fillOpacity: String(0.18 + 0.72 * Math.sqrt(n / max)) } : undefined}
						onClick={() => selectState(sel === s.iso ? null : s.iso)}
					>
						<title>{`${s.name}: ${n}`}</title>
					</path>
				);
			})}
		</svg>
	);
}

/**
 * Events per hour, 48 bars. An hour Vigía read nothing of is drawn as a dotted gap, never as a zero bar; a partly
 * read hour is drawn hollow.
 */
function HourBars({ hours }: { hours: GdeltView["hourly"] }) {
	const l = lang.value;
	const w = 480;
	const h = 56;
	const bw = w / Math.max(1, hours.length);
	const read = hours.filter((x) => x.batches === undefined || x.batches > 0);
	const max = Math.max(1, ...read.map((x) => x.events));
	const peak = read.reduce<GdeltView["hourly"][number] | null>(
		(m, x) => (!m || x.events > m.events ? x : m),
		null,
	);
	const unread = hours.length - read.length;
	return (
		<figure class="gd-hours">
			<svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
				{hours.map((x, i) => {
					const known = x.batches === undefined || x.batches > 0;
					if (!known)
						return (
							<rect key={x.at} class="gd-hours__gap" x={i * bw + 1} y={h - 2} width={bw - 2} height={2} />
						);
					const bh = Math.max(1, (x.events / max) * (h - 4));
					return (
						<rect
							key={x.at}
							class={`gd-hours__bar${x.batches !== undefined && x.batches < 8 ? " is-partial" : ""}`}
							x={i * bw + 1}
							y={h - bh}
							width={bw - 2}
							height={bh}
						/>
					);
				})}
			</svg>
			<figcaption class="gd-axis">
				<span>{t("hace 48 h", "48 h ago")}</span>
				<span>
					{peak?.events
						? t(`máx. ${peak.events} · ${clock(peak.at, l)}`, `peak ${peak.events} · ${clock(peak.at, l)}`)
						: ""}
					{unread ? t(` · ${unread} h sin leer (raya gris)`, ` · ${unread} h not read (grey dash)`) : ""}
				</span>
				<span>{t("ahora", "now")}</span>
			</figcaption>
			<p class="sr-only">
				{t(
					`Eventos por hora en 48 h${peak?.events ? `; el máximo, ${peak.events}, a las ${clock(peak.at, l)}` : ""}; ${unread} horas sin leer.`,
					`Events per hour over 48 h${peak?.events ? `; the peak, ${peak.events}, at ${clock(peak.at, l)}` : ""}; ${unread} hours not read.`,
				)}
			</p>
		</figure>
	);
}

function Kinds({ view }: { view: GdeltView }) {
	const l = lang.value;
	const rows = Object.entries(view.byRoot)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 8);
	const max = Math.max(1, ...rows.map(([, n]) => n));
	if (!rows.length) return null;
	return (
		<section class="gd-block" aria-labelledby="gd-kinds">
			<h3 class="gd-h" id="gd-kinds">
				{t("Tipo de evento (CAMEO)", "Event type (CAMEO)")}
			</h3>
			<ol class="gd-bars">
				{rows.map(([code, n]) => (
					<li key={code}>
						<span class="gd-bars__label">{view.roots[code]?.[l] ?? code}</span>
						<span class="gd-bars__track" aria-hidden="true">
							<i style={{ width: `${(n / max) * 100}%` }} />
						</span>
						<span class="gd-bars__n">{int(n, l)}</span>
					</li>
				))}
			</ol>
		</section>
	);
}

function Latest({ view }: { view: GdeltView }) {
	const l = lang.value;
	const sel = selectedState.value;
	const rows = sel ? view.latest.filter((a) => a.state === sel) : view.latest;
	return (
		<section class="gd-block" aria-labelledby="gd-latest">
			<h3 class="gd-h" id="gd-latest">
				{sel
					? t(
							`Últimos artículos ubicados en ${stateName(sel)}`,
							`Latest articles placed in ${stateName(sel)}`,
						)
					: t("Últimos artículos", "Latest articles")}{" "}
				<span class="gd-h__n">({rows.length})</span>
			</h3>
			{sel ? (
				<p class="gd-note">
					{t(
						`Filtrado por ${stateName(sel)} entre los ${view.latest.length} más recientes.`,
						`Filtered to ${stateName(sel)} among the ${view.latest.length} newest.`,
					)}{" "}
					<button type="button" class="link-button" onClick={() => selectState(null)}>
						{t("Ver todos", "Show all")}
					</button>
				</p>
			) : null}
			{rows.length ? (
				<ol class="gd-list">
					{rows.map((a) => (
						<li key={`${a.url}|${a.at}`} class="gd-item">
							<time class="gd-item__time" dateTime={new Date(a.at).toISOString()}>
								{stamp(a.at, l, now.value)}
							</time>
							<a class="gd-item__link" href={a.url} target="_blank" rel="noopener noreferrer">
								{a.domain}
							</a>
							<span class="gd-item__meta">
								{a.roots.map((r) => view.roots[r]?.[l] ?? r).join(", ")}
								{" · "}
								{a.state ? stateName(a.state) : a.place}
								<span class="gd-item__basis"> ({PLACED[a.placedBy][l]})</span>
								{a.stream === "tr" ? (
									<span class="gd-item__basis"> · {t("traducido", "translated")}</span>
								) : null}
							</span>
						</li>
					))}
				</ol>
			) : (
				<p class="gd-note">{t("Ninguno en este lote.", "None in this batch.")}</p>
			)}
		</section>
	);
}

export function GdeltPanel() {
	const l = lang.value;
	const view = panels.value.gdelt as GdeltView | undefined;
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		wantPanel("gdelt").catch(() => setFailed(true));
	}, []);
	const meta = PANEL_META.gdelt;
	const states = view
		? Object.entries(view.byState).sort((a, b) => b[1].events - a[1].events || a[0].localeCompare(b[0]))
		: [];
	const sel = selectedState.value;
	const b = view?.batches;
	const hours = view?.hourly ?? [];
	return (
		<Panel
			id="gdelt"
			title={meta.title()}
			question={meta.question()}
			feeds={meta.feeds()}
			ready={failed || view !== undefined}
			method={
				view ? (
					<>
						<p>{l === "es" ? view.methodEs : view.methodEn}</p>
						<p>
							{t(
								"«Protesta» y «conflicto material» por estado cuentan artículos (uno puede codificar varios eventos), no personas ni hechos. El mapa gradúa el color por la raíz cuadrada de la parte del estado con más eventos.",
								"“Protest” and “material conflict” per state count articles (one can code several events), not people or incidents. The map grades colour by the square root of the share of the busiest state.",
							)}
						</p>
					</>
				) : null
			}
		>
			{failed && !view ? (
				<p class="gd-note">
					{t("No se pudo cargar la vista de GDELT.", "The GDELT view could not be loaded.")}{" "}
					<button
						type="button"
						class="link-button"
						onClick={() => {
							setFailed(false);
							wantPanel("gdelt").catch(() => setFailed(true));
						}}
					>
						{t("Reintentar", "Retry")}
					</button>
				</p>
			) : null}
			{view ? (
				<div class="gd">
					<p class="gd-band">
						<strong>{t("Codificación automática de GDELT", "GDELT's automatic coding")}</strong>
						{t(
							": noticias del mundo codificadas por máquina, no eventos verificados. Cada fila enlaza el artículo.",
							": world news coded by machine, not verified events. Every row links the article.",
						)}
					</p>
					<dl class="gd-figs">
						<div>
							<dt>{t("Eventos 24 h", "Events 24 h")}</dt>
							<dd>{int(view.events, l)}</dd>
						</div>
						<div>
							<dt>{t("Artículos", "Articles")}</dt>
							<dd>{int(view.articles24h, l)}</dd>
						</div>
						<div>
							<dt>{t("Solo el país", "Country only")}</dt>
							<dd>{int(view.national, l)}</dd>
						</div>
						<div>
							<dt>{t("Homónimos descartados", "Homonyms dropped")}</dt>
							<dd>{int(view.droppedHomonym, l)}</dd>
						</div>
						{b ? (
							<div>
								<dt>{t("Lotes", "Batches")}</dt>
								<dd>
									{int(b.received, l)}
									<span class="gd-figs__of"> {t(`de ${b.expected}`, `of ${b.expected}`)}</span>
									{b.missing ? (
										<span class="gd-figs__note">
											{t(`${b.missing} faltan en GDELT`, `${b.missing} missing at GDELT`)}
										</span>
									) : null}
								</dd>
							</div>
						) : null}
					</dl>
					{b && b.received + b.missing < b.expected ? (
						<p class="gd-note">
							{t(
								`Cobertura parcial: ${b.received} de ${b.expected} lotes de 15 minutos en 24 h (dos series, inglés y traducida, de ${b.expected / 2} cada una); Vigía los lee desde que se activó esta fuente. Las cifras suman solo esos lotes.`,
								`Partial coverage: ${b.received} of ${b.expected} 15-minute batches in 24 h (two series, English and translated, of ${b.expected / 2} each); Vigía reads them since this source was turned on. The figures sum those batches only.`,
							)}
						</p>
					) : null}
					<div class="gd-geo">
						<StateMap view={view} />
						<section class="gd-block" aria-labelledby="gd-states">
							<h3 class="gd-h" id="gd-states">
								{t("Por estado", "By state")}
							</h3>
							{states.length ? (
								<table class="gd-table">
									<thead>
										<tr>
											<th scope="col">{t("Estado", "State")}</th>
											<th scope="col">{t("Eventos", "Events")}</th>
											<th scope="col" title={t("artículos con una protesta", "articles with a protest")}>
												{t("Protesta", "Protest")}
											</th>
											<th
												scope="col"
												title={t("artículos con conflicto material", "articles with material conflict")}
											>
												{t("Conflicto", "Conflict")}
											</th>
										</tr>
									</thead>
									<tbody>
										{states
											.filter(([iso], i) => i < 10 || iso === sel)
											.map(([iso, s]) => (
												<tr key={iso} class={sel === iso ? "is-sel" : ""}>
													<th scope="row">
														<button
															type="button"
															class="gd-table__place"
															aria-pressed={sel === iso}
															onClick={() => selectState(sel === iso ? null : iso)}
														>
															{stateName(iso)}
														</button>
													</th>
													<td>{int(s.events, l)}</td>
													<td>{int(s.protestArticles, l)}</td>
													<td>{int(s.materialConflictArticles, l)}</td>
												</tr>
											))}
									</tbody>
								</table>
							) : (
								<p class="gd-note">
									{t("Ningún evento ubicado en un estado en 24 h.", "No event placed in a state in 24 h.")}
								</p>
							)}
						</section>
					</div>
					<div class="gd-pair">
						<Kinds view={view} />
						<section class="gd-block" aria-labelledby="gd-hours">
							<h3 class="gd-h" id="gd-hours">
								{t("Eventos por hora, 48 h", "Events per hour, 48 h")}
							</h3>
							<HourBars hours={hours} />
						</section>
					</div>
					<Latest view={view} />
					<div class="sources-row">
						{b?.newestAt ? (
							<SourceTag
								source={{ feed: "gdelt-ve", observedAt: b.newestAt, url: "https://www.gdeltproject.org/" }}
								label={t("GDELT, último lote", "GDELT, newest batch")}
							/>
						) : null}
					</div>
				</div>
			) : null}
		</Panel>
	);
}

registerSummary("gdelt", () => {
	const v = panels.value.gdelt as GdeltView | undefined;
	if (!v) return null;
	const l = lang.value;
	return {
		text: t(
			`${int(v.events, l)} eventos en 24 h según la codificación automática de GDELT (${int(v.articles24h, l)} artículos)`,
			`${int(v.events, l)} events in 24 h by GDELT's automatic coding (${int(v.articles24h, l)} articles)`,
		),
		tone: "normal",
	};
});
