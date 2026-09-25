import { useState } from "preact/hooks";
import { addStyles } from "../lib/css.ts";
import { panels } from "../lib/data.ts";
import { int, num, pct } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { PANEL_META } from "../lib/panel-meta.ts";
import marketsCss from "../styles/markets.css?inline";
import { Panel } from "../ui/Panel.tsx";
import { SourceTag } from "../ui/Source.tsx";
import { Sparkline } from "../ui/Sparkline.tsx";

addStyles(marketsCss);

/* Mirrors src/panels/markets.ts: the server computes every figure and change; this file only formats. */

type Change = { abs: number; pct: number; from: string };
export interface MarketTile {
	id: string;
	labelEs: string;
	labelEn: string;
	unit: string;
	cadence: "daily" | "weekly-release" | "monthly";
	digits: number;
	feed: string;
	provider: string;
	sourceUrl: string;
	latest: { value: number; date: string; observedAt: number } | null;
	d1: Change | null;
	w1: Change | null;
	m1: Change | null;
	y1: Change | null;
	spark: number[];
	sparkFrom: string | null;
	stale: boolean;
	next: { value: number; date: string } | null;
}
interface PortWindow {
	from: string;
	to: string;
	days: number;
	calls: number;
	tankerCalls: number;
	importT: number;
	exportT: number;
}
export interface MarketsView {
	groups: { id: string; titleEs: string; titleEn: string; tiles: MarketTile[] }[];
	ports: {
		newestDate: string | null;
		observedAt: number | null;
		week: PortWindow | null;
		prevWeek: PortWindow | null;
		yearAgo: PortWindow | null;
		callsChangePct: number | null;
		callsYoYPct: number | null;
		weekly: { to: string; calls: number; tankerCalls: number; complete: boolean }[];
		byPort: {
			id: string;
			name: string;
			calls: number;
			tankerCalls: number;
			importT: number;
			exportT: number;
		}[];
		portCount: number;
		stale: boolean;
		caveatEs: string;
		caveatEn: string;
		sourceUrl: string;
	};
	rules: { es: string; en: string };
	attributions: { feed: string; text: string; licenceUrl: string }[];
}

/** Short source names for the tile tags; the provenance sheet has the full name and licence. */
const SHORT: Record<string, string> = {
	"fred-oil": "EIA vía FRED",
	"fred-markets": "FRED",
	"trm-colombia": "SFC Colombia",
	"bcb-ptax": "BCB",
	"wb-pinksheet": "Banco Mundial",
	"fao-ffpi": "FAO",
};

/** "2026-08" → "ago 2026"; "2026-09-22" → "22 sep" (dates as the source gives them, no time zone shift). */
function dateLabel(date: string, l: "es" | "en"): string {
	const locale = l === "es" ? "es-VE" : "en-US";
	if (date.length === 7) {
		return new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "short", year: "numeric" })
			.format(Date.parse(`${date}-01T00:00:00Z`))
			.replace(".", "");
	}
	return new Intl.DateTimeFormat(locale, { timeZone: "UTC", day: "numeric", month: "short" })
		.format(Date.parse(`${date}T00:00:00Z`))
		.replace(".", "");
}

/** Up/down is not good/bad for a world price: arrows and neutral colour, never green/red. */
function Delta({ c, label, title }: { c: Change | null; label: string; title: string }) {
	const l = lang.value;
	if (!c) return null;
	const dir = c.pct > 0.05 ? "up" : c.pct < -0.05 ? "down" : "flat";
	return (
		<span class={`mk-delta mk-delta--${dir}`} title={`${title} (${dateLabel(c.from, l)})`}>
			<span aria-hidden="true">{dir === "up" ? "▲" : dir === "down" ? "▼" : "="}</span>
			{pct(c.pct, 1, l)}
			<span class="mk-delta__label">{label}</span>
		</span>
	);
}

