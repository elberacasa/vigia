import { useEffect, useState } from "preact/hooks";
import { type AnomaliesView, countsLine, listLine } from "../lib/anomaly-view.ts";
import { panels, wantPanel } from "../lib/data.ts";
import { int } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { PANEL_META } from "../lib/panel-meta.ts";
import { registerSummary } from "../lib/summary.ts";
import { AnomalyList } from "../ui/Anomalies.tsx";
import { Panel } from "../ui/Panel.tsx";

/*
 * "Lo inusual ahora": the newest reading of every numeric series (235 on a full archive: IODA per state and network,
 * night lights, the BCV's rates and reserves, parallel quotes, oil, Tor, Wikipedia, fires, GDELT, headlines,
 * lightning) judged against its own history by fixed rules, computed by Vigía (src/intel/anomaly.ts). Ranked by
 * the server (regional drops as one item with each state's own figure, moves the BCV took back last). When nothing
 * is unusual, the panel says how many series could be judged and why the others could not: never "todo normal".
 */

const CLASS_WORD: Record<string, { es: string; en: string }> = {
	connectivity: { es: "conectividad", en: "connectivity" },
	night: { es: "luces nocturnas", en: "night lights" },
	change: { es: "tasas y precios", en: "rates and prices" },
	level: { es: "Tor y Wikipedia", en: "Tor and Wikipedia" },
	count: { es: "conteos diarios", en: "daily counts" },
	hourly: { es: "rayos por hora", en: "hourly lightning" },
};

function useAnomalies(): { view: AnomaliesView | undefined; failed: boolean } {
	const view = panels.value.anomalies as AnomaliesView | undefined;
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		wantPanel("anomalies").catch(() => setFailed(true));
	}, []);
	return { view, failed: failed && !view };
}

export function UnusualPanel() {
	const { view, failed } = useAnomalies();
	const l = lang.value;
	const meta = PANEL_META.inusual;
	return (
		<Panel
			id="inusual"
			title={meta.title()}
			question={meta.question()}
			feeds={meta.feeds()}
			ready={failed || view !== undefined}
			method={view ? view.rules[l].map((r) => <p key={r}>{r}</p>) : undefined}
		>
			{failed ? (
				<p class="empty">
					{t(
						"No se pudo cargar la lista (se pide al abrir este panel).",
						"The list could not be loaded (it is fetched when this panel opens).",
					)}
				</p>
			) : null}
			{view ? (
				<div class="unusual">
					<p class="an-empty">{listLine(view, l)}</p>
					{view.items.length ? <AnomalyList items={view.items} /> : null}
					<p class="an-counts">
						{t("Calculado por Vigía sobre", "Computed by Vigía over")} {countsLine(view.counts, l)}.
						{view.counts.regions
							? t(
									` ${int(view.counts.regions, l)} caída regional agrupa ${int(view.counts.grouped, l)} lecturas por estado.`,
									` ${int(view.counts.regions, l)} regional drop groups ${int(view.counts.grouped, l)} state readings.`,
								)
							: ""}
					</p>
					<ul class="an-classes" aria-label={t("Por clase de serie", "By kind of series")}>
						{Object.entries(view.counts.byClass).map(([k, c]) => (
							<li key={k}>
								{CLASS_WORD[k]?.[l] ?? k}{" "}
								<span class="mono">
									{int(c.judged, l)}/{int(c.series, l)}
								</span>
								{c.unusual ? (
									<span>
										{" "}
										· {int(c.unusual, l)} {t("inusual", "unusual")}
									</span>
								) : null}
							</li>
						))}
					</ul>
				</div>
			) : null}
		</Panel>
	);
}

registerSummary("inusual", () => {
	const v = panels.value.anomalies as AnomaliesView | undefined;
	if (!v) return null;
	const l = lang.value;
	const n = v.items.length;
	return n
		? {
				text: t(
					`${int(n, l)} ${n === 1 ? "lectura inusual" : "lecturas inusuales"} (calculado por Vigía)`,
					`${int(n, l)} unusual ${n === 1 ? "reading" : "readings"} (computed by Vigía)`,
				),
				tone: "normal",
			}
		: {
				text: t(
					`Ninguna inusual; ${int(v.counts.judged, l)} de ${int(v.counts.series, l)} series se pudieron juzgar`,
					`None unusual; ${int(v.counts.judged, l)} of ${int(v.counts.series, l)} series could be judged`,
				),
				tone: "normal",
			};
});
