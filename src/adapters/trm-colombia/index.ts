import { z } from "zod";
import type { Adapter, Licence, Observation } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";

/**
 * Colombia's official exchange rate, the TRM (Tasa de Cambio Representativa del Mercado, pesos per US dollar),
 * certified by the Superintendencia Financiera de Colombia and published as open data on datos.gov.co (Socrata
 * dataset 32sa-8pi3). Colombia is Venezuela's largest land neighbour and trading partner along the border, where
 * the peso circulates.
 *
 * Verified 2026-09-24: one row per validity period (`vigenciadesde`..`vigenciahasta`, local calendar days; a
 * weekend is one row), `valor` a decimal string. The TRM for the next business day is published the afternoon
 * before, so the newest row is often dated tomorrow: like the BCV's "Fecha Valor", `observedAt` is the day the rate
 * is in force from (00:00 Bogotá, UTC−5 all year), and the panel shows a future one as "próxima". ~0.55 s, ~40 KB
 * for 400 days. No key; Socrata throttles anonymous clients only at high rates (we make 4 requests a day).
 *
 * Licence: CC BY-SA 4.0 (dataset metadata), attribution to the Superintendencia Financiera de Colombia.
 */

export const TRM_LICENCE: Licence = {
	id: "cc-by-sa-4.0-superfinanciera",
	name: "CC BY-SA 4.0 (Superintendencia Financiera de Colombia, datos.gov.co)",
	url: "https://creativecommons.org/licenses/by-sa/4.0/",
	attribution: "Fuente: Superintendencia Financiera de Colombia, TRM (datos.gov.co)",
	commercial: true,
};

export const TRM_PAGE =
	"https://www.datos.gov.co/Econom-a-y-Finanzas/Tasa-de-Cambio-Representativa-del-Mercado-TRM/32sa-8pi3";
const DAY = 86_400_000;
const BOGOTA_OFFSET_MS = -5 * 3_600_000;
const WINDOW_DAYS = 400;
/** Published the business day before; over a long weekend up to 4 days ahead. More means a bad date. */
const MAX_AHEAD_MS = 5 * DAY;

export type TrmRate = {
	/** Colombian pesos per US dollar. */
	readonly copPerUsd: number;
	/** First and last local day the rate is in force, "YYYY-MM-DD". */
	readonly validFrom: string;
	readonly validTo: string;
};

export function trmUrl(now: number): string {
	const since = new Date(now - WINDOW_DAYS * DAY).toISOString().slice(0, 10);
	const q = new URLSearchParams({
		$select: "valor,unidad,vigenciadesde,vigenciahasta",
		$where: `vigenciadesde >= '${since}T00:00:00'`,
		$order: "vigenciadesde DESC",
		$limit: "1000",
	});
	return `https://www.datos.gov.co/resource/32sa-8pi3.json?${q}`;
}

const LocalDay = z.string().regex(/^\d{4}-\d{2}-\d{2}T00:00:00(\.000)?$/);
const Row = z.object({
	valor: z.string().regex(/^\d+(\.\d+)?$/),
	unidad: z.literal("COP"),
	vigenciadesde: LocalDay,
	vigenciahasta: LocalDay,
});

/** 00:00 Bogotá of a "YYYY-MM-DD" day; null if the day is not real. */
export function bogotaMidnight(day: string): number | null {
	const ms = Date.parse(`${day}T00:00:00Z`);
	if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== day) return null;
	return ms - BOGOTA_OFFSET_MS;
}

export const trmColombia: Adapter<TrmRate> = {
	id: "trm-colombia",
	layer: "money",
	name: { es: "Peso colombiano: TRM oficial", en: "Colombian peso: official TRM" },
	provider: "Superintendencia Financiera de Colombia",
	homepage: TRM_PAGE,
	licence: TRM_LICENCE,
	keys: [],
	intervalMs: 6 * 3_600_000,
	// Newest validity day older than 5 days (a long weekend plus a holiday) means it stopped publishing.
	freshness: { fetchMs: 24 * 3_600_000, dataMs: 5 * DAY },

	async fetch(ctx) {
		return [
			await ctx.http.request(trmUrl(ctx.now()), {
				headers: { accept: "application/json" },
				hostGapMs: 2_000,
				maxBytes: 1024 * 1024,
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
			throw new SchemaError("datos.gov.co: la respuesta no es JSON");
		}
		if (!Array.isArray(body)) throw new SchemaError("datos.gov.co: se esperaba una lista de filas");
		const out: Observation<TrmRate>[] = [];
		for (const item of body) {
			const row = Row.safeParse(item);
			if (!row.success) continue;
			const validFrom = row.data.vigenciadesde.slice(0, 10);
			const validTo = row.data.vigenciahasta.slice(0, 10);
			const observedAt = bogotaMidnight(validFrom);
			const copPerUsd = Number(row.data.valor);
			if (observedAt === null || bogotaMidnight(validTo) === null || validTo < validFrom) continue;
			if (observedAt - raw.fetchedAt > MAX_AHEAD_MS || !(copPerUsd > 0)) continue;
			out.push({
				source: "trm-colombia",
				series: "usd-cop",
				sourceUrl: TRM_PAGE,
				fetchedAt: raw.fetchedAt,
				observedAt,
				licence: TRM_LICENCE.id,
				value: { copPerUsd, validFrom, validTo },
				confidence: 1,
				basis: "official",
			});
		}
		if (body.length > 0 && out.length === 0)
			throw new SchemaError("datos.gov.co: ninguna fila válida de la TRM");
		return out;
	},
};
