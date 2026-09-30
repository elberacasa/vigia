import { Conditional } from "../../core/conditional.ts";
import type { Adapter, Observation } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { caracasDateToMs } from "../../formats/time.ts";
import type { Cell, Sheet } from "../../formats/xlsx.ts";
import { readXlsx } from "../../formats/xlsx.ts";
import { bcvDateCell } from "../bcv-official/cells.ts";
import { BCV_LICENCE } from "../bcv-official/index.ts";
import { bcvRequest } from "../bcv-official/tls.ts";

/**
 * BCV international reserves, daily (`2_1_1.xlsx`, "Reservas internacionales"): one sheet per year since 2016, one
 * row per business day, newest first, in millions of US dollars: the BCV's own reserves, the macroeconomic
 * stabilisation fund (FEM, "incluye cartera administrada por el BCV") and the total. From 2018 the sheets add the
 * same figures in euros and yuan, which the BCV converts from the dollar figures with its own reference rate two
 * business days earlier; those conversions are not stored (they add no information).
 *
 * Measured 2026-09-28: 319,994 bytes, Last-Modified Mon 28 Sep 2026 18:41 GMT with 25/09/2026 as the newest row (one
 * business day behind), 2,588 rows since 2016; the newest weeks are marked "(*)" provisional. The home page shows
 * the same total (e.g. "Reservas Internacionales 23/09/2026: 12.912 MM US$").
 *
 * Dates mix Excel serials and "25/09/2026(*)" text (bcv-official/cells.ts). The document properties, which name BCV
 * staff, are never read.
 */

export const BCV_RESERVES_URL =
	"https://www.bcv.org.ve/sites/default/files/indicadores_sector_externo/2_1_1.xlsx";
export const BCV_RESERVES_PAGE = "https://www.bcv.org.ve/estadisticas/reservas-internacionales";

export type ReservesDay = {
	/** Business day, "YYYY-MM-DD" (Caracas). */
	readonly date: string;
	/** Millions of US dollars, as published. */
	readonly bcvMusd: number;
	/** Fondo de Estabilización Macroeconómica ("FIEM / FEM" in the weekly file), millions of US dollars. */
	readonly femMusd: number;
	readonly totalMusd: number;
	/** "(*) Cifras provisionales". */
	readonly provisional: boolean;
};

function text(cell: Cell | undefined): string {
	return typeof cell === "string" ? cell.trim().toUpperCase() : "";
}

/** FECHA | BCV | FEM | TOTAL in the first four columns, with "Millones de US$"/"Millones de USD" just below. */
export function reserveColumns(rows: readonly Cell[][]): number | null {
	for (let r = 0; r < Math.min(rows.length, 20); r++) {
		const row = rows[r] ?? [];
		if (text(row[0]) !== "FECHA" || text(row[1]) !== "BCV" || !/^(FIEM \/ )?FEM/.test(text(row[2]))) continue;
		if (!text(row[3]).startsWith("TOTAL")) continue;
		const unit = [rows[r + 1], rows[r + 2]].map((x) => text(x?.[1])).join(" ");
		if (!/MILLONES DE (USD|US\$)/.test(unit)) return null;
		return r;
	}
	return null;
}

const num = (cell: Cell | undefined): number | null =>
	typeof cell === "number" && Number.isFinite(cell) ? cell : null;

const conditional = new Conditional();

export const bcvReserves: Adapter<ReservesDay> = {
	id: "bcv-reserves",
	layer: "money",
	name: { es: "Reservas internacionales (BCV)", en: "International reserves (BCV)" },
	provider: "Banco Central de Venezuela",
	homepage: BCV_RESERVES_PAGE,
	licence: BCV_LICENCE,
	keys: [],
	// Updated once per business day (~14:40 Caracas on 2026-09-28); every 6 h with If-None-Match.
	intervalMs: 6 * 3_600_000,
	// One business day behind; a long weekend plus Carnaval or Holy Week can reach 6 days, so 8 days means the BCV
	// stopped publishing.
	freshness: { fetchMs: 2 * 86_400_000, dataMs: 8 * 86_400_000 },

	async fetch(ctx) {
		const raw = await bcvRequest(ctx, BCV_RESERVES_URL, {
			binary: true,
			maxBytes: 8 * 1024 * 1024,
			headers: conditional.headers(),
			okStatuses: conditional.okStatuses(),
		});
		conditional.remember(raw, () => bcvReserves.normalise([raw]));
		return [raw];
	},

	normalise(raws) {
		const raw = raws[0];
		if (!raw) throw new SchemaError("no response");
		if (raw.status === 304) return [];
		let sheets: readonly Sheet[];
		try {
			sheets = readXlsx(new Uint8Array(Buffer.from(raw.body, "base64"))).sheets;
		} catch (error) {
			throw new SchemaError(`BCV 2_1_1.xlsx ilegible: ${(error as Error).message}`);
		}
		const latestAllowed = raw.fetchedAt + 86_400_000;
		const out: Observation<ReservesDay>[] = [];
		const seen = new Set<string>();
		// A day written twice with different figures (2021-10-22, measured 2026-09-28: 11,142 and 11,155) cannot be
		// told apart: both rows are dropped rather than one picked.
		const ambiguous = new Set<string>();
		let yearSheets = 0;
		for (const sheet of sheets) {
			if (sheet.hidden || !/^\d{4}$/.test(sheet.name.trim())) continue;
			const header = reserveColumns(sheet.rows);
			if (header === null)
				throw new SchemaError(`BCV reservas: la hoja ${sheet.name} no trae FECHA | BCV | FEM | TOTAL en US$`);
			yearSheets++;
			for (const row of sheet.rows.slice(header + 1)) {
				const date = bcvDateCell(row[0] ?? null);
				const bcv = num(row[1]);
				const fem = num(row[2]);
				const total = num(row[3]);
				if (!date || bcv === null || fem === null || total === null || !(total > 0)) continue;
				// The published total is BCV + FEM; a row that does not add up is a layout change, not a figure.
				if (Math.abs(bcv + fem - total) > 1) {
					throw new SchemaError(`BCV reservas ${date.date}: ${bcv} + ${fem} ≠ ${total}`);
				}
				const observedAt = caracasDateToMs(date.date);
				if (observedAt === null || observedAt > latestAllowed) continue;
				if (date.date.slice(0, 4) !== sheet.name.trim()) continue;
				if (seen.has(date.date)) {
					ambiguous.add(date.date);
					continue;
				}
				seen.add(date.date);
				out.push({
					source: "bcv-reserves",
					series: "reserves",
					sourceUrl: BCV_RESERVES_PAGE,
					fetchedAt: raw.fetchedAt,
					observedAt,
					licence: BCV_LICENCE.id,
					value: {
						date: date.date,
						bcvMusd: bcv,
						femMusd: fem,
						totalMusd: total,
						provisional: date.provisional,
					},
					confidence: date.provisional ? 0.9 : 1,
					basis: "official",
				});
			}
		}
		const kept = out.filter((o) => !ambiguous.has(o.value.date));
		if (yearSheets === 0 || kept.length < 200) {
			throw new SchemaError(`BCV reservas: ${yearSheets} hojas anuales, ${kept.length} días legibles`);
		}
		return kept;
	},
};
