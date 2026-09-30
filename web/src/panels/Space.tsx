import { useEffect, useState } from "preact/hooks";
import { addStyles } from "../lib/css.ts";
import { now, panels, wantPanel } from "../lib/data.ts";
import { int, stamp } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import type { PanelId } from "../lib/layout.ts";
import { PANEL_META } from "../lib/panel-meta.ts";
import { entityLink } from "../lib/router.ts";
import {
	barScale,
	type FlightsView,
	type FloodsView,
	type ForestView,
	flightsHeadline,
	floodLine,
	forestLead,
	ha,
	km2,
	type MethaneView,
	plumeRate,
	type RadarView,
	trafficWord,
	unseenWord,
	type VesselsView,
	vesselLine,
} from "../lib/space-view.ts";
import { STATE_SLUG } from "../lib/states.ts";
import { registerSummary } from "../lib/summary.ts";
import spaceCss from "../styles/space.css?inline";
import { Panel } from "../ui/Panel.tsx";
import { SourceTag } from "../ui/Source.tsx";

addStyles(spaceCss);

/*
 * The space and movement views (src/panels/{floods,forest,methane,vessels,radar,flights}.ts), each served on demand
 * and fetched when its panel opens: floods and forest in Tierra, methane plumes and radar ship counts in Energía,
 * Cloudflare's traffic in Internet, airline flight counts in Oficial. Every figure is the server's, with its source,
 * age and caveat; Vigía's own computations say so with their method. A feed behind a free key shows how to unlock
 * it, never an empty chart. No map of vessels or aircraft: counts only.
 */

function useView<T>(id: string): { view: T | undefined; failed: boolean } {
	const view = panels.value[id] as T | undefined;
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		wantPanel(id).catch(() => setFailed(true));
	}, [id]);
	return { view, failed: failed && !view };
}

function Failed() {
	return (
		<p class="empty">
			{t(
				"No se pudo cargar este panel (se pide al abrirlo).",
				"This panel could not be loaded (it is fetched when opened).",
			)}
		</p>
	);
}

function Computed({ method }: { method: string }) {
	return (
		<details class="sp-computed">
			<summary>{t("calculado por Vigía", "computed by Vigía")}</summary>
			<p>{method.replace(/^calculado por Vigía:\s*/, "")}</p>
		</details>
	);
}

function Caveat({ text }: { text: string }) {
	return <p class="sp-caveat">{text}</p>;
}

/** A small bar chart of one series: linear bars, each with its own hover text; a band for what was not seen. */
function Bars({
	values,
	titles,
	band,
	hatched,
	label,
}: {
	values: readonly number[];
	titles: readonly string[];
	/** 0–1 per bar: a quiet band of what the source could not see (clouds). */
	band?: readonly number[];
	/** Bars of a period still running. */
	hatched?: readonly boolean[];
	label: string;
}) {
	const h = barScale(values);
	const W = values.length * 10;
	const H = 48;
	return (
		<svg class="sp-bars" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
			{h.map((v, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: bars are positions in a fixed series.
				<g key={i}>
					<title>{titles[i]}</title>
					{band ? (
						<rect x={i * 10} y={0} width={8} height={H * (band[i] ?? 0)} class="sp-bar__unseen" />
					) : null}
					<rect x={i * 10} y={0} width={8} height={H} class="sp-bar__hit" />
					{v > 0 ? (
						<rect
							x={i * 10}
							y={H - v * (H - 2)}
							width={8}
							height={v * (H - 2)}
							class={`sp-bar${hatched?.[i] ? " sp-bar--running" : ""}`}
						/>
					) : (
						<rect x={i * 10} y={H - 1} width={8} height={1} class="sp-bar sp-bar--zero" />
					)}
				</g>
			))}
		</svg>
	);
}

/* ---------- Inundaciones (NASA MODIS) ---------- */

