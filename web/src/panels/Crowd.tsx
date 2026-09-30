import { useEffect, useState } from "preact/hooks";
import { crowdConfig, loadCrowdConfig } from "../lib/crowd.ts";
import {
	type CrowdItem,
	type CrowdPlace,
	type CrowdView,
	crowdPlaces,
	heldText,
	withoutHeld,
} from "../lib/crowd-view.ts";
import { addStyles } from "../lib/css.ts";
import { now, panels, wantPanel } from "../lib/data.ts";
import { ago, int } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { PANEL_META } from "../lib/panel-meta.ts";
import { entityLink } from "../lib/router.ts";
import { stateName } from "../lib/states.ts";
import { registerSummary } from "../lib/summary.ts";
import { selectedState, selectState } from "../map/view.ts";
import crowdCss from "../styles/crowd.css?inline";
import { ReportButton } from "../ui/crowd/Entry.tsx";
import { Panel } from "../ui/Panel.tsx";

addStyles(crowdCss);

/*
 * "Reportes de usuarios": what people told this Vigía about their power, water, internet and fuel in the last two
 * hours, per municipality and per state, counted by code (src/crowd). Always the words "reportes de usuarios" and
 * the count; never a percentage, never "sin luz en X", never a measurement's colours. A figure with held reports
 * says "posible manipulación" with what was held, by answer. The view is on demand (fetched when the panel opens).
 */

function useCrowd(): { view: CrowdView | undefined; failed: boolean } {
	const view = panels.value.crowd as CrowdView | undefined;
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		wantPanel("crowd").catch(() => setFailed(true));
		void loadCrowdConfig();
	}, []);
	return { view, failed: failed && !view };
}

function Row({ p }: { p: CrowdPlace }) {
	const l = lang.value;
	const n = now.value;
	const where = p.level === "municipality" ? `${p.name} · ${p.stateName ?? stateName(p.state)}` : p.name;
	return (
		<li class="crowd__row">
			<span class="crowd__place">
				{p.level === "municipality" ? <a {...entityLink(p.entity)}>{where}</a> : where}
			</span>
			{p.items.map((it: CrowdItem) => {
				const held = it.flagged ? heldText(it.heldAnswers, l) : null;
				return (
					<span class="crowd__text" key={it.service}>
						<strong>{it.serviceName[l]}</strong>: {held ? withoutHeld(it.text[l]) : it.text[l]}
						{held ? (
							<>
								{" "}
								<span class="crowd__held">{held}</span>
							</>
						) : null}
					</span>
				);
			})}
			<span class="crowd__meta">
				<span class="crowd__tag">{t("reportes de usuarios", "user reports")}</span>
				<span>{t("sin verificar", "unverified")}</span>
				<span class="mono">{ago(n - p.newest, l)}</span>
				{p.stale ? <span class="crowd__stale">{t("desactualizado", "out of date")}</span> : null}
			</span>
		</li>
	);
}

