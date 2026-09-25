import type { ComponentChildren } from "preact";
import { healthById, panels } from "../lib/data.ts";
import { int, num, pct } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { Digits } from "../ui/Digits.tsx";
import type { ConnectivityView } from "./Connectivity.tsx";
import type { FiresView, HazardsView } from "./Earth.tsx";
import type { MoneyView } from "./Money.tsx";
import type { NewsView } from "./News.tsx";
import type { QuakesView } from "./Quakes.tsx";

/**
 * The country's vital signs in one row: each tile is a figure computed on the server, with a link to its panel
 * (where its source and age are). Tiles with no data yet say so instead of showing zero.
 */
function Tile(props: {
	href: string;
	label: string;
	value: ComponentChildren;
	sub?: ComponentChildren;
	tone?: "normal" | "warn" | "alert" | "signal";
	/** Feeds behind the figure: without fresh data the tile says so instead of showing a number (never a false 0). */
	feeds: readonly string[];
	/** The figure is a count of zero: on late data it is a dash, not a bold "0" (review 4, M2). */
	zero?: boolean;
}) {
	const states = props.feeds.map((f) => healthById.value.get(f)?.state ?? "pending");
	const usable = states.some((st) => st === "ok" || st === "degraded" || st === "stale");
	const stale = usable && states.every((st) => st === "stale" || st === "failing" || st === "pending");
	if (!usable) {
		return (
			<a class="tile tile--nodata" href={props.href}>
				<span class="tile__label">{props.label}</span>
				<span class="tile__value data">—</span>
				<span class="tile__sub">{t("sin datos todavía", "no data yet")}</span>
			</a>
		);
	}
	return (
		<a class={`tile tile--${stale ? "warn" : (props.tone ?? "normal")}`} href={props.href}>
			<span class="tile__label">{props.label}</span>
			<span class="tile__value data">{stale && props.zero ? "—" : props.value}</span>
			<span class="tile__sub">{stale ? t("desactualizado", "out of date") : props.sub}</span>
		</a>
	);
}

const WAIT = "…";

/**
 * A tile figure that rolls when its number changes; "…" while it has none. `speak` announces the change to screen
 * readers: only for rates and anomaly counts.
 */
function fig(
	label: string,
	raw: number | null | undefined,
	format: (n: number) => string,
	unit?: string,
	speak = false,
) {
	if (raw === null || raw === undefined) return WAIT;
	return <Digits value={format(raw)} raw={raw} label={label} announce={speak} {...(unit ? { unit } : {})} />;
}

export function Pulse() {
	const p = panels.value;
	const l = lang.value;
	const money = p.money as MoneyView | undefined;
	const conn = p.connectivity as ConnectivityView | undefined;
	const quakes = p.quakes as QuakesView | undefined;
	const fires = p.fires as FiresView | undefined;
	const hazards = p.hazards as HazardsView | undefined;
	const news = p.news as NewsView | undefined;
	const usd = money?.official.usd.current;
	const yadio = money?.yadio.figure;
	const dropped = conn ? conn.summary.states.drop + conn.summary.states.severe : null;
	const threats = hazards
		? hazards.storms.threats + hazards.gdacs.counts.red + hazards.gdacs.counts.orange
		: null;
	return (
		<nav class="pulse" aria-label={t("Signos vitales", "Vital signs")}>
			<Tile
				href="#dinero"
				feeds={["bcv-official", "bcv-api", "bcv-history"]}
				label={t("Dólar BCV", "BCV dollar")}
				value={fig(t("Dólar BCV", "BCV dollar"), usd?.vesPerUnit, (n) => num(n, 2, l), "Bs", true)}
				sub={money?.official.usd.change24h ? `${pct(money.official.usd.change24h.pct, 2, l)} 24 h` : "Bs"}
			/>
			<Tile
				href="#dinero"
				feeds={["yadio"]}
				label="Yadio"
				value={fig("Yadio", yadio?.vesPerUsd, (n) => num(n, 2, l), "Bs", true)}
				sub={yadio?.gap ? `${t("brecha", "gap")} ${pct(yadio.gap.pct, 1, l)}` : "Bs"}
				tone="signal"
			/>
			<Tile
				href="#conectividad"
				feeds={["ioda-states"]}
				label={t("Estados con caída de señal", "States with a signal drop")}
				value={
					dropped === null
						? WAIT
						: dropped === 0 && !conn?.summary.allClear
							? // Not enough states with fresh data to say zero: a dash, not "…" (which reads as loading).
								"—"
							: fig(
									t("Estados con caída de señal", "States with a signal drop"),
									dropped,
									(n) => int(n, l),
									undefined,
									true,
								)
				}
				sub={
					conn && dropped === 0 && !conn.summary.allClear
						? conn.summary.states.normal
							? `${t("datos de", "data for")} ${conn.summary.states.normal} ${t("de", "of")} ${conn.states.length} · IODA`
							: t("sin datos suficientes · IODA", "not enough data · IODA")
						: conn
							? `${t("de", "of")} ${conn.states.length} · IODA`
							: "IODA"
				}
				tone={dropped ? (conn?.summary.states.severe ? "alert" : "warn") : "normal"}
				zero={dropped === 0}
			/>
			<Tile
				href="#sismos"
				feeds={["usgs-quakes", "funvisis-quakes"]}
				label={t("Sismos 24 h", "Quakes 24 h")}
				value={fig(t("Sismos en 24 h", "Quakes in 24 h"), quakes?.counts.day, (n) => int(n, l))}
				sub={quakes ? `${int(quakes.counts.week, l)} ${t("en 7 días", "in 7 days")}` : "USGS · FUNVISIS"}
				zero={quakes?.counts.day === 0}
			/>
			<Tile
				href="#incendios"
				feeds={["firms-fires"]}
				label={t("Focos de calor 24 h", "Heat spots 24 h")}
				value={fig(
					t("Focos de calor en 24 h", "Heat spots in 24 h"),
					fires ? fires.venezuela.last24h - fires.venezuela.persistent24h : null,
					(n) => int(n, l),
				)}
				sub="NASA FIRMS"
			/>
			<Tile
				href="#alertas"
				feeds={["nhc-storms", "gdacs-events"]}
				label={t("Alertas", "Alerts")}
				value={fig(t("Alertas", "Alerts"), threats, (n) => int(n, l), undefined, true)}
				sub={t("ciclones cerca, GDACS", "nearby cyclones, GDACS")}
				tone={threats ? "warn" : "normal"}
				zero={threats === 0}
			/>
			<Tile
				href="#noticias"
				feeds={["el-pitazo", "efecto-cocuyo", "tal-cual", "cronica-uno", "runrunes", "el-diario"]}
				label={t("Titulares 24 h", "Headlines 24 h")}
				value={fig(t("Titulares en 24 h", "Headlines in 24 h"), news?.items24h, (n) => int(n, l))}
				sub={news ? `${news.outletsReporting24h} ${t("medios", "outlets")}` : ""}
			/>
		</nav>
	);
}
