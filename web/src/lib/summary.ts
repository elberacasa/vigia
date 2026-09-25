import type { AirspaceView } from "../panels/Airspace.tsx";
import type { AttentionView } from "../panels/Attention.tsx";
import type { CensorshipView } from "../panels/Censorship.tsx";
import type { ConnectivityView } from "../panels/Connectivity.tsx";
import type { GazetteView, PocketView, ServicesView } from "../panels/Daily.tsx";
import type { FiresView, HazardsView, WeatherView } from "../panels/Earth.tsx";
import { type EnergyView, NOTABLE } from "../panels/energy-view.ts";
import type { HumanitarianView } from "../panels/Humanitarian.tsx";
import type { NightlightsView, SatelliteView } from "../panels/Imagery.tsx";
import type { IncidentsView } from "../panels/Incidents.tsx";
import type { LiveTvView } from "../panels/LiveTv.tsx";
import type { MarketsView } from "../panels/Markets.tsx";
import type { MoneyView } from "../panels/Money.tsx";
import type { NetwatchView } from "../panels/Netwatch.tsx";
import type { NewsView } from "../panels/News.tsx";
import type { QuakesView } from "../panels/Quakes.tsx";
import { healthById, now, panels } from "./data.ts";
import { ago, clock, int, num, pct } from "./format.ts";
import { groupFreshness, internetWord, isLive } from "./fresh.ts";
import { lang, t } from "./i18n.ts";
import type { PanelId } from "./layout.ts";

/**
 * The one line a collapsed panel keeps, so it still answers its question: "Sismos · 9 en 24 h · el mayor M3,6…".
 * Built only from figures the server already computed (formatting here, no arithmetic on data beyond picking
 * the largest row), with a tone that marks what is not normal by the same rules the panel itself uses.
 */
export type Tone = "normal" | "warn" | "alert";
export interface Summary {
	text: string;
	tone: Tone;
	/** A few labelled figures for the phone's compact rows (the dollar). */
	figures?: { label: string; value: string; unit?: string }[];
}

/** The key of each panel's computed view in /api/panels. */
const DATA: Record<PanelId, string> = {
	incidentes: "incidents",
	dinero: "money",
	bolsillo: "pocket",
	servicios: "services",
	gaceta: "gazette",
	conectividad: "connectivity",
	noticias: "news",
	sismos: "quakes",
	clima: "weather",
	luces: "nightlights",
	incendios: "fires",
	alertas: "hazards",
	satelite: "satellite",
	petroleo: "oil",
	mercados: "markets",
	censura: "censorship",
	red: "netwatch",
	energia: "energy",
	"espacio-aereo": "airspace",
	atencion: "attention",
	tv: "livetv",
	humanitario: "humanitarian",
};

/** The server's panel id behind a wall panel (for /api/panels and /api/evidence). */
export function dataKey(id: PanelId): string {
	return DATA[id];
}

/** Whether the panel's data has arrived at all (the panel shows a loading state until then). */
export function panelReady(id: string): boolean {
	const key = DATA[id as PanelId];
	return key === undefined || panels.value[key] !== undefined;
}

interface OilView {
	benchmarks: {
		id: string;
		label: string;
		latest: { usdPerBarrel: number } | null;
		change: { pct: number } | null;
	}[];
}

function plural(n: number, one: string, many: string): string {
	return n === 1 ? one : many;
}

/**
 * The feeds behind each summary (review 3, L4: the phone's one-line summaries had no freshness gate). When none of
 * them is live, a claim of absence ("Ninguno en 24 h", "Sin amenazas") becomes "Sin datos recientes", and a figure
 * keeps its value with the age of its data. Every panel has an entry (review 4, M2: incidents, network and markets
 * had none, so "Ninguna coincidencia de fuentes ahora" sat next to "Desactualizado"); a test checks it against
 * panel-meta. A function reads the feeds the panel's own view names.
 */
