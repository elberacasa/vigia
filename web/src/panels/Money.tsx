import { addStyles } from "../lib/css.ts";
import { now, panels } from "../lib/data.ts";
import { ago, num, pct, stamp } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { PANEL_META } from "../lib/panel-meta.ts";
import panelsCss from "../styles/panels.css?inline";
import { Digits } from "../ui/Digits.tsx";
import { Panel } from "../ui/Panel.tsx";
import { SourceTag } from "../ui/Source.tsx";
import { Sparkline } from "../ui/Sparkline.tsx";

addStyles(panelsCss);

/** Mirrors src/panels/money.ts (server computes every number; this file only formats). */
interface Change {
	abs: number;
	pct: number;
	fromValue: number;
	fromObservedAt: number;
}
interface OfficialFigure {
	vesPerUnit: number;
	valueDate: string;
	validFrom: number;
	fetchedAt: number;
	feed: string;
	sourceUrl: string;
	conversion: string | null;
	/** Feeds that returned this same value for this Fecha Valor (two: "confirmado por 2 vías"). */
	confirmedBy?: string[];
	/** Set when the figure reached Vigía through bcv-api: its label and bcv-api's last read of the BCV. */
	route?: { label: string; readAt: number } | null;
}
export interface RouteDiscrepancy {
	currency: "USD" | "EUR";
	valueDate: string;
	direct: { feed: string; vesPerUnit: number; fetchedAt: number; sourceUrl: string };
	mirror: { feed: string; vesPerUnit: number; fetchedAt: number; changedAt: number; sourceUrl: string };
}
interface OfficialRate {
	currency: "USD" | "EUR";
	label: string;
	current: OfficialFigure | null;
	next: OfficialFigure | null;
	change24h: Change | null;
	change7d: Change | null;
	stale: boolean;
	possiblyMissed: boolean;
	/** Optional: a view cached by an older client may lack it. */
	discrepancies?: RouteDiscrepancy[];
}
interface Gap {
	pct: number;
	officialVesPerUsd: number;
	officialValueDate: string;
	skewMs: number;
}
interface QuoteFigure {
	vesPerUsd: number;
	observedAt: number;
	fetchedAt: number;
	ageMs: number;
	gap: Gap | null;
	change24h: Change | null;
	change7d: Change | null;
}
interface YadioQuote {
	id: "yadio";
	label: string;
	feed: string;
	sourceUrl: string;
	attribution: string;
	figure: QuoteFigure | null;
	stale: boolean;
}
interface P2pSideView {
	status: "ok" | "insufficient";
	medianVesPerUsdt: number | null;
	n: number;
	considered: number;
	gap: Gap | null;
}
interface P2pQuote {
	id: string;
	label: string;
	feed: string;
	sourceUrl: string;
	attribution: string;
	observedAt: number;
	ageMs: number;
	buy: P2pSideView;
	sell: P2pSideView;
	spreadPct: number | null;
	stale: boolean;
}
interface DayPoint {
	date: string;
	vesPerUsd: number;
	observedAt: number;
	feed: string;
}
interface Inflation {
	latest: { period: string; monthlyPct: number | null; provisional: boolean; observedAt: number } | null;
	yearOnYearPct: number | null;
	yearToDatePct: number | null;
	derivedLabel: string;
	series24m: { period: string; monthlyPct: number | null; yearOnYearPct: number | null }[];
	feed: string;
	sourceUrl: string;
	stale: boolean;
}
export interface MoneyView {
	official: { usd: OfficialRate; eur: OfficialRate; attribution: string };
	yadio: YadioQuote;
	p2p: P2pQuote[];
	gapLabel: string;
	series90d: { official: DayPoint[]; yadio: DayPoint[] };
	inflation: Inflation;
}

interface OilBenchmark {
	id: string;
	label: string;
	latest: { usdPerBarrel: number; date: string; observedAt: number } | null;
	change: { usd: number; pct: number } | null;
	series30d: { date: string; usdPerBarrel: number }[];
	sourceUrl: string;
}
interface OilView {
	feed: string;
	attribution: string;
	benchmarks: OilBenchmark[];
}

const MONTHS_ES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic"];
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayLabel(date: string, l: "es" | "en"): string {
	const [, m = "1", d = "1"] = date.split("-");
	return l === "es" ? `${Number(d)} ${MONTHS_ES[Number(m) - 1]}` : `${MONTHS_EN[Number(m) - 1]} ${Number(d)}`;
}