function Tile({ tile, tag = true }: { tile: MarketTile; tag?: boolean }) {
	const l = lang.value;
	const label = l === "es" ? tile.labelEs : tile.labelEn;
	const monthly = tile.cadence === "monthly";
	const latest = tile.latest;
	return (
		<li class={`mk-tile${tile.stale ? " mk-tile--stale" : ""}`}>
			<span class="mk-tile__label">{label}</span>
			{latest ? (
				<>
					<p class="mk-tile__value data">
						{num(latest.value, tile.digits, l)}
						<span class="figure__unit">{tile.unit}</span>
					</p>
					<p class="mk-tile__when data">
						{monthly
							? t(`promedio de ${dateLabel(latest.date, l)}`, `${dateLabel(latest.date, l)} average`)
							: dateLabel(latest.date, l)}
						{tile.stale ? <span class="mk-tile__stale"> · {t("con retraso", "delayed")}</span> : null}
					</p>
					<p class="mk-tile__deltas">
						{monthly ? (
							<Delta
								c={tile.m1}
								label={t("mes", "month")}
								title={t("Frente al mes anterior", "Against the previous month")}
							/>
						) : (
							<>
								<Delta
									c={tile.d1}
									label={t("día", "day")}
									title={t(
										"Frente al día hábil anterior (a 4 días como mucho; tras un hueco más largo no se muestra)",
										"Against the previous trading day (at most 4 days back; not shown after a longer gap)",
									)}
								/>
								<Delta c={tile.w1} label="7 d" title={t("Frente a hace 7 días", "Against 7 days earlier")} />
							</>
						)}
						<Delta
							c={tile.y1}
							label={t("1 año", "1 yr")}
							title={t("Frente a hace un año", "Against a year earlier")}
						/>
					</p>
					<Sparkline
						tone="info"
						height={28}
						values={tile.spark}
						summary={
							monthly
								? t(
										`${label}: últimos ${tile.spark.length} meses`,
										`${label}: last ${tile.spark.length} months`,
									)
								: t(`${label}: últimos 90 días`, `${label}: last 90 days`)
						}
					/>
					{tile.next ? (
						<p class="mk-tile__next data">
							{t("próxima", "next")} {dateLabel(tile.next.date, l)}: {num(tile.next.value, tile.digits, l)}
						</p>
					) : null}
					{tag ? (
						<SourceTag
							source={{
								feed: tile.feed,
								observedAt: latest.observedAt,
								url: tile.sourceUrl,
								detail: monthly
									? t(
											`${tile.provider}. Promedio mensual de ${dateLabel(latest.date, l)}.`,
											`${tile.provider}. Monthly average for ${dateLabel(latest.date, l)}.`,
										)
									: `${tile.provider}. ${latest.date}.`,
							}}
							label={SHORT[tile.feed] ?? tile.provider}
						/>
					) : null}
				</>
			) : (
				<p class="mk-tile__empty">{t("sin datos aún", "no data yet")}</p>
			)}
		</li>
	);
}

function kt(tonnes: number, l: "es" | "en"): string {
	return tonnes >= 1_000_000
		? `${num(tonnes / 1_000_000, 2, l)} Mt`
		: `${int(Math.round(tonnes / 1000), l)} kt`;
}