export function CrowdPanel() {
	const { view, failed } = useCrowd();
	const l = lang.value;
	const meta = PANEL_META.reportes;
	const iso = selectedState.value;
	const config = crowdConfig.value;
	const off = config?.enabled === false;
	const n = now.value;
	const munis = view ? crowdPlaces(view.municipalities, l, n) : [];
	const states = view ? crowdPlaces(view.states, l, n) : [];
	const shownMunis = iso ? munis.filter((m) => m.state === iso) : munis;
	const hours = Math.round((view?.windowMs ?? 7_200_000) / 3_600_000);
	return (
		<Panel
			id="reportes"
			title={meta.title()}
			question={meta.question()}
			feeds={meta.feeds()}
			ready={failed || view !== undefined}
			method={
				<>
					{(view?.rules[l] ?? config?.rules[l] ?? []).map((r) => (
						<p key={r}>{r}</p>
					))}
					{config ? (
						<>
							<p>
								<strong>{t("Qué se guarda", "What is kept")}</strong>
							</p>
							{config.stored[l].map((r) => (
								<p key={r}>{r}</p>
							))}
						</>
					) : null}
				</>
			}
		>
			{failed ? (
				<p class="empty">
					{t(
						"No se pudieron cargar los reportes de usuarios (se piden al abrir este panel).",
						"The user reports could not be loaded (they are fetched when this panel opens).",
					)}
				</p>
			) : null}
			{view ? (
				<div class="crowd">
					<div class="crowd__lead">
						<p class="crowd__note">
							{view.counts.reports
								? t(
										`${int(view.counts.reports, l)} ${view.counts.reports === 1 ? "respuesta" : "respuestas"} de usuarios en ${int(view.counts.municipalities, l)} ${view.counts.municipalities === 1 ? "municipio" : "municipios"}, últimas ${hours} h. Reportes, no una medición: cada fila dice cuántos y de cuándo.`,
										`${int(view.counts.reports, l)} user ${view.counts.reports === 1 ? "answer" : "answers"} in ${int(view.counts.municipalities, l)} ${view.counts.municipalities === 1 ? "municipality" : "municipalities"}, last ${hours} h. Reports, not a measurement: each row says how many and when.`,
									)
								: off
									? t(
											"Este Vigía no recibe reportes de usuarios: quien lo administra los apagó.",
											"This Vigía does not take user reports: whoever runs it turned them off.",
										)
									: t(
											`Nadie ha reportado aquí en las últimas ${hours} h. Eso no dice que haya servicio: son reportes voluntarios, no una medición.`,
											`Nobody has reported here in the last ${hours} h. That does not say there is service: these are voluntary reports, not a measurement.`,
										)}
						</p>
						<ReportButton />
					</div>
					{view.counts.flagged ? (
						<p class="crowd__note">
							{t(
								`${int(view.counts.flagged, l)} con posible manipulación: los reportes que pasan del techo de su municipio se retienen y no se cuentan.`,
								`${int(view.counts.flagged, l)} with possible manipulation: reports past their municipality's ceiling are held and not counted.`,
							)}
						</p>
					) : null}
					{iso ? (
						<p class="crowd__note">
							{t(`Municipios de ${stateName(iso)}.`, `Municipalities of ${stateName(iso)}.`)}{" "}
							<button type="button" class="link-button" onClick={() => selectState(null)}>
								{t("Ver todo el país", "Show the whole country")}
							</button>
						</p>
					) : null}
					{shownMunis.length ? (
						<ul class="crowd__list" aria-label={t("Por municipio", "By municipality")}>
							{shownMunis.map((p) => (
								<Row key={p.entity} p={p} />
							))}
						</ul>
					) : null}
					{states.length && !iso ? (
						<>
							<h3 class="crowd__h">
								{t(
									"Por estado (suma de sus municipios que se muestran)",
									"By state (sum of its shown municipalities)",
								)}
							</h3>
							<ul class="crowd__list" aria-label={t("Por estado", "By state")}>
								{states.map((p) => (
									<Row key={p.entity} p={p} />
								))}
							</ul>
						</>
					) : null}
					<p class="crowd__note">
						{t("Fuente", "Source")}:{" "}
						{l === "es" ? view.source.attribution : "Anonymous user reports to this Vigía"} ·{" "}
						<a href={view.source.licenceUrl} target="_blank" rel="noopener noreferrer">
							CC0
						</a>{" "}
					</p>
				</div>
			) : null}
		</Panel>
	);
}

registerSummary("reportes", () => {
	const v = panels.value.crowd as CrowdView | undefined;
	if (!v) return null;
	const l = lang.value;
	return {
		text: v.counts.reports
			? t(
					`${int(v.counts.reports, l)} respuestas de usuarios en ${int(v.counts.municipalities, l)} municipios, 2 h`,
					`${int(v.counts.reports, l)} user answers in ${int(v.counts.municipalities, l)} municipalities, 2 h`,
				)
			: t("Ningún reporte de usuarios en 2 h", "No user reports in 2 h"),
		tone: "normal",
	};
});