export function FloodsPanel() {
	const { view, failed } = useView<FloodsView>("floods");
	const l = lang.value;
	const meta = PANEL_META.inundaciones;
	const d = view?.day ?? null;
	return (
		<Panel
			id="inundaciones"
			title={meta.title()}
			question={meta.question()}
			feeds={meta.feeds()}
			ready={failed || view !== undefined}
			method={
				view ? (
					<>
						<p>{view.label}</p>
						<p>{view.caveat}</p>
						<p>{view.method}</p>
						<p>{view.attribution}</p>
					</>
				) : undefined
			}
		>
			{failed ? <Failed /> : null}
			{view ? (
				d ? (
					<div class="sp">
						<div class="sp-lead">
							<span class="sp-lead__v data">{km2(d.venezuela.floodKm2, l)}</span>
							<span class="sp-lead__t">
								{t(
									`de inundación vista por satélite en Venezuela, ${d.date}`,
									`of flood seen by satellite in Venezuela, ${d.date}`,
								)}
								<span class="sp-unseen">{unseenWord(d.venezuela.unseenPct, l)}</span>
							</span>
						</div>
						<p class="sp-note">
							<span class="sp-recurring">
								{t(
									`y ${km2(d.venezuela.recurringKm2, l)} de inundación recurrente (agua que aparece casi todos los años en esta época)`,
									`and ${km2(d.venezuela.recurringKm2, l)} of recurring flood (water seen most years at this season)`,
								)}
							</span>
						</p>
						<Caveat text={view.caveat} />
						{view.series.length > 1 ? (
							<figure class="sp-fig">
								<figcaption class="sp-h">
									{t("Inundación por día, km² (banda: sin ver)", "Flood per day, km² (band: unseen)")}
								</figcaption>
								<Bars
									values={view.series.map((s) => s.floodKm2)}
									band={view.series.map((s) => s.unseenPct / 100)}
									titles={view.series.map((s) => `${s.date}: ${floodLine({ ...s, areaKm2: 0 }, l)}`)}
									label={t("Inundación por día", "Flood per day")}
								/>
								<div class="sp-axis data">
									<span>{view.series[0]?.date}</span>
									<span>{view.series.at(-1)?.date}</span>
								</div>
							</figure>
						) : null}
						<h3 class="sp-h">{t("Por estado", "By state")}</h3>
						<ul class="sp-rows">
							{d.states
								.filter((s) => s.floodKm2 > 0 || s.recurringKm2 > 0)
								.slice(0, 8)
								.map((s) => (
									<li key={s.iso}>
										<a {...entityLink(`ve.${STATE_SLUG.get(s.iso) ?? ""}`)} class="sp-row__name">
											{s.name}
										</a>
										<span class="data">{km2(s.floodKm2, l)}</span>
										<span class="sp-unseen">{unseenWord(s.unseenPct, l)}</span>
									</li>
								))}
						</ul>
						{d.municipalities.length ? (
							<>
								<h3 class="sp-h">{t("Municipios con más inundación", "Municipalities with most flood")}</h3>
								<ul class="sp-rows">
									{d.municipalities.slice(0, 6).map((m) => (
										<li key={m.code}>
											<span class="sp-row__name">
												{m.name} <span class="sp-dim">· {m.stateName}</span>
											</span>
											<span class="data">{km2(m.floodKm2, l)}</span>
											<span class="sp-unseen">{unseenWord(m.unseenPct, l)}</span>
										</li>
									))}
								</ul>
							</>
						) : null}
						<Computed method={view.method} />
						<div class="sources-row">
							<SourceTag
								source={{ feed: view.feed, observedAt: d.observedAt, url: d.sourceUrl }}
								label={t("NASA MODIS (Worldview, ese día)", "NASA MODIS (Worldview, that day)")}
							/>
						</div>
					</div>
				) : (
					<p class="empty">{t("Aún no se ha leído ningún día.", "No day read yet.")}</p>
				)
			) : null}
		</Panel>
	);
}

/* ---------- Bosque (Global Forest Watch) ---------- */