function monthLabel(period: string, l: "es" | "en"): string {
	const [y = "", m = "1"] = period.split("-");
	return `${(l === "es" ? MONTHS_ES : MONTHS_EN)[Number(m) - 1]} ${y}`;
}

function Delta({ change, label }: { change: Change | null; label: string }) {
	if (!change) return null;
	const l = lang.value;
	const dir = change.pct > 0 ? "up" : change.pct < 0 ? "down" : "flat";
	return (
		<span class={`delta delta--${dir}`} title={`${label}: ${num(change.fromValue, 2, l)} → Bs`}>
			<span aria-hidden="true">{dir === "up" ? "▲" : dir === "down" ? "▼" : "•"}</span>{" "}
			{pct(change.pct, 2, l)} <span class="delta__label">{label}</span>
		</span>
	);
}

function GapBadge({ gap }: { gap: Gap | null }) {
	if (!gap) return null;
	const l = lang.value;
	return (
		<span
			class="gap"
			title={t(
				"Brecha frente a la tasa oficial vigente, calculada por Vigía",
				"Gap to the official rate in force, computed by Vigía",
			)}
		>
			{t("brecha", "gap")} <strong class="data">{pct(gap.pct, 1, l)}</strong>
		</span>
	);
}

/** "vía bcv-api · leído del BCV hace 12 min": a figure that reached Vigía through bcv-api, aged by bcv-api's read. */
function RouteNote({ route }: { route: OfficialFigure["route"] }) {
	if (!route) return null;
	const l = lang.value;
	return (
		<span
			title={t(
				"La página del BCV no respondió a Vigía; esta cifra llegó por bcv-api",
				"The BCV page did not answer Vigía; this figure came through bcv-api",
			)}
		>
			{" · "}
			{t("vía bcv-api", "via bcv-api")},{" "}
			<span class="data">
				{t("leída del BCV", "read from the BCV")} {ago(now.value - route.readAt, l)}
			</span>
		</span>
	);
}

/** The official euro, one line under the dollar: same routes, same rules. */
function EuroLine({ rate }: { rate: OfficialRate }) {
	const l = lang.value;
	const cur = rate.current;
	if (!cur && !rate.next) return null;
	return (
		<p class="rate__next">
			{t("Euro oficial", "Official euro")}
			{cur ? ": " : " · "}
			{cur ? (
				<>
					<strong class="data">{num(cur.vesPerUnit, 2, l)}</strong> Bs, {t("desde el", "since")}{" "}
					{dayLabel(cur.valueDate, l)}
					<RouteNote route={cur.route} />
				</>
			) : null}
			{rate.next ? (
				<>
					{cur ? " · " : null}
					{t("publicada para el", "published for")} {dayLabel(rate.next.valueDate, l)}:{" "}
					<strong class="data">{num(rate.next.vesPerUnit, 2, l)}</strong>
					<RouteNote route={rate.next.route} />
				</>
			) : null}
		</p>
	);
}

/** Plain-language state of one official figure's routes, for the "?" sheet. */
function routeState(f: OfficialFigure, l: "es" | "en"): string {
	if (f.route) {
		return t(
			`vía bcv-api (la página del BCV no la entregó a Vigía), leída del BCV ${ago(now.value - f.route.readAt, l)}`,
			`via bcv-api (the BCV page did not give it to Vigía), read from the BCV ${ago(now.value - f.route.readAt, l)}`,
		);
	}
	if ((f.confirmedBy?.length ?? 0) >= 2)
		return t(
			"confirmado por 2 vías (bcv.org.ve y bcv-api)",
			"confirmed by 2 routes (bcv.org.ve and bcv-api)",
		);
	return f.feed === "bcv-history"
		? t("del archivo histórico del BCV, una sola vía", "from the BCV history file, a single route")
		: t("solo por bcv.org.ve, una sola vía", "via bcv.org.ve only, a single route");
}

