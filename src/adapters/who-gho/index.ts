import { z } from "zod";
import type { Adapter, Licence, Observation } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";

/**
 * WHO's Global Health Observatory (GHO OData API): the yearly figures Venezuela reports to WHO for diseases that
 * track the health system's state, next to WHO's own estimate where WHO makes one, and vaccination coverage.
 * One keyless request per indicator (six per run, 1–15 KB, ~1 s each; verified 2026-09-24):
 *
 * - `MALARIA_CONF_CASES`: confirmed malaria cases reported by the country (2024: 101,924);
 * - `MALARIA_EST_CASES`: WHO's estimated malaria cases, with its interval (2024: 110,613; 98,000–128,000). A
 *   reported and an estimated figure are different things and are shown side by side, never blended;
 * - `WHS3_62` measles and `WHS3_41` diphtheria: cases reported to WHO/UNICEF (2025: 0 and 0);
 * - `WHS8_110` MCV1 and `WHS4_100` DTP3: WHO/UNICEF estimates of national immunization coverage (WUENIC), % of
 *   one-year-olds (2025: 53 % and 50 %).
 *
 * Rows carry the year (`TimeDim`) and when WHO last updated them (`Date`). `observedAt` is 31 December of the
 * year. The GHO answers zero cases as `0E-9`; that parses to 0.
 *
 * Licence: CC BY-NC-SA 3.0 IGO (WHO's data policy for GHO). Vigía is non-commercial.
 */

export const WHO_LICENCE: Licence = {
	id: "cc-by-nc-sa-3.0-igo-who",
	name: "CC BY-NC-SA 3.0 IGO (OMS)",
	url: "https://www.who.int/about/policies/publishing/copyright",
	attribution: "Fuente: Organización Mundial de la Salud, Global Health Observatory",
	commercial: false,
};

const API = "https://ghoapi.azureedge.net/api";

export const GHO_INDICATORS = [
	{
		code: "MALARIA_CONF_CASES",
		page: "https://www.who.int/data/gho/data/themes/malaria",
		series: "malaria-reported",
		labelEs: "Malaria: casos confirmados notificados",
		labelEn: "Malaria: confirmed cases reported",
		unit: "cases",
		basis: "official",
	},
	{
		code: "MALARIA_EST_CASES",
		page: "https://www.who.int/data/gho/data/indicators/indicator-details/GHO/estimated-number-of-malaria-cases",
		series: "malaria-estimated",
		labelEs: "Malaria: casos estimados por la OMS",
		labelEn: "Malaria: cases estimated by WHO",
		unit: "cases",
		basis: "quote",
	},
	{
		code: "WHS3_62",
		page: "https://www.who.int/data/gho/data/indicators/indicator-details/GHO/measles---number-of-reported-cases",
		series: "measles-reported",
		labelEs: "Sarampión: casos notificados",
		labelEn: "Measles: cases reported",
		unit: "cases",
		basis: "official",
	},
	{
		code: "WHS3_41",
		page: "https://www.who.int/data/gho/data/indicators/indicator-details/GHO/diphtheria---number-of-reported-cases",
		series: "diphtheria-reported",
		labelEs: "Difteria: casos notificados",
		labelEn: "Diphtheria: cases reported",
		unit: "cases",
		basis: "official",
	},
	{
		code: "WHS8_110",
		page: "https://www.who.int/data/gho/data/indicators/indicator-details/GHO/measles-containing-vaccine-first-dose-(mcv1)-immunization-coverage-among-1-year-olds-(-)",
		series: "mcv1-coverage",
		labelEs: "Vacuna contra el sarampión (1.ª dosis)",
		labelEn: "Measles vaccine (1st dose)",
		unit: "%",
		basis: "quote",
	},
	{
		code: "WHS4_100",
		page: "https://www.who.int/data/gho/data/indicators/indicator-details/GHO/diphtheria-tetanus-toxoid-and-pertussis-(dtp3)-immunization-coverage-among-1-year-olds-(-)",
		series: "dtp3-coverage",
		labelEs: "Vacuna DTP (3.ª dosis)",
		labelEn: "DTP vaccine (3rd dose)",
		unit: "%",
		basis: "quote",
	},
] as const;