export function ForestPanel() {
	const { view, failed } = useView<ForestView>("forest");
	const l = lang.value;
	const meta = PANEL_META.bosque;
	return (
		<Panel
			id="bosque"
			title={meta.title()}
			question={meta.question()}
			feeds={meta.feeds()}
			ready={failed || view !== undefined}
			method={
				view ? (
					<>
						<p>{view.label}</p>
						<p>{view.caveat}</p>
						<p>{view.placesNote}</p>
						<p>{view.method}</p>
					</>
				) : undefined
			}
		>
			{failed ? <Failed /> : null}
			{view ? (
				<div class="sp">
					{view.recent.weeks ? (
						<div class="sp-lead">
							<span class="sp-lead__v data">
								{ha(view.venezuela.forest.high + view.venezuela.forest.highest, l)}
							</span>
							<span class="sp-lead__t">
								{t(
									`de alertas en bosque natural, confianza alta o máxima, ${view.recent.weeks} semanas (${view.recent.from} a ${view.recent.to})`,
									`of alerts in natural forest, high or highest confidence, ${view.recent.weeks} weeks (${view.recent.from} to ${view.recent.to})`,
								)}
							</span>
						</div>
					) : (
						<p class="sp-note">
							{t(
								"Sin semanas terminadas sumadas todavía: abajo, cada semana leída.",
								"No finished weeks summed yet: below, each week read.",
							)}
						</p>
					)}
					<Caveat text={view.caveat} />
					{view.weeks.length ? (
						<figure class="sp-fig">
							<figcaption class="sp-h">
								{t(
									"Bosque natural por semana, ha (alta o máxima); rayada: semana en curso",
									"Natural forest per week, ha (high or highest); hatched: running week",
								)}
							</figcaption>
							<Bars
								values={view.weeks.map((w) => w.forest.high + w.forest.highest)}
								hatched={view.weeks.map((w) => (w as { ended?: boolean }).ended === false)}
								titles={view.weeks.map(
									(w) =>
										`${w.week}: ${forestLead(w.forest, l)}; ${t("otra vegetación", "other vegetation")} ${ha(w.other.total, l)}`,
								)}
								label={t("Alertas en bosque natural por semana", "Natural forest alerts per week")}
							/>
							<div class="sp-axis data">
								<span>{view.weeks[0]?.week}</span>
								<span>{view.weeks.at(-1)?.week}</span>
							</div>
							<p class="sp-dim sp-small">
								{t(
									"Las semanas terminadas siguen creciendo mientras GFW agrega alertas tardías.",
									"Finished weeks keep growing as GFW adds late alerts.",
								)}
							</p>
						</figure>
					) : null}
					{view.states.length ? (
						<>
							<h3 class="sp-h">{t("Por estado", "By state")}</h3>
							<ul class="sp-rows">
								{view.states.slice(0, 8).map((s) => (
									<li key={s.iso}>
										<span class="sp-row__name">{s.name}</span>
										<span class="data">{ha(s.forest.high + s.forest.highest, l)}</span>
										<span class="sp-dim">
											{t("otra vegetación", "other vegetation")} {ha(s.other.total, l)}
										</span>
									</li>
								))}
							</ul>
						</>
					) : null}
					{view.municipalities.length ? (
						<>
							<h3 class="sp-h">{t("Municipios", "Municipalities")}</h3>
							<ul class="sp-rows">
								{view.municipalities.slice(0, 6).map((m) => (
									<li key={m.gadmId}>
										<span class="sp-row__name">
											{m.name}
											{m.code ? "" : ` ${t("(límites GADM)", "(GADM boundaries)")}`}{" "}
											<span class="sp-dim">· {m.stateName}</span>
										</span>
										<span class="data">{ha(m.forest.high + m.forest.highest, l)}</span>
									</li>
								))}
							</ul>
						</>
					) : null}
					{view.protectedAreas.length ? (
						<>
							<h3 class="sp-h">
								{t("Áreas protegidas (nunca se suman entre sí)", "Protected areas (never summed together)")}
							</h3>
							<ul class="sp-rows">
								{view.protectedAreas.slice(0, 6).map((a) => (
									<li key={a.wdpaIds.join()}>
										<span class="sp-row__name">{a.name}</span>
										<span class="data">{ha(a.forest.high + a.forest.highest, l)}</span>
									</li>
								))}
							</ul>
						</>
					) : null}
					<Computed method={view.method} />
					<div class="sources-row">
						<SourceTag
							source={{ feed: view.feed, observedAt: view.fetchedAt, url: view.sourceUrl }}
							label={`Global Forest Watch${view.version ? ` · ${view.version}` : ""}`}
						/>
					</div>
				</div>
			) : null}
		</Panel>
	);
}