/** One disagreement between the routes: both values and both times, and which one is shown. Also on /estado. */
export function DiscrepancyNote({ d }: { d: RouteDiscrepancy }) {
	const l = lang.value;
	return (
		<p class="warn-text" role="note">
			{t("Discrepancia entre vías", "Routes disagree")} (
			{d.currency === "USD" ? t("dólar", "dollar") : "euro"}, {t("Fecha Valor", "Fecha Valor")}{" "}
			{dayLabel(d.valueDate, l)}): bcv.org.ve <strong class="data">{num(d.direct.vesPerUnit, 8, l)}</strong>{" "}
			Bs ({t("leída por Vigía el", "read by Vigía on")}{" "}
			<span class="data">{stamp(d.direct.fetchedAt, l)}</span>) · bcv-api{" "}
			<strong class="data">{num(d.mirror.vesPerUnit, 8, l)}</strong> Bs (
			{t("cambió en bcv-api el", "changed in bcv-api on")}{" "}
			<span class="data">{stamp(d.mirror.changedAt, l)}</span>,{" "}
			{t("recibida por Vigía el", "received by Vigía on")}{" "}
			<span class="data">{stamp(d.mirror.fetchedAt, l)}</span>).{" "}
			{t("Se muestra la de bcv.org.ve.", "The bcv.org.ve figure is shown.")}
		</p>
	);
}

/** The "?" sheet's account of the official rate's two routes: rules, the state of each figure shown, discrepancies. */
function OfficialRoutes({ usd, eur }: { usd: OfficialRate; eur: OfficialRate }) {
	const l = lang.value;
	const rows: { key: string; label: string; f: OfficialFigure }[] = [];
	for (const [rate, name] of [
		[usd, t("Dólar", "Dollar")],
		[eur, t("Euro", "Euro")],
	] as const) {
		if (rate.current)
			rows.push({
				key: `${rate.currency}-c`,
				label: `${name}, ${t("vigente desde el", "in force since")} ${dayLabel(rate.current.valueDate, l)}`,
				f: rate.current,
			});
		if (rate.next)
			rows.push({
				key: `${rate.currency}-n`,
				label: `${name}, ${t("publicada para el", "published for")} ${dayLabel(rate.next.valueDate, l)}`,
				f: rate.next,
			});
	}
	const discrepancies = [...(usd.discrepancies ?? []), ...(eur.discrepancies ?? [])];
	return (
		<>
			<p>
				{t(
					"La tasa oficial llega por dos vías: la página del BCV leída por Vigía (bcv.org.ve) y bcv-api, un servicio abierto que lee la misma página. Si las dos dan la misma cifra para la misma Fecha Valor (a los 8 decimales que publica el BCV), se muestra una sola vez. Si bcv.org.ve no responde, se muestra la cifra de bcv-api con su vía y la hora en que bcv-api leyó al BCV. Si no coinciden, se muestra la de bcv.org.ve y se listan las dos aquí. Nunca se promedian.",
					"The official rate reaches Vigía by two routes: the BCV page read by Vigía (bcv.org.ve) and bcv-api, an open service that reads the same page. When both give the same figure for the same Fecha Valor (to the 8 decimals the BCV publishes), it is shown once. When bcv.org.ve does not answer, bcv-api's figure is shown with its route and the time bcv-api read the BCV. When they disagree, the bcv.org.ve figure is shown and both are listed here. They are never averaged.",
				)}
			</p>
			{rows.length ? (
				<ul class="mk-attrib">
					{rows.map((r) => (
						<li key={r.key}>
							{r.label}: <strong class="data">{num(r.f.vesPerUnit, 2, l)}</strong> Bs, {routeState(r.f, l)}.
						</li>
					))}
				</ul>
			) : null}
			{discrepancies.map((d) => (
				<DiscrepancyNote key={`${d.currency}-${d.valueDate}`} d={d} />
			))}
		</>
	);
}