export const SUMMARY_FEEDS: Record<PanelId, readonly string[] | (() => readonly string[])> = {
	incidentes: () => (panels.value.incidents as { feeds?: string[] } | undefined)?.feeds ?? ["ioda-states"],
	dinero: ["bcv-official", "bcv-api", "bcv-history"],
	bolsillo: ["bcv-official", "bcv-api", "bcv-history"],
	servicios: ["dahiti-guri"],
	gaceta: ["gaceta-oficial"],
	conectividad: ["ioda-states"],
	// The headline count is dated by the stories themselves; the outlets are too many to gate on (one late is normal).
	noticias: [],
	sismos: ["usgs-quakes", "funvisis-quakes"],
	clima: ["open-meteo-weather"],
	luces: ["gibs-nightlights"],
	incendios: ["firms-fires"],
	alertas: ["nhc-storms", "gdacs-events"],
	satelite: ["goes-nsa"],
	petroleo: ["fred-oil"],
	mercados: ["fred-oil", "fred-markets", "trm-colombia", "wb-pinksheet", "imf-portwatch"],
	censura: ["ooni-ve", "vesinfiltro-blocks"],
	red: ["ooni-methods", "tor-metrics", "ripestat-prefixes"],
	energia: ["firms-flares"],
	"espacio-aereo": ["easa-czib", "faa-prohibitions"],
	atencion: ["wiki-attention"],
	tv: ["radio-streams", "youtube-live"],
	humanitario: ["mpps-boletin", "who-gho", "r4v-figures", "unhcr-population", "ocha-fts"],
};

/** The feeds behind a panel's one-line summary. */
export function summaryFeeds(id: PanelId): readonly string[] {
	const f = SUMMARY_FEEDS[id];
	return typeof f === "function" ? f() : f;
}

/** A summary before the freshness gate; `absence` marks a claim that nothing is happening. */
type Draft = Summary & { absence?: boolean };

export function summarize(id: PanelId): Summary | null {
	const draft = compute(id);
	if (!draft) return null;
	const { absence, ...s } = draft;
	const feeds = summaryFeeds(id);
	if (!feeds.length) return s;
	const f = groupFreshness(feeds, healthById.value);
	if (!f.stale) return s;
	const age = f.lastAt ? ago(now.value - f.lastAt, lang.value) : null;
	if (absence)
		return {
			text: age
				? t(`Sin datos recientes (último ${age})`, `No recent data (last ${age})`)
				: t("Sin datos recientes", "No recent data"),
			tone: "normal",
		};
	return {
		...s,
		text: age ? `${s.text} · ${t("dato de", "data from")} ${age}` : s.text,
	};
}