/* ---------- Metano (Carbon Mapper) ---------- */

export function MethanePanel() {
	const { view, failed } = useView<MethaneView>("methane");
	const l = lang.value;
	const meta = PANEL_META.metano;
	const [all, setAll] = useState(false);
	return (
		<Panel
			id="metano"
			title={meta.title()}
			question={meta.question()}
			feeds={meta.feeds()}
			ready={failed || view !== undefined}
			method={
				view ? (
					<>
						<p>{view.label}</p>
						<p>{view.caveat}</p>
						<p>{view.facilityRule}</p>
						<p>{view.monthsNote}</p>
					</>
				) : undefined
			}
		>
			{failed ? <Failed /> : null}
			{view ? (
				<div class="sp">
					<div class="sp-lead">
						<span class="sp-lead__v data">{int(view.plumes.length, l)}</span>
						<span class="sp-lead__t">
							{t(
								`plumas de metano captadas en 12 meses${view.plumes[0] ? `; la más reciente, ${stamp(view.plumes[0].observedAt, l, now.value)}` : ""}`,
								`methane plumes captured in 12 months${view.plumes[0] ? `; the newest, ${stamp(view.plumes[0].observedAt, l, now.value)}` : ""}`,
							)}
						</span>
					</div>
					<Caveat text={view.caveat} />
					{view.facilities.length ? (
						<>
							<h3 class="sp-h">{t("Por instalación (a menos de 3 km)", "By facility (within 3 km)")}</h3>
							<ul class="sp-rows">
								{view.facilities.slice(0, 8).map((f) => (
									<li key={f.id}>
										<span class="sp-row__name">{f.name}</span>
										<span class="data">
											{int(f.plumes, l)} {f.plumes === 1 ? t("pluma", "plume") : t("plumas", "plumes")}
										</span>
										<span class="sp-dim">
											{t("la mayor", "largest")}{" "}
											{f.maxKgH !== null
												? `${int(Math.round(f.maxKgH), l)} kg/h`
												: t("sin estimación", "no estimate")}
										</span>
									</li>
								))}
							</ul>
						</>
					) : null}
					<h3 class="sp-h">{t("Plumas, la más reciente primero", "Plumes, newest first")}</h3>
					<ul class="sp-plumes">
						{view.plumes.slice(0, all ? 60 : 6).map((p) => (
							<li key={p.plumeId}>
								<span class="data sp-plume__when">{stamp(p.observedAt, l, now.value)}</span>
								<span class="sp-plume__where">
									{p.facilityName
										? `${p.facilityName} (${p.facilityKm} km)`
										: `${p.municipalityName ?? p.stateName}, ${p.stateName}`}
								</span>
								<span class="data">{plumeRate(p, l)}</span>
								<span class="sp-dim">{p.instrumentEs}</span>
								<a class="sp-link" href={p.sourceUrl} target="_blank" rel="noopener noreferrer">
									Carbon Mapper ↗
								</a>
							</li>
						))}
					</ul>
					{view.plumes.length > 6 ? (
						<button type="button" class="link-button sp-more" onClick={() => setAll(!all)}>
							{all
								? t("Ver menos", "Show fewer")
								: t(
										`Ver más (hasta 60 de ${view.plumes.length})`,
										`Show more (up to 60 of ${view.plumes.length})`,
									)}
						</button>
					) : null}
					{view.months.length > 1 ? (
						<figure class="sp-fig">
							<figcaption class="sp-h">
								{t("Plumas publicadas por mes", "Plumes published per month")}
							</figcaption>
							<Bars
								values={view.months.map((m) => m.plumes)}
								titles={view.months.map((m) => `${m.month}: ${m.plumes}`)}
								label={t("Plumas por mes", "Plumes per month")}
							/>
							<div class="sp-axis data">
								<span>{view.months[0]?.month}</span>
								<span>{view.months.at(-1)?.month}</span>
							</div>
							<p class="sp-dim sp-small">{view.monthsNote}</p>
						</figure>
					) : null}
					<div class="sources-row">
						<SourceTag
							source={{
								feed: view.feed,
								observedAt: view.plumes[0]?.observedAt ?? null,
								url: view.sourceUrl,
							}}
							label="Carbon Mapper"
						/>
					</div>
				</div>
			) : null}
		</Panel>
	);
}

