import type { Adapter, Observation } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { caracasMidnight } from "../../formats/time.ts";
import { readXls } from "../../formats/xls.ts";
import type { Cell } from "../../formats/xlsx.ts";
import { BCV_LICENCE } from "../bcv-official/index.ts";
import { bcvRequest } from "../bcv-official/tls.ts";

/**
 * BCV national consumer price index (INPC, base December 2007 = 100), monthly since December 2007, from
 * `4_5_7.xls` ("Índices y variaciones"), a legacy BIFF8 workbook read by the in-repo reader (formats/xls.ts).
 *
 * Layout: one sheet; year headers such as "2026(*)" (the asterisk marks provisional figures), then one row
 * per month, newest first: [Spanish month name, index, monthly % change]. We store the index and the monthly
 * change exactly as published. Year-on-year and other derived rates are computed by the money panel from the
 * index levels, and labelled as computed by Vigía.
 *
 * The BCV publishes about the first week of the following month, and has gone months without publishing in
 * the past, so the UI always names the month a figure refers to. Author metadata is never read.
 */

export const BCV_INPC_URL = "https://www.bcv.org.ve/sites/default/files/precios_consumidor/4_5_7.xls";
export const BCV_INPC_PAGE = "https://www.bcv.org.ve/estadisticas/consumidor";

export type InpcMonth = {
	/** The month the figure refers to, "YYYY-MM". */
	readonly period: string;
	/** Index level, December 2007 = 100. */
	readonly index: number;
	/** Monthly % change as published by the BCV; null where the BCV gives none (December 2007). */
	readonly monthlyPct: number | null;
	/** The BCV marks the year as provisional ("(*)"). */
	readonly provisional: boolean;
};

const MONTHS: Readonly<Record<string, number>> = {
	enero: 1,
	febrero: 2,
	marzo: 3,
	abril: 4,
	mayo: 5,
	junio: 6,
	julio: 7,
	agosto: 8,
	septiembre: 9,
	setiembre: 9,
	octubre: 10,
	noviembre: 11,
	diciembre: 12,
};

export function monthNumber(cell: Cell): number | null {
	if (typeof cell !== "string") return null;
	const key = cell.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
	return MONTHS[key] ?? null;
}

export function yearHeader(cell: Cell): { year: number; provisional: boolean } | null {
	if (typeof cell === "number" && Number.isInteger(cell) && cell >= 2000 && cell <= 2100) {
		return { year: cell, provisional: false };
	}
	if (typeof cell !== "string") return null;
	const m = /^\s*(\d{4})\s*(\(\s*\*+\s*\))?\s*$/.exec(cell);
	if (!m) return null;
	return { year: Number(m[1]), provisional: m[2] !== undefined };
}

export const bcvInpc: Adapter<InpcMonth> = {
	id: "bcv-inpc",
	layer: "money",
	name: { es: "Inflación: INPC (BCV)", en: "Inflation: consumer price index (BCV)" },
	provider: "Banco Central de Venezuela",
	homepage: BCV_INPC_PAGE,
	licence: BCV_LICENCE,
	keys: [],
	// Monthly data; daily polling (~60 KB) notices a publication within a day.
	intervalMs: 24 * 3_600_000,
	// observedAt is the first day of the month; the next month is due ~5 weeks after that. Stale when the
	// newest month started more than 70 days ago (e.g. no September figure by 10 November).
	freshness: { fetchMs: 3 * 24 * 3_600_000, dataMs: 70 * 86_400_000 },

	async fetch(ctx) {
		return [await bcvRequest(ctx, BCV_INPC_URL, { binary: true, maxBytes: 4 * 1024 * 1024 })];
	},

	normalise(raws) {
		const raw = raws[0];
		if (!raw) throw new SchemaError("no response");
		let rows: Cell[][];
		try {
			const book = readXls(new Uint8Array(Buffer.from(raw.body, "base64")));
			rows = book.sheets[0]?.rows ?? [];
		} catch (error) {
			throw new SchemaError(`BCV 4_5_7.xls ilegible: ${(error as Error).message}`);
		}
		const out: Observation<InpcMonth>[] = [];
		const seen = new Set<string>();
		let year: { year: number; provisional: boolean } | null = null;
		for (const row of rows) {
			const first = row[0] ?? null;
			const header = yearHeader(first);
			if (header) {
				year = header;
				continue;
			}
			const month = monthNumber(first);
			if (month === null || year === null) continue;
			const index = row[1];
			const pct = row[2];
			if (typeof index !== "number" || !(index > 0)) continue;
			const period = `${year.year}-${String(month).padStart(2, "0")}`;
			if (seen.has(period)) throw new SchemaError(`BCV INPC: mes repetido ${period}`);
			seen.add(period);
			const observedAt = caracasMidnight(year.year, month, 1);
			if (observedAt > raw.fetchedAt) continue;
			out.push({
				source: "bcv-inpc",
				series: "inpc",
				sourceUrl: BCV_INPC_PAGE,
				fetchedAt: raw.fetchedAt,
				observedAt,
				licence: BCV_LICENCE.id,
				value: {
					period,
					index,
					monthlyPct: typeof pct === "number" && Number.isFinite(pct) ? pct : null,
					provisional: year.provisional,
				},
				confidence: year.provisional ? 0.9 : 1,
				basis: "official",
			});
		}
		if (out.length < 12) throw new SchemaError(`BCV INPC: solo ${out.length} meses legibles`);
		return out;
	},
};
