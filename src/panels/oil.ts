import { EIA_VIA_FRED, FRED_SERIES, fredOil, type OilPrice } from "../adapters/fred-oil/index.ts";
import type { Store, StoredObservation } from "../core/store.ts";
import type { Panel } from "../server/panels.ts";

const DAY = 86_400_000;

export type OilPoint = { date: string; usdPerBarrel: number };

export type OilBenchmark = {
	/** "brent" | "wti" */
	id: string;
	label: string;
	/** Newest trading day. */
	latest: { usdPerBarrel: number; date: string; observedAt: number; fetchedAt: number } | null;
	/** The trading day before `latest`. */
	previous: { usdPerBarrel: number; date: string } | null;
	/** latest − previous, in US$ and in % of previous. */
	change: { usd: number; pct: number } | null;
	/** Trading days of the last 30 calendar days (ending at `now`), oldest first. */
	series30d: OilPoint[];
	sourceUrl: string;
	/** The newest trading day is older than the feed's budget (6 days): not live. */
	stale: boolean;
};

export type OilView = {
	feed: "fred-oil";
	attribution: string;
	licenceUrl: string;
	benchmarks: OilBenchmark[];
};

/** One value per trading day: the latest stored revision wins. */
export function perDay(
	history: readonly StoredObservation<OilPrice>[],
): Map<string, StoredObservation<OilPrice>> {
	const days = new Map<string, StoredObservation<OilPrice>>();
	for (const o of history) {
		const prev = days.get(o.value.date);
		if (!prev || o.fetchedAt > prev.fetchedAt || (o.fetchedAt === prev.fetchedAt && o.id > prev.id)) {
			days.set(o.value.date, o);
		}
	}
	return days;
}

export function oilView(store: Store, now: number): OilView {
	const benchmarks = FRED_SERIES.map((s): OilBenchmark => {
		// 45 days back so "previous" exists even when the 30-day window starts after a long gap.
		const days = [
			...perDay(store.history<OilPrice>("fred-oil", s.series, now - 45 * DAY, now)).values(),
		].sort((a, b) => a.observedAt - b.observedAt);
		const last = days.at(-1);
		const before = days.at(-2);
		const change =
			last && before
				? {
						usd: last.value.usdPerBarrel - before.value.usdPerBarrel,
						pct: (last.value.usdPerBarrel / before.value.usdPerBarrel - 1) * 100,
					}
				: null;
		return {
			id: s.series,
			label: s.label,
			latest: last
				? {
						usdPerBarrel: last.value.usdPerBarrel,
						date: last.value.date,
						observedAt: last.observedAt,
						fetchedAt: last.fetchedAt,
					}
				: null,
			previous: before ? { usdPerBarrel: before.value.usdPerBarrel, date: before.value.date } : null,
			change,
			series30d: days
				.filter((o) => o.observedAt >= now - 30 * DAY)
				.map((o) => ({ date: o.value.date, usdPerBarrel: o.value.usdPerBarrel })),
			sourceUrl: `https://fred.stlouisfed.org/series/${s.fredId}`,
			stale: !last || now - last.observedAt > (fredOil.freshness.dataMs ?? 6 * DAY),
		};
	});
	return {
		feed: "fred-oil",
		attribution: EIA_VIA_FRED.attribution,
		licenceUrl: EIA_VIA_FRED.url,
		benchmarks,
	};
}

export const oilPanel: Panel<OilView> = {
	id: "oil",
	sources: ["fred-oil"],
	compute: (store: Store, now: number) => oilView(store, now),
};
