import { z } from "zod";
import type { Adapter, Licence } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";

/**
 * Yadio (yadio.io): a USD→VES rate that Yadio computes from P2P ads on several exchanges (Binance, Bybit,
 * OKX, MEXC, ...). The formula is not published, so this is a named third party's index, shown as
 * "Yadio (índice de anuncios P2P; fórmula no publicada)" with a link back, as Yadio's terms require.
 *
 * We read only `/rate/VES/USD` (70 bytes, with Yadio's own timestamp in ms; updates about every 5 minutes).
 * We never use Yadio's "official" figure (`/json/VES` → `USD.other.official`): it matched no BCV figure when
 * checked (852.685 vs BCV 854.4637 / 855.6625). The official rate comes only from the BCV.
 *
 * Errors come back as HTTP 200 with `{"error": "..."}` (e.g. "currency not found"), so the body is validated,
 * not the status.
 */

export const YADIO_LICENCE: Licence = {
	id: "yadio-attribution",
	name: "Yadio API: gratuita con atribución y enlace a yadio.io",
	url: "https://yadio.io/terms.html",
	attribution: "Fuente: yadio.io",
	commercial: "unclear",
};

export const YADIO_HOME = "https://yadio.io/";
export const YADIO_RATE_URL = "https://api.yadio.io/rate/VES/USD";
export const YADIO_LABEL = "Yadio (índice de anuncios P2P; fórmula no publicada)";

export type YadioRate = {
	/** Bolívares per US dollar, as Yadio publishes it. */
	readonly vesPerUsd: number;
};

const Rate = z.object({
	rate: z.number().positive().finite(),
	// Milliseconds since the epoch (a seconds value would be ~1.8e9 and fail this bound).
	timestamp: z.number().int().gt(1_000_000_000_000),
	request: z.literal("rate:VES/USD"),
});
const ErrorBody = z.object({ error: z.string() });

/** Yadio's clock may run slightly ahead of ours; more than this means a bad timestamp. */
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export const yadio: Adapter<YadioRate> = {
	id: "yadio",
	layer: "money",
	name: { es: "Dólar según Yadio (índice P2P)", en: "Dollar per Yadio (P2P index)" },
	provider: "Yadio",
	homepage: YADIO_HOME,
	licence: YADIO_LICENCE,
	keys: [],
	// Yadio recomputes about every 5 min; its limit is 100 requests/min, we make one every 5 min.
	intervalMs: 5 * 60_000,
	freshness: { fetchMs: 20 * 60_000, dataMs: 30 * 60_000 },

	async fetch(ctx) {
		const raw = await ctx.http.request(YADIO_RATE_URL, {
			headers: { accept: "application/json" },
			hostGapMs: 2_000,
			maxBytes: 64 * 1024,
			signal: ctx.signal,
		});
		return [raw];
	},

	normalise(raws) {
		const raw = raws[0];
		if (!raw) throw new SchemaError("no response");
		let body: unknown;
		try {
			body = JSON.parse(raw.body);
		} catch {
			throw new SchemaError("Yadio: la respuesta no es JSON");
		}
		const error = ErrorBody.safeParse(body);
		if (error.success) throw new SchemaError(`Yadio respondió con error: ${error.data.error.slice(0, 200)}`);
		const parsed = Rate.safeParse(body);
		if (!parsed.success) throw new SchemaError(`Yadio /rate: ${parsed.error.message}`);
		const { rate, timestamp } = parsed.data;
		if (timestamp - raw.fetchedAt > MAX_CLOCK_SKEW_MS) {
			throw new SchemaError("Yadio: marca de tiempo en el futuro");
		}
		return [
			{
				source: "yadio",
				series: "usd-ves",
				sourceUrl: YADIO_HOME,
				fetchedAt: raw.fetchedAt,
				// Yadio's clock may run a little ahead of ours: clamp, so the newest reading is never hidden as "future".
				observedAt: Math.min(timestamp, raw.fetchedAt),
				licence: YADIO_LICENCE.id,
				value: { vesPerUsd: rate },
				// A named third party's index with an unpublished method.
				confidence: 0.8,
				basis: "quote",
			},
		];
	},
};
