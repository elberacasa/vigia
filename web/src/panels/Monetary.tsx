import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { addStyles } from "../lib/css.ts";
import { panels, wantPanel } from "../lib/data.ts";
import { num } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { bigBs, calDate, changeText, musd, usdWords } from "../lib/monetary-view.ts";
import { PANEL_META } from "../lib/panel-meta.ts";
import { registerSummary } from "../lib/summary.ts";
import monetaryCss from "../styles/monetary.css?inline";
import { Panel } from "../ui/Panel.tsx";
import { SourceTag } from "../ui/Source.tsx";
import { Sparkline } from "../ui/Sparkline.tsx";

addStyles(monetaryCss);

/* Mirrors src/panels/monetary.ts (the server computes every figure and change; this file only formats). */

interface Change {
	abs: number;
	pct: number;
	fromValue: number;
	fromObservedAt: number;
}

interface Block {
	stale: boolean;
	feed: string;
	sourceUrl: string;
	attribution: string;
}

export interface MonetaryView {
	now: number;
	derivedLabel: string;
	usdLabel: string;
	liquidity: Block & {
		latest: {
			weekEnding: string;
			m2Ves: number;
			m1Ves: number;
			currencyVes: number;
			demandDepositsVes: number;
			savingsDepositsVes: number;
			quasiMoneyVes: number;
			provisional: boolean;
			rectified: boolean;
			observedAt: number;
			fetchedAt: number;
		} | null;
		changeWeek: Change | null;
		change4w: Change | null;
		changeYear: Change | null;
		changeYtd: Change | null;
		usd: { m2Usd: number; vesPerUsd: number; rateValueDate: string; feed: string } | null;
		series: { weekEnding: string; m2Ves: number; weekPct: number | null; provisional: boolean }[];
	};
	reserves: Block & {
		latest: {
			date: string;
			totalMusd: number;
			bcvMusd: number;
			femMusd: number;
			provisional: boolean;
			observedAt: number;
			fetchedAt: number;
		} | null;
		changeDay: Change | null;
		change7d: Change | null;
		change30d: Change | null;
		changeYear: Change | null;
		changeYtd: Change | null;
		series: { date: string; totalMusd: number; provisional: boolean }[];
	};
	intervention: Block & {
		latest: { date: string; number: string; vesPerEur: number; observedAt: number; fetchedAt: number } | null;
		days7: number;
		days30: number;
		daysYear: number;
		numbers365: number;
		recent: { date: string; number: string; vesPerEur: number; conversion: string | null }[];
		note: string;
	};
}

/** One change, labelled, with a glyph so it reads without colour; the comparison date in its tooltip. */
function Delta({ label, change }: { label: string; change: Change | null }) {
	const l = lang.value;
	if (!change)
		return (
			<li class="mon-delta mon-delta--none">
				<span class="mon-delta__label">{label}</span>
				<span class="mon-delta__v">—</span>
			</li>
		);
	const c = changeText(change.pct, l);
	const from = new Date(change.fromObservedAt).toISOString().slice(0, 10);
	return (
		<li class="mon-delta" title={t(`frente al ${calDate(from, "es")}`, `against ${calDate(from, "en")}`)}>
			<span class="mon-delta__label">{label}</span>
			<span class="mon-delta__v">
				<span aria-hidden="true" class="mon-delta__g">
					{c.glyph}
				</span>
				{c.text}
			</span>
		</li>
	);
}

/** "Provisional" / "Rectificado": the BCV's own marks on a figure, in words. */
function Mark({ kind }: { kind: "provisional" | "rectified" | "stale" }) {
	const text =
		kind === "provisional"
			? t("Provisional", "Provisional")
			: kind === "rectified"
				? t("Rectificado", "Revised")
				: t("Desactualizado", "Out of date");
	const title =
		kind === "provisional"
			? t(
					"El BCV la publica como cifra provisional: puede cambiar.",
					"The BCV publishes it as provisional: it may change.",
				)
			: kind === "rectified"
				? t(
						"El BCV corrigió esta cifra después de publicarla.",
						"The BCV corrected this figure after publishing it.",
					)
				: t(
						"La fuente no se ha leído dentro de su plazo.",
						"The source has not been read within its budget.",
					);
	return (
		<span class={`mon-mark mon-mark--${kind}`} title={title}>
			{text}
		</span>
	);
}

function Section({ id, title, children }: { id: string; title: string; children: ComponentChildren }) {
	return (
		<section class="mon-block" aria-labelledby={id}>
			<h3 class="mon-block__h" id={id}>
				{title}
			</h3>
			{children}
		</section>
	);
}