function Ports({ view }: { view: MarketsView["ports"] }) {
	const l = lang.value;
	const [all, setAll] = useState(false);
	const week = view.week;
	if (!week || !view.newestDate || view.observedAt === null) {
		return <p class="mk-tile__empty">{t("Puertos: sin datos aún", "Ports: no data yet")}</p>;
	}
	const shown = all ? view.byPort : view.byPort.slice(0, 5);
	const range = `${dateLabel(week.from, l)}–${dateLabel(week.to, l)}`;
	return (
		<div class="mk-ports">
			<div class="mk-ports__figures">
				<div class="figure">
					<span class="figure__label">{t("Buques que llegaron", "Ships that arrived")}</span>
					<span class="figure__value">{int(week.calls, l)}</span>
					<span class="note">
						{t(
							`${int(week.tankerCalls, l)} tanqueros · ${range}`,
							`${int(week.tankerCalls, l)} tankers · ${range}`,
						)}
						{week.days < 7 ? t(` (${week.days} de 7 días)`, ` (${week.days} of 7 days)`) : ""}
					</span>
				</div>
				<div class="figure">
					<span class="figure__label">{t("Frente a la semana anterior", "Against the week before")}</span>
					<span class="figure__value figure__value--plain">
						{view.callsChangePct === null ? "—" : pct(view.callsChangePct, 0, l)}
					</span>
					<span class="note">
						{view.prevWeek
							? t(`${int(view.prevWeek.calls, l)} buques`, `${int(view.prevWeek.calls, l)} ships`)
							: ""}
						{view.callsYoYPct !== null && view.yearAgo
							? t(
									` · hace 52 semanas ${int(view.yearAgo.calls, l)} (${pct(view.callsYoYPct, 0, l)})`,
									` · 52 weeks ago ${int(view.yearAgo.calls, l)} (${pct(view.callsYoYPct, 0, l)})`,
								)
							: ""}
					</span>
				</div>
				<div class="figure">
					<span class="figure__label">{t("Carga estimada", "Estimated cargo")}</span>
					<span class="figure__value figure__value--plain mk-ports__cargo">
						{kt(week.importT, l)} <span class="figure__unit">{t("entrada", "in")}</span>
					</span>
					<span class="note">
						{kt(week.exportT, l)} {t("de salida · estimación del FMI", "out · IMF estimate")}
					</span>
				</div>
			</div>
			<Sparkline
				tone="info"
				height={36}
				values={view.weekly.map((w) => w.calls)}
				summary={t(
					`Buques por semana, últimas ${view.weekly.length} semanas; la última: ${week.calls}`,
					`Ships per week, last ${view.weekly.length} weeks; latest: ${week.calls}`,
				)}
			/>
			<p class="mk-ports__axis data" aria-hidden="true">
				<span>{view.weekly[0] ? dateLabel(view.weekly[0].to, l) : ""}</span>
				<span>{t("buques por semana", "ships per week")}</span>
				<span>{dateLabel(view.newestDate, l)}</span>
			</p>
			{view.byPort.length ? (
				<ul class="mk-portlist">
					{shown.map((p) => (
						<li key={p.id}>
							<span class="mk-portlist__name">{p.name}</span>
							<span class="mk-portlist__n data">
								{int(p.calls, l)}
								{p.tankerCalls ? (
									<span class="mk-portlist__tk">
										{t(` · ${p.tankerCalls} tanq.`, ` · ${p.tankerCalls} tank.`)}
									</span>
								) : null}
							</span>
						</li>
					))}
				</ul>
			) : null}
			{view.byPort.length > 5 ? (
				<button type="button" class="link-button" onClick={() => setAll(!all)}>
					{all
						? t("Ver menos", "Show fewer")
						: t(
								`Ver los ${view.byPort.length} puertos con llegadas`,
								`Show all ${view.byPort.length} ports with arrivals`,
							)}
				</button>
			) : null}
			<p class="note mk-ports__caveat">{l === "es" ? view.caveatEs : view.caveatEn}</p>
			<div class="sources-row">
				<SourceTag
					source={{
						feed: "imf-portwatch",
						observedAt: view.observedAt,
						url: view.sourceUrl,
						detail: t(
							`FMI PortWatch, ${view.portCount} puertos y terminales; último día publicado ${view.newestDate} (UTC). Sumas semanales calculadas por Vigía.`,
							`IMF PortWatch, ${view.portCount} ports and terminals; newest published day ${view.newestDate} (UTC). Weekly sums computed by Vigía.`,
						),
					}}
					label="FMI PortWatch"
				/>
			</div>
		</div>
	);
}

type Group = MarketsView["groups"][number];

