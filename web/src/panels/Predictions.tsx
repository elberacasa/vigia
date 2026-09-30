import { useEffect, useState } from "preact/hooks";
import { addStyles } from "../lib/css.ts";
import { now, panels, wantPanel } from "../lib/data.ts";
import { ago, stamp } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { pointsText, priceText, volumeText } from "../lib/monetary-view.ts";
import { PANEL_META } from "../lib/panel-meta.ts";
import { registerSummary } from "../lib/summary.ts";
import monetaryCss from "../styles/monetary.css?inline";
import { Panel } from "../ui/Panel.tsx";
import { SourceTag } from "../ui/Source.tsx";

addStyles(monetaryCss);

/* Mirrors src/panels/predictions.ts (the server computes the 24 h change and the quiet flag; this file only formats). */

interface OptionView {
	outcome: string;
	lastPrice: number | null;
	bid: number | null;
	ask: number | null;
	lastTradeAt: number | null;
	quiet: boolean;
	change24hPoints: number | null;
	volume: number | null;
	volume24h: number | null;
	sourceUrl: string;
}

interface EventView {
	venue: "polymarket" | "kalshi";
	eventId: string;
	title: string;
	url: string;
	closesAt: number | null;
	optionsInEvent: number;
	volumeUnit: "USD" | "contracts";
	volume24h: number;
	options: OptionView[];
	fetchedAt: number;
}

export interface PredictionsView {
	now: number;
	priceLabel: string;
	changeLabel: string;
	events: EventView[];
	venues: {
		id: string;
		name: string;
		attribution: string;
		homepage: string;
		lastReadAt: number | null;
		stale: boolean;
	}[];
}

const VENUE_NAME: Record<EventView["venue"], string> = { polymarket: "Polymarket", kalshi: "Kalshi" };

/** Events shown before "ver todos": the busiest by 24 h volume, as the server orders them. */
const FIRST = 8;

function Option({ o, unit }: { o: OptionView; unit: EventView["volumeUnit"] }) {
	const l = lang.value;
	const width = o.lastPrice === null ? 0 : Math.max(0, Math.min(100, o.lastPrice * 100));
	return (
		<li class={`pm-opt${o.quiet ? " is-quiet" : ""}`}>
			<div class="pm-opt__line">
				<span class="pm-opt__name">{o.outcome}</span>
				<span class="pm-opt__price">
					<span class="pm-opt__word">{t("precio", "price")}</span> {priceText(o.lastPrice, l)}
				</span>
			</div>
			{/* The bar is the price itself on a 0–100 % scale: a picture of the number, nothing more. */}
			<span class="pm-opt__bar" aria-hidden="true">
				<i style={{ width: `${width}%` }} />
			</span>
			<p class="pm-opt__meta">
				{o.bid !== null || o.ask !== null ? (
					<span>
						{t("compra", "bid")} {priceText(o.bid, l)} · {t("venta", "ask")} {priceText(o.ask, l)}
					</span>
				) : null}
				{o.change24hPoints !== null ? (
					<span title={t("cambio en 24 h calculado por Vigía", "24 h change computed by Vigía")}>
						{t("24 h", "24 h")}: {pointsText(o.change24hPoints, l)}
					</span>
				) : null}
				{o.volume !== null ? (
					<span>
						{t("volumen", "volume")} {volumeText(o.volume, unit, l)}
					</span>
				) : null}
				<span class={o.quiet ? "pm-quiet" : undefined}>
					{o.lastTradeAt === null
						? t("sin operaciones registradas", "no trades recorded")
						: o.quiet
							? t(
									`sin operaciones en 7 días o más: última ${ago(now.value - o.lastTradeAt, "es")}`,
									`no trades for 7 days or more: last ${ago(now.value - o.lastTradeAt, "en")}`,
								)
							: t(
									`última operación ${ago(now.value - o.lastTradeAt, "es")}`,
									`last trade ${ago(now.value - o.lastTradeAt, "en")}`,
								)}
				</span>
			</p>
		</li>
	);
}

function Event({ e }: { e: EventView }) {
	const l = lang.value;
	const hidden = e.optionsInEvent - e.options.length;
	return (
		<li class="pm-event">
			<header class="pm-event__head">
				<span class={`pm-venue pm-venue--${e.venue}`}>{VENUE_NAME[e.venue]}</span>
				{/* The venue's own words, verbatim: two markets with similar names ask different questions. */}
				<a
					class="pm-event__q"
					href={e.url}
					target="_blank"
					rel="noopener noreferrer"
					lang={e.venue === "kalshi" ? "es" : "en"}
				>
					{e.title}
				</a>
			</header>
			<ol class="pm-opts">
				{e.options.map((o) => (
					<Option key={o.outcome} o={o} unit={e.volumeUnit} />
				))}
			</ol>
			<p class="pm-event__foot">
				{hidden > 0 ? (
					<span>
						{t(
							`${hidden} opciones más en ${VENUE_NAME[e.venue]}`,
							`${hidden} more options on ${VENUE_NAME[e.venue]}`,
						)}
					</span>
				) : null}
				{e.closesAt !== null ? (
					<span>
						{t("cierra", "closes")} {stamp(e.closesAt, l, now.value)}
					</span>
				) : null}
				<span>
					{t("volumen 24 h", "24 h volume")} {volumeText(e.volume24h, e.volumeUnit, l)}
				</span>
			</p>
		</li>
	);
}