function Liquidity({ v, usdLabel }: { v: MonetaryView["liquidity"]; usdLabel: string }) {
	const l = lang.value;
	const m = v.latest;
	if (!m) return <p class="mon-empty">{t("Sin datos de liquidez aún.", "No money-supply data yet.")}</p>;
	const series = v.series.map((p) => p.m2Ves);
	const first = v.series[0];
	// M2 = M1 + quasi-money; M1 = currency + demand deposits + savings deposits (the BCV's own breakdown).
	const inM1: [string, number][] = [
		[t("Efectivo", "Currency"), m.currencyVes],
		[t("Depósitos a la vista", "Demand deposits"), m.demandDepositsVes],
		[t("Depósitos de ahorro", "Savings deposits"), m.savingsDepositsVes],
	];
	return (
		<>
			<div class="mon-head">
				<p class="mon-fig">
					<span class="mon-fig__label">{t("Liquidez monetaria (M2)", "Money supply (M2)")}</span>
					<span class="mon-fig__v">
						<span class="mon-fig__unit">Bs</span> {bigBs(m.m2Ves, l)}
					</span>
					<span class="mon-fig__when">
						{t(`semana al ${calDate(m.weekEnding, "es")}`, `week to ${calDate(m.weekEnding, "en")}`)}
						{m.provisional ? <Mark kind="provisional" /> : null}
						{m.rectified ? <Mark kind="rectified" /> : null}
						{v.stale ? <Mark kind="stale" /> : null}
					</span>
				</p>
				{v.usd ? (
					<p class="mon-fig mon-fig--derived">
						<span class="mon-fig__label">{t("En dólares", "In dollars")}</span>
						<span class="mon-fig__v mon-fig__v--sm">{usdWords(v.usd.m2Usd, l)}</span>
						<span class="mon-fig__when">
							{t(
								`a ${num(v.usd.vesPerUsd, 2, "es")} Bs/US$ (${calDate(v.usd.rateValueDate, "es")})`,
								`at ${num(v.usd.vesPerUsd, 2, "en")} Bs/US$ (${calDate(v.usd.rateValueDate, "en")})`,
							)}
						</span>
						<span class="mon-derived">{usdLabel}</span>
					</p>
				) : null}
			</div>
			<ul class="mon-deltas">
				<Delta label={t("Semana", "Week")} change={v.changeWeek} />
				<Delta label={t("4 semanas", "4 weeks")} change={v.change4w} />
				<Delta label={t("Un año", "One year")} change={v.changeYear} />
				<Delta label={t("En el año", "Year to date")} change={v.changeYtd} />
			</ul>
			{series.length > 1 && first ? (
				<div class="mon-chart">
					<Sparkline
						tone="info"
						values={series}
						summary={t(
							`Liquidez M2 de las últimas ${series.length} semanas, desde Bs ${bigBs(first.m2Ves, "es")} (${calDate(first.weekEnding, "es")}) hasta Bs ${bigBs(m.m2Ves, "es")}`,
							`M2 over the last ${series.length} weeks, from Bs ${bigBs(first.m2Ves, "en")} (${calDate(first.weekEnding, "en")}) to Bs ${bigBs(m.m2Ves, "en")}`,
						)}
					/>
					<p class="mon-axis" aria-hidden="true">
						<span>{calDate(first.weekEnding, l)}</span>
						<span>{t(`${series.length} semanas`, `${series.length} weeks`)}</span>
						<span>{calDate(m.weekEnding, l)}</span>
					</p>
				</div>
			) : null}
			<dl class="mon-parts" aria-label={t("Componentes de M2", "Components of M2")}>
				<div class="mon-parts__row mon-parts__row--sum">
					<dt>{t("M1 (dinero en circulación y depósitos)", "M1 (currency and deposits)")}</dt>
					<dd>Bs {bigBs(m.m1Ves, l)}</dd>
				</div>
				{inM1.map(([label, ves]) => (
					<div class="mon-parts__row mon-parts__row--in" key={label}>
						<dt>{label}</dt>
						<dd>Bs {bigBs(ves, l)}</dd>
					</div>
				))}
				<div class="mon-parts__row mon-parts__row--sum">
					<dt>{t("Cuasidinero", "Quasi-money")}</dt>
					<dd>Bs {bigBs(m.quasiMoneyVes, l)}</dd>
				</div>
			</dl>
			<div class="sources-row">
				<SourceTag source={{ feed: v.feed, observedAt: m.observedAt, url: v.sourceUrl }} label="BCV" />
				{v.usd ? (
					<SourceTag
						// The rate's own value date (Caracas midnight), not the week's.
						source={{ feed: v.usd.feed, observedAt: Date.parse(`${v.usd.rateValueDate}T00:00:00-04:00`) }}
						label={t("Tipo de cambio: BCV", "Exchange rate: BCV")}
					/>
				) : null}
			</div>
		</>
	);
}