function OfficialCard({ rate, big, eur }: { rate: OfficialRate; big: boolean; eur?: OfficialRate }) {
	const l = lang.value;
	const cur = rate.current;
	return (
		<div class={`rate${big ? " rate--big" : ""}`}>
			<div class="rate__head">
				<span class="rate__label">
					{rate.currency === "USD"
						? t("Dólar oficial", "Official dollar")
						: t("Euro oficial", "Official euro")}
				</span>
				<span class="rate__who">{cur?.route ? cur.route.label : "BCV"}</span>
			</div>
			{cur ? (
				<>
					<p class="rate__value data">
						<Digits
							value={num(cur.vesPerUnit, 2, l)}
							raw={cur.vesPerUnit}
							label={
								rate.currency === "USD"
									? t("Dólar oficial", "Official dollar")
									: t("Euro oficial", "Official euro")
							}
							announce={false}
						/>
						<span class="figure__unit">Bs</span>
					</p>
					<p class="rate__meta">
						{t("vigente desde el", "in force since")} {dayLabel(cur.valueDate, l)}
						<RouteNote route={cur.route} />
						{rate.possiblyMissed ? (
							<span class="warn-text">
								{" "}
								·{" "}
								{t(
									"hoy puede ser feriado bancario, o la tasa de hoy aún no llegó a Vigía (se completa con el histórico del BCV)",
									"today may be a bank holiday, or today's rate has not reached Vigía yet (the BCV history file fills it in)",
								)}
							</span>
						) : null}
					</p>
					<div class="rate__deltas">
						<Delta change={rate.change24h} label="24 h" />
						<Delta change={rate.change7d} label={t("7 d", "7 d")} />
					</div>
					{rate.next ? (
						<p class="rate__next">
							{t("Publicada para el", "Published for")} {dayLabel(rate.next.valueDate, l)}:{" "}
							<strong class="data">{num(rate.next.vesPerUnit, 2, l)}</strong>
							<RouteNote route={rate.next.route} />
						</p>
					) : null}
					{eur ? <EuroLine rate={eur} /> : null}
					{rate.discrepancies?.length || eur?.discrepancies?.length ? (
						<p class="rate__meta warn-text">
							{t(
								"bcv.org.ve y bcv-api no coinciden: se muestra la cifra de bcv.org.ve; detalle en «?»",
								"bcv.org.ve and bcv-api disagree: the bcv.org.ve figure is shown; details under “?”",
							)}
						</p>
					) : null}
					<SourceTag
						source={{ feed: cur.feed, observedAt: cur.validFrom, url: cur.sourceUrl, detail: rate.label }}
						label={cur.route ? cur.route.label : "BCV"}
					/>
				</>
			) : (
				<p class="empty">{t("Esperando al BCV…", "Waiting for the BCV…")}</p>
			)}
		</div>
	);
}

