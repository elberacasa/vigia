import type { Adapter, Observation } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { caracasDateToMs, caracasMidnight } from "../../formats/time.ts";
import { type Cell, excelSerialToUtcDay, readXlsx } from "../../formats/xlsx.ts";
import { BCV_LICENCE } from "../bcv-official/index.ts";
import { bcvRequest } from "../bcv-official/tls.ts";

/**
 * BCV daily USD reference-rate history (`2_1_1_tdc.xlsx`, "Tipo de cambio de referencia Bs/US$"): one sheet
 * per year since 2016, columns FECHA | COMPRA | VENTA, newest first. FECHA is the Fecha Valor (checked: the
 * 2026-09-23 row equals the quarterly file's "Fecha Valor: 23/09/2026"). The file lags the home page by about
 * two business days; `bcv-official` covers the most recent days.
 *
 * Each yearly sheet is in the currency of its time. We convert to today's bolívares with the legal
 * redenomination table and say so in every converted value:
 * - until 2018-08-19: bolívar fuerte (Bs.F); 2018-08-20 reconversion 1:100,000 (Decreto 3.548);
 * - until 2021-09-30: bolívar soberano (Bs.S); 2021-10-01 reconversion 1:1,000,000 (Decreto 4.553).
 * So a Bs.F figure is divided by 100,000,000,000 and a Bs.S figure by 1,000,000.
 *
 * Only cell values are read; the file's document properties (which name BCV staff) are never opened.
 */

export const BCV_HISTORY_URL =
	"https://www.bcv.org.ve/sites/default/files/indicadores_sector_externo/2_1_1_tdc.xlsx";
export const BCV_HISTORY_PAGE = "https://www.bcv.org.ve/estadisticas/tipo-de-cambio-de-referencia-0";

export type PublishedUnit = "Bs.F" | "Bs.S" | "Bs.";

export type BcvHistoryRate = {
	/** Ask (venta), in today's bolívares per US dollar. */
	readonly vesPerUsd: number;
	/** Bid (compra), in today's bolívares per US dollar. */
	readonly bidVesPerUsd: number;
	/** The ask exactly as published, in `publishedUnit`. */
	readonly publishedAsk: number;
	readonly publishedBid: number;
	readonly publishedUnit: PublishedUnit;
	/** What the published figures were divided by to reach today's bolívares (1 = unchanged). */
	readonly divisor: number;
	/** Spanish note shown next to a converted figure; null when nothing was converted. */
	readonly conversion: string | null;
	/** Fecha Valor, "YYYY-MM-DD". */
	readonly valueDate: string;
};

export const REDENOMINATIONS = [
	{ from: "2018-08-20", factor: 100_000, unitBefore: "Bs.F" },
	{ from: "2021-10-01", factor: 1_000_000, unitBefore: "Bs.S" },
] as const;

/** The unit a BCV figure dated `valueDate` was published in, and the divisor to today's bolívares. */
export function unitOn(valueDate: string): { unit: PublishedUnit; divisor: number } {
	if (valueDate < "2018-08-20") return { unit: "Bs.F", divisor: 100_000 * 1_000_000 };
	if (valueDate < "2021-10-01") return { unit: "Bs.S", divisor: 1_000_000 };
	return { unit: "Bs.", divisor: 1 };
}

const CONVERSION_NOTE: Record<PublishedUnit, string | null> = {
	"Bs.F":
		"Convertido por Vigía a bolívares actuales: publicado en bolívares fuertes (Bs.F) y dividido entre " +
		"100.000.000.000 (reconversiones de 2018, 1:100.000, y de 2021, 1:1.000.000).",
	"Bs.S":
		"Convertido por Vigía a bolívares actuales: publicado en bolívares soberanos (Bs.S) y dividido entre " +
		"1.000.000 (reconversión de 2021).",
	"Bs.": null,
};

/** A FECHA cell: an Excel serial (2017 onwards) or a "30/12/2016" string (2016 sheet). */
export function cellDate(cell: Cell): string | null {
	if (typeof cell === "number" && cell > 30_000 && cell < 80_000) {
		return new Date(excelSerialToUtcDay(cell)).toISOString().slice(0, 10);
	}
	if (typeof cell === "string") {
		const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(cell);
		if (!m) return null;
		const iso = `${m[3]}-${(m[2] ?? "").padStart(2, "0")}-${(m[1] ?? "").padStart(2, "0")}`;
		return caracasDateToMs(iso) === null ? null : iso;
	}
	return null;
}

