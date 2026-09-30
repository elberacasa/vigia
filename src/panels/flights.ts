import {
	ADSB_HOME,
	type AdsbFlights,
	adsbFlights,
	type Flight,
	type FlightClass,
	type Snapshot,
} from "../adapters/adsb-flights/index.ts";
import type { Store } from "../core/store.ts";
import type { Panel } from "../server/panels.ts";

/**
 * "¿Se está aislando el país?" Airline flights seen over and around Venezuela per Venezuelan day (UTC−4), by class
 * (international arrivals and departures, domestic, overflights, nearby), the airlines flying international routes,
 * the Venezuelan airports those routes name, and the network's coverage (aircraft heard per hour). Every figure is
 * "vuelos vistos" by volunteer receivers, a floor; military aircraft only ever appear as a count.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const VET_MS = -4 * HOUR;
export const DAYS = 14;

export const LABEL =
	"Vuelos de aerolíneas vistos por la red de receptores de adsb.lol (conteos por día de Venezuela)";
export const CAVEAT =
	"No hay receptores en Venezuela: la red oye aviones en crucero desde Aruba, Curazao, Trinidad, Colombia y Brasil, y casi nunca un despegue o aterrizaje. Llegadas y salidas se deducen de la ruta publicada del vuelo (base de rutas de Virtual Radar Server), no del aterrizaje. Son vuelos vistos, un mínimo: un vuelo bajo o lejos de todo receptor no aparece. Las aeronaves militares y privadas solo se cuentan, nunca se listan.";
export const METHOD =
	"calculado por Vigía: cada vuelo con indicativo de aerolínea cuenta una vez por día (UTC−4), la primera vez que se ve; la clase sale de su ruta publicada, descartada si pasa lejos de donde se vio el avión";

export type ClassCounts = Record<FlightClass, number> & { total: number; internationalAll: number };

export type FlightsView = {
	now: number;
	label: string;
	caveat: string;
	method: string;
	feed: string;
	attribution: string;
	sourceUrl: string;
	/** Newest snapshot: when, and whether it is stale. */
	lastSnapshotAt: number | null;
	stale: boolean;
	/** Venezuelan days, oldest first (the last one is today, still counting). */
	/**
	 * `snapshots`: how many times the feed read the sky that Venezuelan day (one every 10 minutes: 144 a full day).
	 * A day with none has no count at all (`covered: false`: "sin datos", never 0: whole-release review, M9).
	 */
	days: (ClassCounts & { date: string; partial: boolean; snapshots: number; covered: boolean })[];
	/** Today so far: airlines with international flights (arrival, departure, via), most first. */
	airlinesToday: { airline: string; name: string | null; flights: number }[];
	/** The last 7 complete days: same. */
	airlines7d: { airline: string; name: string | null; flights: number }[];
	/** Venezuelan airports named by the international routes of the last 7 complete days. */
	airports7d: { icao: string; flights: number }[];
	/** Coverage: per hour of the last 24 h, snapshots taken and the most aircraft heard at once. */
	coverage24h: {
		hourStart: number;
		snapshots: number;
		maxAircraft: number;
		maxAirline: number;
		maxMilitary: number;
	}[];
};

const CLASSES: readonly FlightClass[] = [
	"arrival",
	"departure",
	"international",
	"domestic",
	"overflight",
	"nearby",
	"no-route",
];
const INTERNATIONAL: ReadonlySet<FlightClass> = new Set(["arrival", "departure", "international"]);

function empty(): ClassCounts {
	const c = Object.fromEntries(CLASSES.map((k) => [k, 0])) as Record<FlightClass, number>;
	return { ...c, total: 0, internationalAll: 0 };
}

const vetDay = (at: number) => new Date(at + VET_MS).toISOString().slice(0, 10);

type FlightRow = { observedAt: number; value: Flight };
type SnapRow = { observedAt: number; value: Snapshot };

function airlinesOf(flights: readonly Flight[]) {
	const by = new Map<string, { name: string | null; flights: number }>();
	for (const f of flights) {
		if (!INTERNATIONAL.has(f.class)) continue;
		const e = by.get(f.airline) ?? { name: f.airlineName, flights: 0 };
		e.flights++;
		by.set(f.airline, e);
	}
	return [...by]
		.map(([airline, e]) => ({ airline, ...e }))
		.sort((a, b) => b.flights - a.flights || a.airline.localeCompare(b.airline));
}

