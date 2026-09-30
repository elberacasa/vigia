import { useEffect, useState } from "preact/hooks";
import { addStyles } from "../lib/css.ts";
import { now, panels, wantPanel } from "../lib/data.ts";
import { ago, clock, int, num, stamp } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { PANEL_META } from "../lib/panel-meta.ts";
import { registerSummary } from "../lib/summary.ts";
import { selectedState, selectState } from "../map/view.ts";
import lightningCss from "../styles/lightning.css?inline";
import { Panel } from "../ui/Panel.tsx";
import { SourceTag } from "../ui/Source.tsx";
import { barHeight, coverage, type LightningView, slots, WINDOW_MS } from "./lightning-view.ts";

addStyles(lightningCss);

/**
 * "Rayos": lightning flashes GOES-19's GLM detected over Venezuela, from the server's 15-minute windows (the view is
 * fetched when the panel opens). Every figure is the server's count; the panel only lays it out. It always says
 * what it counts: flashes a satellite detected, not every lightning strike, and only good-quality ones.
 */

/** "Detectados por GLM, no todos los rayos": said on screen every time, not only in the "?" sheet. */
function Caveat() {
	return (
		<p class="lx-caveat">
			{t(
				"Destellos detectados por el satélite GOES-19 (GLM): no todos los rayos, y solo los de buena calidad.",
				"Flashes detected by the GOES-19 satellite (GLM): not every lightning strike, and only good-quality ones.",
			)}
		</p>
	);
}

function Fig(props: { label: string; value: string; unit?: string; note?: string; muted?: boolean }) {
	return (
		<div class="lx-fig">
			<dt>{props.label}</dt>
			<dd>
				<span class={`lx-fig__v${props.muted ? " lx-fig__v--muted" : ""}`}>{props.value}</span>
				{props.unit ? <span class="lx-fig__u"> {props.unit}</span> : null}
				{props.note ? <span class="lx-fig__note">{props.note}</span> : null}
			</dd>
		</div>
	);
}

/** 96 bars of 15 minutes: Venezuela, with Catatumbo's share drawn inside; unread windows are gaps, partial ones dotted. */
function Bars({ view }: { view: LightningView }) {
	const l = lang.value;
	const s = slots(view.series24h, view.now);
	const max = Math.max(0, ...view.series24h.map((p) => p.venezuela));
	const W = 96 * 4;
	const H = 56;
	const first = s[0]?.start ?? 0;
	const last = (s.at(-1)?.start ?? 0) + WINDOW_MS;
	const peak = view.series24h.reduce<(typeof view.series24h)[number] | null>(
		(m, p) => (!m || p.venezuela > m.venezuela ? p : m),
		null,
	);
	const summary = peak
		? t(
				`${view.last24h.windowsRead} de ${view.last24h.windowsExpected} ventanas de 15 min leídas; la de más destellos, ${clock(peak.windowStart, "es")}, con ${int(peak.venezuela, "es")}.`,
				`${view.last24h.windowsRead} of ${view.last24h.windowsExpected} 15-min windows read; the busiest, ${clock(peak.windowStart, "en")}, with ${int(peak.venezuela, "en")}.`,
			)
		: t("Ninguna ventana de 15 min leída todavía.", "No 15-min window read yet.");
	return (
		<figure class="lx-bars">
			<figcaption class="lx-h">
				{t("Destellos cada 15 min, 24 h", "Flashes every 15 min, 24 h")}
				<span class="lx-h__max data">{max ? t(`máx. ${int(max, l)}`, `max ${int(max, l)}`) : ""}</span>
			</figcaption>
			<svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
				{s.map((slot, i) => {
					const x = i * 4;
					if (!slot.point) return null;
					const h = barHeight(slot.point.venezuela, max) * (H - 2);
					const hc = barHeight(slot.point.catatumbo, max) * (H - 2);
					return (
						<g key={slot.start} class={slot.point.complete ? "" : "lx-bar--partial"}>
							<rect x={x} y={0} width={3} height={H} class="lx-bar__read" />
							{h > 0 ? <rect x={x} y={H - h} width={3} height={h} class="lx-bar" /> : null}
							{hc > 0 ? <rect x={x} y={H - hc} width={3} height={hc} class="lx-bar--cat" /> : null}
							{h === 0 ? <rect x={x} y={H - 1} width={3} height={1} class="lx-bar" /> : null}
						</g>
					);
				})}
			</svg>
			<div class="lx-axis data">
				<span>{stamp(first, l, now.value)}</span>
				<span>{clock(last, l)}</span>
			</div>
			<p class="lx-key">
				<span class="lx-key__i lx-key__i--vz" aria-hidden="true" />
				{t("Venezuela", "Venezuela")}
				<span class="lx-key__i lx-key__i--cat" aria-hidden="true" />
				{t("Catatumbo", "Catatumbo")}
				<span class="lx-key__i lx-key__i--read" aria-hidden="true" />
				{t("ventana leída (hueco: sin leer)", "window read (gap: not read)")}
				{view.last24h.incomplete ? (
					<>
						<span class="lx-key__i lx-key__i--partial" aria-hidden="true" />
						{t("con archivos faltantes", "with files missing")}
					</>
				) : null}
			</p>
			<p class="sr-only">{summary}</p>
		</figure>
	);
}

