import { z } from "zod";
import type { Adapter, FetchContext, Licence, Observation, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { distanceKm } from "../../geo/index.ts";
import { placeAt } from "../../ontology/geo.ts";
import { AIRLINES } from "./airlines.ts";

/**
 * Airline flights seen over and around Venezuela, as counts: every 10 minutes, the aircraft that the adsb.lol
 * community network hears in three circles of 250 NM over the country; each flight of a listed commercial airline
 * (its ICAO designator in `airlines.ts` and a flight number) is counted once per Venezuelan day and classed by its published route (VRS standing data, CC0) as an international
 * arrival or departure, a domestic flight, an overflight (seen over Venezuelan land, or its route's great-circle legs
 * cross it), or a flight nearby; a route too far from where the aircraft is seen (ROUTE_OFF_KM) is treated as unknown. It answers
 * "is the country being cut off?" by the number of international flights and the airlines still flying.
 *
 * What is never kept: positions, tracks, registrations or aircraft addresses. Only flights of the commercial airlines
 * listed by hand in `airlines.ts` are ever listed, by their public flight number. Everything else is only counted
 * per snapshot and never listed: aircraft flagged military in adsb.lol's database (`dbFlags & 1`, their own count),
 * aircraft whose owners asked not to be shown (PIA `& 4`, LADD `& 8`), and every other callsign: private and
 * general aviation, business jets and charters (EJA, VJT…), and state and military flights without the flag (RCH,
 * SAM, CNV…), which an operator's three-letter code alone cannot tell apart from an airline's.
 *
 * Coverage (measured 2026-09-29 from this machine): adsb.lol hears aircraft through volunteer receivers, and none
 * sits in Venezuela; what it sees are aircraft at cruise level within line of sight of receivers in the ABC islands,
 * Trinidad, Colombia and Brazil, and low aircraft only near those islands (a Caribbean Airlines approach to Piarco
 * at 7,000 ft; nothing below 10,000 ft over Venezuela at night). So departures and arrivals are known from the
 * route of a flight seen en route, not from its takeoff or landing; flights too low or too far from any receiver are
 * missed, and a flight whose route file is stale is misclassed. Every count is "vuelos vistos", a floor.
 *
 * Access: `GET https://api.adsb.lol/v2/point/{lat}/{lon}/{nm}` (no key; ODbL). adsb.lol's API terms: free to use;
 * "in the future, you will require an API key which you can get by feeding"; contact them for production use. It
 * limits requests (measured 2026-09-29 on one connection: the 4th request 5 s apart and the 6th 15 s apart were
 * refused with 429), so Vigía keeps to its limit rather than working around it: three requests 20 s apart every
 * 10 minutes, about 1–10 KB each, a 429 honoured (the run fails and the next one tries again). Off by default on a
 * public mirror (a public site is "production use" by adsb.lol's terms: the operator should write to them first).
 * Routes: `https://vrs-standing-data.adsb.lol/routes/{AB}/{CALLSIGN}.json` (818 B; 404 when unknown; CC0), each
 * callsign looked up once a week and at most 30 new ones per run.
 */

export const ADSB_LICENCE: Licence = {
	id: "odbl-adsb-lol",
	name: "ODbL 1.0 (adsb.lol); rutas: VRS standing data (CC0)",
	url: "https://api.adsb.lol/docs",
	attribution:
		"Aeronaves: adsb.lol (ODbL, red de receptores voluntarios); rutas: Virtual Radar Server standing data (CC0). Conteos calculados por Vigía.",
	commercial: true,
};

export const ADSB_HOME = "https://adsb.lol/?lat=8.0&lon=-66.0&zoom=6";
const API = "https://api.adsb.lol/v2/point";
const ROUTES = "https://vrs-standing-data.adsb.lol/routes";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Venezuela is UTC−4 all year. */
const VET_MS = -4 * HOUR;
export const RADIUS_NM = 250;
/** Three circles of 250 NM (463 km): the north-west, the north-east and the south (Amazonas' far south is left out). */
export const CIRCLES: readonly (readonly [number, number])[] = [
	[10.2, -69.8],
	[9.6, -64.8],
	[5.5, -65.5],
];
/** adsb.lol flags (dbFlags): 1 military, 4 privacy (PIA), 8 LADD (owner asked not to be displayed). */
const MILITARY = 1;
const NEVER_LISTED = 1 | 4 | 8;
export const ROUTE_TTL_MS = 7 * DAY;
export const MAX_ROUTE_LOOKUPS = 30;
/**
 * A route farther than this from where the aircraft is seen is doubtful (stale route file, reused callsign): 400 km,
 * or a fifth of the route's length when longer (airways stray from the great circle: AAL929 Miami–São Paulo was seen
 * 494 km off its great circle over Sucre on 2026-09-29).
 */
export const ROUTE_OFF_KM = 400;
export const ROUTE_OFF_SHARE = 0.2;

export function routeLengthKm(airports: readonly { lat: number; lon: number }[]): number {
	let km = 0;
	for (let i = 0; i + 1 < airports.length; i++) {
		const a = airports[i] as { lat: number; lon: number };
		const b = airports[i + 1] as { lat: number; lon: number };
		km += distanceKm(a.lat, a.lon, b.lat, b.lon);
	}
	return km;
}

/** An airline callsign: a 3-letter ICAO designator and a flight number ("CMP180", "VCV2922", "AAL929A"). */
export const AIRLINE_CALLSIGN = /^[A-Z]{3}\d{1,4}[A-Z]{0,2}$/;

export type FlightClass =
	| "arrival"
	| "departure"
	| "international"
	| "domestic"
	| "overflight"
	| "nearby"
	| "no-route";

export type Flight = {
	kind: "flight";
	/** Venezuelan day (UTC−4) the flight was first seen. */
	date: string;
	callsign: string;
	/** ICAO airline designator and, when Vigía knows it, the airline's name. */
	airline: string;
	airlineName: string | null;
	/** ICAO airport codes of the published route, in order; empty when the route is unknown. */
	route: string[];
	class: FlightClass;
	/** Venezuelan airports (ICAO, "SV…") in the route. */
	veAirports: string[];
	/** Whether it was over Venezuelan land when first seen (the class uses the route, not this). */
	overVenezuela: boolean;
	/** Whether the route passes near where the aircraft was seen (within ROUTE_OFF_KM of its legs). */
	routePlausible: boolean | null;
};

export type Snapshot = {
	kind: "snapshot";
	/** Aircraft with a position in the circles. */
	aircraft: number;
	/** Flights of a listed commercial airline (listed as flights). */
	airline: number;
	/** Flagged military in adsb.lol's database: counted, never listed. */
	military: number;
	/** Everything else: private, business and general aviation, unlisted operators, state flights without the military
	 * flag, owners' privacy flags, no callsign. Counted, never listed. */
	other: number;
	/** Of all of them, over Venezuelan land. */
	overVenezuela: number;
	circles: number;
	circlesAnswered: number;
};

export type AdsbFlights = Flight | Snapshot;

export function pointUrl(lat: number, lon: number): string {
	return `${API}/${lat}/${lon}/${RADIUS_NM}`;
}
export function routeUrl(callsign: string): string {
	return `${ROUTES}/${callsign.slice(0, 2)}/${callsign}.json`;
}

const Aircraft = z.object({
	hex: z.string().max(10),
	flight: z.string().max(10).optional(),
	lat: z.number().finite().optional(),
	lon: z.number().finite().optional(),
	alt_baro: z.union([z.number(), z.literal("ground")]).optional(),
	dbFlags: z.number().int().optional(),
	seen_pos: z.number().optional(),
});
const Snap = z.object({ ac: z.array(z.unknown()), now: z.number().int().positive() });
const Airport = z.object({ icao: z.string().regex(/^[A-Z0-9]{3,4}$/), lat: z.number(), lon: z.number() });
const Route = z.object({
	callsign: z.string(),
	airline_code: z.string().regex(/^[A-Z]{3}$/),
	airport_codes: z.string().regex(/^[A-Z0-9]{3,4}(-[A-Z0-9]{3,4})*$/),
	_airports: z.array(Airport).default([]),
});
type RouteInfo = z.infer<typeof Route>;

/** Route lookups kept in memory between runs (a route file changes rarely): the raw response and when it came. */
const routeCache = new Map<string, RawResponse>();
/** Callsigns kept in memory at most (a few hundred are seen a day); the oldest lookups go first. */
const CACHE_MAX = 5_000;

/** Adds to a Map used as a bounded cache: re-inserted keys move to the end, the oldest are dropped past the cap. */
function remember<K, V>(cache: Map<K, V>, key: K, value: V): void {
	cache.delete(key);
	cache.set(key, value);
	while (cache.size > CACHE_MAX) {
		const oldest = cache.keys().next();
		if (oldest.done) break;
		cache.delete(oldest.value);
	}
}

/** Whether a flight may be listed: a listed commercial airline's flight number, and no military or privacy flag. */
export function listable(callsign: string, dbFlags = 0): boolean {
	return !(dbFlags & NEVER_LISTED) && AIRLINE_CALLSIGN.test(callsign) && callsign.slice(0, 3) in AIRLINES;
}

function callsignsOf(raws: readonly RawResponse[]): Set<string> {
	const out = new Set<string>();
	for (const raw of raws) {
		try {
			const env = Snap.safeParse(JSON.parse(raw.body));
			if (!env.success) continue;
			for (const a of env.data.ac) {
				const p = Aircraft.safeParse(a);
				if (!p.success) continue;
				const cs = p.data.flight?.trim();
				if (cs && listable(cs, p.data.dbFlags)) out.add(cs);
			}
		} catch {
			// normalise reports bad snapshots
		}
	}
	return out;
}

async function routes(ctx: FetchContext, callsigns: ReadonlySet<string>): Promise<RawResponse[]> {
	const now = ctx.now();
	let lookups = 0;
	const out: RawResponse[] = [];
	for (const cs of [...callsigns].sort()) {
		const cached = routeCache.get(cs);
		if (cached && now - cached.fetchedAt < ROUTE_TTL_MS) {
			out.push(cached);
			continue;
		}
		if (lookups >= MAX_ROUTE_LOOKUPS) continue;
		lookups++;
		try {
			const res = await ctx.http.request(routeUrl(cs), {
				okStatuses: [404],
				hostGapMs: 1_000,
				timeoutMs: 20_000,
				maxBytes: 64 * 1024,
				retries: 1,
				signal: ctx.signal,
			});
			remember(routeCache, cs, res);
			out.push(res);
		} catch (error) {
			if (ctx.signal.aborted) throw error;
			// A failed lookup is retried next run; the flight waits for it (it is not stored without its route).
		}
	}
	return out;
}

/** Shortest distance from a point to the great-circle legs of a route, km (sampled every ~50 km along each leg). */
export function distanceToRouteKm(
	lat: number,
	lon: number,
	airports: readonly { lat: number; lon: number }[],
): number {
	let best = Number.POSITIVE_INFINITY;
	for (let i = 0; i + 1 < airports.length; i++) {
		const a = airports[i] as { lat: number; lon: number };
		const b = airports[i + 1] as { lat: number; lon: number };
		const legKm = distanceKm(a.lat, a.lon, b.lat, b.lon);
		const steps = Math.max(1, Math.ceil(legKm / 50));
		for (let s = 0; s <= steps; s++) {
			const p = interpolate(a, b, s / steps);
			best = Math.min(best, distanceKm(lat, lon, p.lat, p.lon));
		}
	}
	return best;
}

/** A point `f` of the way along the great circle from a to b. */
function interpolate(a: { lat: number; lon: number }, b: { lat: number; lon: number }, f: number) {
	const r = Math.PI / 180;
	const [la1, lo1, la2, lo2] = [a.lat * r, a.lon * r, b.lat * r, b.lon * r];
	const d =
		2 *
		Math.asin(
			Math.sqrt(
				Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2,
			),
		);
	if (d === 0) return { lat: a.lat, lon: a.lon };
	const A = Math.sin((1 - f) * d) / Math.sin(d);
	const B = Math.sin(f * d) / Math.sin(d);
	const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
	const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
	const z2 = A * Math.sin(la1) + B * Math.sin(la2);
	return { lat: Math.atan2(z2, Math.hypot(x, y)) / r, lon: Math.atan2(y, x) / r };
}

const crossCache = new Map<string, boolean>();

/** Whether a route's great-circle legs pass over Venezuelan land (sampled every ~25 km; memoised by route). */
export function routeCrossesVenezuela(
	airports: readonly { icao: string; lat: number; lon: number }[],
): boolean {
	const key = airports.map((a) => a.icao).join("-");
	const hit = crossCache.get(key);
	if (hit !== undefined) return hit;
	let crosses = false;
	for (let i = 0; i + 1 < airports.length && !crosses; i++) {
		const a = airports[i] as { lat: number; lon: number };
		const b = airports[i + 1] as { lat: number; lon: number };
		const steps = Math.max(1, Math.ceil(distanceKm(a.lat, a.lon, b.lat, b.lon) / 25));
		for (let s = 0; s <= steps && !crosses; s++) {
			const p = interpolate(a, b, s / steps);
			if (p.lat < 0.5 || p.lat > 12.3 || p.lon < -73.5 || p.lon > -59.7) continue;
			crosses = placeAt(p.lat, p.lon).state !== null;
		}
	}
	remember(crossCache, key, crosses);
	return crosses;
}

/**
 * The class of a flight from its published route: arrival, departure or international (a Venezuelan airport and a
 * foreign one), domestic (only Venezuelan airports), overflight (no Venezuelan airport, the route crosses Venezuelan
 * land) or nearby (neither: seen from the circles, not crossing).
 */
export function classify(route: readonly string[], crossesVenezuela: boolean): FlightClass {
	if (route.length === 0) return "no-route";
	const ve = route.map((c) => c.startsWith("SV"));
	if (ve.every((x) => !x)) return crossesVenezuela ? "overflight" : "nearby";
	if (ve.every((x) => x)) return "domestic";
	if (!ve[0] && ve.at(-1)) return "arrival";
	if (ve[0] && !ve.at(-1)) return "departure";
	return "international";
}

const vetDay = (at: number) => new Date(at + VET_MS).toISOString().slice(0, 10);

export const adsbFlights: Adapter<AdsbFlights> = {
	id: "adsb-flights",
	layer: "society",
	name: {
		es: "Vuelos vistos sobre Venezuela (adsb.lol, conteos)",
		en: "Flights seen over Venezuela (adsb.lol, counts)",
	},
	provider: "adsb.lol",
	homepage: ADSB_HOME,
	licence: ADSB_LICENCE,
	keys: [],
	note: {
		es: "adsb.lol ofrece su API gratis (ODbL), avisa que en el futuro pedirá una clave a quien no aporte un receptor y pide que le escriba quien la use en producción: en un espejo público está apagado hasta que su operador lo haga. Vigía la consulta cada 10 minutos (3 peticiones, 20 s entre ellas) y solo guarda conteos: nunca posiciones, trayectorias ni matrículas.",
		en: "adsb.lol offers its API free (ODbL), warns it may require a key from non-feeders and asks production users to get in touch: on a public mirror it is off until its operator has. Vigía asks every 10 minutes (3 requests, 20 s apart) and keeps counts only: never positions, tracks or registrations.",
	},
	defaultIn: { local: true, public: false },
	// A jet crosses a 250 NM circle in about an hour: every 10 min sees each flight several times.
	intervalMs: 10 * 60_000,
	// The snapshot is the heartbeat: stale when none in 40 min (three missed runs).
	freshness: { fetchMs: 40 * 60_000, dataMs: 40 * 60_000 },

	async fetch(ctx) {
		const snaps: RawResponse[] = [];
		for (const [lat, lon] of CIRCLES)
			snaps.push(
				await ctx.http.request(pointUrl(lat, lon), {
					headers: { accept: "application/json" },
					hostGapMs: 20_000,
					timeoutMs: 20_000,
					maxBytes: 4 * 1024 * 1024,
					signal: ctx.signal,
				}),
			);
		return [...snaps, ...(await routes(ctx, callsignsOf(snaps)))];
	},

	normalise(raws) {
		const snaps = raws.filter((r) => r.url.startsWith(API));
		if (snaps.length === 0) throw new SchemaError("adsb.lol: sin respuestas de aeronaves");
		const routesBy = new Map<string, RouteInfo | null>();
		for (const r of raws) {
			if (!r.url.startsWith(ROUTES)) continue;
			const cs = r.url.slice(r.url.lastIndexOf("/") + 1, -".json".length);
			if (r.status === 404) {
				routesBy.set(cs, null);
				continue;
			}
			try {
				const parsed = Route.safeParse(JSON.parse(r.body));
				if (parsed.success && parsed.data.callsign === cs) routesBy.set(cs, parsed.data);
			} catch {
				// a broken route file: the flight waits for a good one
			}
		}

		const seen = new Map<string, { a: z.infer<typeof Aircraft>; at: number }>();
		let answered = 0;
		let snapAt = 0;
		let fetchedAt = 0;
		for (const raw of snaps) {
			let body: unknown;
			try {
				body = JSON.parse(raw.body);
			} catch {
				throw new SchemaError("adsb.lol: la respuesta no es JSON");
			}
			const env = Snap.safeParse(body);
			if (!env.success) throw new SchemaError("adsb.lol: falta «ac» o «now»");
			answered++;
			snapAt = Math.max(snapAt, env.data.now);
			fetchedAt = Math.max(fetchedAt, raw.fetchedAt);
			for (const item of env.data.ac) {
				const p = Aircraft.safeParse(item);
				if (!p.success || p.data.lat === undefined || p.data.lon === undefined) continue;
				// The same aircraft in two overlapping circles is one aircraft.
				if (!seen.has(p.data.hex)) seen.set(p.data.hex, { a: p.data, at: env.data.now });
			}
		}
		const at = Math.min(snapAt, fetchedAt);
		const snapshot: Snapshot = {
			kind: "snapshot",
			aircraft: 0,
			airline: 0,
			military: 0,
			other: 0,
			overVenezuela: 0,
			circles: CIRCLES.length,
			circlesAnswered: answered,
		};
		const out: Observation<AdsbFlights>[] = [];
		const base = { source: "adsb-flights", sourceUrl: ADSB_HOME, fetchedAt, licence: ADSB_LICENCE.id };
		for (const { a } of seen.values()) {
			const lat = a.lat as number;
			const lon = a.lon as number;
			const over = placeAt(lat, lon).state !== null;
			snapshot.aircraft++;
			if (over) snapshot.overVenezuela++;
			if ((a.dbFlags ?? 0) & MILITARY) {
				snapshot.military++;
				continue;
			}
			const cs = a.flight?.trim() ?? "";
			if (!listable(cs, a.dbFlags)) {
				snapshot.other++;
				continue;
			}
			snapshot.airline++;
			// Not looked up yet (the per-run cap): counted in the snapshot, listed on a later run.
			if (!routesBy.has(cs)) continue;
			const route = routesBy.get(cs) ?? null;
			const codes = route ? route.airport_codes.split("-") : [];
			const plausible =
				route && route._airports.length >= 2
					? distanceToRouteKm(lat, lon, route._airports) <=
						Math.max(ROUTE_OFF_KM, ROUTE_OFF_SHARE * routeLengthKm(route._airports))
					: null;
			const airline = cs.slice(0, 3);
			const date = vetDay(at);
			out.push({
				...base,
				series: `flight:${date}:${cs}`,
				observedAt: at,
				keepFirst: true,
				value: {
					kind: "flight",
					date,
					callsign: cs,
					airline,
					airlineName: AIRLINES[airline] ?? null,
					route: codes,
					class:
						plausible === false
							? "no-route"
							: classify(codes, over || (route !== null && routeCrossesVenezuela(route._airports))),
					veAirports: codes.filter((c) => c.startsWith("SV")),
					overVenezuela: over,
					routePlausible: plausible,
				},
				// Seen by the network (a measurement); the class rests on a published route, checked against the position.
				confidence: plausible === false ? 0.5 : 0.8,
				basis: "measurement",
			});
		}
		out.push({
			...base,
			series: "snapshot",
			observedAt: at,
			value: snapshot,
			confidence: 1,
			basis: "measurement",
		});
		return out;
	},
};

/** Test hook: forget cached routes. */
export function clearRouteCache(): void {
	routeCache.clear();
}
