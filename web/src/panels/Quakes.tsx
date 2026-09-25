import { useState } from "preact/hooks";
import { addStyles } from "../lib/css.ts";
import { now, panels } from "../lib/data.ts";
import { ago, int, num, stamp } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { PANEL_META } from "../lib/panel-meta.ts";
import { useFresh } from "../lib/seen.ts";
import panelsCss from "../styles/panels.css?inline";
import { Digits, NewPill, NewTag } from "../ui/Digits.tsx";
import { Panel } from "../ui/Panel.tsx";
import { SourceTag } from "../ui/Source.tsx";

addStyles(panelsCss);

/** Mirrors src/panels/quakes.ts. Each source's magnitude is shown as published, side by side, never blended. */
interface QuakeReading {
	feed: string;
	label: "USGS" | "FUNVISIS";
	at: number;
	mag: number;
	magType: string | null;
	depthKm: number | null;
	sourcePlace: string | null;
	status: string;
	url: string;
}
export interface QuakeRow {
	id: string;
	at: number;
	lat: number;
	lon: number;
	zone: "venezuela" | "near" | "far";
	state: string | null;
	stateName: string | null;
	country: string | null;
	placeEs: string;
	usgs: QuakeReading | null;
	funvisis: QuakeReading | null;
	maxMag: number;
	feltSize: boolean;
	felt: number | null;
	tsunami: boolean;
	feltReportUrl: string;
}
interface QuakeWindow {
	venezuela: number;
	near: number;
	feltSize: number;
	funvisisComplete: boolean;
}
export interface QuakesView {
	items: QuakeRow[];
	windows: { day: QuakeWindow; week: QuakeWindow; month: QuakeWindow };
	counts: { day: number; week: number; month: number };
	strongestWeek: QuakeRow | null;
	reference: {
		titleEs: string;
		titleEn: string;
		events: { id: string; mag: number; magType: string; at: number; placeText: string; url: string }[];
		daysSince: number;
		sequence: { noteEs: string };
	};
	coverage: { usgsNoteEs: string; funvisisNoteEs: string };
	matchRule: { noteEs: string };
}

function Reading({ r }: { r: QuakeReading }) {
	const l = lang.value;
	return (
		<a
			class={`reading reading--${r.label.toLowerCase()}`}
			href={r.url}
			target="_blank"
			rel="noopener noreferrer"
		>
			<span class="reading__who">{r.label}</span>
			<span class="reading__mag data">{num(r.mag, 1, l)}</span>
			{r.magType ? <span class="reading__type">{r.magType}</span> : null}
		</a>
	);
}

function WindowFigure({ label, w }: { label: string; w: QuakeWindow }) {
	const l = lang.value;
	return (
		<div class="figure">
			<span class="figure__label">{label}</span>
			<span class="figure__value">
				<Digits
					value={int(w.venezuela + w.near, l)}
					raw={w.venezuela + w.near}
					label={`${t("Sismos", "Quakes")}, ${label}`}
					announce={false}
				/>
			</span>
			<span class="note">
				{int(w.venezuela, l)} {t("en Venezuela", "in Venezuela")} · {int(w.near, l)} {t("cerca", "nearby")}
				{w.funvisisComplete ? "" : " *"}
			</span>
		</div>
	);
}

