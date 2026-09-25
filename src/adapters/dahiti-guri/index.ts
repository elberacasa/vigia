import { z } from "zod";
import type { Adapter, Licence, Observation } from "../../core/types.ts";
import { MissingKeyError, SchemaError } from "../../core/types.ts";

/**
 * The Guri reservoir's water level from satellite altimetry, from DAHITI (Database for Hydrological Time Series of
 * Inland Waters, DGFI-TUM, Munich). Guri (Bolívar) feeds the Simón Bolívar dam, the largest share of Venezuela's
 * electricity, so its level is the slow signal behind rationing: Corpoelec publishes no machine-readable level
 * (its site answered 403 on 2026-09-24; OPSIS's domain does not resolve), and this is the free alternative.
 *
 * What it is (measured 2026-09-24 on DAHITI's public target page, https://dahiti.dgfi.tum.de/en/67/):
 * - DAHITI-ID 67 "Guri, Lake", Venezuela, reservoir at 7.5115 °N −62.8473 °W. 1,019 points from 1992-10-18 to
 *   2026-08-16 (min 242.43 m, max 272.42 m); "Last Update 2026-09-25 02:13". A point every ~10 days (Jason/Sentinel-6
 *   repeat cycle), published ~5–6 weeks after the pass: on 2026-09-24 the newest point was 39 days old.
 * - Heights are water-surface elevations above the EIGEN-6C4 geoid, in metres, with a per-point uncertainty
 *   (typically 0.002–0.05 m). They are close to, but not the same as, the "cota" in m.s.n.m. that Corpoelec
 *   reads at the dam: the panel calls this a satellite estimate and never compares it with official thresholds.
 * - Dates are UTC ("2026-08-16T18:54:26", no zone; the page's chart uses the same instants as epoch ms).
 *
 * Access: API v2 (https://dahiti.dgfi.tum.de/en/api/doc/v2/download-water-level/), POST JSON
 * `{api_key, dahiti_id, format: "json"}`; the key comes with a free DAHITI account (no card; name, organisation and
 * a sentence of motivation are asked). An invalid key answers 403 `{"code":403,"message":"Permission Denied …"}`
 * (checked 2026-09-24). The key travels in the POST body, never in a URL or `sourceUrl`. Without the key the feed is
 * locked; Vigía does not read the public page's embedded series, because DAHITI offers downloads after registration.
 *
 * Licence: CC BY 4.0, with DAHITI's terms of use: free for private persons, education and non-profits, no
 * commercial use, cite the product (register page, checked 2026-09-24). Vigía is free and non-commercial.
 */

export const GURI_DAHITI_ID = 67;
export const DAHITI_KEY_ID = "dahiti-api-key";
export const DAHITI_API = "https://dahiti.dgfi.tum.de/api/v2/download-water-level/";
export const GURI_PAGE = "https://dahiti.dgfi.tum.de/en/67/water-level-altimetry/";
export const GURI_SERIES = "guri:wse";

export const DAHITI_LICENCE: Licence = {
	id: "cc-by-4.0-dahiti",
	name: "CC BY 4.0 (DAHITI, DGFI-TUM; uso no comercial según sus términos)",
	url: "https://dahiti.dgfi.tum.de/en/register/",
	attribution:
		"DAHITI, DGFI-TUM (Schwatke et al. 2015, Hydrol. Earth Syst. Sci. 19, 4345–4364): nivel por altimetría satelital",
	commercial: false,
	// Registration-gated and non-commercial: Vigía shows what it derives (the level against the record), never the
	// series itself for download (code review 4, M5).
	raw: false,
};

export type GuriLevel = {
	/** Water-surface elevation above the EIGEN-6C4 geoid, metres. */
	wseM: number;
	/** DAHITI's uncertainty for this point, metres. */
	uncertaintyM: number;
	/** Mission and pass, as DAHITI labels them ("sentinel6a_LR_NTC_F08_hf 219 114"). */
	mission: string;
};

const Point = z.object({
	date: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/),
	wse: z.number().finite(),
	wse_u: z.number().finite().nonnegative(),
	data: z.string().optional(),
});

const Envelope = z.object({
	code: z.literal(200),
	target: z.object({ id: z.union([z.string(), z.number()]) }).passthrough(),
	data: z.array(z.unknown()),
});

/** A sane window for a water surface in Guri: the record is 242–273 m; anything far outside is a bad point. */
const PLAUSIBLE_M = { min: 200, max: 300 } as const;

export const dahitiGuri: Adapter<GuriLevel> = {
	id: "dahiti-guri",
	layer: "earth",
	name: {
		es: "Embalse de Guri: nivel por altimetría satelital",
		en: "Guri reservoir: level from satellite altimetry",
	},
	provider: "DAHITI (DGFI-TUM)",
	homepage: GURI_PAGE,
	licence: DAHITI_LICENCE,
	keys: [DAHITI_KEY_ID],
	// A new point every ~10 days, published weeks later: once a day is more than enough.
	intervalMs: 24 * 3_600_000,
	// Fetch: 3 missed days. Data: the newest point was 39 days old on 2026-09-24 in normal operation; 75 days means
	// DAHITI has skipped several passes, which the panel must say.
	freshness: { fetchMs: 3 * 86_400_000, dataMs: 75 * 86_400_000 },
	async fetch(ctx) {
		const key = ctx.key(DAHITI_KEY_ID);
		if (!key) throw new MissingKeyError(DAHITI_KEY_ID);
		const res = await ctx.http.request(DAHITI_API, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({ api_key: key, dahiti_id: GURI_DAHITI_ID, format: "json" }),
			timeoutMs: 60_000,
			maxBytes: 5_000_000,
			retries: 2,
			signal: ctx.signal,
		});
		return [res];
	},
	normalise(raws) {
		const out: Observation<GuriLevel>[] = [];
		for (const raw of raws) {
			let json: unknown;
			try {
				json = JSON.parse(raw.body);
			} catch {
				throw new SchemaError("DAHITI: la respuesta no es JSON");
			}
			const env = Envelope.safeParse(json);
			if (!env.success)
				throw new SchemaError(`DAHITI: sobre inesperado (${env.error.issues[0]?.message ?? ""})`);
			if (Number(env.data.target.id) !== GURI_DAHITI_ID)
				throw new SchemaError(`DAHITI: se pidió Guri (67) y llegó el objetivo ${env.data.target.id}`);
			for (const item of env.data.data) {
				const p = Point.safeParse(item);
				if (!p.success) continue;
				const at = Date.parse(`${p.data.date}Z`);
				if (!Number.isFinite(at) || at > raw.fetchedAt) continue;
				if (p.data.wse < PLAUSIBLE_M.min || p.data.wse > PLAUSIBLE_M.max) continue;
				out.push({
					source: "dahiti-guri",
					series: GURI_SERIES,
					sourceUrl: GURI_PAGE,
					fetchedAt: raw.fetchedAt,
					observedAt: at,
					licence: DAHITI_LICENCE.id,
					value: { wseM: p.data.wse, uncertaintyM: p.data.wse_u, mission: p.data.data ?? "" },
					location: { lat: 7.5115, lon: -62.8473, state: "VE-F", place: "Embalse de Guri" },
					// An instrument reading, but an estimate of the level from space (not the dam's gauge).
					confidence: 0.9,
					basis: "measurement",
				});
			}
		}
		return out;
	},
};
