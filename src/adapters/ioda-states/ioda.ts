import { z } from "zod";
import type { Licence, Observation, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";

/**
 * Shared IODA v2 client code (Internet Outage Detection and Analysis, Georgia Tech Internet Intelligence Lab).
 * Used by ioda-states, ioda-asn and ioda-events.
 *
 * Quirks measured on 2026-09-24:
 * - The API accepts several entity codes separated by commas, so all 25 regions (or all ISPs) come back in one
 *   request per datasource; `datasource` itself takes one value only (a comma list is HTTP 400).
 * - The last 1 to 6 native bins are always `null` (still being filled). A `null` is "no data yet", never zero:
 *   nulls are not stored at all.
 * - `maxPoints` re-bins by averaging the native bins, ignoring nulls. We ask for 10-minute bins for every signal
 *   (bgp and merit-nt are natively 5 min, ping-slash24 10 min) so the three signals line up bin for bin; the last
 *   non-null re-binned bin can average only one of its two native bins, so it is dropped until it is complete.
 * - Loss, latency, gtr-sarima and mozilla return a list of objects per bin instead of a number; we do not request
 *   them, and a non-number bin is skipped rather than coerced.
 */

export const IODA_API = "https://api.ioda.inetintel.cc.gatech.edu/v2";
export const IODA_SITE = "https://ioda.inetintel.cc.gatech.edu";

/** No published rate limit; research measured 15 calls without a problem. We stay at one request per 2 s. */
export const IODA_HOST_GAP_MS = 2_000;

export const BIN_S = 600;
export const BIN_MS = BIN_S * 1_000;

/** Signals IODA serves at region and ASN level as plain numbers. */
export const IODA_SIGNALS = ["bgp", "ping-slash24", "merit-nt"] as const;
export type IodaSignal = (typeof IODA_SIGNALS)[number];

export const SIGNAL_INFO: Record<
	IodaSignal,
	{ readonly es: string; readonly unit: string; readonly what: string }
> = {
	bgp: {
		es: "BGP",
		unit: "bloques /24 anunciados",
		what: "Bloques de direcciones /24 visibles en las tablas de rutas BGP (¿la red está anunciada?).",
	},
	"ping-slash24": {
		es: "Sondeo activo",
		unit: "bloques /24 que responden",
		what: "Bloques /24 que responden a sondas activas de IODA (¿hay equipos encendidos y conectados?).",
	},
	"merit-nt": {
		es: "Telescopio",
		unit: "IPs de origen únicas",
		what: "Direcciones que envían tráfico no solicitado al telescopio de red de Merit (ruido de fondo de equipos conectados).",
	},
};

/**
 * IODA publishes no licence. Every response says "Copyright (c) 2021-2025 Georgia Tech Research Corporation. All
 * Rights Reserved." We display with attribution and a link back; permission to redistribute and archive has been
 * requested from IODA. Until it is granted, raw rows are never exposed (`raw: false`) and bundles withhold values.
 */
export const IODA_LICENCE: Licence = {
	id: "ioda-all-rights-reserved",
	name: "Todos los derechos reservados (Georgia Tech); se muestra con atribución, permiso pendiente",
	url: "https://ioda.inetintel.cc.gatech.edu/about",
	attribution: "Datos: IODA, Georgia Tech",
	commercial: "unclear",
	raw: false,
};

/** One 10-minute bin of one IODA signal for one entity. */
export type IodaBin = {
	readonly signal: IodaSignal;
	/** Unit depends on the signal (SIGNAL_INFO): /24 blocks for bgp and ping-slash24, unique IPs for merit-nt. */
	readonly value: number;
};

const Series = z.object({
	entityType: z.string(),
	entityCode: z.string(),
	entityName: z.string().optional(),
	datasource: z.string(),
	from: z.number().int(),
	until: z.number().int(),
	step: z.number().int().positive(),
	nativeStep: z.number().int().positive(),
	values: z.array(z.unknown()),
});
export type IodaSeries = z.infer<typeof Series>;

const Envelope = z.object({
	type: z.literal("signals"),
	error: z.string().nullable(),
	// IODA answers errors with HTTP 400 or 200, `error` set and `data: null`.
	data: z.array(z.array(z.unknown())).nullable(),
});

/** Full window on the first run of a process (7-day baseline + 1 day), then a short catch-up window. */
export const FULL_WINDOW_S = 8 * 86_400;
export const SHORT_WINDOW_S = 6 * 3_600;
const FULL_REFRESH_MS = 24 * 3_600_000;

/**
 * Window planning: the first fetch in a process (or once a day) takes 8 days so the baseline exists and gaps
 * from downtime are filled; later fetches take 6 hours, since history is in the store. Identical re-fetched bins
 * are deduplicated by the store at no cost.
 */
export class WindowPlanner {
	#lastFullAt: number | null = null;

	plan(now: number): { from: number; until: number; maxPoints: number } {
		const full = this.#lastFullAt === null || now - this.#lastFullAt > FULL_REFRESH_MS;
		const span = full ? FULL_WINDOW_S : SHORT_WINDOW_S;
		// `until` on the next bin boundary so every bin is whole and IODA's re-binning lands on 600 s.
		const until = (Math.floor(now / 1_000 / BIN_S) + 1) * BIN_S;
		if (full) this.#lastFullAt = now;
		return { from: until - span, until, maxPoints: span / BIN_S };
	}

	/** A failed full fetch must be retried as full. */
	reset(): void {
		this.#lastFullAt = null;
	}
}

export function signalsUrl(
	entityType: "region" | "asn" | "country",
	codes: readonly string[],
	signal: IodaSignal,
	window: { from: number; until: number; maxPoints: number },
): string {
	const p = new URLSearchParams({
		from: String(window.from),
		until: String(window.until),
		datasource: signal,
		maxPoints: String(window.maxPoints),
	});
	return `${IODA_API}/signals/raw/${entityType}/${codes.join(",")}?${p}`;
}

/** Parses one signals response into its series; throws SchemaError on a broken envelope or an API error. */
export function parseSignals(raw: RawResponse): IodaSeries[] {
	let json: unknown;
	try {
		json = JSON.parse(raw.body);
	} catch {
		throw new SchemaError(`IODA: respuesta no es JSON (${raw.url})`);
	}
	const envelope = Envelope.safeParse(json);
	if (!envelope.success) throw new SchemaError(`IODA signals: ${envelope.error.message}`);
	const { error, data } = envelope.data;
	if (error !== null) throw new SchemaError(`IODA signals error: ${error}`);
	if (data === null) throw new SchemaError("IODA signals: data null");
	const out: IodaSeries[] = [];
	for (const group of data) {
		for (const item of group) {
			const parsed = Series.safeParse(item);
			if (parsed.success) out.push(parsed.data);
		}
	}
	return out;
}

function isSignal(s: string): s is IodaSignal {
	return (IODA_SIGNALS as readonly string[]).includes(s);
}

/**
 * Turns IODA series into one observation per non-null bin. `entity` maps an IODA entity to our series prefix and
 * page (or null to skip it, e.g. IODA's "Invalid Region").
 */
export function binsToObservations(
	source: string,
	raw: RawResponse,
	series: readonly IodaSeries[],
	entity: (s: IodaSeries) => {
		prefix: string;
		sourceUrl: string;
		location?: Observation["location"];
	} | null,
): Observation<IodaBin>[] {
	const out: Observation<IodaBin>[] = [];
	for (const s of series) {
		if (!isSignal(s.datasource)) continue;
		const target = entity(s);
		if (!target) continue;
		if (s.step !== BIN_S) {
			throw new SchemaError(`IODA devolvió paso de ${s.step} s para ${s.datasource}; se esperaba ${BIN_S} s`);
		}
		// Index of the last number: a re-binned bin at the trailing edge may average fewer native bins.
		let last = -1;
		for (let i = s.values.length - 1; i >= 0; i--) {
			if (typeof s.values[i] === "number") {
				last = i;
				break;
			}
		}
		const end = s.step > s.nativeStep ? last - 1 : last;
		for (let i = 0; i <= end; i++) {
			const v = s.values[i];
			if (typeof v !== "number" || !Number.isFinite(v) || v < 0) continue;
			const observedAt = (s.from + i * s.step) * 1_000;
			if (observedAt > raw.fetchedAt) continue;
			const obs: Observation<IodaBin> = {
				source,
				series: `${target.prefix}:${s.datasource}`,
				sourceUrl: target.sourceUrl,
				fetchedAt: raw.fetchedAt,
				observedAt,
				licence: IODA_LICENCE.id,
				value: { signal: s.datasource, value: v },
				confidence: 1,
				basis: "measurement",
				...(target.location ? { location: target.location } : {}),
			};
			out.push(obs);
		}
	}
	return out;
}