function Reserves({ v }: { v: MonetaryView["reserves"] }) {
	const l = lang.value;
	const r = v.latest;
	if (!r) return <p class="mon-empty">{t("Sin datos de reservas aún.", "No reserves data yet.")}</p>;
	const first = v.series[0];
	return (
		<>
			<div class="mon-head">
				<p class="mon-fig">
					<span class="mon-fig__label">{t("Reservas internacionales", "International reserves")}</span>
					<span class="mon-fig__v">{musd(r.totalMusd, l)}</span>
					<span class="mon-fig__when">
						{calDate(r.date, l)}
						{r.provisional ? <Mark kind="provisional" /> : null}
						{v.stale ? <Mark kind="stale" /> : null}
					</span>
				</p>
				<dl class="mon-split">
					<div>
						<dt>BCV</dt>
						<dd>{musd(r.bcvMusd, l)}</dd>
					</div>
					<div>
						<dt title={t("Fondo de Estabilización Macroeconómica", "Macroeconomic Stabilisation Fund")}>
							FEM
						</dt>
						<dd>{musd(r.femMusd, l)}</dd>
					</div>
				</dl>
			</div>
			<ul class="mon-deltas">
				<Delta label={t("Día", "Day")} change={v.changeDay} />
				<Delta label={t("7 días", "7 days")} change={v.change7d} />
				<Delta label={t("30 días", "30 days")} change={v.change30d} />
				<Delta label={t("Un año", "One year")} change={v.changeYear} />
				<Delta label={t("En el año", "Year to date")} change={v.changeYtd} />
			</ul>
			{v.series.length > 1 && first ? (
				<div class="mon-chart">
					<Sparkline
						tone="info"
						values={v.series.map((p) => p.totalMusd)}
						summary={t(
							`Reservas de los últimos 365 días: de ${musd(first.totalMusd, "es")} el ${calDate(first.date, "es")} a ${musd(r.totalMusd, "es")}`,
							`Reserves over the last 365 days: from ${musd(first.totalMusd, "en")} on ${calDate(first.date, "en")} to ${musd(r.totalMusd, "en")}`,
						)}
					/>
					<p class="mon-axis" aria-hidden="true">
						<span>{calDate(first.date, l)}</span>
						<span>{t("365 días", "365 days")}</span>
						<span>{calDate(r.date, l)}</span>
					</p>
				</div>
			) : null}
			<div class="sources-row">
				<SourceTag source={{ feed: v.feed, observedAt: r.observedAt, url: v.sourceUrl }} label="BCV" />
			</div>
		</>
	);
}