function StatesTable({ view }: { view: LightningView }) {
	const l = lang.value;
	const sel = selectedState.value;
	if (!view.states.length)
		return (
			<p class="lx-empty">
				{t(
					"Ningún destello en tierra venezolana en las ventanas leídas.",
					"No flash over Venezuelan land in the windows read.",
				)}
			</p>
		);
	return (
		<table class="lx-table">
			<caption class="lx-h">{t("Por estado", "By state")}</caption>
			<thead>
				<tr>
					<th scope="col">{t("Estado", "State")}</th>
					<th scope="col">{t("Última hora", "Last hour")}</th>
					<th scope="col">24 h</th>
					<th scope="col" title={view.densityLabel}>
						{t("Densidad*", "Density*")}
					</th>
				</tr>
			</thead>
			<tbody>
				{view.states.map((s) => (
					<tr key={s.iso} class={sel === s.iso ? "is-selected" : ""}>
						<th scope="row">
							<button type="button" class="lx-state" onClick={() => selectState(s.iso)}>
								{s.name}
							</button>
						</th>
						<td class="data">{view.lastHour ? int(s.lastHour, l) : "—"}</td>
						<td class="data">{int(s.last24h, l)}</td>
						<td class="data">{num(s.density24h, 2, l)}</td>
					</tr>
				))}
			</tbody>
			<tfoot>
				<tr>
					<td colSpan={4}>
						{t(
							"* destellos por 1.000 km² por hora leída en 24 h, calculado por Vigía (destellos ÷ superficie ÷ horas leídas).",
							"* flashes per 1,000 km² per hour read over 24 h, calculated by Vigía (flashes ÷ area ÷ hours read).",
						)}
					</td>
				</tr>
			</tfoot>
		</table>
	);
}

