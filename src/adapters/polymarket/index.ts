import { z } from "zod";
import type { Adapter, Licence, Observation, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";

/**
 * Polymarket, a prediction market: the prices of its open markets about Venezuela, shown as what they are, the price
 * of a bet between traders, attributed and dated ("Polymarket: 64 % 'Sí', última operación 21:03"), never as a
 * poll, a probability Vigía stands behind, or a forecast.
 *
 * - Events: `gamma-api.polymarket.com/events?tag_id=246&active=true&closed=false` (tag 246 = "Venezuela"; 842 KB,
 *   80 KB gzipped, 0.7 s, measured 2026-09-28: 27 events). The tag also covers Cuba, Mexico, Colombia and sports:
 *   `isAboutVenezuela` keeps an event only when its title names Venezuela or one of its political figures, and
 *   never a sports one (15 events kept on 2026-09-28).
 * - Only the leading markets of each event are stored (at most 5, highest last price first; each value says how many
 *   options the event has), about 85 an hour.
 * - Last trade time: `data-api.polymarket.com/trades?market=<conditionId>&limit=1`, for those markets (60 per run
 *   at most). The trade record names the trader (wallet, pseudonym, picture):
 *   only its time and price are read; nothing else is kept.
 *
 * Rate limits (docs.polymarket.com, 2026-09-24): Gamma /events 500 requests per 10 s, data API far above what an
 * hourly run needs. Terms: polymarket.com/tos is rendered client-side and could not be read by a script; the public
 * API is documented for this use. On by default with a note and a switch, as the project does for unclear terms.
 */

export const POLYMARKET_EVENTS =
	"https://gamma-api.polymarket.com/events?tag_id=246&active=true&closed=false&limit=100";
const TRADES = "https://data-api.polymarket.com/trades";
export const POLYMARKET_HOME = "https://polymarket.com/";

export const POLYMARKET_LICENCE: Licence = {
	id: "polymarket-api",
	name: "Polymarket, API pública (sus términos no se pudieron leer: solo uso personal, sin redistribuir)",
	url: "https://docs.polymarket.com/",
	attribution: "Fuente: Polymarket (mercado de predicción; precios entre apostadores, no encuestas)",
	commercial: "unclear",
	// Terms forbid passing its rows on: the raw feed endpoints refuse them (whole-release review, B3).
	raw: false,
};

/** The value every prediction-market adapter stores for one market (one outcome of an event). */
export type PredictionMarket = {
	readonly venue: "polymarket" | "kalshi";
	readonly eventId: string;
	readonly eventTitle: string;
	readonly eventUrl: string;
	readonly marketId: string;
	/** The option this market prices ("Nicolás Maduro", "Before 2027", or the question itself for yes/no events). */
	readonly outcome: string;
	readonly question: string;
	/** Price of the last trade of "Yes", 0–1 (a price, shown as a percentage with that word). */
	readonly lastPrice: number | null;
	readonly bid: number | null;
	readonly ask: number | null;
	/** When that last trade happened (epoch ms), from the venue's trade record. */
	readonly lastTradeAt: number | null;
	readonly volume: number | null;
	readonly volume24h: number | null;
	/** Polymarket volumes are US dollars (USDC); Kalshi's are contracts of US$1. */
	readonly volumeUnit: "USD" | "contracts";
	readonly closesAt: number | null;
	/** Open options in the event; only the leading ones (highest last price) are stored. */
	readonly optionsInEvent: number;
};

const TERMS =
	/venezuel|maduro|machado|delcy|cilia flores|diosdado|padrino l[oó]pez|edmundo gonz[aá]lez|chavismo/i;

/** Whether an event is about Venezuela (its title), and not a sports one (its tags). */
export function isAboutVenezuela(title: string, tags: readonly string[]): boolean {
	return TERMS.test(title) && !tags.some((t) => /^(sports|soccer|basketball|baseball|games)$/i.test(t));
}

const num = z
	.union([z.number(), z.string()])
	.nullish()
	.transform((v) => {
		if (v === null || v === undefined || v === "") return null;
		const n = Number(v);
		return Number.isFinite(n) ? n : null;
	});
const Market = z.object({
	id: z.union([z.string(), z.number()]).transform(String),
	question: z.string(),
	groupItemTitle: z.string().nullish(),
	conditionId: z.string(),
	lastTradePrice: num,
	bestBid: num,
	bestAsk: num,
	volumeNum: num,
	volume24hr: num,
	endDate: z.string().nullish(),
	active: z.boolean().nullish(),
	closed: z.boolean().nullish(),
});
const Event = z.object({
	id: z.union([z.string(), z.number()]).transform(String),
	slug: z.string(),
	title: z.string(),
	tags: z.array(z.object({ slug: z.string().nullish(), label: z.string().nullish() })).nullish(),
	markets: z.array(z.unknown()).nullish(),
});
const Trade = z.object({ timestamp: z.number(), price: z.number().nullish() });

/** At most this many markets per event get a last-trade lookup: the ones with the highest last price. */
export const LEADING = 5;
const MAX_TRADE_LOOKUPS = 60;

type ParsedEvent = { id: string; slug: string; title: string; markets: z.infer<typeof Market>[] };

export function venezuelaEvents(body: string): ParsedEvent[] {
	let json: unknown;
	try {
		json = JSON.parse(body);
	} catch {
		throw new SchemaError("Polymarket: la respuesta de eventos no es JSON");
	}
	if (!Array.isArray(json)) throw new SchemaError("Polymarket: se esperaba una lista de eventos");
	const out: ParsedEvent[] = [];
	for (const item of json) {
		const e = Event.safeParse(item);
		if (!e.success) continue;
		const tags = (e.data.tags ?? []).map((t) => t.slug ?? t.label ?? "");
		if (!isAboutVenezuela(e.data.title, tags)) continue;
		const markets = (e.data.markets ?? [])
			.map((m) => Market.safeParse(m))
			.filter((m) => m.success)
			.map((m) => m.data)
			.filter((m) => m.active !== false && m.closed !== true);
		if (markets.length > 0) out.push({ id: e.data.id, slug: e.data.slug, title: e.data.title, markets });
	}
	return out;
}

/** The markets of an event worth a last-trade lookup: highest last price first. */
export function leading<M extends { lastTradePrice: number | null }>(markets: readonly M[]): M[] {
	return [...markets].sort((a, b) => (b.lastTradePrice ?? 0) - (a.lastTradePrice ?? 0)).slice(0, LEADING);
}

const tradesUrl = (conditionId: string) => `${TRADES}?market=${encodeURIComponent(conditionId)}&limit=1`;

export const polymarket: Adapter<PredictionMarket> = {
	id: "polymarket",
	layer: "society",
	name: { es: "Mercado de predicción Polymarket: Venezuela", en: "Polymarket prediction market: Venezuela" },
	provider: "Polymarket",
	homepage: POLYMARKET_HOME,
	licence: POLYMARKET_LICENCE,
	keys: [],
	// Its terms page renders nothing but the site's footer to an automated browser (tried 2026-09-29, /tos and
	// /terms-of-use): unread, so treated like Kalshi's until someone reads them: personal use only, never on a
	// public mirror, raw rows never served (whole-release review, B3).
	defaultIn: { local: true, public: false },
	note: {
		es: "No pudimos leer los términos de Polymarket (su página no se muestra a un navegador automático). Vigía lee su API pública una vez por hora para tu uso personal, muestra los precios con su nombre, no la activa en un espejo público y no reparte sus datos en bruto.",
		en: "Polymarket's terms could not be read (its page does not render for an automated browser). Vigía reads its public API hourly for your personal use, shows prices under its name, keeps it off on a public mirror and never hands out its raw data.",
	},
	// Hourly: prices move all day, but a situation room needs the level, not the tick (80 KB gzipped per run).
	intervalMs: 3_600_000,
	freshness: { fetchMs: 4 * 3_600_000, dataMs: null },

	async fetch(ctx) {
		const events = await ctx.http.request(POLYMARKET_EVENTS, {
			headers: { accept: "application/json" },
			hostGapMs: 500,
			maxBytes: 16 * 1024 * 1024,
			signal: ctx.signal,
		});
		const raws: RawResponse[] = [events];
		const lookups = venezuelaEvents(events.body)
			.flatMap((e) => leading(e.markets))
			.slice(0, MAX_TRADE_LOOKUPS);
		for (const m of lookups) {
			const trade = await ctx.http
				.request(tradesUrl(m.conditionId), {
					headers: { accept: "application/json" },
					hostGapMs: 250,
					signal: ctx.signal,
				})
				.catch(() => null);
			if (trade) raws.push(trade);
		}
		return raws;
	},

	normalise(raws) {
		const events = raws.find((r) => r.url === POLYMARKET_EVENTS);
		if (!events) throw new SchemaError("Polymarket: falta la lista de eventos");
		// Last trade per market: only the time and price are read from the trade record.
		const lastTrade = new Map<string, number>();
		for (const r of raws) {
			const market = r.url.startsWith(TRADES) ? new URL(r.url).searchParams.get("market") : null;
			if (!market) continue;
			try {
				const first = Trade.safeParse((JSON.parse(r.body) as unknown[])[0]);
				if (first.success) lastTrade.set(market, first.data.timestamp * 1_000);
			} catch {
				// A broken trade answer leaves that market without a last-trade time.
			}
		}
		const out: Observation<PredictionMarket>[] = [];
		for (const e of venezuelaEvents(events.body)) {
			const eventUrl = `https://polymarket.com/event/${encodeURIComponent(e.slug)}`;
			for (const m of leading(e.markets)) {
				const closes = m.endDate ? Date.parse(m.endDate) : Number.NaN;
				const tradeAt = lastTrade.get(m.conditionId) ?? null;
				out.push({
					source: "polymarket",
					series: `market:${m.conditionId}`,
					sourceUrl: eventUrl,
					fetchedAt: events.fetchedAt,
					// The quote is what the venue shows at read time; the last trade has its own time in the value.
					observedAt: events.fetchedAt,
					licence: POLYMARKET_LICENCE.id,
					value: {
						venue: "polymarket",
						eventId: e.id,
						eventTitle: e.title,
						eventUrl,
						marketId: m.id,
						outcome: m.groupItemTitle || m.question,
						question: m.question,
						lastPrice: m.lastTradePrice,
						bid: m.bestBid,
						ask: m.bestAsk,
						lastTradeAt: tradeAt !== null && tradeAt <= events.fetchedAt + 60_000 ? tradeAt : null,
						volume: m.volumeNum,
						volume24h: m.volume24hr,
						volumeUnit: "USD",
						closesAt: Number.isFinite(closes) ? closes : null,
						optionsInEvent: e.markets.length,
					},
					confidence: 1,
					basis: "quote",
				});
			}
		}
		return out;
	},
};