function Intervention({ v }: { v: MonetaryView["intervention"] }) {
	const l = lang.value;
	const i = v.latest;
	return (
		<>
			{/* The BCV publishes no amounts: said in the body, where the figures are, not only in the "?" sheet. */}
			<p class="mon-note">
				{t(
					v.note,
					"The BCV publishes the date, number and exchange rate of each foreign-exchange intervention; it does not publish the amount.",
				)}
			</p>
			{i ? (
				<>
					<div class="mon-head">
						<p class="mon-fig">
							<span class="mon-fig__label">{t("Última intervención", "Latest intervention")}</span>
							<span class="mon-fig__v mon-fig__v--sm">
								N° {i.number} <span class="mon-fig__unit">·</span> {num(i.vesPerEur, 2, l)}{" "}
								<span class="mon-fig__unit">Bs/€</span>
							</span>
							<span class="mon-fig__when">
								{calDate(i.date, l)}
								{v.stale ? <Mark kind="stale" /> : null}
							</span>
						</p>
						<dl class="mon-split">
							<div>
								<dt>{t("Días con intervención, 7 d", "Days with one, 7 d")}</dt>
								<dd>{v.days7}</dd>
							</div>
							<div>
								<dt>{t("30 d", "30 d")}</dt>
								<dd>{v.days30}</dd>
							</div>
							<div>
								<dt>{t("En el año", "This year")}</dt>
								<dd>{v.daysYear}</dd>
							</div>
						</dl>
					</div>
					<p class="mon-sub">
						{t(
							`${v.numbers365} intervenciones numeradas en 365 días (el BCV numera una por semana).`,
							`${v.numbers365} numbered interventions in 365 days (the BCV numbers one a week).`,
						)}
					</p>
					{v.recent.length ? (
						<table class="mon-table">
							<caption class="sr-only">{t("Intervenciones recientes", "Recent interventions")}</caption>
							<thead>
								<tr>
									<th scope="col">{t("Fecha", "Date")}</th>
									<th scope="col">N°</th>
									<th scope="col" class="num">
										Bs/€
									</th>
								</tr>
							</thead>
							<tbody>
								{v.recent.slice(0, 8).map((r) => (
									<tr key={`${r.date}-${r.number}`}>
										<td>{calDate(r.date, l)}</td>
										<td>{r.number}</td>
										<td class="num">{num(r.vesPerEur, 2, l)}</td>
									</tr>
								))}
							</tbody>
						</table>
					) : null}
					<div class="sources-row">
						<SourceTag source={{ feed: v.feed, observedAt: i.observedAt, url: v.sourceUrl }} label="BCV" />
					</div>
				</>
			) : (
				<p class="mon-empty">{t("Sin datos de intervención aún.", "No intervention data yet.")}</p>
			)}
		</>
	);
}

export function MonetaryPanel() {
	const view = panels.value.monetary as MonetaryView | undefined;
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		wantPanel("monetary").catch(() => setFailed(true));
	}, []);
	const meta = PANEL_META.monetario;
	return (
		<Panel
			id="monetario"
			class="panel--monetary"
			title={meta.title()}
			question={meta.question()}
			feeds={meta.feeds()}
			ready={failed || view !== undefined}
			method={
				<>
					<p>
						{t(
							"Liquidez monetaria (M2, semanal), reservas internacionales (diarias) e intervenciones cambiarias, tal como las publica el Banco Central de Venezuela. Los cambios (semana, 4 semanas, un año, en el año; día, 7 y 30 días para las reservas) los calcula Vigía a partir de las cifras publicadas.",
							"Money supply (M2, weekly), international reserves (daily) and foreign-exchange interventions, as the Central Bank of Venezuela publishes them. The changes (week, 4 weeks, one year, year to date; day, 7 and 30 days for reserves) are computed by Vigía from the published figures.",
						)}
					</p>
					{view ? (
						<>
							<p>{view.derivedLabel}.</p>
							<p>
								{t("En dólares", "In dollars")}: {view.usdLabel}.
							</p>
							<p>{view.intervention.note}</p>
						</>
					) : null}
				</>
			}
		>
			{failed && !view ? (
				<p class="mon-empty">
					{t(
						"No se pudieron cargar las cifras del BCV (se piden al abrir este panel).",
						"The BCV figures could not be loaded (they are fetched when this panel opens).",
					)}{" "}
					<button
						type="button"
						class="link-button"
						onClick={() => {
							setFailed(false);
							wantPanel("monetary").catch(() => setFailed(true));
						}}
					>
						{t("Reintentar", "Retry")}
					</button>
				</p>
			) : view ? (
				<div class="mon">
					<Section id="mon-m2" title={t("Liquidez", "Money supply")}>
						<Liquidity v={view.liquidity} usdLabel={view.usdLabel} />
					</Section>
					<Section id="mon-res" title={t("Reservas", "Reserves")}>
						<Reserves v={view.reserves} />
					</Section>
					<Section id="mon-int" title={t("Intervención cambiaria", "FX intervention")}>
						<Intervention v={view.intervention} />
					</Section>
				</div>
			) : null}
		</Panel>
	);
}

registerSummary("monetario", () => {
	const m = (
		panels.value.monetary as
			| { liquidity: { latest: { m2Ves: number; weekEnding: string } | null } }
			| undefined
	)?.liquidity.latest;
	if (!m) return null;
	const l = lang.value;
	return {
		text: t(
			`Liquidez (M2) Bs ${num(m.m2Ves / 1e12, 2, l)} billones, semana al ${m.weekEnding.slice(8)}/${m.weekEnding.slice(5, 7)}`,
			`Money supply (M2) Bs ${num(m.m2Ves / 1e12, 2, l)} trillion, week to ${m.weekEnding.slice(5, 7)}/${m.weekEnding.slice(8)}`,
		),
		tone: "normal",
	};
});
