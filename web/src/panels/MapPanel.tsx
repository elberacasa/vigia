import type { ComponentType } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { addStyles } from "../lib/css.ts";
import { healthById, now, panels } from "../lib/data.ts";
import { clauseFeeds, clauseText, currentClauses, type HeadlineInput } from "../lib/headline.ts";
import { lang, t } from "../lib/i18n.ts";
import { later } from "../lib/lazy.tsx";
import { newsTopic, TOPICS } from "../lib/topics.ts";
import { connectivityFills, fireFills, levelLabel } from "../map/fills.ts";
import { FRAME } from "../map/geometry.gen.ts";
import { history, indexAt, type LevelCode, stepLabel } from "../map/history.ts";
import { LayerList, layerInfo } from "../map/LayerList.tsx";
import {
	CameraLayer,
	CameraStrip,
	CrowdLayer,
	FacilityLayer,
	FlareLayer,
	FloodLayer,
	LightningLayer,
	PlumeLayer,
} from "../map/LayerRows.tsx";
import { type StateFill, VenezuelaMap } from "../map/Map.tsx";
import { project } from "../map/project.ts";
import { markArrivals, QuakeLayer, type QuakePoint } from "../map/QuakeLayer.tsx";
import { ShareMenu } from "../map/ShareMenu.tsx";
import { NightUnderlay, SatelliteControls, SatelliteUnderlay, satelliteFrame } from "../map/underlays.tsx";
import {
	highlightedMunicipality,
	nextLayer,
	pickedPoint,
	pickPoint,
	type Shading,
	selectEntity,
	selectedEntity,
	selectedState,
	selectMunicipality,
	selectState,
	setLayer,
	shading,
	showCameras,
	showCrowd,
	showFacilities,
	showFires,
	showFlares,
	showFloods,
	showLightning,
	showPlumes,
	showQuakes,
	toggleQuakes,
	viewTime,
} from "../map/view.ts";
import { Panel } from "../ui/Panel.tsx";
import type { ConnectivityView } from "./Connectivity.tsx";
import type { FiresView } from "./Earth.tsx";
import type { EnergyView } from "./energy-view.ts";
import type { NightlightsView, SatelliteView } from "./Imagery.tsx";
import type { NewsView } from "./News.tsx";
import type { QuakesView } from "./Quakes.tsx";

// The view state lives in map/view.ts (URL-backed); re-exported for the panels that already import it from here.
export {
	nextLayer,
	type Shading,
	selectedState,
	selectState,
	setLayer,
	setViewTime,
	shading,
	showFires,
	showQuakes,
	stepViewTime,
	toggleFires,
	toggleQuakes,
	viewTime,
} from "../map/view.ts";

/** Reports layer: headlines per state in 24 h (for the selected topic), scaled to the busiest state. */
function reportFills(
	news: NewsView | undefined,
	topic: keyof typeof TOPICS | null,
): Record<string, StateFill> {
	if (!news) return {};
	const counts = Object.entries(news.byState).map(
		([iso, s]) => [iso, topic ? (s.topics[topic] ?? 0) : s.items] as const,
	);
	const max = Math.max(1, ...counts.map(([, n]) => n));
	const fills: Record<string, StateFill> = {};
	for (const [iso, n] of counts) {
		if (n === 0) continue;
		fills[iso] = {
			tone: "signal",
			intensity: Math.sqrt(n / max),
			label: t(`${n} titulares en 24 h`, `${n} headlines in 24 h`),
		};
	}
	return fills;
}

/** AI layer (only when the AI section is on): blackout reports per state, as classified by the chosen model. */
function aiBlackoutFills(
	view: { blackoutsByState: Record<string, number>; model: string | null } | undefined,
): Record<string, StateFill> {
	const fills: Record<string, StateFill> = {};
	const counts = Object.entries(view?.blackoutsByState ?? {});
	const max = Math.max(1, ...counts.map(([, n]) => n));
	for (const [iso, n] of counts) {
		fills[iso] = {
			tone: "signal",
			intensity: Math.sqrt(n / max),
			label: t(
				`${n} reportes de apagón (IA: ${view?.model ?? ""})`,
				`${n} blackout reports (AI: ${view?.model ?? ""})`,
			),
		};
	}
	return fills;
}

const TONE: Record<LevelCode, StateFill["tone"]> = { n: "ok", d: "drop", s: "severe", x: "nodata" };
const LEVEL: Record<LevelCode, "normal" | "drop" | "severe" | "no-data"> = {
	n: "normal",
	d: "drop",
	s: "severe",
	x: "no-data",
};