export function MoneyPanel() {
	const view = panels.value.money as MoneyView | undefined;
	const l = lang.value;
	const y = view?.yadio;
	const officialSeries = view?.series90d.official ?? [];
	const yadioSeries = view?.series90d.yadio ?? [];
	return (
		<Panel
			id="dinero"
			title={PANEL_META.dinero.title()}
			question={PANEL_META.dinero.question()}
			feeds={PANEL_META.dinero.feeds()}
			method={
				view ? (
					<>
						<OfficialRoutes usd={view.official.usd} eur={view.official.eur} />
						<span>{view.gapLabel}</span>
						<span>
							{t(
								"Vigía no publica una tasa propia: cada cotización lleva el nombre de quien la publica.",
								"Vigía publishes no rate of its own: every quote carries the name of who publishes it.",
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
					<div class="rates">
						<OfficialCard rate={view.official.usd} big={true} eur={view.official.eur} />
						<div class="rate">
							<div class="rate__head">
								<span class="rate__label">Yadio</span>
								<span class="rate__who">{t("índice P2P", "P2P index")}</span>
							</div>
							{y?.figure ? (
								<>
									<p class="rate__value data">
										<Digits
											value={num(y.figure.vesPerUsd, 2, l)}
											raw={y.figure.vesPerUsd}
											label="Yadio"
											announce={false}
										/>
										<span class="figure__unit">Bs</span>
									</p>
									<p class="rate__meta">
										<GapBadge gap={y.figure.gap} />
									</p>
									<div class="rate__deltas">
										<Delta change={y.figure.change24h} label="24 h" />
									</div>
									<SourceTag
										source={{
											feed: y.feed,
											observedAt: y.figure.observedAt,
											url: y.sourceUrl,
											detail: y.label,
										}}
										label="Yadio"
									/>
								</>
							) : (
								<p class="empty">{t("Sin dato reciente", "No recent figure")}</p>
							)}
						</div>
					</div>
					{view.p2p.length ? (
						<ul class="p2p">
							{view.p2p.map((q) => (
								<li key={q.id}>
									<span class="p2p__name">{q.label}</span>
									<span>
										{t("compra", "buy")}{" "}
										<strong class="data">
											{q.buy.medianVesPerUsdt !== null
												? num(q.buy.medianVesPerUsdt, 2, l)
												: t("sin datos suficientes", "not enough data")}
										</strong>
										<span class="note"> (n={q.buy.n})</span>
									</span>
									<GapBadge gap={q.buy.gap} />
									<SourceTag
										source={{
											feed: q.feed,
											observedAt: q.observedAt,
											url: q.sourceUrl,
											detail: q.attribution,
										}}
									/>
								</li>
							))}
						</ul>
					) : null}
					<div class="chart-block">
						<p class="chart-block__title">
							{t("Últimos 90 días", "Last 90 days")}
							<span class="legend legend--signal">BCV</span>
							<span class="legend legend--info">Yadio</span>
						</p>
						<div class="chart-stack">
							<Sparkline
								values={officialSeries.map((p) => p.vesPerUsd)}
								summary={t(
									`Tasa oficial del BCV, de ${num(officialSeries[0]?.vesPerUsd ?? 0, 2, l)} a ${num(officialSeries.at(-1)?.vesPerUsd ?? 0, 2, l)} Bs en 90 días`,
									`BCV official rate, from ${num(officialSeries[0]?.vesPerUsd ?? 0, 2, l)} to ${num(officialSeries.at(-1)?.vesPerUsd ?? 0, 2, l)} Bs in 90 days`,
								)}
							/>
							{yadioSeries.length > 1 ? (
								<Sparkline
									tone="info"
									values={yadioSeries.map((p) => p.vesPerUsd)}
									summary={t("Índice Yadio en el mismo período", "Yadio index over the same period")}
								/>
							) : null}
						</div>
						{officialSeries.length ? (
							<p class="chart-block__axis note data">
								<span>{dayLabel(officialSeries[0]?.date ?? "", l)}</span>
								<span>
									{t("mín", "min")} {num(Math.min(...officialSeries.map((p) => p.vesPerUsd)), 2, l)} ·{" "}
									{t("máx", "max")} {num(Math.max(...officialSeries.map((p) => p.vesPerUsd)), 2, l)}
								</span>
								<span>{dayLabel(officialSeries.at(-1)?.date ?? "", l)}</span>
							</p>
						) : null}
					</div>
					<div class="inflation">
						<div>
							<span class="rate__label">{t("Inflación", "Inflation")}</span>
							{view.inflation.latest ? (
								<p class="inflation__row">
									<span>
										<strong class="data">{pct(view.inflation.latest.monthlyPct ?? 0, 1, l)}</strong>{" "}
										{t("en", "in")} {monthLabel(view.inflation.latest.period, l)}
									</span>
									{view.inflation.yearOnYearPct !== null ? (
										<span>
											<strong class="data">{pct(view.inflation.yearOnYearPct, 0, l)}</strong>{" "}
											{t("en 12 meses", "over 12 months")}
											<sup title={view.inflation.derivedLabel}>*</sup>
										</span>
									) : null}
								</p>
							) : (
								<p class="empty">…</p>
							)}
							<p class="note">* {view.inflation.derivedLabel}</p>
						</div>
						{view.inflation.latest ? (
							<SourceTag
								source={{
									feed: view.inflation.feed,
									observedAt: view.inflation.latest.observedAt,
									url: view.inflation.sourceUrl,
								}}
								label="BCV · INPC"
							/>
						) : null}
					</div>
				</>
			)}
		</Panel>
	);
}

export function OilPanel() {
	const view = panels.value.oil as OilView | undefined;
	const l = lang.value;
	return (
		<Panel
			id="petroleo"
			title={PANEL_META.petroleo.title()}
			question={PANEL_META.petroleo.question()}
			feeds={PANEL_META.petroleo.feeds()}
		>
			{!view ? (
				<p class="skeleton">…</p>
			) : (
				<div class="oil">
					{view.benchmarks.map((b) => (
						<div class="oil__item" key={b.id}>
							<span class="rate__label">{b.label}</span>
							{b.latest ? (
								<>
									<p class="rate__value rate__value--sm data">
										{num(b.latest.usdPerBarrel, 2, l)}
										<span class="figure__unit">US$/bbl</span>
									</p>
									{b.change ? (
										<span class={`delta delta--${b.change.pct >= 0 ? "up" : "down"}`}>
											{pct(b.change.pct, 1, l)}{" "}
											<span class="delta__label">{t("día anterior", "prev. day")}</span>
										</span>
									) : null}
									<Sparkline
										tone="info"
										values={b.series30d.map((p) => p.usdPerBarrel)}
										summary={`${b.label}, 30 d`}
									/>
									<SourceTag
										source={{ feed: view.feed, observedAt: b.latest.observedAt, url: b.sourceUrl }}
										label="EIA vía FRED"
									/>
								</>
							) : (
								<p class="empty">…</p>
							)}
						</div>
					))}
				</div>
			)}
		</Panel>
	);
}

export function ago2(ms: number): string {
	return ago(now.value - ms, lang.value);
}
