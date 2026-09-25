import type { Adapter, Observation, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import {
	binsToObservations,
	IODA_HOST_GAP_MS,
	IODA_LICENCE,
	IODA_SIGNALS,
	IODA_SITE,
	type IodaBin,
	parseSignals,
	signalsUrl,
	WindowPlanner,
} from "../ioda-states/ioda.ts";

/**
 * IODA raw signals for the main Venezuelan ISPs, by autonomous system (ASN), in 10-minute bins. Same signals and
 * quirks as ioda-states. Series: `asn:<number>:<signal>`. One run = 3 requests (one per signal, all ASNs at once).
 *
 * ASN names verified against IODA's entity list and RIPE on 2026-09-24. Digitel runs two ASNs; the panel adds
 * them bin by bin. Foreign transit ASNs in IODA's VE list (Cogent, Level3, Google Cloud) are deliberately absent.
 */

export type Isp = {
	readonly id: string;
	readonly name: string;
	readonly asns: readonly string[];
	/** Registered holder name(s) as IODA/RIPE print them. */
	readonly holder: string;
	readonly kind: "fijo" | "móvil" | "fijo y móvil" | "inalámbrico fijo";
};

export const ISPS: readonly Isp[] = [
	{ id: "cantv", name: "CANTV", asns: ["8048"], holder: "CANTV Servicios, Venezuela", kind: "fijo" },
	{ id: "movilnet", name: "Movilnet", asns: ["27889"], holder: "Telecomunicaciones MOVILNET", kind: "móvil" },
	{
		id: "movistar",
		name: "Movistar",
		asns: ["6306"],
		holder: "TELEFONICA VENEZOLANA, C.A.",
		kind: "fijo y móvil",
	},
	{
		id: "digitel",
		name: "Digitel",
		asns: ["264731", "27717"],
		holder: "Corporacion Digitel C.A.",
		kind: "móvil",
	},
	{ id: "inter", name: "Inter", asns: ["21826"], holder: "Corporación Telemic C.A.", kind: "fijo" },
	{
		id: "airtek",
		name: "Airtek",
		asns: ["61461"],
		holder: "Airtek Solutions C.A.",
		kind: "inalámbrico fijo",
	},
	{ id: "netuno", name: "NetUno", asns: ["11562"], holder: "Net Uno, C.A.", kind: "fijo" },
	{ id: "thundernet", name: "Thundernet", asns: ["272809"], holder: "THUNDERNET, C.A.", kind: "fijo" },
	{
		id: "g-network",
		name: "G-Network",
		asns: ["272122"],
		holder: "TELECOMUNICACIONES G-NETWORK, C.A.",
		kind: "fijo",
	},
];

export const ISP_ASNS: readonly string[] = ISPS.flatMap((i) => i.asns);
const KNOWN = new Set(ISP_ASNS);

const planner = new WindowPlanner();

export const iodaAsn: Adapter<IodaBin> = {
	id: "ioda-asn",
	layer: "internet",
	name: { es: "Conectividad por proveedor (IODA)", en: "Connectivity by ISP (IODA)" },
	provider: "IODA, Georgia Tech Internet Intelligence Lab",
	homepage: `${IODA_SITE}/asn/8048`,
	licence: IODA_LICENCE,
	keys: [],
	intervalMs: 10 * 60_000,
	freshness: { fetchMs: 40 * 60_000, dataMs: 60 * 60_000 },

	async fetch(ctx) {
		const window = planner.plan(ctx.now());
		const out: RawResponse[] = [];
		try {
			for (const signal of IODA_SIGNALS) {
				out.push(
					await ctx.http.request(signalsUrl("asn", ISP_ASNS, signal, window), {
						headers: { accept: "application/json" },
						hostGapMs: IODA_HOST_GAP_MS,
						timeoutMs: 30_000,
						maxBytes: 4 * 1024 * 1024,
						signal: ctx.signal,
					}),
				);
			}
		} catch (error) {
			planner.reset();
			throw error;
		}
		return out;
	},

	normalise(raws) {
		if (raws.length === 0) throw new SchemaError("IODA: sin respuestas");
		const out: Observation<IodaBin>[] = [];
		for (const raw of raws) {
			out.push(
				...binsToObservations("ioda-asn", raw, parseSignals(raw), (s) =>
					s.entityType === "asn" && KNOWN.has(s.entityCode)
						? { prefix: `asn:${s.entityCode}`, sourceUrl: `${IODA_SITE}/asn/${s.entityCode}` }
						: null,
				),
			);
		}
		return out;
	},
};