/** Connectivity fills at a past step, straight from the server's replay (no client arithmetic). */
function historyFills(index: number): Record<string, StateFill> {
	const h = history.value;
	const fills: Record<string, StateFill> = {};
	if (!h) return fills;
	const when = stepLabel(h.times[index] as number, h.stepMs, lang.value);
	for (const [iso, row] of Object.entries(h.states)) {
		const code = (row[index] ?? "x") as LevelCode;
		fills[iso] = { tone: TONE[code], label: `${levelLabel(LEVEL[code])} · ${when}` };
	}
	return fills;
}

const LEGENDS: Record<Shading, () => { swatch: string; label: string }[]> = {
	connectivity: () => [
		{ swatch: "ok", label: t("Normal", "Normal") },
		{ swatch: "drop", label: t("Caída de señal", "Signal drop") },
		{ swatch: "severe", label: t("Caída fuerte", "Severe drop") },
		{ swatch: "nodata", label: t("Sin datos", "No data") },
	],
	reports: () => [
		{ swatch: "signal", label: t("Más titulares (palabra clave)", "More headlines (keyword)") },
	],
	fires: () => [
		{ swatch: "signal", label: t("Más focos de calor probables, 24 h", "More likely heat spots, 24 h") },
	],
	nightlights: () => [
		{
			swatch: "light",
			label: t("Luz nocturna (NASA, noche anterior)", "Night light (NASA, previous night)"),
		},
	],
	satellite: () => [{ swatch: "sat", label: t("GOES-19 GeoColor", "GOES-19 GeoColor") }],
	aiBlackouts: () => [
		{
			swatch: "signal",
			label: t(
				"Reportes de apagón en noticias, 48 h (IA, puede equivocarse)",
				"Blackout reports in news, 48 h (AI, may be wrong)",
			),
		},
	],
};

/** Feeds behind each shading: the panel's freshness badge and the share card's footer. */
const FEEDS: Record<Shading, readonly string[]> = {
	connectivity: ["ioda-states"],
	nightlights: ["gibs-nightlights"],
	satellite: ["goes-nsa"],
	reports: [],
	fires: ["firms-fires"],
	aiBlackouts: [],
};

const LAYER_LABEL: Record<Shading, () => string> = {
	connectivity: () => t("Capa: conectividad por estado (IODA)", "Layer: connectivity by state (IODA)"),
	nightlights: () => t("Capa: luces nocturnas", "Layer: night lights"),
	satellite: () => t("Capa: satélite", "Layer: satellite"),
	reports: () =>
		t("Capa: titulares por estado, ubicados por palabra clave", "Layer: headlines by state, by keyword"),
	fires: () => t("Capa: focos de calor", "Layer: heat spots"),
	aiBlackouts: () =>
		t(
			"Capa IA: reportes de apagón clasificados por un modelo (puede equivocarse)",
			"AI layer: blackout reports classified by a model (may be wrong)",
		),
};