export type GhoSeries = (typeof GHO_INDICATORS)[number]["series"];

export type GhoValue = {
	readonly indicator: string;
	readonly year: number;
	readonly value: number;
	/** WHO's uncertainty interval, for estimates. */
	readonly low: number | null;
	readonly high: number | null;
	/** "YYYY-MM-DD": when WHO last updated the row. */
	readonly updated: string | null;
};

export const ghoUrl = (code: string) => `${API}/${code}?$filter=SpatialDim%20eq%20'VEN'`;
export const GHO_HOME = "https://www.who.int/data/gho";

const Num = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?(E-?\d+)?$/i)]).transform(Number);
const Row = z.object({
	IndicatorCode: z.string(),
	SpatialDim: z.literal("VEN"),
	TimeDim: z.number().int().min(1950).max(2100),
	Dim1: z.string().nullable().optional(),
	NumericValue: Num,
	Low: Num.nullable().optional(),
	High: Num.nullable().optional(),
	Date: z.string().nullable().optional(),
});
const Envelope = z.object({ value: z.array(z.unknown()) });

export const whoGho: Adapter<GhoValue> = {
	id: "who-gho",
	layer: "society",
	name: {
		es: "Salud: casos notificados a la OMS y cobertura de vacunación",
		en: "Health: cases reported to WHO and vaccination coverage",
	},
	provider: "Organización Mundial de la Salud (GHO)",
	homepage: GHO_HOME,
	licence: WHO_LICENCE,
	keys: [],
	// Yearly figures, updated a few times a year (WUENIC every July, the World Malaria Report each December).
	intervalMs: 7 * 86_400_000,
	// observedAt is 31 December of the newest year: 2025's arrived July 2026, so ~7–19 months old when on time.
	// Stale past 26 months (a year's update missed).
	freshness: { fetchMs: 21 * 86_400_000, dataMs: 790 * 86_400_000 },

	async fetch(ctx) {
		const out = [];
		for (const ind of GHO_INDICATORS) {
			out.push(
				await ctx.http.request(ghoUrl(ind.code), {
					headers: { accept: "application/json" },
					hostGapMs: 1_000,
					maxBytes: 2 * 1024 * 1024,
					signal: ctx.signal,
				}),
			);
		}
		return out;
	},

	normalise(raws) {
		const out: Observation<GhoValue>[] = [];
		for (const raw of raws) {
			const ind = GHO_INDICATORS.find((i) => raw.url.includes(`/api/${i.code}?`));
			if (!ind) continue;
			let body: unknown;
			try {
				body = JSON.parse(raw.body);
			} catch {
				throw new SchemaError(`OMS: ${ind.code} no es JSON`);
			}
			const env = Envelope.safeParse(body);
			if (!env.success) throw new SchemaError(`OMS: ${ind.code} sin «value»`);
			for (const it of env.data.value) {
				const p = Row.safeParse(it);
				if (!p.success || p.data.IndicatorCode !== ind.code) continue;
				// Totals only: a row broken down by a dimension (sex, age) is not the national figure.
				if (p.data.Dim1) continue;
				const v = p.data.NumericValue;
				if (!Number.isFinite(v) || v < 0 || (ind.unit === "%" && v > 100)) continue;
				const observedAt = Date.UTC(p.data.TimeDim, 11, 31);
				if (observedAt > raw.fetchedAt) continue;
				out.push({
					source: "who-gho",
					series: ind.series,
					sourceUrl: ind.page,
					fetchedAt: raw.fetchedAt,
					observedAt,
					licence: WHO_LICENCE.id,
					value: {
						indicator: ind.code,
						year: p.data.TimeDim,
						value: ind.unit === "cases" ? Math.round(v) : v,
						low: p.data.Low ?? null,
						high: p.data.High ?? null,
						updated: p.data.Date?.slice(0, 10) ?? null,
					},
					confidence: ind.basis === "official" ? 1 : 0.9,
					basis: ind.basis,
				});
			}
		}
		if (out.length === 0) throw new SchemaError("OMS: ninguna cifra de Venezuela en la respuesta");
		return out;
	},
};
