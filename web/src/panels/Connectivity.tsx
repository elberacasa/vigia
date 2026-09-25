import { useState } from "preact/hooks";
import { addStyles } from "../lib/css.ts";
import { now, panels } from "../lib/data.ts";
import { ago, int, num } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { PANEL_META } from "../lib/panel-meta.ts";
import { useFresh } from "../lib/seen.ts";
import { levelLabel } from "../map/fills.ts";
import { selectedState } from "../map/view.ts";
import panelsCss from "../styles/panels.css?inline";
import { NewPill, NewTag } from "../ui/Digits.tsx";
import { Panel } from "../ui/Panel.tsx";
import { SourceTag } from "../ui/Source.tsx";

addStyles(panelsCss);

/** Mirrors src/panels/connectivity.ts. The server classifies; this file only shows. */
export type Level = "normal" | "drop" | "severe" | "no-data";
type IodaSignal = "bgp" | "ping-slash24" | "merit-nt";
interface SignalReading {
	signal: IodaSignal;
	level: Level;
	noData: string | null;
	current: number | null;
	observedAt: number | null;
	baseline: number | null;
	baselineDays: number;
	pctOfBaseline: number | null;
	changePct: number | null;
	vsWeekPct: number | null;
}
interface Spark {
	signal: IodaSignal;
	startAt: number;
	stepMs: number;
	values: (number | null)[];
}
interface ProbeSummary {
	connected: number;
	disconnected: number;
	active: number;
	disconnects24h: number;
	observedAt: number;
	feed: string;
	sourceUrl: string;
}
export interface PlaceStatus {
	id: string;
	name: string;
	kind: "state" | "isp" | "country";
	codes: string[];
	level: Level;
	headline: string;
	agreeing: IodaSignal[];
	usableSignals: number;
	signals: SignalReading[];
	lastBinAt: number | null;
	spark: Spark | null;
	events7d: number;
	probes: ProbeSummary | null;
	note: string | null;
	feed: string;
	sourceUrl: string;
}
interface OutageEventItem {
	id: string;
	kind: "state" | "isp" | "country";
	name: string;
	signal: string;
	startAt: number;
	endAt: number;
	durationMin: number;
	openAtFetch: boolean;
	url: string;
}
interface RoutingSummary {
	observedAt: number;
	v4ChangePct: number | null;
	drop: boolean;
	feed: string;
	sourceUrl: string;
	note: string;
}
export interface ConnectivityView {
	asOf: number | null;
	summary: {
		states: { normal: number; drop: number; severe: number; noData: number };
		isps: { normal: number; drop: number; severe: number; noData: number };
		text: string;
		affected: string[];
		allClear: boolean;
	};
	country: PlaceStatus;
	states: PlaceStatus[];
	isps: PlaceStatus[];
	events: OutageEventItem[];
	routing: RoutingSummary | null;
	atlas: { observedAt: number | null; attribution: string; caveat: string };
	method: {
		baseline: string;
		rules: {
			signal: IodaSignal;
			label: string;
			unit: string;
			what: string;
			dropFloorPct: number;
			severeFloorPct: number;
		}[];
		caveats: string[];
	};
	attribution: string;
	feeds: string[];
}

const SIGNAL_SHORT: Record<IodaSignal, { es: string; en: string }> = {
	bgp: { es: "Rutas", en: "Routes" },
	"ping-slash24": { es: "Sondeo", en: "Probing" },
	"merit-nt": { es: "Telescopio", en: "Telescope" },
};

/** 48 h of % of baseline as a tiny bar strip; gaps where there was no data; 100 % is the reference line. */
function PercentStrip({ spark }: { spark: Spark | null }) {
	if (!spark) return <span class="strip strip--empty" />;
	const w = 96;
	const h = 22;
	const n = spark.values.length;
	const bw = w / n;
	return (
		<svg class="strip" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
			<line x1={0} x2={w} y1={h * 0.35} y2={h * 0.35} class="strip__ref" />
			{spark.values.map((v, i) => {
				if (v === null) return null;
				const clamped = Math.max(0, Math.min(140, v));
				const bh = (clamped / 140) * h;
				const tone = v < 60 ? "severe" : v < 85 ? "drop" : "ok";
				return (
					<rect
						x={(i * bw).toFixed(2)}
						y={(h - bh).toFixed(2)}
						width={Math.max(0.6, bw - 0.4).toFixed(2)}
						height={bh.toFixed(2)}
						class={`strip__bar strip__bar--${tone}`}
					/>
				);
			})}
		</svg>
	);
}

