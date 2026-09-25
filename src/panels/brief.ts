/**
 * The daily brief, built by code (no model): the day's most-covered stories with every outlet that covered them, and
 * the key figures with their sources. The same content renders as a page and as plain text people can paste into
 * WhatsApp or Telegram. A model-written paragraph is an optional extra in the AI section, never this.
 */
import { bcvApi } from "../adapters/bcv-api/index.ts";
import { bcvOfficial } from "../adapters/bcv-official/index.ts";
import { firmsFires } from "../adapters/firms-fires/index.ts";
import { funvisisQuakes } from "../adapters/funvisis-quakes/index.ts";
import { iodaStates } from "../adapters/ioda-states/index.ts";
import { nhcStorms } from "../adapters/nhc-storms/index.ts";
import { openMeteoWeather } from "../adapters/open-meteo-weather/index.ts";
import { mentionsVenezuela } from "../adapters/rss/factory.ts";
import { usgsQuakes } from "../adapters/usgs-quakes/index.ts";
import { yadio } from "../adapters/yadio/index.ts";
import type { Store } from "../core/store.ts";
import { stateByIso } from "../geo/index.ts";
import { normalize } from "../news/text.ts";
import type { Panel, PanelReader } from "../server/panels.ts";
import { ALL_CLEAR_MIN_STATES, type ConnectivityView, connectivityView } from "./connectivity.ts";
import { type FiresView, firesView } from "./fires.ts";
import { type HazardsView, hazardsView } from "./hazards.ts";
import { type MoneyView, moneyView } from "./money.ts";
import { type NewsView, newsView } from "./news.ts";
import { type QuakesView, quakesView } from "./quakes.ts";
import { type WeatherView, weatherView } from "./weather.ts";

const HOUR = 3_600_000;

export type BriefFigure = {
	label: string;
	value: string;
	source: string;
	/** When the figure was true: the source's own time, or the last successful check for a count. */
	observedAt: number | null;
	url: string | null;
	/** The feed missed its freshness budget: the value is the last one Vigía got, shown with its time. */
	stale: boolean;
};
export type BriefStory = { title: string; url: string; outlets: string[]; at: number; state: string | null };

export type BriefView = {
	/** Caracas calendar day this brief covers ("YYYY-MM-DD"). */
	day: string;
	generatedAt: number;
	figures: BriefFigure[];
	stories: BriefStory[];
	/** Plain text for messaging apps: every line with its source; links at the end. */
	text: string;
	method: string;
};

