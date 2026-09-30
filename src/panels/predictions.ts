import { kalshi } from "../adapters/kalshi/index.ts";
import { type PredictionMarket, polymarket } from "../adapters/polymarket/index.ts";
import type { Store, StoredObservation } from "../core/store.ts";
import type { Panel } from "../server/panels.ts";

/**
 * "¿Qué apuestan los mercados?" The open prediction markets about Venezuela on Polymarket and Kalshi, each option
 * with the price of its last trade, bid and ask, the time of that trade and the volume, attributed to its venue.
 * A price is what traders pay for a contract that pays US$1 if the outcome happens: the panel says so, never calls
 * it a probability of Vigía's, and never blends the two venues into one number. The 24-hour change is computed here
 * from the stored readings.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A trade older than this is flagged: the price is old even if the market is open. */
export const QUIET_MS = 7 * DAY;
/** Readings within this of a venue's newest one belong to the same run. */
const RUN_SPAN_MS = 30 * 60_000;

export const PRICE_LABEL =
	"Precio de la última operación de un contrato que paga US$1 si ocurre: lo que apuestan los participantes, no una encuesta ni un pronóstico de Vigía";
export const CHANGE_LABEL = "cambio en 24 h calculado por Vigía (puntos porcentuales del precio)";

export type OptionView = {
	outcome: string;
	lastPrice: number | null;
	bid: number | null;
	ask: number | null;
	lastTradeAt: number | null;
	/** No trade for QUIET_MS or more. */
	quiet: boolean;
	/** Last price now minus the last price in the reading nearest to 24 h ago (±3 h), in points (×100). */
	change24hPoints: number | null;
	volume: number | null;
	volume24h: number | null;
	sourceUrl: string;
};

export type EventView = {
	venue: PredictionMarket["venue"];
	eventId: string;
	title: string;
	url: string;
	closesAt: number | null;
	optionsInEvent: number;
	volumeUnit: PredictionMarket["volumeUnit"];
	/** Sum of the shown options' 24 h volume (ordering only). */
	volume24h: number;
	options: OptionView[];
	fetchedAt: number;
};

export type PredictionsView = {
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
};

type Row = Pick<
	StoredObservation<PredictionMarket>,
	"series" | "observedAt" | "fetchedAt" | "sourceUrl" | "value"
>;

/** Change in points between the newest reading and the one nearest to 24 h before it (±3 h). */
export function change24h(history: readonly Row[], latest: Row): number | null {
	const target = latest.observedAt - DAY;
	let best: Row | null = null;
	for (const r of history) {
		const d = Math.abs(r.observedAt - target);
		if (d <= 3 * HOUR && (!best || d < Math.abs(best.observedAt - target))) best = r;
	}
	if (!best || best.value.lastPrice === null || latest.value.lastPrice === null) return null;
	return Math.round((latest.value.lastPrice - best.value.lastPrice) * 10_000) / 100;
}

export function eventsOf(rows: readonly Row[], now: number): EventView[] {
	const bySeries = new Map<string, Row[]>();
	for (const r of rows) bySeries.set(r.series, [...(bySeries.get(r.series) ?? []), r]);
	// A market's newest reading counts when it is from the venue's newest run (a run's requests span a few minutes);
	// older ones are markets that closed or dropped out of the leading options.
	const newestRead = new Map<string, number>();
	for (const r of rows)
		newestRead.set(r.value.venue, Math.max(newestRead.get(r.value.venue) ?? 0, r.fetchedAt));
	const events = new Map<string, EventView>();
	for (const history of bySeries.values()) {
		const latest = history.reduce((a, b) => (b.observedAt > a.observedAt ? b : a));
		const v = latest.value;
		if (latest.fetchedAt < (newestRead.get(v.venue) ?? 0) - RUN_SPAN_MS) continue;
		// No filter on `closesAt`: Polymarket leaves stale end dates on options that still trade (measured 2026-09-28:
		// "December 31" options ending "2026-01-31" traded on 26 Sep). The venues' own open/closed flags decide.
		const key = `${v.venue}:${v.eventId}`;
		const event = events.get(key) ?? {
			venue: v.venue,
			eventId: v.eventId,
			title: v.eventTitle,
			url: v.eventUrl,
			closesAt: v.closesAt,
			optionsInEvent: v.optionsInEvent,
			volumeUnit: v.volumeUnit,
			volume24h: 0,
			options: [],
			fetchedAt: latest.fetchedAt,
		};
		event.options.push({
			outcome: v.outcome,
			lastPrice: v.lastPrice,
			bid: v.bid,
			ask: v.ask,
			lastTradeAt: v.lastTradeAt,
			quiet: v.lastTradeAt === null || now - v.lastTradeAt > QUIET_MS,
			change24hPoints: change24h(history, latest),
			volume: v.volume,
			volume24h: v.volume24h,
			sourceUrl: latest.sourceUrl,
		});
		event.volume24h += v.volume24h ?? 0;
		if (v.closesAt !== null && (event.closesAt === null || v.closesAt > event.closesAt))
			event.closesAt = v.closesAt;
		events.set(key, event);
	}
	for (const e of events.values()) e.options.sort((a, b) => (b.lastPrice ?? 0) - (a.lastPrice ?? 0));
	return [...events.values()].sort((a, b) => b.volume24h - a.volume24h || a.title.localeCompare(b.title));
}

export function predictionsView(store: Store, now: number): PredictionsView {
	const rows = [polymarket, kalshi].flatMap((a) =>
		store
			.latestPerSeries<PredictionMarket>(a.id, now - 2 * DAY, 2_000)
			.flatMap((latest) => store.history<PredictionMarket>(a.id, latest.series, now - 2 * DAY, now, 200)),
	);
	const events = eventsOf(rows, now);
	return {
		now,
		priceLabel: PRICE_LABEL,
		changeLabel: CHANGE_LABEL,
		events,
		venues: [polymarket, kalshi].map((a) => {
			const last = store.lastSuccessAt(a.id);
			return {
				id: a.id,
				name: a.provider,
				attribution: a.licence.attribution,
				homepage: a.homepage,
				lastReadAt: last,
				stale: last === null || now - last > a.freshness.fetchMs,
			};
		}),
	};
}

export const predictionsPanel: Panel<PredictionsView> = {
	id: "predictions",
	onDemand: true,
	sources: [polymarket.id, kalshi.id],
	compute: (store: Store, now: number) => predictionsView(store, now),
};
