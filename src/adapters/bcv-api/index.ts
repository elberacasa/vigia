import { z } from "zod";
import type { Adapter, Licence, Observation } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { caracasDateToMs } from "../../formats/time.ts";
import type { BcvCurrency } from "../bcv-official/index.ts";
import { seriesFor, valueDateInRange } from "../bcv-official/index.ts";

/**
 * bcv-api (github.com/elberacasa/bcv-api): a small public service, run by Vigía's maintainer, that reads the
 * BCV home page from Cloudflare's edge and serves the official USD and EUR rates as JSON. It is a second route to
 * the SAME figure `bcv-official` reads directly from bcv.org.ve, not a different rate: the money panel shows the
 * BCV once, says "confirmado por 2 vías" when both routes agree, falls back to this route (labelled, with its age)
 * when bcv.org.ve cannot be read, and flags a discrepancy (never an average) when they disagree.
 *
 * Measured 2026-09-24 against the live endpoint and its README:
 * - `bcv_usd` / `bcv_eur`: Bs per unit, as BCV publishes them (up to 8 decimals; JSON drops trailing zeros:
 *   855.6625 is BCV's "855,66250000").
 * - `fecha_valor`: the banking day the rate applies to, exactly the direct page's "Fecha Valor": it runs ahead
 *   after the afternoon publish and jumps Friday → Monday. `observedAt` is 00:00 Caracas of that day, the same
 *   convention as `bcv-official`, so the panel's "vigente" / "Publicada para …" logic applies unchanged.
 * - `scraped_at`: bcv-api's last successful read of bcv.org.ve. It polls every minute in the publish window
 *   (12:00-22:00 Caracas, weekdays, until the new rate appears) and every 20 min otherwise (the heartbeat).
 * - `stale`: true after 70 min without a successful read (~3 missed heartbeats). A stale answer carries no
 *   confirmation that its value is still BCV's current one, so the run fails loudly (the status page shows why)
 *   and nothing from it is stored.
 * - `changed_at`: when a value or the Fecha Valor last changed.
 *
 * Observations: `usd-ves` / `eur-ves` (same series ids as `bcv-official`), one per Fecha Valor and value, and
 * `read`, one per heartbeat, observed at `scraped_at`: the time this route last read the BCV, which the panel
 * uses for the route's age so a figure is never presented as fresher than bcv-api's own read.
 *
 * Licence: the figures are the BCV's public official rate, under the BCV's terms (non-commercial reproduction
 * citing the source); bcv-api only republishes them. The repository has no licence of its own for its code,
 * which Vigía does not use (it reads the public endpoint).
 */

export const BCV_API_LICENCE: Licence = {
	id: "bcv-api-mirror",
	name: "BCV vía bcv-api: reproducción sin fines de lucro citando la fuente",
	url: "https://www.bcv.org.ve/terminos-condiciones",
	attribution: "Fuente: Banco Central de Venezuela, vía bcv-api (bcv-api.umbrabadge.workers.dev)",
	commercial: false,
};

export const BCV_API_URL = "https://bcv-api.umbrabadge.workers.dev/";
export const BCV_API_REPO = "https://github.com/elberacasa/bcv-api";
export const BCV_API_PROVIDER = "BCV (vía bcv-api)";

export type BcvApiRate = {
	readonly currency: BcvCurrency;
	/** Bolívares per one unit of the currency, as the BCV publishes it. */
	readonly vesPerUnit: number;
	/** Fecha Valor, "YYYY-MM-DD" (Caracas). */
	readonly valueDate: string;
	/** When bcv-api last saw a value or the Fecha Valor change (epoch ms). */
	readonly changedAt: number;
};

export type BcvApiRead = {
	/** The Fecha Valor bcv-api held at this read, "YYYY-MM-DD". */
	readonly valueDate: string;
	/** When bcv-api last saw a value or the Fecha Valor change (epoch ms). */
	readonly changedAt: number;
};

export type BcvApiValue = BcvApiRate | BcvApiRead;

export const READ_SERIES = "read";

const Iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)) && /(Z|[+-]\d{2}:\d{2})$/.test(s), {
	message: "ISO time with a zone",
});
const Rate = z.number().positive().finite();

