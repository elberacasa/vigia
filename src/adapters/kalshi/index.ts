import { z } from "zod";
import type { Adapter, FetchContext, Licence, Observation, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { isAboutVenezuela, LEADING, type PredictionMarket } from "../polymarket/index.ts";

/**
 * Kalshi, a US-regulated prediction exchange (CFTC): the prices of its open markets about Venezuela, shown as
 * attributed prices of contracts, never as Vigía's forecast.
 *
 * Its public market-data API needs no key (`api.elections.kalshi.com/trade-api/v2`, measured 2026-09-28):
 * - Discovery, once a day: `/series?category=Politics|Elections|Economics` (2,473 + 1,934 + 889 series, ~0.5 MB
 *   gzipped), kept when the series title names Venezuela or one of its political figures and is not sports
 *   (`isAboutVenezuela`): 17 series on 2026-09-28, 6 with open events (head of state at a date, de facto leader, Machado's visit, an
 *   election, crude production, oil companies, a US deployment vote…). A full pass over the 12,251 open events
 *   (62 pages, 6.9 MB) found the same ones and is not repeated.
 * - Each series' open events with their markets: `/events?series_ticker=…&status=open&with_nested_markets=true`
 *   (1–93 KB).
 * - The last trade of each event's leading markets (at most 5, highest last price): `/markets/trades?ticker=…&limit=1`
 *   (0.4 KB; it carries no trader identity).
 *
 * Prices are dollars per US$1 contract (0–1); volumes are contracts. Kalshi's Data Terms of Service
 * (kalshi-public-docs.s3.amazonaws.com/kalshi-data-terms-of-service.pdf, read 2026-09-29) allow access "only for
 * your personal use for non-commercial purposes", forbid "scraping" and "systematic retrieval", and forbid
 * "providing archived or cached data sets containing Kalshi Data to another person": opt-in, like Binance P2P, never
 * on a public mirror, raw rows never served (whole-release review, B3).
 */

const API = "https://api.elections.kalshi.com/trade-api/v2";
export const KALSHI_HOME = "https://kalshi.com/";
const CATEGORIES = ["Politics", "Elections", "Economics"] as const;
const DISCOVERY_MS = 24 * 3_600_000;
const MAX_SERIES = 25;

export const KALSHI_LICENCE: Licence = {
	id: "kalshi-api",
	name: "Kalshi, términos de datos: solo uso personal y no comercial; prohíbe la extracción automatizada y la redistribución",
	url: "https://kalshi-public-docs.s3.amazonaws.com/kalshi-data-terms-of-service.pdf",
	attribution: "Fuente: Kalshi (bolsa de contratos de eventos regulada por la CFTC; precios, no encuestas)",
	commercial: false,
	// Terms forbid passing its rows on: the raw feed endpoints refuse them (whole-release review, B3).
	raw: false,
};

const Series = z.object({
	ticker: z.string(),
	title: z.string(),
	category: z.string().nullish(),
	tags: z.array(z.string()).nullish(),
});
const SeriesList = z.object({ series: z.array(z.unknown()).nullish() });

const dollars = z
	.union([z.string(), z.number()])
	.nullish()
	.transform((v) => {
		if (v === null || v === undefined || v === "") return null;
		const n = Number(v);
		return Number.isFinite(n) ? n : null;
	});
const Market = z.object({
	ticker: z.string(),
	title: z.string().nullish(),
	yes_sub_title: z.string().nullish(),
	status: z.string().nullish(),
	last_price_dollars: dollars,
	yes_bid_dollars: dollars,
	yes_ask_dollars: dollars,
	volume_fp: dollars,
	volume_24h_fp: dollars,
	close_time: z.string().nullish(),
});
const Event = z.object({
	event_ticker: z.string(),
	series_ticker: z.string(),
	title: z.string(),
	sub_title: z.string().nullish(),
	markets: z.array(z.unknown()).nullish(),
});
const Events = z.object({ events: z.array(z.unknown()) });
const Trades = z.object({ trades: z.array(z.object({ created_time: z.string(), ticker: z.string() })) });

/** Series whose title is about Venezuela, from one or more `/series` answers. */
export function venezuelaSeries(bodies: readonly string[]): string[] {
	const out = new Set<string>();
	for (const body of bodies) {
		let json: unknown;
		try {
			json = JSON.parse(body);
		} catch {
			throw new SchemaError("Kalshi: la lista de series no es JSON");
		}
		const list = SeriesList.safeParse(json);
		if (!list.success) throw new SchemaError("Kalshi: lista de series inesperada");
		for (const item of list.data.series ?? []) {
			const s = Series.safeParse(item);
			if (!s.success) continue;
			const tags = [...(s.data.tags ?? []), s.data.category ?? ""];
			if (isAboutVenezuela(s.data.title, tags)) out.add(s.data.ticker);
		}
	}
	return [...out].sort();
}

type ParsedEvent = z.infer<typeof Event> & { parsedMarkets: z.infer<typeof Market>[] };

export function openEvents(body: string): ParsedEvent[] {
	let json: unknown;
	try {
		json = JSON.parse(body);
	} catch {
		throw new SchemaError("Kalshi: la respuesta de eventos no es JSON");
	}
	const parsed = Events.safeParse(json);
	if (!parsed.success) throw new SchemaError("Kalshi: respuesta de eventos sin `events`");
	const out: ParsedEvent[] = [];
	for (const item of parsed.data.events) {
		const e = Event.safeParse(item);
		if (!e.success) continue;
		const parsedMarkets = (e.data.markets ?? [])
			.map((m) => Market.safeParse(m))
			.filter((m) => m.success)
			.map((m) => m.data)
			.filter((m) => !m.status || m.status === "active" || m.status === "open");
		if (parsedMarkets.length > 0) out.push({ ...e.data, parsedMarkets });
	}
	return out;
}

export function leadingMarkets<M extends { last_price_dollars: number | null }>(markets: readonly M[]): M[] {
	return [...markets]
		.sort((a, b) => (b.last_price_dollars ?? 0) - (a.last_price_dollars ?? 0))
		.slice(0, LEADING);
}

const eventsUrl = (series: string) =>
	`${API}/events?series_ticker=${encodeURIComponent(series)}&status=open&with_nested_markets=true`;
const tradesUrl = (ticker: string) => `${API}/markets/trades?ticker=${encodeURIComponent(ticker)}&limit=1`;

let discovered: { at: number; series: string[] } | null = null;

async function discover(ctx: FetchContext): Promise<string[]> {
	if (discovered && ctx.now() - discovered.at < DISCOVERY_MS) return discovered.series;
	const bodies: string[] = [];
	for (const category of CATEGORIES) {
		const r = await ctx.http.request(`${API}/series?category=${category}`, {
			headers: { accept: "application/json" },
			hostGapMs: 1_000,
			maxBytes: 32 * 1024 * 1024,
			timeoutMs: 45_000,
			signal: ctx.signal,
		});
		bodies.push(r.body);
	}
	const series = venezuelaSeries(bodies).slice(0, MAX_SERIES);
	discovered = { at: ctx.now(), series };
	return series;
}

export const kalshi: Adapter<PredictionMarket> = {
	id: "kalshi",
	layer: "society",
	name: { es: "Mercado de predicción Kalshi: Venezuela", en: "Kalshi prediction market: Venezuela" },
	provider: "Kalshi",
	homepage: KALSHI_HOME,
	licence: KALSHI_LICENCE,
	keys: [],
	optIn: {
		es:
			"Los términos de datos de Kalshi permiten el acceso «solo para tu uso personal y no comercial» y prohíben la " +
			"extracción automatizada («scraping») y entregar a otros copias de sus datos. Vigía la consulta una vez por hora, " +
			"nunca la activa en un espejo público y no reparte sus datos en bruto. Actívala solo si aceptas ese riesgo; " +
			"sin ella, Polymarket sigue mostrando mercados sobre Venezuela.",
		en:
			'Kalshi\'s data terms allow access "only for your personal use for non-commercial purposes" and forbid ' +
			"scraping and handing copies of its data to others. Vigía polls it hourly, never turns it on on a public " +
			"mirror and never hands out its raw data. Turn it on only if you accept that risk; without it, Polymarket " +
			"still shows markets about Venezuela.",
	},
	intervalMs: 3_600_000,
	freshness: { fetchMs: 4 * 3_600_000, dataMs: null },

	async fetch(ctx) {
		const raws: RawResponse[] = [];
		for (const series of await discover(ctx)) {
			const events = await ctx.http.request(eventsUrl(series), {
				headers: { accept: "application/json" },
				hostGapMs: 500,
				maxBytes: 16 * 1024 * 1024,
				signal: ctx.signal,
			});
			raws.push(events);
			for (const e of openEvents(events.body)) {
				for (const m of leadingMarkets(e.parsedMarkets)) {
					const trade = await ctx.http
						.request(tradesUrl(m.ticker), {
							headers: { accept: "application/json" },
							hostGapMs: 500,
							signal: ctx.signal,
						})
						.catch(() => null);
					if (trade) raws.push(trade);
				}
			}
		}
		return raws;
	},

	normalise(raws) {
		const lastTrade = new Map<string, number>();
		for (const r of raws.filter((x) => x.url.includes("/markets/trades?"))) {
			try {
				const t = Trades.safeParse(JSON.parse(r.body));
				const first = t.success ? t.data.trades[0] : undefined;
				const at = first ? Date.parse(first.created_time) : Number.NaN;
				if (first && Number.isFinite(at)) lastTrade.set(first.ticker, at);
			} catch {
				// A broken trade answer leaves that market without a last-trade time.
			}
		}
		const out: Observation<PredictionMarket>[] = [];
		for (const r of raws.filter((x) => x.url.includes("/events?"))) {
			for (const e of openEvents(r.body)) {
				const eventUrl = `https://kalshi.com/markets/${e.series_ticker.toLowerCase()}`;
				for (const m of leadingMarkets(e.parsedMarkets)) {
					const closes = m.close_time ? Date.parse(m.close_time) : Number.NaN;
					const tradeAt = lastTrade.get(m.ticker) ?? null;
					out.push({
						source: "kalshi",
						series: `market:${m.ticker}`,
						sourceUrl: eventUrl,
						fetchedAt: r.fetchedAt,
						observedAt: r.fetchedAt,
						licence: KALSHI_LICENCE.id,
						value: {
							venue: "kalshi",
							eventId: e.event_ticker,
							eventTitle: e.sub_title ? `${e.title} (${e.sub_title})` : e.title,
							eventUrl,
							marketId: m.ticker,
							outcome: m.yes_sub_title || m.title || m.ticker,
							question: m.title ?? e.title,
							lastPrice: m.last_price_dollars,
							bid: m.yes_bid_dollars,
							ask: m.yes_ask_dollars,
							lastTradeAt: tradeAt !== null && tradeAt <= r.fetchedAt + 60_000 ? tradeAt : null,
							volume: m.volume_fp,
							volume24h: m.volume_24h_fp,
							volumeUnit: "contracts",
							closesAt: Number.isFinite(closes) ? closes : null,
							optionsInEvent: e.parsedMarkets.length,
						},
						confidence: 1,
						basis: "quote",
					});
				}
			}
		}
		return out;
	},
};