/* ---------- Buques en terminales (Global Fishing Watch, locked until a free token) ---------- */

export function VesselsPanel() {
	const { view, failed } = useView<VesselsView>("vessels");
	const l = lang.value;
	const meta = PANEL_META.buques;
	return (
		<Panel
			id="buques"
			title={meta.title()}
			question={meta.question()}
			feeds={meta.feeds()}
			freeKey="global-fishing-watch-token"
			ready={failed || view !== undefined}
			method={
				view ? (
					<>
						<p>{view.label}</p>
						<p>{view.caveat}</p>
						<p>{view.sumNote}</p>
					</>
				) : undefined
			}
		>
			{failed ? <Failed /> : null}
			{view ? (
				<div class="sp">
					<Caveat text={view.caveat} />
					<ul class="sp-rows">
						{view.areas.map((a) => (
							<li key={a.id}>
								<span class="sp-row__name">{a.name}</span>
								<span class="sp-dim">{vesselLine(a, view.windowDays, l)}</span>
								<span class="data">{a.lastDate ?? "—"}</span>
							</li>
						))}
					</ul>
					<p class="sp-dim sp-small">{view.sumNote}</p>
				</div>
			) : null}
		</Panel>
	);
}

/* ---------- Cloudflare (locked until a free token) ---------- */

export function RadarPanel() {
	const { view, failed } = useView<RadarView>("radar");
	const l = lang.value;
	const meta = PANEL_META.cloudflare;
	const tr = view?.traffic ?? null;
	return (
		<Panel
			id="cloudflare"
			title={meta.title()}
			question={meta.question()}
			feeds={meta.feeds()}
			freeKey="cloudflare-radar-token"
			ready={failed || view !== undefined}
			method={view ? <p>{view.label}</p> : undefined}
		>
			{failed ? <Failed /> : null}
			{view ? (
				<div class="sp">
					{tr ? (
						<>
							<div class="sp-lead">
								<span class="sp-lead__t">{trafficWord(tr, l)}</span>
							</div>
							<figure class="sp-fig">
								<figcaption class="sp-h">
									{t(
										"Índice de tráfico 0–1, 7 días (no un volumen)",
										"Traffic index 0–1, 7 days (not a volume)",
									)}
								</figcaption>
								<Bars
									values={tr.points.map((p) => p[1])}
									titles={tr.points.map((p) => `${stamp(p[0], l, now.value)}: ${p[1].toFixed(2)}`)}
									label={t("Índice de tráfico de Cloudflare", "Cloudflare traffic index")}
								/>
							</figure>
							<Computed method={tr.method} />
						</>
					) : (
						<p class="empty">{t("Sin curva de tráfico guardada todavía.", "No traffic curve stored yet.")}</p>
					)}
					{view.outages.length ? (
						<>
							<h3 class="sp-h">
								{t("Notas de cortes de Cloudflare (30 días)", "Cloudflare outage notes (30 days)")}
							</h3>
							<ul class="sp-rows">
								{view.outages.map((o) => (
									<li key={o.id}>
										<span class="sp-row__name">
											{o.description ?? o.scope ?? "—"}{" "}
											{o.causeEs ? <span class="sp-dim">· {o.causeEs}</span> : null}
										</span>
										<span class="sp-dim">{o.ongoing ? t("en curso", "ongoing") : o.endDate}</span>
									</li>
								))}
							</ul>
						</>
					) : null}
					{view.anomalies.length ? (
						<>
							<h3 class="sp-h">{t("Anomalías de tráfico (7 días)", "Traffic anomalies (7 days)")}</h3>
							<ul class="sp-rows">
								{view.anomalies.map((a) => (
									<li key={a.uuid}>
										<span class="sp-row__name">{a.asnName ?? t("todo el país", "the whole country")}</span>
										<span class="sp-dim">
											{a.status === "VERIFIED"
												? t("verificada", "verified")
												: t("sin verificar", "unverified")}
										</span>
										<span class="data">{a.startDate.slice(0, 16).replace("T", " ")}</span>
									</li>
								))}
							</ul>
						</>
					) : null}
					<p class="sp-dim sp-small">{view.attribution}</p>
				</div>
			) : null}
		</Panel>
	);
}