export function QuakesPanel() {
	const view = panels.value.quakes as QuakesView | undefined;
	const [showFar, setShowFar] = useState(false);
	const l = lang.value;
	const rows = (view?.items ?? []).filter((q) => showFar || q.zone !== "far").slice(0, 12);
	const incomplete = view ? !view.windows.month.funvisisComplete : false;
	// Rows new to this device get the "nuevo" mark (all quakes in the list, so hiding far ones changes nothing).
	const quakeAt = new Map((view?.items ?? []).map((q) => [q.id, q.at]));
	const fresh = useFresh(
		"quakes",
		(view?.items ?? []).map((q) => q.id),
		(id) => quakeAt.get(id),
	);
	return (
		<Panel
			id="sismos"
			title={PANEL_META.sismos.title()}
			question={PANEL_META.sismos.question()}
			feeds={PANEL_META.sismos.feeds()}
			extra={<NewPill scope="quakes" panel="sismos" />}
			foot={
				view ? (
					<>
						<span>{view.matchRule.noteEs}</span>
						<span>{view.coverage.usgsNoteEs}</span>
					</>
				) : null
			}
		>
			{!view ? (
				<p class="skeleton">…</p>
			) : (
				<>
					<div class="stat-row">
						<WindowFigure label={t("Últimas 24 h", "Last 24 h")} w={view.windows.day} />
						<WindowFigure label={t("7 días", "7 days")} w={view.windows.week} />
						<WindowFigure label={t("30 días", "30 days")} w={view.windows.month} />
					</div>
					{incomplete ? <p class="note">* {view.coverage.funvisisNoteEs}</p> : null}
					<ul class="quakes">
						{rows.map((q) => (
							<li
								class={`quake-row quake-row--${q.zone}${q.feltSize ? " is-felt" : ""}${fresh.has(q.id) ? " is-new" : ""}`}
								key={q.id}
							>
								<div class="quake-row__mags">
									{q.usgs ? <Reading r={q.usgs} /> : null}
									{q.funvisis ? <Reading r={q.funvisis} /> : null}
								</div>
								<div class="quake-row__main">
									<span class="quake-row__place">
										{fresh.has(q.id) ? <NewTag /> : null}
										{q.placeEs}
									</span>
									<span class="note data">
										{stamp(q.at, l)} · {ago(now.value - q.at, l)}
										{(q.usgs ?? q.funvisis)?.depthKm !== null && (q.usgs ?? q.funvisis)?.depthKm !== undefined
											? ` · ${int((q.usgs ?? q.funvisis)?.depthKm ?? 0, l)} km ${t("prof.", "deep")}`
											: ""}
										{q.felt ? ` · ${int(q.felt, l)} ${t("reportes de sentido", "felt reports")}` : ""}
									</span>
								</div>
								<a class="quake-row__felt" href={q.feltReportUrl} target="_blank" rel="noopener noreferrer">
									{t("¿Lo sentiste?", "Felt it?")}
								</a>
							</li>
						))}
					</ul>
					<label class="toggle note">
						<input type="checkbox" checked={showFar} onChange={() => setShowFar(!showFar)} />{" "}
						{t(
							"Mostrar también los lejanos (Colombia, Caribe)",
							"Also show distant ones (Colombia, Caribbean)",
						)}
					</label>
					<details class="reference">
						<summary>
							{l === "es" ? view.reference.titleEs : view.reference.titleEn} ·{" "}
							{t(`hace ${view.reference.daysSince} días`, `${view.reference.daysSince} days ago`)}
						</summary>
						<ul>
							{view.reference.events.map((e) => (
								<li key={e.id}>
									<a href={e.url} target="_blank" rel="noopener noreferrer">
										M{num(e.mag, 1, l)} {e.magType} · {e.placeText}
									</a>{" "}
									<span class="note data">{stamp(e.at, l)}</span>
								</li>
							))}
						</ul>
						<p class="note">{view.reference.sequence.noteEs}</p>
					</details>
					<div class="sources-row">
						{view.items[0]?.usgs ? (
							<SourceTag
								source={{
									feed: "usgs-quakes",
									observedAt: view.items[0].usgs.at,
									url: view.items[0].usgs.url,
								}}
							/>
						) : null}
						{view.items.find((q) => q.funvisis)?.funvisis ? (
							<SourceTag
								source={{
									feed: "funvisis-quakes",
									observedAt: view.items.find((q) => q.funvisis)?.funvisis?.at ?? 0,
									url: "http://www.funvisis.gob.ve/",
								}}
							/>
						) : null}
					</div>
				</>
			)}
		</Panel>
	);
}
