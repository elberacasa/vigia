import { z } from "zod";
import type { Adapter, Licence, Observation, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";

/**
 * UNHCR's refugee statistics (the Refugee Data Finder's API, api.unhcr.org/population/v1): end-of-year stocks of
 * people from Venezuela who are refugees, asylum seekers, or "other people in need of international protection"
 * (a category UNHCR created in 2022 for Venezuelans displaced abroad without refugee status; before, "Venezuelans
 * displaced abroad"), and of refugees and asylum seekers hosted *in* Venezuela (mostly Colombians).
 *
 * Three requests per run, keyless (verified 2026-09-24, ~1 s each, 3–33 KB): totals by year for origin VEN, totals
 * by year for asylum country VEN, and origin VEN by host country for the last three years. Newest year then: 2025
 * (UNHCR publishes year-end figures each June in Global Trends; mid-year figures are not in this endpoint).
 *
 * Quirks measured: counts arrive as numbers, as numeric strings ("0"), or as "-" for "not applicable / not
 * reported"; "-" is kept as null, never as 0. `observedAt` is 31 December of the year (the stock's reference date).
 *
 * Licence: CC BY 4.0 (UNHCR Refugee Data Finder). Attribution: "UNHCR Refugee Data Finder".
 */

export const UNHCR_LICENCE: Licence = {
	id: "cc-by-4.0-unhcr",
	name: "CC BY 4.0 (ACNUR, Refugee Data Finder)",
	url: "https://www.unhcr.org/refugee-statistics/",
	attribution: "Fuente: ACNUR (UNHCR), Refugee Data Finder",
	commercial: true,
};

export const UNHCR_PAGE = "https://www.unhcr.org/refugee-statistics/download?url=h8Yo";
const API = "https://api.unhcr.org/population/v1/population/";
const HISTORY_YEARS = 11;

export type Stock = {
	readonly year: number;
	readonly refugees: number | null;
	readonly asylumSeekers: number | null;
	/** "Other people in need of international protection" (UNHCR's `oip`). */
	readonly otherInNeed: number | null;
	/** Host country (ISO 3166-1 alpha-3) for per-country rows; null for totals. */
	readonly country: string | null;
	readonly countryName: string | null;
};

/** A UNHCR count: a number, a numeric string, or "-" (not applicable), which is null. */
const Count = z.union([
	z.number().int().nonnegative(),
	z.literal("-").transform(() => null),
	z
		.string()
		.regex(/^\d+$/)
		.transform((s) => Number(s)),
]);

const Item = z.object({
	year: z.number().int().min(1951).max(2100),
	coa_iso: z.string(),
	coa_name: z.string(),
	refugees: Count,
	asylum_seekers: Count,
	oip: Count,
});
const Envelope = z.object({ items: z.array(z.unknown()) });

export function unhcrUrls(now: number): { abroad: string; hosted: string; byCountry: string } {
	const y = new Date(now).getUTCFullYear();
	const q = (params: Record<string, string>) => `${API}?${new URLSearchParams({ limit: "500", ...params })}`;
	return {
		abroad: q({ coo: "VEN", yearFrom: String(y - HISTORY_YEARS), yearTo: String(y) }),
		hosted: q({ coa: "VEN", yearFrom: String(y - HISTORY_YEARS), yearTo: String(y) }),
		byCountry: q({ coo: "VEN", coa_all: "true", yearFrom: String(y - 3), yearTo: String(y) }),
	};
}

/** 31 December of `year`, 00:00 UTC: the reference date of a year-end stock. */
export function yearEnd(year: number): number {
	return Date.UTC(year, 11, 31);
}

function items(raw: RawResponse): unknown[] {
	let body: unknown;
	try {
		body = JSON.parse(raw.body);
	} catch {
		throw new SchemaError("ACNUR: la respuesta no es JSON");
	}
	const env = Envelope.safeParse(body);
	if (!env.success) throw new SchemaError("ACNUR: falta «items» en la respuesta");
	return env.data.items;
}

export const unhcrPopulation: Adapter<Stock> = {
	id: "unhcr-population",
	layer: "society",
	name: {
		es: "Personas refugiadas y desplazadas desde y hacia Venezuela (ACNUR)",
		en: "Refugees and displaced people from and to Venezuela (UNHCR)",
	},
	provider: "ACNUR (UNHCR)",
	homepage: UNHCR_PAGE,
	licence: UNHCR_LICENCE,
	keys: [],
	// Year-end figures, published once a year in June (revisions any time): a weekly check is plenty.
	intervalMs: 7 * 86_400_000,
	// The newest year-end (31 Dec) is published ~6 months later and replaced 12 months after that: up to ~18
	// months old when on time. Stale past 20 months (a missed June release).
	freshness: { fetchMs: 21 * 86_400_000, dataMs: 610 * 86_400_000 },

	async fetch(ctx) {
		const urls = unhcrUrls(ctx.now());
		const opts = {
			headers: { accept: "application/json" },
			hostGapMs: 2_000,
			maxBytes: 2 * 1024 * 1024,
			signal: ctx.signal,
		};
		return [
			await ctx.http.request(urls.abroad, opts),
			await ctx.http.request(urls.hosted, opts),
			await ctx.http.request(urls.byCountry, opts),
		];
	},

	normalise(raws) {
		const out: Observation<Stock>[] = [];
		let valid = 0;
		for (const raw of raws) {
			const u = new URL(raw.url);
			const byCountry = u.searchParams.get("coa_all") === "true";
			const hosted = u.searchParams.has("coa");
			for (const it of items(raw)) {
				const p = Item.safeParse(it);
				if (!p.success) continue;
				valid++;
				const d = p.data;
				const perCountry = byCountry && /^[A-Z]{3}$/.test(d.coa_iso);
				if (byCountry && !perCountry) continue;
				const observedAt = yearEnd(d.year);
				if (observedAt > raw.fetchedAt) continue;
				out.push({
					source: "unhcr-population",
					series: perCountry ? `abroad:${d.coa_iso}` : hosted ? "hosted" : "abroad",
					sourceUrl: UNHCR_PAGE,
					fetchedAt: raw.fetchedAt,
					observedAt,
					licence: UNHCR_LICENCE.id,
					value: {
						year: d.year,
						refugees: d.refugees,
						asylumSeekers: d.asylum_seekers,
						otherInNeed: d.oip,
						country: perCountry ? d.coa_iso : null,
						countryName: perCountry ? d.coa_name : null,
					},
					confidence: 1,
					basis: "official",
				});
			}
		}
		if (valid === 0) throw new SchemaError("ACNUR: ninguna fila válida");
		return out;
	},
};