const fmt = (n: number, digits = 2) =>
	new Intl.NumberFormat("es-VE", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
const pct = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmt(Math.abs(n), 1)} %`;

export function caracasDay(t: number): string {
	return new Date(t - 4 * HOUR).toISOString().slice(0, 10);
}

/** Caracas wall-clock time of a figure: "14:05" today, "23/09 14:05" on another day. */
export function caracasTime(t: number, now: number): string {
	const iso = new Date(t - 4 * HOUR).toISOString();
	const hm = iso.slice(11, 16);
	return caracasDay(t) === caracasDay(now) ? hm : `${iso.slice(8, 10)}/${iso.slice(5, 7)} ${hm}`;
}

type Feed = { readonly id: string; readonly freshness: { readonly fetchMs: number } };

/** Newest successful run among the feeds that is inside its freshness budget, or null (no fresh check). */
function freshCheck(store: Store, feeds: readonly Feed[], now: number): number | null {
	let best: number | null = null;
	for (const feed of feeds) {
		const t = store.lastSuccessAt(feed.id);
		if (t !== null && now - t <= feed.freshness.fetchMs) best = Math.max(best ?? 0, t);
	}
	return best;
}

/**
 * Pure given the store: every figure comes from the tested panel computations, read from the panel cache when one
 * is given (so the brief never recomputes what the other panels already hold). A count or an "all clear" is only
 * stated when its feed checked inside its freshness budget; otherwise the line says there is no recent data.
 */
/** Politics words specific to Venezuela; "presidente", "gobierno" or "elecciones" alone fit any country's news. */
const VE_POLITICS =
	/(^| )(asamblea nacional|cne|tsj|psuv|fanb|oposicion venezolana|diputad(o|a|os|as)|chavis\w*)( |$)/;

/**
 * A story for "Lo más cubierto" (the brief, /resumen, /informe): about Venezuela, not just carried by Venezuelan
 * outlets. A Venezuelan state, a mention of Venezuela, or a topic other than politics; politics only with a
 * Venezuelan institution named (review 4, L15: a wire story on Trump and the White House press pool passed on
 * "presidente").
 */
export function aboutVenezuela(story: {
	title: string;
	states: readonly string[];
	topics: readonly string[];
}): boolean {
	if (story.states.length > 0 || mentionsVenezuela(story.title)) return true;
	if (story.topics.some((t) => t !== "politica")) return true;
	return story.topics.includes("politica") && VE_POLITICS.test(normalize(story.title));
}

export function briefView(store: Store, now: number, read?: PanelReader): BriefView {
	const view = <T>(id: string, compute: () => T): T => (read?.(id) as T | undefined) ?? compute();
	const stale = (feeds: readonly Feed[]) => freshCheck(store, feeds, now) === null;
	const figures: BriefFigure[] = [];
	const money = view<MoneyView>("money", () => moneyView(store, now));
	const usd = money.official.usd.current;
	if (usd) {
		figures.push({
			label: "Dólar oficial (BCV)",
			value: `Bs ${fmt(usd.vesPerUnit)}${money.official.usd.change24h ? ` (${pct(money.official.usd.change24h.pct)} en 24 h)` : ""}`,
			source: usd.route?.label ?? "BCV",
			observedAt: usd.validFrom,
			url: usd.sourceUrl,
			// Either route to the same figure keeps it current (money.ts).
			stale: stale([bcvOfficial, bcvApi]),
		});
	}
	const y = money.yadio.figure;
	if (y) {
		figures.push({
			label: "Yadio (índice P2P)",
			value: `Bs ${fmt(y.vesPerUsd)}${y.gap ? `, brecha ${pct(y.gap.pct)} frente al BCV` : ""}`,
			source: "Yadio",
			observedAt: y.observedAt,
			url: money.yadio.sourceUrl,
			stale: stale([yadio]),
		});
	}
	const conn = view<ConnectivityView>("connectivity", () => connectivityView(store, now));
	if (conn.asOf) {
		const affected = conn.states.filter((s) => s.level === "drop" || s.level === "severe").map((s) => s.name);
		figures.push({
			label: "Internet por estado (IODA)",
			value: affected.length
				? `caída de señal en ${affected.join(", ")}`
				: conn.summary.allClear
					? "sin caídas de señal por estado"
					: conn.summary.states.normal === 0
						? // The connectivity panel's coverage rule: no state with data is no reading at all (review 4, M1).
							"sin datos suficientes de IODA en este momento"
						: `sin caídas en los ${conn.summary.states.normal} estados con datos; faltan datos de ${conn.summary.states.noData} (se necesitan ${ALL_CLEAR_MIN_STATES} para afirmar que no hay caídas)`,
			source: "IODA, Georgia Tech",
			observedAt: conn.asOf,
			url: conn.country.sourceUrl,
			stale: stale([iodaStates]),
		});
	}
	const quakes = view<QuakesView>("quakes", () => quakesView(store, now));
	const quakesChecked = freshCheck(store, [usgsQuakes, funvisisQuakes], now);
	const strongest = quakes.items
		.filter((q) => q.zone !== "far" && q.at >= now - 24 * HOUR)
		.sort((a, b) => b.maxMag - a.maxMag)[0];
	if (quakesChecked !== null || strongest) {
		// A count, and above all a zero, is only true if a quake feed checked recently.
		figures.push({
			label: "Sismos en 24 h (Venezuela y cerca)",
			value:
				quakesChecked === null
					? `sin datos recientes; el mayor registrado M${fmt(strongest?.maxMag ?? 0, 1)} ${strongest?.placeEs ?? ""}`.trim()
					: `${quakes.counts.day}${strongest ? `; el mayor M${fmt(strongest.maxMag, 1)} ${strongest.placeEs} (${caracasTime(strongest.at, now)})` : ""}`,
			source: "USGS, FUNVISIS",
			observedAt: quakesChecked ?? strongest?.at ?? null,
			url: strongest ? (strongest.usgs?.url ?? strongest.funvisis?.url ?? null) : null,
			stale: quakesChecked === null,
		});
	} else {
		figures.push({
			label: "Sismos en 24 h (Venezuela y cerca)",
			value: "sin datos recientes de USGS ni FUNVISIS",
			source: "USGS, FUNVISIS",
			observedAt: null,
			url: null,
			stale: true,
		});
	}
	const fires = view<FiresView>("fires", () => firesView(store, now));
	if (fires.newestDetectionAt && !stale([firmsFires])) {
		figures.push({
			label: "Focos de calor en 24 h",
			value: `${fires.venezuela.last24h - fires.venezuela.persistent24h} probables incendios${fires.topStates[0] ? `, más en ${fires.topStates[0].stateName}` : ""}`,
			source: "NASA FIRMS",
			observedAt: fires.newestDetectionAt,
			url: fires.sourceUrl,
			stale: false,
		});
	}
	const hazards = view<HazardsView>("hazards", () => hazardsView(store, now));
	const nhcStale = stale([nhcStorms]);
	figures.push({
		label: "Ciclones",
		value: nhcStale ? "sin datos recientes de NOAA" : hazards.storms.statusEs,
		source: "NOAA NHC",
		observedAt: hazards.storms.checkedAt,
		url: "https://www.nhc.noaa.gov/",
		stale: nhcStale,
	});
	const weather = view<WeatherView>("weather", () => weatherView(store, now));
	const storms = weather.notable.filter((n) => n.rule === "storm").length;
	// "No storms" is a claim of absence: only from a forecast inside its freshness budget.
	if (weather.newestObservedAt && (storms > 0 || !stale([openMeteoWeather]))) {
		figures.push({
			label: "Pronóstico, próximas 24 h",
			value: storms ? `tormentas en ${storms} capitales de estado` : "sin tormentas previstas en capitales",
			source: "Open-Meteo (modelo)",
			observedAt: weather.newestObservedAt,
			url: weather.sourceUrl,
			stale: stale([openMeteoWeather]),
		});
	}

	// Most covered: distinct outlets with a dated item in the last 24 h (not the recency-weighted front page).
	const news = view<NewsView>("news", () => newsView(store, now));
	const stories: BriefStory[] = news.covered24h
		.map((c) => ({ story: news.stories[c.id], outlets: c.outlets }))
		.filter((c): c is { story: NonNullable<typeof c.story>; outlets: string[] } => Boolean(c.story))
		.filter(({ story }) => aboutVenezuela(story))
		.slice(0, 8)
		.map(({ story, outlets }) => ({
			title: story.title,
			url: story.url,
			outlets,
			at: story.at,
			state: story.state ? (stateByIso(story.state)?.name ?? null) : null,
		}));

	const day = caracasDay(now);
	const lines = [`Vigía · Resumen del ${day} (hora de Caracas)`, "", "Cifras:"];
	for (const f of figures) {
		const when = f.observedAt
			? ` (dato: ${caracasTime(f.observedAt, now)}${f.stale ? ", sin actualizar" : ""})`
			: "";
		lines.push(`• ${f.label}: ${f.value}${when} [${f.source}]`);
	}
	lines.push("", "Lo más cubierto en 24 h:");
	stories.forEach((s, i) => {
		lines.push(
			`${i + 1}. ${s.title}${s.state ? ` (${s.state})` : ""} — ${s.outlets.length} ${s.outlets.length === 1 ? "medio" : "medios"}: ${s.outlets.slice(0, 4).join(", ")}${s.outlets.length > 4 ? "…" : ""}`,
		);
		lines.push(`   ${s.url}`);
	});
	lines.push("", "Hecho por código a partir de fuentes públicas; sin IA. Cada cifra con su fuente.");
	return {
		day,
		generatedAt: now,
		figures,
		stories,
		text: lines.join("\n"),
		method:
			"Resumen armado por código: cifras de los paneles (cada una con su fuente y su hora; un conteo solo se afirma si la fuente respondió hace poco) y las historias con más medios distintos que publicaron en las últimas 24 h. Sin texto generado por IA.",
	};
}

export const briefPanel: Panel<BriefView> = {
	id: "brief",
	sources: [
		"bcv-official",
		"bcv-api",
		"yadio",
		"ioda-states",
		"usgs-quakes",
		"funvisis-quakes",
		"firms-fires",
		"nhc-storms",
		"open-meteo-weather",
	],
	compute: (store: Store, now: number, read?: PanelReader) => briefView(store, now, read),
};