export function LightningPanel() {
	const view = panels.value.lightning as LightningView | undefined;
	const [failed, setFailed] = useState(false);
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		let live = true;
		wantPanel("lightning").catch(() => {
			if (live) setFailed(true);
		});
		return () => {
			live = false;
		};
	}, [attempt]);
	const l = lang.value;
	const meta = PANEL_META.rayos;
	const cov = view ? coverage(view.last24h) : "none";
	const h = view?.lastHour ?? null;
	return (
		<Panel
			id="rayos"
			class="panel--lightning"
			title={meta.title()}
			question={meta.question()}
			feeds={meta.feeds()}
			ready={failed || view !== undefined}
			method={
				<>
					<p>{view?.label ?? ""}</p>
					<p>
						{t(
							"GLM, a bordo del satélite GOES-19 de NOAA, ve desde el espacio los destellos de las tormentas, de día y de noche. No ve todos los rayos (su tasa de detección baja con nubes muy densas y en los bordes de su vista) y Vigía cuenta solo los que el satélite marca de buena calidad. Vigía lee sus archivos de 20 s en ventanas de 15 min: una ventana sin todos sus archivos se cuenta y se marca como incompleta.",
							"GLM, aboard NOAA's GOES-19 satellite, sees storms' flashes from space, day and night. It does not see every strike (its detection rate drops under very dense cloud and at the edge of its view), and Vigía counts only the ones the satellite flags as good quality. Vigía reads its 20-s files in 15-min windows: a window without all its files is counted and marked incomplete.",
						)}
					</p>
					<p>
						{t(
							"«Última hora»: las cuatro ventanas más recientes, solo si son seguidas y recientes; si no, no se da la cifra. «Catatumbo»: el recuadro del relámpago del Catatumbo, al suroeste del lago de Maracaibo. Densidad: ",
							"“Last hour”: the four newest windows, only when consecutive and recent; otherwise no figure is given. “Catatumbo”: the box of the Catatumbo lightning, south-west of Lake Maracaibo. Density: ",
						)}
						{view?.densityLabel ?? ""}.
					</p>
				</>
			}
		>
			{failed && !view ? (
				<p class="lx-empty">
					{t("No se pudieron cargar los datos de rayos.", "The lightning data could not be loaded.")}{" "}
					<button
						type="button"
						class="link-button"
						onClick={() => {
							setFailed(false);
							setAttempt((a) => a + 1);
						}}
					>
						{t("Reintentar", "Retry")}
					</button>
				</p>
			) : view ? (
				<div class="lx">
					<Caveat />
					<div class="lx-status">
						{view.stale ? (
							<span class="lx-badge lx-badge--stale">
								{t("Desactualizado", "Out of date")}
								{view.newest ? (
									<span class="data">
										{" "}
										· {t("última ventana", "last window")} {ago(now.value - view.newest.windowStart, l)}
									</span>
								) : null}
							</span>
						) : null}
						{cov === "partial" ? (
							<span
								class="lx-badge lx-badge--partial"
								title={t(
									"Faltan ventanas de 15 min o archivos de GLM en las últimas 24 h: las sumas de 24 h son menores que lo detectado.",
									"15-min windows or GLM files are missing in the last 24 h: the 24-h sums are below what was detected.",
								)}
							>
								{t("Incompleto", "Incomplete")}
							</span>
						) : null}
						<span class="lx-cover data">
							{t(
								`${view.last24h.windowsRead} de ${view.last24h.windowsExpected} ventanas leídas`,
								`${view.last24h.windowsRead} of ${view.last24h.windowsExpected} windows read`,
							)}
							{view.last24h.incomplete
								? t(
										` · ${view.last24h.incomplete} con archivos faltantes`,
										` · ${view.last24h.incomplete} with files missing`,
									)
								: ""}
						</span>
					</div>
					{cov === "none" ? (
						<p class="lx-empty">
							{t(
								"Aún no hay ventanas de 15 min leídas: la primera llega unos 20 min después de cerrar.",
								"No 15-min window read yet: the first arrives about 20 min after it closes.",
							)}
						</p>
					) : (
						<>
							<dl class="lx-figs">
								<Fig
									label={t("Venezuela, última hora", "Venezuela, last hour")}
									value={h ? int(h.venezuela, l) : "—"}
									muted={!h}
									note={
										h
											? `${clock(h.from, l)}–${clock(h.to, l)}${h.complete ? "" : t(" · incompleta", " · incomplete")}`
											: t("sin una hora seguida y reciente", "no recent consecutive hour")
									}
								/>
								<Fig
									label={t("Venezuela, 24 h", "Venezuela, 24 h")}
									value={int(view.last24h.venezuela, l)}
									note={t("destellos en las ventanas leídas", "flashes in the windows read")}
								/>
							</dl>
							<section class="lx-cat" aria-labelledby="lx-cat-h">
								<h3 class="lx-h" id="lx-cat-h">
									{t("Catatumbo", "Catatumbo")}
									<span class="lx-h__note">
										{t("relámpago del Catatumbo, Zulia", "Catatumbo lightning, Zulia")}
									</span>
								</h3>
								<dl class="lx-figs lx-figs--cat">
									<Fig
										label={t("Última hora", "Last hour")}
										value={h ? int(h.catatumbo, l) : "—"}
										muted={!h}
									/>
									<Fig label="24 h" value={int(view.last24h.catatumbo, l)} />
									<Fig
										label={t("Sobre el lago, última hora", "Over the lake, last hour")}
										value={h ? int(h.lake, l) : "—"}
										muted={!h}
									/>
								</dl>
							</section>
							<Bars view={view} />
							<StatesTable view={view} />
						</>
					)}
					<div class="sources-row">
						{view.newest ? (
							<SourceTag
								source={{
									feed: view.feed,
									observedAt: view.newest.windowStart,
									url: view.sourceUrl,
									detail: t(
										`ventana de 15 min que empieza ${clock(view.newest.windowStart, l)}`,
										`15-min window starting ${clock(view.newest.windowStart, l)}`,
									),
								}}
								label="NOAA GOES-19 GLM"
							/>
						) : null}
					</div>
				</div>
			) : null}
		</Panel>
	);
}

registerSummary("rayos", () => {
	const v = panels.value.lightning as LightningView | undefined;
	if (!v?.lastHour) return null;
	const l = lang.value;
	return {
		text: t(
			`${int(v.lastHour.venezuela, l)} destellos detectados por GLM entre las ${clock(v.lastHour.from, l)} y las ${clock(v.lastHour.to, l)} (${int(v.lastHour.catatumbo, l)} en el Catatumbo)`,
			`${int(v.lastHour.venezuela, l)} flashes detected by GLM from ${clock(v.lastHour.from, l)} to ${clock(v.lastHour.to, l)} (${int(v.lastHour.catatumbo, l)} at Catatumbo)`,
		),
		tone: "normal",
	};
});