/** The one feed every tile of a group comes from (and has data), or null when they differ. */
function sharedFeed(g: Group): string | null {
	const feeds = new Set(g.tiles.map((x) => x.feed));
	return feeds.size === 1 && g.tiles.every((x) => x.latest) ? (g.tiles[0]?.feed ?? null) : null;
}

/** A group from one source carries one source tag (with the newest month) instead of one per tile. */
function GroupHead({ group }: { group: Group }) {
	const l = lang.value;
	const feed = sharedFeed(group);
	const first = group.tiles[0];
	const newest = group.tiles.reduce<MarketTile["latest"]>(
		(a, x) => (x.latest && (!a || x.latest.observedAt > a.observedAt) ? x.latest : a),
		null,
	);
	const title = (
		<h3 class="mk-group__h caps" id={`mk-${group.id}`}>
			{l === "es" ? group.titleEs : group.titleEn}
		</h3>
	);
	if (!feed || !first || !newest) return title;
	return (
		<div class="mk-group__head">
			{title}
			<SourceTag
				source={{
					feed,
					observedAt: newest.observedAt,
					url: first.sourceUrl,
					detail:
						first.cadence === "monthly"
							? t(
									`${first.provider}. Promedios mensuales; el último, ${dateLabel(newest.date, l)}.`,
									`${first.provider}. Monthly averages; the newest, ${dateLabel(newest.date, l)}.`,
								)
							: first.provider,
				}}
				label={SHORT[feed] ?? first.provider}
			/>
		</div>
	);
}

export function MarketsPanel() {
	const view = panels.value.markets as MarketsView | undefined;
	const l = lang.value;
	return (
		<Panel
			id="mercados"
			title={PANEL_META.mercados.title()}
			question={PANEL_META.mercados.question()}
			feeds={PANEL_META.mercados.feeds()}
			method={
				view ? (
					<>
						<p>{l === "es" ? view.rules.es : view.rules.en}</p>
						<p>
							{t(
								"Una flecha arriba o abajo dice hacia dónde se movió el precio, no si es bueno o malo: un petróleo más caro ayuda a las cuentas de PDVSA y encarece la gasolina importada.",
								"An up or down arrow says where the price moved, not whether that is good or bad: dearer oil helps PDVSA's accounts and makes imported fuel dearer.",
							)}
						</p>
						<p>{l === "es" ? view.ports.caveatEs : view.ports.caveatEn}</p>
						<ul class="mk-attrib">
							{view.attributions.map((a) => (
								<li key={a.feed}>
									{a.text} ·{" "}
									<a href={a.licenceUrl} target="_blank" rel="noopener noreferrer">
										{t("licencia", "licence")}
									</a>
								</li>
							))}
						</ul>
					</>
				) : null
			}
		>
			{!view ? (
				<p class="skeleton">…</p>
			) : (
				<div class="mk">
					{view.groups.map((g) => (
						<section class="mk-group" key={g.id} aria-labelledby={`mk-${g.id}`}>
							<GroupHead group={g} />
							{g.tiles.some((tile) => tile.latest) ? (
								<ul class="mk-tiles">
									{g.tiles.map((tile) => (
										<Tile key={tile.id} tile={tile} tag={!sharedFeed(g)} />
									))}
								</ul>
							) : (
								// A group with no data at all is one line, not a grid of empty tiles.
								<p class="mk-tile__empty">
									{t("Sin datos aún: ", "No data yet: ")}
									{g.tiles.map((tile) => (l === "es" ? tile.labelEs : tile.labelEn)).join(", ")}
								</p>
							)}
						</section>
					))}
					<section class="mk-group" aria-labelledby="mk-ports">
						<h3 class="mk-group__h caps" id="mk-ports">
							{t("Puertos de Venezuela (semanal, AIS)", "Venezuela's ports (weekly, AIS)")}
						</h3>
						<Ports view={view.ports} />
					</section>
				</div>
			)}
		</Panel>
	);
}