/* ---------- Vuelos (adsb.lol) ---------- */

export function FlightsPanel() {
	const { view, failed } = useView<FlightsView>("flights");
	const l = lang.value;
	const meta = PANEL_META.vuelos;
	const head = view ? flightsHeadline(view, l) : null;
	return (
		<Panel
			id="vuelos"
			title={meta.title()}
			question={meta.question()}
			feeds={meta.feeds()}
			ready={failed || view !== undefined}
			method={
				view ? (
					<>
						<p>{view.label}</p>
						<p>{view.caveat}</p>
						<p>{view.method}</p>
					</>
				) : undefined
			}
		>
			{failed ? <Failed /> : null}
			{view && head ? (
				<div class="sp">
					<div class="sp-lead">
						<span class="sp-lead__v data">{head.today === null ? "—" : int(head.today, l)}</span>
						<span class="sp-lead__t">
							{head.today === null ? head.text : head.text.replace(/^\S+\s/, "")}
							{head.weekDays
								? t(
										` · ${int(head.week, l)} en los últimos ${head.weekDays} días completos`,
										` · ${int(head.week, l)} in the last ${head.weekDays} complete days`,
									)
								: ""}
						</span>
					</div>
					<Caveat text={view.caveat} />
					<figure class="sp-fig">
						<figcaption class="sp-h">
							{t(
								"Vuelos de aerolínea vistos por día, sobre y cerca de Venezuela; rayado: hoy, contando",
								"Airline flights seen per day, over and near Venezuela; hatched: today, counting",
							)}
						</figcaption>
						<Bars
							values={view.days.map((d) => (d.covered ? d.total : 0))}
							// A day the feed never read is a full "unseen" column, never a bar of 0 (review M9).
							band={view.days.map((d) => (d.covered ? 0 : 1))}
							hatched={view.days.map((d) => d.partial)}
							titles={view.days.map((d) =>
								d.covered
									? `${d.date}: ${d.internationalAll} ${t("internacionales", "international")}, ${d.domestic} ${t("nacionales", "domestic")}, ${d.overflight} ${t("sobrevuelos", "overflights")}, ${d["no-route"]} ${t("sin ruta", "no route")}`
									: `${d.date}: ${t("sin datos (Vigía no leyó la fuente ese día)", "no data (Vigía did not read the source that day)")}`,
							)}
							label={t("Vuelos de aerolínea vistos por día", "Airline flights seen per day")}
						/>
						<div class="sp-axis data">
							<span>{view.days[0]?.date}</span>
							<span>{view.days.at(-1)?.date}</span>
						</div>
					</figure>
					{(() => {
						const today = view.days.at(-1);
						return today ? (
							<dl class="sp-figs">
								{(
									[
										["arrival", t("llegadas", "arrivals")],
										["departure", t("salidas", "departures")],
										["domestic", t("nacionales", "domestic")],
										["overflight", t("sobrevuelos", "overflights")],
										["nearby", t("cerca", "nearby")],
										["no-route", t("sin ruta publicada", "no published route")],
									] as const
								).map(([k, w]) => (
									<div key={k}>
										<dt>{w}</dt>
										<dd class="data">{today.covered ? int(today[k], l) : "—"}</dd>
									</div>
								))}
							</dl>
						) : null;
					})()}
					{view.airlines7d.length ? (
						<>
							<h3 class="sp-h">
								{t("Aerolíneas internacionales, 7 días", "International airlines, 7 days")}
							</h3>
							<ul class="sp-rows">
								{view.airlines7d.slice(0, 8).map((a) => (
									<li key={a.airline}>
										<span class="sp-row__name">{a.name ?? a.airline}</span>
										<span class="data">{int(a.flights, l)}</span>
									</li>
								))}
							</ul>
						</>
					) : null}
					{view.airports7d.length ? (
						<>
							<h3 class="sp-h">
								{t("Aeropuertos en sus rutas, 7 días", "Airports on their routes, 7 days")}
							</h3>
							<ul class="sp-rows">
								{view.airports7d.slice(0, 8).map((a) => (
									<li key={a.icao}>
										<span class="sp-row__name data">{a.icao}</span>
										<span class="data">{int(a.flights, l)}</span>
									</li>
								))}
							</ul>
						</>
					) : null}
					{view.coverage24h.length ? (
						<p class="sp-dim sp-small">
							{t(
								`Cobertura: ${view.coverage24h.reduce((a, c) => a + c.snapshots, 0)} lecturas en 24 h; a lo sumo ${Math.max(...view.coverage24h.map((c) => c.maxAircraft))} aeronaves oídas a la vez (${Math.max(...view.coverage24h.map((c) => c.maxMilitary))} militares, solo contadas).`,
								`Coverage: ${view.coverage24h.reduce((a, c) => a + c.snapshots, 0)} readings in 24 h; at most ${Math.max(...view.coverage24h.map((c) => c.maxAircraft))} aircraft heard at once (${Math.max(...view.coverage24h.map((c) => c.maxMilitary))} military, only counted).`,
							)}
						</p>
					) : null}
					<Computed method={view.method} />
					<div class="sources-row">
						<SourceTag
							source={{ feed: view.feed, observedAt: view.lastSnapshotAt, url: view.sourceUrl }}
							label="adsb.lol"
						/>
					</div>
				</div>
			) : null}
		</Panel>
	);
}

/* ---------- Summaries for the phone's rows (registered when this chunk loads) ---------- */

const reg = (id: PanelId, fn: () => { text: string; tone: "normal" } | null) => registerSummary(id, fn);
reg("inundaciones", () => {
	const v = panels.value.floods as FloodsView | undefined;
	if (!v?.day) return null;
	return { text: floodLine(v.day.venezuela, lang.value), tone: "normal" };
});
reg("bosque", () => {
	const v = panels.value.forest as ForestView | undefined;
	if (!v?.recent.weeks) return null;
	return { text: forestLead(v.venezuela.forest, lang.value), tone: "normal" };
});
reg("metano", () => {
	const v = panels.value.methane as MethaneView | undefined;
	if (!v) return null;
	return {
		text: t(`${v.plumes.length} plumas en 12 meses`, `${v.plumes.length} plumes in 12 months`),
		tone: "normal",
	};
});
reg("vuelos", () => {
	const v = panels.value.flights as FlightsView | undefined;
	return v ? { text: flightsHeadline(v, lang.value).text, tone: "normal" } : null;
});