function compute(id: PanelId): Draft | null {
	const p = panels.value;
	const l = lang.value;
	switch (id) {
		case "incidentes": {
			const v = p.incidents as IncidentsView | undefined;
			if (!v) return null;
			const active = v.incidents.filter((i) => i.status === "active");
			const measured = active.filter((i) => !i.reportsOnly);
			const reports = active.length - measured.length;
			const where = (list: typeof active) => list.map((i) => i.stateName ?? i.title[l]).join(", ");
			if (measured.length)
				return {
					text: t(
						`${measured.length} ${plural(measured.length, "corroborado", "corroborados")}: ${where(measured)}${reports ? ` · ${reports} solo con reportes` : ""}`,
						`${measured.length} corroborated: ${where(measured)}${reports ? ` · ${reports} with reports only` : ""}`,
					),
					tone: "warn",
				};
			if (reports)
				return {
					text: t(
						`Solo reportes de prensa, sin medición: ${where(active)}`,
						`Press reports only, no measurement: ${where(active)}`,
					),
					tone: "normal",
				};
			return {
				text: t("Ninguna coincidencia de fuentes ahora", "No sources agree on anything now"),
				tone: "normal",
				absence: true,
			};
		}
		case "dinero": {
			const v = p.money as MoneyView | undefined;
			const usd = v?.official.usd.current;
			if (!v || !usd) return null;
			// Yadio has its own feed: a late Yadio figure is left out rather than shown beside a current BCV rate.
			const yadioLive = isLive(healthById.value.get("yadio")?.state);
			const y = yadioLive ? v.yadio.figure : null;
			const figures: NonNullable<Summary["figures"]> = [
				{ label: "BCV", value: num(usd.vesPerUnit, 2, l), unit: "Bs" },
			];
			if (y) figures.push({ label: "Yadio", value: num(y.vesPerUsd, 2, l), unit: "Bs" });
			if (y?.gap) figures.push({ label: t("Brecha", "Gap"), value: pct(y.gap.pct, 1, l) });
			return {
				text: figures.map((f) => `${f.label} ${f.value}${f.unit ? ` ${f.unit}` : ""}`).join(" · "),
				tone: "normal",
				figures,
			};
		}
		case "conectividad": {
			const v = p.connectivity as ConnectivityView | undefined;
			if (!v) return null;
			// One wording for every surface: "sin caídas" only with the server's all-clear and a live IODA feed.
			// Before /api/health loads, IODA's state is unknown: say nothing rather than "sin caídas" or "sin datos".
			const ioda = healthById.value.get("ioda-states");
			if (!ioda) return null;
			const word = internetWord(v, isLive(ioda.state), lang.value);
			if (!word) return null;
			const names = v.summary.affected.join(", ");
			const s = v.summary.states;
			if (s.drop + s.severe > 0 && word.tone !== "muted")
				return {
					text: names ? `${word.long}: ${names}` : word.long,
					tone: word.tone === "alert" ? "alert" : "warn",
				};
			// No data (or a late feed) is an absence claim: the freshness gate words it "Sin datos recientes (último …)".
			return { text: word.long, tone: "normal", absence: word.tone === "muted" };
		}
		case "noticias": {
			const v = p.news as NewsView | undefined;
			if (!v) return null;
			const top = v.top.map((sid) => v.stories[sid]).find((s) => s !== undefined);
			const count = t(
				`${int(v.items24h, l)} titulares en 24 h de ${v.outletsReporting24h} medios`,
				`${int(v.items24h, l)} headlines in 24 h from ${v.outletsReporting24h} outlets`,
			);
			return {
				text: top
					? t(
							`Más cubierto (${top.outletCount} medios): ${top.title}`,
							`Most covered (${top.outletCount} outlets): ${top.title}`,
						)
					: count,
				tone: "normal",
			};
		}
		case "sismos": {
			const v = p.quakes as QuakesView | undefined;
			if (!v) return null;
			const day = v.items.filter((q) => q.zone !== "far" && now.value - q.at < 86_400_000);
			const biggest = day.reduce<(typeof day)[number] | null>(
				(best, q) => (!best || q.maxMag > best.maxMag ? q : best),
				null,
			);
			if (!v.counts.day || !biggest)
				return {
					text: t(
						`Ninguno en 24 h · ${int(v.counts.week, l)} en 7 días`,
						`None in 24 h · ${int(v.counts.week, l)} in 7 days`,
					),
					tone: "normal",
					absence: true,
				};
			return {
				text: t(
					`${int(v.counts.day, l)} en 24 h · el mayor M${num(biggest.maxMag, 1, l)} ${biggest.placeEs}`,
					`${int(v.counts.day, l)} in 24 h · largest M${num(biggest.maxMag, 1, l)} ${biggest.placeEs}`,
				),
				tone: day.some((q) => q.feltSize) ? "warn" : "normal",
			};
		}
		case "clima": {
			const v = p.weather as WeatherView | undefined;
			if (!v) return null;
			if (!v.notable.length)
				return {
					text: t("Sin tormentas ni lluvias fuertes previstas", "No storms or heavy rain ahead"),
					tone: "normal",
					absence: true,
				};
			const RULES = {
				storm: ["Tormenta", "Thunderstorms"],
				heavyRain: ["Lluvia fuerte", "Heavy rain"],
				gale: ["Ráfagas fuertes", "Strong gusts"],
				heat: ["Calor peligroso", "Dangerous heat"],
			} as const;
			const parts = (Object.keys(RULES) as (keyof typeof RULES)[])
				.map((rule) => {
					const n = new Set(v.notable.filter((x) => x.rule === rule).map((x) => x.capital)).size;
					if (!n) return null;
					const [es, en] = RULES[rule];
					return t(
						`${es} en ${n} ${plural(n, "capital", "capitales")}`,
						`${en} in ${n} ${plural(n, "capital", "capitals")}`,
					);
				})
				.filter((x) => x !== null);
			return {
				text: parts.join(" · "),
				tone: v.notable.some((x) => x.when === "now") ? "warn" : "normal",
			};
		}
		case "luces": {
			const v = p.nightlights as NightlightsView | undefined;
			const n = v?.national;
			if (!v || !n) return null;
			if (n.comparable && n.pctChange !== null)
				return {
					text: t(
						`Venezuela: ${pct(n.pctChange, 0, l)} de luz frente a sus noches anteriores`,
						`Venezuela: ${pct(n.pctChange, 0, l)} light versus previous nights`,
					),
					tone: "normal",
				};
			return {
				text:
					n.quality === "cloudy"
						? t("Noche mayormente nublada: sin comparación útil", "Mostly cloudy night: no useful comparison")
						: t("Sin comparación útil esta noche", "No useful comparison tonight"),
				tone: "normal",
			};
		}
		case "incendios": {
			const v = p.fires as FiresView | undefined;
			if (!v) return null;
			const likely = v.venezuela.last24h - v.venezuela.persistent24h;
			const top = v.topStates[0];
			return {
				text: t(
					`${int(likely, l)} focos probables en 24 h${top?.likelyFires24h ? ` · más en ${top.stateName} (${int(top.likelyFires24h, l)})` : ""}`,
					`${int(likely, l)} likely fires in 24 h${top?.likelyFires24h ? ` · most in ${top.stateName} (${int(top.likelyFires24h, l)})` : ""}`,
				),
				tone: "normal",
			};
		}
		case "alertas": {
			const v = p.hazards as HazardsView | undefined;
			if (!v) return null;
			const threats = v.storms.threats + v.gdacs.counts.red + v.gdacs.counts.orange;
			if (threats)
				return {
					text: t(
						`${threats} ${plural(threats, "alerta", "alertas")} para Venezuela o cerca`,
						`${threats} ${plural(threats, "alert", "alerts")} for or near Venezuela`,
					),
					tone: v.gdacs.counts.red ? "alert" : "warn",
				};
			const storms = v.storms.active.length;
			return {
				text: storms
					? t(
							`Sin amenazas para Venezuela · ${storms} ${plural(storms, "ciclón activo", "ciclones activos")} lejos`,
							`No threats to Venezuela · ${storms} active ${plural(storms, "cyclone", "cyclones")} far away`,
						)
					: t("Sin amenazas para Venezuela", "No threats to Venezuela"),
				tone: "normal",
				absence: true,
			};
		}
		case "satelite": {
			const v = p.satellite as SatelliteView | undefined;
			if (!v?.newest) return null;
			return {
				text: t(
					`GOES-19, imagen de las ${clock(v.newest.observedAt, l)} · ${v.frames.length} en el bucle`,
					`GOES-19, image from ${clock(v.newest.observedAt, l)} · ${v.frames.length} in the loop`,
				),
				tone: "normal",
			};
		}
		case "petroleo": {
			const v = p.oil as OilView | undefined;
			if (!v) return null;
			const parts = v.benchmarks
				.filter((b) => b.latest)
				.map(
					(b) =>
						`${b.label} ${num(b.latest?.usdPerBarrel ?? 0, 2, l)} US$${b.change ? ` (${pct(b.change.pct, 1, l)})` : ""}`,
				);
			return parts.length ? { text: parts.join(" · "), tone: "normal" } : null;
		}
		case "censura": {
			const v = p.censorship as CensorshipView | undefined;
			if (!v) return null;
			const parts: string[] = [];
			if (v.vsf)
				parts.push(
					t(
						`${int(v.vsf.sitesBlocked, l)} sitios bloqueados (VE sin Filtro)`,
						`${int(v.vsf.sitesBlocked, l)} sites blocked (VE sin Filtro)`,
					),
				);
			if (v.ooni)
				parts.push(
					t(
						`${int(v.ooni.domainsFlagged, l)} con indicios (OONI)`,
						`${int(v.ooni.domainsFlagged, l)} flagged (OONI)`,
					),
				);
			return parts.length ? { text: parts.join(" · "), tone: "normal" } : null;
		}
		case "red": {
			const v = p.netwatch as NetwatchView | undefined;
			if (!v) return null;
			const parts: string[] = [];
			if (v.methods.days.length)
				parts.push(
					t(
						`${int(v.methods.totalBlocked, l)} sitios bloqueados (OONI)`,
						`${int(v.methods.totalBlocked, l)} sites blocked (OONI)`,
					),
				);
			if (v.tor.latest?.relay != null)
				parts.push(t(`Tor ${int(v.tor.latest.relay, l)}/día`, `Tor ${int(v.tor.latest.relay, l)}/day`));
			const routeEvents = v.routing.events.filter((e) => e.by >= now.value - 2 * 86_400_000).length;
			if (v.routing.isps.length)
				parts.push(
					routeEvents
						? t(`${routeEvents} cambios de rutas en 48 h`, `${routeEvents} routing changes in 48 h`)
						: t("rutas sin cambios", "routes unchanged"),
				);
			const torAlert = v.tor.recentFlags.some((f) => f.day >= (v.tor.latest?.day ?? 0) - 3 * 86_400_000);
			return parts.length
				? { text: parts.join(" · "), tone: routeEvents ? "alert" : torAlert ? "warn" : "normal" }
				: null;
		}
		case "energia": {
			const v = p.energy as EnergyView | undefined;
			if (!v?.latestNight) return null;
			const notable = v.facilities.filter((f) => NOTABLE.includes(f.status));
			const lit = t(
				`Llama en ${v.lit7} de ${v.facilities.length} instalaciones (7 noches)`,
				`Flame at ${v.lit7} of ${v.facilities.length} facilities (7 nights)`,
			);
			if (!notable.length) return { text: lit, tone: "normal" };
			const dark = notable.filter((f) => f.status === "dark");
			return {
				text: `${notable.map((f) => (l === "es" ? f.nameEs : f.nameEn)).join(", ")}: ${t("fuera de lo habitual", "out of the ordinary")} · ${lit}`,
				tone: dark.some((f) => f.kind === "refinery" || f.kind === "complex") ? "alert" : "warn",
			};
		}
		case "mercados": {
			const v = p.markets as MarketsView | undefined;
			if (!v) return null;
			const tiles = v.groups.flatMap((g) => g.tiles);
			const parts: string[] = [];
			for (const id of ["brent", "usd-cop", "pink-gold"]) {
				const x = tiles.find((tile) => tile.id === id);
				if (!x?.latest) continue;
				const c = x.cadence === "monthly" ? x.m1 : x.d1;
				parts.push(
					`${l === "es" ? x.labelEs : x.labelEn} ${num(x.latest.value, id === "pink-gold" ? 0 : x.digits, l)}${c ? ` (${pct(c.pct, 1, l)})` : ""}`,
				);
			}
			if (v.ports.week)
				parts.push(
					t(
						`${int(v.ports.week.calls, l)} buques en puertos en 7 días`,
						`${int(v.ports.week.calls, l)} ships in port in 7 days`,
					),
				);
			return parts.length ? { text: parts.join(" · "), tone: "normal" } : null;
		}
		case "espacio-aereo": {
			const v = p.airspace as AirspaceView | undefined;
			if (!v || v.status === "unknown") return null;
			return v.status === "advisory"
				? {
						text: t(
							"Aviso vigente sobre el espacio aéreo venezolano",
							"Advisory in force on Venezuelan airspace",
						),
						tone: "alert",
					}
				: {
						text: t(
							"Sin avisos vigentes de EASA ni FAA para Venezuela",
							"No EASA or FAA advisory in force for Venezuela",
						),
						tone: "normal",
						absence: true,
					};
		}
		case "humanitario": {
			const v = p.humanitarian as HumanitarianView | undefined;
			if (!v) return null;
			const parts: string[] = [];
			const malaria = v.health.figures.find((f) => f.id === "malaria");
			if (v.health.bulletin && malaria?.week != null)
				parts.push(
					t(
						`Malaria ${int(malaria.week, l)} casos (SE ${v.health.bulletin.week})`,
						`Malaria ${int(malaria.week, l)} cases (week ${v.health.bulletin.week})`,
					),
				);
			const hrp = v.aid.plans.find((x) => x.kind === "hrp");
			if (hrp?.pctFunded != null)
				parts.push(
					t(
						`plan humanitario ${hrp.year}: ${num(hrp.pctFunded, 0, l)} % financiado`,
						`${hrp.year} humanitarian plan: ${num(hrp.pctFunded, 0, l)}% funded`,
					),
				);
			if (v.migration.r4v.total)
				parts.push(
					t(
						`${num(v.migration.r4v.total.people / 1e6, 2, l)} M migrantes en la región (R4V)`,
						`${num(v.migration.r4v.total.people / 1e6, 2, l)} M migrants in the region (R4V)`,
					),
				);
			return parts.length ? { text: parts.join(" · "), tone: "normal" } : null;
		}
		case "tv": {
			const v = p.livetv as LiveTvView | undefined;
			if (!v || (!v.tv.measured && !v.radio.measured)) return null;
			const tv = v.tv.measured
				? t(`${v.tv.live} de ${v.tv.total} canales en vivo`, `${v.tv.live} of ${v.tv.total} channels live`)
				: t("TV sin medir", "TV not measured");
			const radio = v.radio.measured
				? t(
						`${v.radio.live} de ${v.radio.total} radios emitiendo`,
						`${v.radio.live} of ${v.radio.total} radios on air`,
					)
				: t("radio sin medir", "radio not measured");
			return { text: `${tv} · ${radio}`, tone: "normal" };
		}
		case "bolsillo": {
			const v = p.pocket as PocketView | undefined;
			const usd = v?.wage.inCurrency.find((w) => w.rateId === "bcv-usd");
			if (!v || !usd) return null;
			return {
				text: t(
					`Salario mínimo Bs ${num(v.wage.vesMonthly, 0, l)} = US$ ${num(usd.amount, 2, l)} a tasa BCV`,
					`Minimum wage Bs ${num(v.wage.vesMonthly, 0, l)} = US$ ${num(usd.amount, 2, l)} at the BCV rate`,
				),
				tone: "normal",
			};
		}
		case "servicios": {
			const v = p.services as ServicesView | undefined;
			const g = v?.guri;
			if (!g?.latest) return null;
			const s = g.season;
			// Bottom quarter of the same weeks in the record: worth a look (the panel's "?" states this rule).
			const low = s ? s.below / s.years < 0.25 : false;
			return {
				text: t(
					`Guri ${num(g.latest.m, 2, l)} m por satélite${s ? `, más alto que en ${s.below} de ${s.years} años en esta época` : ""}`,
					`Guri ${num(g.latest.m, 2, l)} m by satellite${s ? `, higher than in ${s.below} of ${s.years} years at this time of year` : ""}`,
				),
				tone: low ? "warn" : "normal",
			};
		}
		case "gaceta": {
			const v = p.gazette as GazetteView | undefined;
			const i = v?.issues[0];
			if (!v || !i) return null;
			const kind = i.kind === "extraordinaria" ? t("Ext.", "Extra.") : t("Ord.", "Ord.");
			const first = i.acts[0]?.title;
			return {
				text: t(
					`Última Gaceta: N° ${num(i.number, 0, l)} ${kind} (${i.date.slice(8)}/${i.date.slice(5, 7)})${first ? ` · ${first}` : ""}`,
					`Latest Gazette: No. ${num(i.number, 0, l)} ${kind} (${i.date.slice(5, 7)}/${i.date.slice(8)})${first ? ` · ${first}` : ""}`,
				),
				tone: "normal",
			};
		}
		case "atencion": {
			const v = p.attention as AttentionView | undefined;
			if (!v?.day) return null;
			const spiking = v.topics.filter((x) => x.spike);
			if (spiking.length)
				return {
					text: t(
						`Pico de lecturas en Wikipedia: ${spiking.map((x) => x.labelEs).join(", ")}`,
						`Wikipedia reads spiking: ${spiking.map((x) => x.labelEn).join(", ")}`,
					),
					tone: "warn",
				};
			return {
				text: t(
					`${int(v.total.views, l)} lecturas en Wikipedia el ${v.day}, sin picos`,
					`${int(v.total.views, l)} Wikipedia reads on ${v.day}, no spikes`,
				),
				tone: "normal",
			};
		}
	}
}