/** Pure: the view from stored flight rows (one per flight and day) and snapshots. */
export function flightsViewOf(
	flights: readonly FlightRow[],
	snaps: readonly SnapRow[],
	now: number,
): Omit<FlightsView, "feed" | "attribution" | "sourceUrl"> {
	const today = vetDay(now);
	const dates: string[] = [];
	for (let d = DAYS - 1; d >= 0; d--) dates.push(vetDay(now - d * DAY));
	const byDay = new Map(dates.map((d) => [d, empty()]));
	const byDate = new Map<string, Flight[]>();
	for (const r of flights) {
		const c = byDay.get(r.value.date);
		if (!c) continue;
		c[r.value.class]++;
		c.total++;
		if (INTERNATIONAL.has(r.value.class)) c.internationalAll++;
		const list = byDate.get(r.value.date) ?? [];
		list.push(r.value);
		byDate.set(r.value.date, list);
	}
	const last7 = dates.slice(-8, -1).flatMap((d) => byDate.get(d) ?? []);
	const airports = new Map<string, number>();
	for (const f of last7)
		if (INTERNATIONAL.has(f.class))
			for (const a of new Set(f.veAirports)) airports.set(a, (airports.get(a) ?? 0) + 1);

	const perDay = new Map<string, number>();
	for (const s of snaps) {
		const d = vetDay(s.observedAt);
		perDay.set(d, (perDay.get(d) ?? 0) + 1);
	}
	const hours = new Map<
		number,
		{ snapshots: number; maxAircraft: number; maxAirline: number; maxMilitary: number }
	>();
	let lastSnapshotAt: number | null = null;
	for (const s of snaps) {
		lastSnapshotAt = Math.max(lastSnapshotAt ?? 0, s.observedAt);
		if (s.observedAt <= now - DAY || s.observedAt > now) continue;
		const h = Math.floor(s.observedAt / HOUR) * HOUR;
		const e = hours.get(h) ?? { snapshots: 0, maxAircraft: 0, maxAirline: 0, maxMilitary: 0 };
		e.snapshots++;
		e.maxAircraft = Math.max(e.maxAircraft, s.value.aircraft);
		e.maxAirline = Math.max(e.maxAirline, s.value.airline);
		e.maxMilitary = Math.max(e.maxMilitary, s.value.military);
		hours.set(h, e);
	}
	const budget = adsbFlights.freshness.dataMs ?? 30 * 60_000;
	return {
		now,
		label: LABEL,
		caveat: CAVEAT,
		method: METHOD,
		lastSnapshotAt,
		stale: lastSnapshotAt === null || now - lastSnapshotAt > budget,
		days: dates.map((date) => {
			const snapshots = perDay.get(date) ?? 0;
			const counts = byDay.get(date) ?? empty();
			// Read that day: a snapshot kept, or a flight recorded (which only a reading makes).
			return {
				date,
				partial: date === today,
				snapshots,
				covered: snapshots > 0 || counts.total > 0,
				...counts,
			};
		}),
		airlinesToday: airlinesOf(byDate.get(today) ?? []),
		airlines7d: airlinesOf(last7),
		airports7d: [...airports]
			.map(([icao, n]) => ({ icao, flights: n }))
			.sort((a, b) => b.flights - a.flights || a.icao.localeCompare(b.icao)),
		coverage24h: [...hours]
			.map(([hourStart, e]) => ({ hourStart, ...e }))
			.sort((a, b) => a.hourStart - b.hourStart),
	};
}

export function flightsView(store: Store, now: number): FlightsView {
	// One row per flight and day: ~100–600 a day seen; the cap is far above 15 days of them.
	const rows = store.latestPerSeries<AdsbFlights>(adsbFlights.id, now - (DAYS + 1) * DAY, 50_000);
	const flights = rows.filter((r): r is typeof r & { value: Flight } => r.value.kind === "flight");
	const snaps = store
		// Every snapshot of the days shown (144 a day at most), for each day's coverage and the last 24 h's hours.
		.history<AdsbFlights>(adsbFlights.id, "snapshot", now - (DAYS + 1) * DAY, now, (DAYS + 1) * 160)
		.filter((r): r is typeof r & { value: Snapshot } => r.value.kind === "snapshot");
	return {
		...flightsViewOf(flights, snaps, now),
		feed: adsbFlights.id,
		attribution: adsbFlights.licence.attribution,
		sourceUrl: ADSB_HOME,
	};
}

export const flightsPanel: Panel<FlightsView> = {
	id: "flights",
	onDemand: true,
	sources: [adsbFlights.id],
	compute: (store, now) => flightsView(store, now),
};