export function PredictionsPanel() {
	const view = panels.value.predictions as PredictionsView | undefined;
	const [failed, setFailed] = useState(false);
	const [all, setAll] = useState(false);
	useEffect(() => {
		wantPanel("predictions").catch(() => setFailed(true));
	}, []);
	const meta = PANEL_META.apuestas;
	const events = view ? (all ? view.events : view.events.slice(0, FIRST)) : [];
	return (
		<Panel
			id="apuestas"
			class="panel--predictions"
			title={meta.title()}
			question={meta.question()}
			feeds={meta.feeds()}
			ready={failed || view !== undefined}
			method={
				<>
					<p>
						{t(
							"Mercados de predicción abiertos sobre Venezuela en Polymarket y Kalshi. Cada precio es el de la última operación de un contrato que paga US$1 si el resultado ocurre: lo que pagan los participantes, no una encuesta ni un pronóstico de Vigía. Cada mercado lleva su pregunta exacta, en las palabras de su plataforma: mercados de nombre parecido preguntan cosas distintas (por ejemplo, quién lidera oficialmente y quién lidera de facto). Las plataformas nunca se promedian.",
							"Open prediction markets about Venezuela on Polymarket and Kalshi. Each price is the last trade of a contract that pays US$1 if the outcome happens: what participants pay, not a poll or a forecast by Vigía. Each market carries its exact question, in its venue's words: markets with similar names ask different things (for example, who leads officially and who leads de facto). Venues are never averaged.",
						)}
					</p>
					{view ? (
						<>
							<p>{view.priceLabel}.</p>
							<p>{view.changeLabel}.</p>
						</>
					) : null}
					<p>
						{t(
							"Volumen: dólares en Polymarket, contratos en Kalshi. «Sin operaciones en 7 días»: el mercado sigue abierto, pero su precio es viejo. Vigía no lee la identidad de ningún participante.",
							"Volume: dollars on Polymarket, contracts on Kalshi. “No trades for 7 days”: the market is still open, but its price is old. Vigía reads no participant's identity.",
						)}
					</p>
				</>
			}
		>
			{failed && !view ? (
				<p class="mon-empty">
					{t(
						"No se pudieron cargar los mercados (se piden al abrir este panel).",
						"The markets could not be loaded (they are fetched when this panel opens).",
					)}{" "}
					<button
						type="button"
						class="link-button"
						onClick={() => {
							setFailed(false);
							wantPanel("predictions").catch(() => setFailed(true));
						}}
					>
						{t("Reintentar", "Retry")}
					</button>
				</p>
			) : view ? (
				<div class="pm">
					<p class="pm-disclaimer">
						{t(
							view.priceLabel,
							"Price of the last trade of a contract that pays US$1 if it happens: what participants bet, not a poll or a forecast by Vigía",
						)}
						.
					</p>
					{view.venues.some((v) => v.stale) ? (
						<p class="pm-stale" role="status">
							{view.venues
								.filter((v) => v.stale)
								.map((v) =>
									t(
										`${v.name}: desactualizado${v.lastReadAt ? ` (leído ${ago(now.value - v.lastReadAt, "es")})` : ""}`,
										`${v.name}: out of date${v.lastReadAt ? ` (read ${ago(now.value - v.lastReadAt, "en")})` : ""}`,
									),
								)
								.join(" · ")}
						</p>
					) : null}
					{events.length ? (
						<ol class="pm-events">
							{events.map((e) => (
								<Event key={`${e.venue}:${e.eventId}`} e={e} />
							))}
						</ol>
					) : (
						<p class="mon-empty">
							{t("Ningún mercado abierto sobre Venezuela ahora.", "No open market about Venezuela now.")}
						</p>
					)}
					{view.events.length > FIRST ? (
						<button type="button" class="pm-more" aria-expanded={all} onClick={() => setAll(!all)}>
							{all
								? t("Ver menos", "Show fewer")
								: t(`Ver los ${view.events.length} mercados`, `Show all ${view.events.length} markets`)}
						</button>
					) : null}
					<div class="sources-row">
						{view.venues.map((v) =>
							v.lastReadAt !== null ? (
								<SourceTag
									key={v.id}
									source={{ feed: v.id, observedAt: v.lastReadAt, url: v.homepage }}
									label={v.name}
								/>
							) : null,
						)}
					</div>
				</div>
			) : null}
		</Panel>
	);
}

registerSummary("apuestas", () => {
	const v = panels.value.predictions as { events: unknown[] } | undefined;
	if (!v?.events.length) return null;
	return {
		text: t(
			`${v.events.length} mercados de predicción abiertos sobre Venezuela (Polymarket, Kalshi)`,
			`${v.events.length} open prediction markets about Venezuela (Polymarket, Kalshi)`,
		),
		tone: "normal",
	};
});