function PlaceRow({ place }: { place: PlaceStatus }) {
	const l = lang.value;
	const iso = place.kind === "state" ? place.id : null;
	const worst = place.signals
		.filter((s) => s.pctOfBaseline !== null)
		.sort((a, b) => (a.pctOfBaseline ?? 0) - (b.pctOfBaseline ?? 0))[0];
	return (
		<li class={`place place--${place.level}`}>
			<button
				type="button"
				class="place__name"
				disabled={!iso}
				onClick={() => {
					if (iso) selectedState.value = iso;
				}}
			>
				<span class={`level-dot level-dot--${place.level}`} aria-hidden="true" />
				{place.name}
			</button>
			<PercentStrip spark={place.spark} />
			<span class="place__value data">
				{worst?.pctOfBaseline !== null && worst?.pctOfBaseline !== undefined
					? `${num(worst.pctOfBaseline, 0, l)} %`
					: "—"}
			</span>
			<span class="place__level">{levelLabel(place.level)}</span>
		</li>
	);
}

/** A place worth showing expanded: not normal now, or it dipped below 85 % of normal in the last 48 h. */
function notable(p: PlaceStatus): boolean {
	if (p.level !== "normal") return true;
	return (p.spark?.values ?? []).some((v) => v !== null && v < 85);
}