/** Strongest heat spots as small dots (NASA FIRMS); they fade in once, staggered, when they first appear. */
function FireDots({ view }: { view: FiresView | undefined }) {
	return (
		<g class="layer-fires">
			{(view?.strongest ?? []).map((f, i) => {
				const [x, y] = project(f.lon, f.lat);
				return (
					<g
						key={`${f.lat},${f.lon},${f.at}`}
						class="fire-mark"
						style={{ transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(var(--zk, 1))` }}
					>
						<circle r={4.5} class="fire-dot" style={{ animationDelay: `${Math.min(i, 25) * 40}ms` }} />
					</g>
				);
			})}
		</g>
	);
}

/** The point last pressed on the map: a small cross, while the inspector says what is there. */
function PickMark() {
	const p = pickedPoint.value;
	if (!p) return null;
	const [x, y] = project(p.lon, p.lat);
	return (
		// biome-ignore lint/a11y/noAriaHiddenOnFocusable: the inspector names what is at the point.
		<g
			class="pick-mark"
			aria-hidden="true"
			style={{ transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(var(--zk, 1))` }}
		>
			<path d="M-7 0h4M3 0h4M0-7v4M0 3v4" class="pick-mark__cross" />
			<circle r={1.6} class="pick-mark__dot" />
		</g>
	);
}

/** What the shortcuts and the palette may ask of the map (mirrors MapDetail in lib/keys.ts). */
type MapAction =
	| { action: "cycle-layer" }
	| { action: "toggle-quakes" }
	| { action: "share" }
	| { action: "layer"; layer: Shading }
	| { action: "municipality"; code: string; state: string };

/** The map's method text loads with the method sheet (it is not needed to draw the map). */
const MapMethodLazy = later(() => import("../map/MapMethod.tsx").then((m) => m.MapMethod));

let slider: ComponentType | null = null;
/** The history strip loads as its own chunk after first paint; its space is reserved so nothing shifts. */
function TimeSlider() {
	const [C, setC] = useState<ComponentType | null>(() => slider);
	useEffect(() => {
		if (C) return;
		Promise.all([import("../map/TimeSlider.tsx"), import("../styles/timeline.css?inline")])
			.then(([m, css]) => {
				addStyles(css.default);
				slider = m.TimeSlider;
				setC(() => m.TimeSlider);
			})
			.catch(() => {
				// Offline without the chunk cached: the live map works without its history strip.
			});
	}, [C]);
	return C ? <C /> : <div class="timeline-strip timeline-strip--loading" aria-hidden="true" />;
}

export function MapPanel() {
	const p = panels.value;
	const l = lang.value;
	const mode = shading.value;
	const topic = newsTopic.value;
	const h = history.value;
	const vt = viewTime.value;
	const pastIndex = mode === "connectivity" && h && vt !== null ? indexAt(h, vt) : -1;
	const past =
		pastIndex !== -1 && h
			? { index: pastIndex, label: stepLabel(h.times[pastIndex] as number, h.stepMs, l) }
			: null;
	const pastEnd = past && h ? (h.times[past.index] as number) + h.stepMs : null;

	const allQuakes = ((p.quakes as QuakesView | undefined)?.items ?? [])
		.filter((q) => q.zone !== "far")
		.map((q): QuakePoint => ({ id: q.id, lat: q.lat, lon: q.lon, mag: q.maxMag, at: q.at }));
	markArrivals(allQuakes, now.value);
	// A past view shows only the quakes that had happened by then.
	const quakes = pastEnd === null ? allQuakes : allQuakes.filter((q) => q.at < pastEnd);
	const fills = past
		? historyFills(past.index)
		: mode === "connectivity"
			? connectivityFills(p.connectivity as ConnectivityView | undefined)
			: mode === "fires"
				? fireFills(p.fires as FiresView | undefined)
				: mode === "reports"
					? reportFills(p.news as NewsView | undefined, topic)
					: mode === "aiBlackouts"
						? aiBlackoutFills(
								p.ai as { blackoutsByState: Record<string, number>; model: string | null } | undefined,
							)
						: {};
	const underlay =
		mode === "satellite" ? <SatelliteUnderlay /> : mode === "nightlights" ? <NightUnderlay /> : null;

	// CSS px per map unit at full view, for the magnitude legend (circles drawn at the map's own scale).
	const stageRef = useRef<HTMLDivElement>(null);
	const [unit, setUnit] = useState(0.5);
	useLayoutEffect(() => {
		const el = stageRef.current;
		if (!el) return;
		const measure = () => setUnit((el.querySelector("svg")?.clientWidth ?? 700) / FRAME.width);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const raster = (() => {
		if (mode === "satellite") {
			const v = p.satellite as SatelliteView | undefined;
			const i = satelliteFrame.value ?? (v?.frames.length ?? 1) - 1;
			const frame = v?.frames[Math.min(i, (v?.frames.length ?? 1) - 1)];
			return v?.bounds && frame ? { url: frame.url, bounds: v.bounds, blend: false } : undefined;
		}
		if (mode === "nightlights") {
			const v = p.nightlights as NightlightsView | undefined;
			return v?.image ? { url: v.image.url, bounds: v.image.bounds, blend: true } : undefined;
		}
		return undefined;
	})();
	// Every source the card shows: the layer's, the quakes', and those behind each clause of the Ahora sentence.
	// The same clauses as the page's Ahora line, gated on their feeds' freshness; stale anomalies carry their age.
	const clauses = past ? [] : currentClauses(p as HeadlineInput, healthById.value, now.value, l);
	const cardFeeds = [
		...new Set([
			...FEEDS[mode],
			...clauseFeeds(clauses),
			...(showQuakes.value ? ["usgs-quakes", "funvisis-quakes"] : []),
		]),
	];
	const makeMapCard = async () =>
		(await import("../lib/share.ts")).mapCard({
			clauses: past
				? [
						{
							text: t(`Internet por estado, ${past.label}`, `Internet by state, ${past.label}`),
							href: "#mapa",
							tone: "normal",
							feeds: ["ioda-states"],
						},
					]
				: clauses.map((c) => ({ ...c, text: clauseText(c, now.value, l) })),
			fills,
			quakes: showQuakes.value ? quakes : [],
			layerLabel: LAYER_LABEL[mode](),
			feeds: cardFeeds,
			...(raster ? { raster } : {}),
			...(past
				? {
						pastLabel: t(
							`Viendo: ${past.label} · datos de ese momento`,
							`Viewing: ${past.label} · data from that time`,
						),
					}
				: {}),
			now: now.value,
			lang: l,
		});

	// Keyboard shortcuts and the palette ask the map through a cancelable "vigia:map" event (lib/keys.ts).
	const shareRef = useRef(makeMapCard);
	shareRef.current = makeMapCard;
	useEffect(() => {
		const onMap = (e: Event) => {
			const d = (e as CustomEvent<MapAction>).detail;
			switch (d?.action) {
				case "cycle-layer":
					nextLayer((id) => !layerInfo().find((x) => x.id === id)?.locked);
					break;
				case "toggle-quakes":
					toggleQuakes();
					break;
				case "layer":
					setLayer(d.layer);
					break;
				case "municipality":
					selectMunicipality(d.code, d.state);
					break;
				case "share":
					void import("../map/ShareMenu.tsx").then((m) => m.shareCard("map", shareRef.current));
					break;
				default:
					return;
			}
			e.preventDefault();
		};
		addEventListener("vigia:map", onMap);
		return () => removeEventListener("vigia:map", onMap);
	}, []);

	return (
		<Panel
			id="mapa"
			class={`panel--map${past ? " is-past" : ""}`}
			title={t("Venezuela ahora", "Venezuela now")}
			feeds={FEEDS[mode]}
			question={t("¿Qué pasa en cada estado?", "What is happening in each state?")}
			method={<MapMethodLazy />}
		>
			<div class="mapview">
				<div class="mapview__stage" ref={stageRef}>
					<VenezuelaMap
						fills={fills}
						underlay={underlay}
						selected={selectedState.value}
						onSelect={selectState}
						highlight={highlightedMunicipality.value}
						onPoint={(lon, lat) => pickPoint(lat, lon)}
						past={Boolean(past)}
						flashKey={past ? null : mode}
						banner={
							past ? (
								<p class="map-past" role="status">
									<strong>{t("Viendo", "Viewing")}:</strong> {past.label} ·{" "}
									{t("datos de ese momento", "data from that time")}
								</p>
							) : null
						}
						layers={() => (
							<>
								{showFacilities.value || selectedEntity.value?.startsWith("infra.") ? (
									<FacilityLayer
										selected={selectedEntity.value}
										onSelect={(f) => selectEntity(f.id, f.iso)}
										only={!showFacilities.value}
									/>
								) : null}
								{/* Reports (the last 2 h) and the newest flood day are not of a replayed hour: live map only. */}
								{showFloods.value && !past ? <FloodLayer /> : null}
								{showCrowd.value && !past ? <CrowdLayer /> : null}
								{showPlumes.value ? <PlumeLayer before={pastEnd} /> : null}
								{showLightning.value ? <LightningLayer /> : null}
								{showFlares.value ? <FlareLayer view={p.energy as EnergyView | undefined} /> : null}
								{showFires.value ? <FireDots view={p.fires as FiresView | undefined} /> : null}
								{showQuakes.value ? <QuakeLayer items={quakes} now={now.value} /> : null}
								{showCameras.value ? <CameraLayer /> : null}
								<PickMark />
							</>
						)}
					/>
					{mode === "connectivity" ? <TimeSlider /> : null}
					{showCameras.value ? (
						<div class="map-under">
							<CameraStrip />
						</div>
					) : null}
					{mode === "satellite" ? (
						<div class="map-under">
							<SatelliteControls />
						</div>
					) : null}
				</div>
				<LayerList
					unit={unit}
					legend={
						<ul class="map-legend">
							{LEGENDS[mode]().map((x) => (
								<li key={x.label}>
									<span class={`map-legend__swatch map-legend__swatch--${x.swatch}`} />
									{x.label}
								</li>
							))}
							{mode === "reports" && topic ? (
								<li>
									{t("Tema", "Topic")}: {TOPICS[topic][l]}
								</li>
							) : null}
						</ul>
					}
					footer={<ShareMenu mapCard={makeMapCard} />}
				/>
			</div>
		</Panel>
	);
}