/** The panel's short name, as its header eyebrow says it. */
export function panelName(id: PanelId): string {
	const NAMES: Record<PanelId, [string, string]> = {
		incidentes: ["Incidentes", "Incidents"],
		dinero: ["Dólar", "Dollar"],
		bolsillo: ["Bolsillo", "Pocket"],
		servicios: ["Servicios", "Services"],
		gaceta: ["Gaceta Oficial", "Official Gazette"],
		conectividad: ["Internet", "Internet"],
		noticias: ["Noticias", "News"],
		sismos: ["Sismos", "Earthquakes"],
		clima: ["Clima", "Weather"],
		luces: ["Luces nocturnas", "Night lights"],
		incendios: ["Incendios", "Fires"],
		alertas: ["Alertas", "Alerts"],
		satelite: ["Satélite", "Satellite"],
		petroleo: ["Petróleo", "Oil"],
		mercados: ["Mercados", "Markets"],
		censura: ["Censura", "Censorship"],
		red: ["Red", "Network"],
		energia: ["Energía", "Energy"],
		"espacio-aereo": ["Espacio aéreo", "Airspace"],
		atencion: ["Atención", "Attention"],
		tv: ["TV y radio", "TV and radio"],
		humanitario: ["Salud, migración y ayuda", "Health, migration and aid"],
	};
	const [es, en] = NAMES[id];
	return t(es, en);
}