export function ConnectivityPanel() {
	const view = panels.value.connectivity as ConnectivityView | undefined;
	const [tab, setTab] = useState<"states" | "isps" | "events" | "method">("states");
	const [showAll, setShowAll] = useState(false);
	const l = lang.value;
	const eventAt = new Map((view?.events ?? []).map((e) => [e.id, e.startAt]));
	const freshEvents = useFresh(
		"outages",
		(view?.events ?? []).map((e) => e.id),
		(id) => eventAt.get(id),
	);
	const s = view?.summary;
	return (
		<Panel
			id="conectividad"
			class="panel--connectivity"
			title={PANEL_META.conectividad.title()}
			question={PANEL_META.conectividad.question()}
			feeds={PANEL_META.conectividad.feeds()}
			extra={<NewPill scope="outages" panel="conectividad" onOpen={() => setTab("events")} />}
			foot={
				view ? (
					<>
						<span>{view.attribution}</span>
						<span>
							{t(
								"Una caída de señal de internet suele acompañar a un apagón, pero no lo prueba. Compara con los reportes y las luces nocturnas.",
								"An internet signal drop often comes with a blackout but does not prove one. Compare with reports and night lights.",
							)}
						</span>
					</>
				) : null
			}
		>
			{!view ? (
				<p class="skeleton">…</p>
			) : (
				<>
					<div class={`verdict verdict--${s?.states.severe ? "severe" : s?.states.drop ? "drop" : "normal"}`}>
						<p class="verdict__text">{s?.text}</p>
						<div class="verdict__counts">
							<span>
								<strong class="data">{s?.states.normal ?? 0}</strong> {t("normales", "normal")}
							</span>
							<span class="warn-text">
								<strong class="data">{s?.states.drop ?? 0}</strong> {t("con caída", "with a drop")}
							</span>
							<span class="alert-text">
								<strong class="data">{s?.states.severe ?? 0}</strong> {t("caída fuerte", "severe")}
							</span>
							<span class="muted">
								<strong class="data">{s?.states.noData ?? 0}</strong> {t("sin datos", "no data")}
							</span>
						</div>
						{view.asOf ? (
							<SourceTag
								source={{
									feed: "ioda-states",
									observedAt: view.asOf,
									url: view.country.sourceUrl,
									detail: t(
										"Señales de IODA (Georgia Tech) comparadas con su mediana de la misma hora en los 7 días anteriores.",
										"IODA (Georgia Tech) signals compared with their same-hour median over the previous 7 days.",
									),
								}}
								label="IODA"
							/>
						) : null}
					</div>
					<div class="segmented segmented--wide" role="tablist">
						<button
							type="button"
							role="tab"
							aria-selected={tab === "states"}
							onClick={() => setTab("states")}
						>
							{t("Estados", "States")}
						</button>
						<button type="button" role="tab" aria-selected={tab === "isps"} onClick={() => setTab("isps")}>
							{t("Operadoras", "ISPs")}
						</button>
						<button
							type="button"
							role="tab"
							aria-selected={tab === "events"}
							onClick={() => setTab("events")}
						>
							{t("Eventos", "Events")} <span class="data note">{view.events.length}</span>
						</button>
						<button
							type="button"
							role="tab"
							aria-selected={tab === "method"}
							onClick={() => setTab("method")}
						>
							{t("Método", "Method")}
						</button>
					</div>
					{tab === "states" || tab === "isps" ? (
						<>
							<p class="places__legend note">
								<span>
									{t("Últimas 48 h, % de lo normal a esa hora", "Last 48 h, % of normal for that hour")}
								</span>
								<span>{t("peor señal ahora", "worst signal now")}</span>
							</p>
							{(() => {
								const all = tab === "states" ? view.states : view.isps;
								const shown = showAll ? all : all.filter(notable);
								const hidden = all.length - shown.length;
								return (
									<>
										<ul class="places">
											{shown.map((p) => (
												<PlaceRow place={p} key={p.id} />
											))}
										</ul>
										{hidden > 0 || showAll ? (
											<button
												type="button"
												class="link-button places__more"
												onClick={() => setShowAll(!showAll)}
											>
												{showAll
													? t("Mostrar solo los que tuvieron caídas", "Show only those with drops")
													: t(
															`${hidden} ${tab === "states" ? "estados" : "operadoras"} normales, sin caídas en 48 h: ver todos`,
															`${hidden} normal ${tab === "states" ? "states" : "ISPs"}, no dips in 48 h: show all`,
														)}
											</button>
										) : null}
										<p class="note">
											{t(
												"Caída: la señal por debajo de lo normal para esa hora más allá de su variación habitual (umbral propio de cada señal; ver Método). Barras naranjas: horas bajo el 85 % de lo normal.",
												"Drop: the signal below normal for that hour beyond its usual variation (each signal's own threshold; see Method). Orange bars: hours under 85% of normal.",
											)}
										</p>
									</>
								);
							})()}
						</>
					) : null}
					{tab === "events" ? (
						view.events.length ? (
							<ul class="events">
								{view.events.slice(0, 30).map((e) => (
									<li key={e.id} class={freshEvents.has(e.id) ? "is-new" : undefined}>
										<a href={e.url} target="_blank" rel="noopener noreferrer">
											{freshEvents.has(e.id) ? <NewTag /> : null}
											<strong>{e.name}</strong>
										</a>
										<span class="note">
											{SIGNAL_SHORT[e.signal as IodaSignal]?.[l] ?? e.signal} ·{" "}
											{ago(now.value - e.startAt, l)} ·{" "}
											{e.openAtFetch ? t("en curso", "ongoing") : `${int(e.durationMin, l)} min`}
										</span>
									</li>
								))}
							</ul>
						) : (
							<p class="empty">
								{t("IODA no registra eventos en 7 días.", "IODA records no events in 7 days.")}
							</p>
						)
					) : null}
					{tab === "method" ? (
						<div class="method">
							<p>{view.method.baseline}</p>
							<ul>
								{view.method.rules.map((r) => (
									<li key={r.signal}>
										<strong>{r.label}</strong>: {r.what}{" "}
										<span class="note">
											({t("caída", "drop")} ≥ {r.dropFloorPct} %, {t("fuerte", "severe")} ≥ {r.severeFloorPct}{" "}
											%)
										</span>
									</li>
								))}
							</ul>
							{view.method.caveats.map((c) => (
								<p class="note" key={c}>
									{c}
								</p>
							))}
							{view.routing ? <p class="note">{view.routing.note}</p> : null}
							<p class="note">{view.atlas.caveat}</p>
						</div>
					) : null}
				</>
			)}
		</Panel>
	);
}
