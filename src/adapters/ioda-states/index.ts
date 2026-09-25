import type { Adapter, Observation, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { stateByIso } from "../../geo/index.ts";
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
} from "./ioda.ts";
import { IODA_REGIONS, regionById } from "./regions.ts";

/**
 * IODA raw signals for every Venezuelan state and for the country: BGP, active probing (ping-slash24) and the
 * Merit network telescope, in 10-minute bins. Region-level signals use IODA's IP geolocation (NetAcuity), so a
 * state's figure is "address space geolocated to that state"; national operators' space concentrates in the
 * Capital District (16,417 routed /24s there vs 1,572 in Zulia on 2026-09-24).
 *
 * Series: `state:<ISO>:<signal>` (e.g. `state:VE-V:ping-slash24`) and `country:VE:<signal>`.
 * One run = 6 requests (3 signals × {all regions in one call, country}), paced 2 s apart.
 */

export type { IodaBin } from "./ioda.ts";

const planner = new WindowPlanner();
const REGION_CODES = IODA_REGIONS.map((r) => r.id);

export const iodaStates: Adapter<IodaBin> = {
	id: "ioda-states",
	layer: "internet",
	name: { es: "Conectividad por estado (IODA)", en: "Connectivity by state (IODA)" },
	provider: "IODA, Georgia Tech Internet Intelligence Lab",
	homepage: `${IODA_SITE}/country/VE`,
	licence: IODA_LICENCE,
	keys: [],
	intervalMs: 10 * 60_000,
	// Newest non-null bin is 15–30 min old at best (measured); stale when the newest bin passes 60 min.
	freshness: { fetchMs: 40 * 60_000, dataMs: 60 * 60_000 },

	async fetch(ctx) {
		const window = planner.plan(ctx.now());
		const out: RawResponse[] = [];
		try {
			for (const signal of IODA_SIGNALS) {
				for (const [type, codes] of [
					["region", REGION_CODES],
					["country", ["VE"]],
				] as const) {
					out.push(
						await ctx.http.request(signalsUrl(type, codes, signal, window), {
							headers: { accept: "application/json" },
							hostGapMs: IODA_HOST_GAP_MS,
							timeoutMs: 30_000,
							maxBytes: 4 * 1024 * 1024,
							signal: ctx.signal,
						}),
					);
				}
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
				...binsToObservations("ioda-states", raw, parseSignals(raw), (s) => {
					if (s.entityType === "country") {
						if (s.entityCode !== "VE") return null;
						return { prefix: "country:VE", sourceUrl: `${IODA_SITE}/country/VE` };
					}
					if (s.entityType !== "region") return null;
					const region = regionById(s.entityCode);
					if (!region) return null;
					const state = stateByIso(region.iso);
					return {
						prefix: `state:${region.iso}`,
						sourceUrl: `${IODA_SITE}/region/${region.id}`,
						...(state
							? {
									location: {
										lat: state.label.lat,
										lon: state.label.lon,
										state: state.iso,
										place: state.name,
									},
								}
							: {}),
					};
				}),
			);
		}
		return out;
	},
};