const Envelope = z.object({
	bcv_usd: Rate,
	// Optional in our reading: a missing or broken EUR skips EUR, like the direct adapter.
	bcv_eur: z.unknown().optional(),
	fecha_valor: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	scraped_at: Iso,
	changed_at: Iso,
	stale: z.boolean(),
	source: z.string().startsWith("https://www.bcv.org.ve"),
});

/** bcv-api's clock (Cloudflare's) may run slightly ahead of ours; more than this is a bad timestamp. */
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export const bcvApi: Adapter<BcvApiValue> = {
	id: "bcv-api",
	layer: "money",
	name: { es: "Tipo de cambio oficial (BCV, vía bcv-api)", en: "Official exchange rate (BCV, via bcv-api)" },
	provider: BCV_API_PROVIDER,
	homepage: BCV_API_REPO,
	licence: BCV_API_LICENCE,
	keys: [],
	// bcv-api answers from its own store (~0.5 KB), so polling it costs the BCV nothing; every 10 min brings a
	// new rate to Vigía within ~12 min of the BCV publishing it without hammering a free-tier service.
	intervalMs: 10 * 60_000,
	// fetchMs: 70 min is bcv-api's own staleness threshold (3.5 of its 20-min heartbeats; 7 of our polls).
	// dataMs: the newest Fecha Valor, same budget as the direct route (a long weekend plus a holiday).
	freshness: { fetchMs: 70 * 60_000, dataMs: 4 * 86_400_000 },

	async fetch(ctx) {
		return [
			await ctx.http.request(BCV_API_URL, {
				headers: { accept: "application/json" },
				hostGapMs: 5_000,
				maxBytes: 16 * 1024,
				signal: ctx.signal,
			}),
		];
	},

	normalise(raws) {
		const raw = raws[0];
		if (!raw) throw new SchemaError("no response");
		let body: unknown;
		try {
			body = JSON.parse(raw.body);
		} catch {
			throw new SchemaError("bcv-api: la respuesta no es JSON");
		}
		const parsed = Envelope.safeParse(body);
		if (!parsed.success) throw new SchemaError(`bcv-api: ${parsed.error.message.slice(0, 300)}`);
		const e = parsed.data;
		const scrapedAt = Date.parse(e.scraped_at);
		const changedAt = Date.parse(e.changed_at);
		if (e.stale) {
			throw new SchemaError(
				`bcv-api responde stale=true: no ha podido leer bcv.org.ve desde ${e.scraped_at}; su valor no se usa`,
			);
		}
		if (scrapedAt - raw.fetchedAt > MAX_CLOCK_SKEW_MS || changedAt - raw.fetchedAt > MAX_CLOCK_SKEW_MS) {
			throw new SchemaError("bcv-api: marca de tiempo en el futuro");
		}
		const observedAt = caracasDateToMs(e.fecha_valor);
		if (observedAt === null) throw new SchemaError(`bcv-api: fecha_valor inválida ${e.fecha_valor}`);
		if (!valueDateInRange(observedAt, raw.fetchedAt)) {
			throw new SchemaError(
				`bcv-api: fecha_valor ${e.fecha_valor} fuera de rango respecto a la hora de consulta`,
			);
		}
		const base = {
			source: "bcv-api",
			sourceUrl: BCV_API_URL,
			fetchedAt: raw.fetchedAt,
			licence: BCV_API_LICENCE.id,
			confidence: 1,
			basis: "official",
		} as const;
		const out: Observation<BcvApiValue>[] = [];
		const eur = Rate.safeParse(e.bcv_eur);
		const rates: [BcvCurrency, number | null][] = [
			["USD", e.bcv_usd],
			["EUR", eur.success ? eur.data : null],
		];
		for (const [currency, vesPerUnit] of rates) {
			if (vesPerUnit === null) continue;
			out.push({
				...base,
				series: seriesFor(currency),
				observedAt,
				value: { currency, vesPerUnit, valueDate: e.fecha_valor, changedAt },
			});
		}
		out.push({
			...base,
			series: READ_SERIES,
			// Clamped like Yadio's: a clock a little ahead must not hide the newest read as "future".
			observedAt: Math.min(scrapedAt, raw.fetchedAt),
			value: { valueDate: e.fecha_valor, changedAt },
		});
		return out;
	},
};
