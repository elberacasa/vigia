import type { Adapter, Licence, Observation, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { monthStart } from "../wb-pinksheet/index.ts";

/**
 * FAO Food Price Index (FFPI): a monthly index of international prices of a basket of food commodities
 * (2014-2016 = 100), with its five group indices (meat, dairy, cereals, vegetable oils, sugar). Venezuela imports
 * much of its wheat, maize and oils, so this is the "what the world charges for food" line.
 *
 * Two requests per run: the FFPI page (63 KB), to find the current CSV link, then the CSV (48 KB). The page link
 * matters: an older CSV path (`/fileadmin/templates/worldfood/.../Food_price_indices_data.csv`) still answers 200
 * with data frozen at March 2018, so a hard-coded URL could serve stale data as if current.
 *
 * Verified 2026-09-24: newest month 2026-08 (released 4 September; the page lists 2026 release dates, next
 * 2 October). Layout: two title lines, then `Date,Food Price Index,Meat,Dairy,Cereals,Oils,Sugar`, an empty
 * row, then `YYYY-MM,...` rows padded with empty columns. FAO revises recent months; the store keeps each
 * revision and the panel reads the newest.
 *
 * Licence: FAO database terms (CC BY 4.0 for datasets FAO disseminates, unless stated otherwise; no other
 * licence is stated on the FFPI page). Attribution to FAO required.
 */

export const FAO_CC_BY: Licence = {
	id: "fao-cc-by-4.0",
	name: "CC BY 4.0 (FAO, términos de bases de datos)",
	url: "https://www.fao.org/contact-us/terms/db-terms-of-use/en/",
	attribution: "Fuente: FAO, Índice de precios de los alimentos",
	commercial: true,
};

export const FFPI_PAGE = "https://www.fao.org/worldfoodsituation/foodpricesindex/en/";

export const FFPI_SERIES = [
	{
		column: "Food Price Index",
		series: "ffpi",
		labelEs: "Alimentos (índice FAO)",
		labelEn: "Food (FAO index)",
	},
	{ column: "Cereals", series: "cereals", labelEs: "Cereales", labelEn: "Cereals" },
	{ column: "Oils", series: "oils", labelEs: "Aceites vegetales", labelEn: "Vegetable oils" },
	{ column: "Dairy", series: "dairy", labelEs: "Lácteos", labelEn: "Dairy" },
	{ column: "Meat", series: "meat", labelEs: "Carne", labelEn: "Meat" },
	{ column: "Sugar", series: "sugar", labelEs: "Azúcar", labelEn: "Sugar" },
] as const;

export type FfpiSeriesId = (typeof FFPI_SERIES)[number]["series"];

export type FoodIndex = {
	/** Index points, 2014-2016 = 100. */
	readonly index: number;
	/** "YYYY-MM". */
	readonly month: string;
};

const KEEP_MONTHS = 60;

/** The nominal-indices CSV link on the FFPI page (absolute, `&amp;` decoded), or null. */
export function findCsvUrl(html: string): string | null {
	const m = /href="(https:\/\/www\.fao\.org\/[^"]*\/food_price_indices_data\.csv[^"]*)"/i.exec(html);
	return m?.[1]?.replace(/&amp;/g, "&") ?? null;
}

export function parseFfpiCsv(body: string): { month: string; values: Map<string, number> }[] {
	const lines = body.replace(/^﻿/, "").split(/\r?\n/);
	const at = lines.findIndex((l) => l.startsWith("Date,"));
	if (at < 0) throw new SchemaError("FAO: no se encontró la cabecera «Date,…»");
	const names = (lines[at] ?? "").split(",").map((s) => s.trim());
	for (const s of FFPI_SERIES) {
		if (!names.includes(s.column)) throw new SchemaError(`FAO: falta la columna «${s.column}»`);
	}
	const out: { month: string; values: Map<string, number> }[] = [];
	for (const line of lines.slice(at + 1)) {
		const cells = line.split(",");
		const month = (cells[0] ?? "").trim();
		const m = /^(\d{4})-(\d{2})$/.exec(month);
		if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) continue;
		const values = new Map<string, number>();
		for (const s of FFPI_SERIES) {
			const text = (cells[names.indexOf(s.column)] ?? "").trim();
			const n = Number(text);
			if (text !== "" && Number.isFinite(n) && n > 0) values.set(s.series, n);
		}
		out.push({ month, values });
	}
	return out;
}

export const faoFfpi: Adapter<FoodIndex> = {
	id: "fao-ffpi",
	layer: "money",
	name: { es: "Índice de precios de los alimentos de la FAO", en: "FAO Food Price Index" },
	provider: "FAO",
	homepage: FFPI_PAGE,
	licence: FAO_CC_BY,
	keys: [],
	// Monthly, first Friday-ish of the month; a daily check costs ~110 KB.
	intervalMs: 24 * 3_600_000,
	// observedAt is the first day of the month; August arrives 4 September, September 2 October: at most ~65
	// days old when on time. Stale past 75 days.
	freshness: { fetchMs: 3 * 24 * 3_600_000, dataMs: 75 * 86_400_000 },

	async fetch(ctx) {
		const page = await ctx.http.request(FFPI_PAGE, {
			headers: { accept: "text/html" },
			hostGapMs: 2_000,
			maxBytes: 2 * 1024 * 1024,
			signal: ctx.signal,
		});
		const url = findCsvUrl(page.body);
		if (!url) throw new SchemaError("FAO: la página ya no enlaza food_price_indices_data.csv");
		return [
			await ctx.http.request(url, {
				headers: { accept: "text/csv" },
				hostGapMs: 2_000,
				maxBytes: 2 * 1024 * 1024,
				signal: ctx.signal,
			}),
		];
	},

	normalise(raws: readonly RawResponse[]) {
		const raw = raws.find((r) => /food_price_indices_data\.csv/i.test(r.url));
		if (!raw) throw new SchemaError("FAO: no llegó el CSV");
		const rows = parseFfpiCsv(raw.body).slice(-KEEP_MONTHS);
		if (rows.length === 0) throw new SchemaError("FAO: sin filas mensuales");
		const out: Observation<FoodIndex>[] = [];
		for (const row of rows) {
			const observedAt = monthStart(row.month);
			if (observedAt > raw.fetchedAt) continue;
			for (const [series, index] of row.values) {
				out.push({
					source: "fao-ffpi",
					series,
					sourceUrl: FFPI_PAGE,
					fetchedAt: raw.fetchedAt,
					observedAt,
					licence: FAO_CC_BY.id,
					value: { index, month: row.month },
					confidence: 1,
					basis: "official",
				});
			}
		}
		return out;
	},
};