function headerColumns(
	rows: readonly Cell[][],
): { row: number; date: number; bid: number; ask: number } | null {
	for (let r = 0; r < Math.min(rows.length, 20); r++) {
		const cells = (rows[r] ?? []).map((c) => (typeof c === "string" ? c.trim().toUpperCase() : ""));
		const date = cells.indexOf("FECHA");
		const bid = cells.indexOf("COMPRA");
		const ask = cells.indexOf("VENTA");
		if (date >= 0 && bid >= 0 && ask >= 0) return { row: r, date, bid, ask };
	}
	return null;
}

export const bcvHistory: Adapter<BcvHistoryRate> = {
	id: "bcv-history",
	layer: "money",
	name: { es: "Historial del tipo de cambio oficial (BCV)", en: "Official exchange rate history (BCV)" },
	provider: "Banco Central de Venezuela",
	homepage: BCV_HISTORY_PAGE,
	licence: BCV_LICENCE,
	keys: [],
	// The file is updated about once per business day (~143 KB); daily is plenty. Unchanged rows are
	// deduplicated by the store, so a re-read costs nothing.
	intervalMs: 24 * 3_600_000,
	freshness: { fetchMs: 3 * 24 * 3_600_000, dataMs: 7 * 24 * 3_600_000 },

	async fetch(ctx) {
		return [await bcvRequest(ctx, BCV_HISTORY_URL, { binary: true, maxBytes: 8 * 1024 * 1024 })];
	},

	normalise(raws) {
		const raw = raws[0];
		if (!raw) throw new SchemaError("no response");
		let workbook: ReturnType<typeof readXlsx>;
		try {
			workbook = readXlsx(new Uint8Array(Buffer.from(raw.body, "base64")));
		} catch (error) {
			throw new SchemaError(`BCV 2_1_1_tdc.xlsx ilegible: ${(error as Error).message}`);
		}
		const latestAllowed = raw.fetchedAt + 7 * 86_400_000;
		const earliest = caracasMidnight(2010, 1, 1);
		const out: Observation<BcvHistoryRate>[] = [];
		let yearSheets = 0;
		for (const sheet of workbook.sheets) {
			if (sheet.hidden || !/^\d{4}$/.test(sheet.name.trim())) continue;
			const cols = headerColumns(sheet.rows);
			if (!cols) continue;
			yearSheets++;
			for (let r = cols.row + 1; r < sheet.rows.length; r++) {
				const row = sheet.rows[r] ?? [];
				const valueDate = cellDate(row[cols.date] ?? null);
				const bid = row[cols.bid];
				const ask = row[cols.ask];
				// Footnotes, blanks and malformed rows are skipped, not fatal.
				if (valueDate === null || typeof bid !== "number" || typeof ask !== "number") continue;
				if (!(bid > 0 && ask > 0)) continue;
				const observedAt = caracasDateToMs(valueDate);
				if (observedAt === null || observedAt < earliest || observedAt > latestAllowed) continue;
				const { unit, divisor } = unitOn(valueDate);
				out.push({
					source: "bcv-history",
					series: "usd-ves",
					sourceUrl: BCV_HISTORY_PAGE,
					fetchedAt: raw.fetchedAt,
					observedAt,
					licence: BCV_LICENCE.id,
					value: {
						vesPerUsd: ask / divisor,
						bidVesPerUsd: bid / divisor,
						publishedAsk: ask,
						publishedBid: bid,
						publishedUnit: unit,
						divisor,
						conversion: CONVERSION_NOTE[unit],
						valueDate,
					},
					confidence: 1,
					basis: divisor === 1 ? "official" : "derived",
				});
			}
		}
		if (yearSheets === 0 || out.length === 0) {
			throw new SchemaError("BCV 2_1_1_tdc.xlsx: no hay hojas anuales con FECHA | COMPRA | VENTA");
		}
		return out;
	},
};
