import { Conditional } from "../../core/conditional.ts";
import type { Adapter, Observation } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { caracasDateToMs } from "../../formats/time.ts";
import { readXls } from "../../formats/xls.ts";
import type { Cell, Sheet } from "../../formats/xlsx.ts";
import { bcvDateCell } from "../bcv-official/cells.ts";
import { BCV_LICENCE } from "../bcv-official/index.ts";
import { bcvRequest } from "../bcv-official/tls.ts";

/**
 * BCV weekly money supply, "Liquidez monetaria en poder del público" (`liquidez_monetaria_semanal1.xls`, a legacy
 * BIFF8 workbook read by formats/xls.ts). One row per week, newest first, dated by the Friday the week ends on:
 * currency and coins held by the public, demand deposits, transferable savings deposits, M1 ("dinero"),
 * quasi-money and M2 ("liquidez monetaria"), plus the BCV's own week-on-week % change.
 *
 * Measured 2026-09-28: 340,480 bytes, Last-Modified Fri 25 Sep 2026 15:23 GMT with the week to 18/09/2026 as the
 * newest row (published about a week after the week ends, on Fridays); ETag and If-None-Match answered 304.
 *
 * The workbook has three sheets, each in the currency of its time: "LIQUIDEZ_Oct2021_Miles" (thousands of today's
 * bolívares, from 01/10/2021), "LIQUIDEZ_2019-2021" (millions of bolívares soberanos) and "LIQUIDEZ 1996-2018"
 * (headed "Bolívares", but its figures continue the bolívar soberano series, 1996 included: re-expressed by the BCV
 * without saying so). Only the current sheet is read: five years of weekly history is what the panel needs for
 * week-on-week and year-on-year changes, and it keeps every stored figure exactly as published times 1,000, with no
 * conversion that rests on our reading of an unlabelled re-expression. The older sheets stay a link.
 *
 * Dates mix Excel serials and text with the BCV's marks: "(*)" provisional, "*" rectified (bcv-official/cells.ts).
 * The document properties, which name BCV staff, are never read.
 */

export const BCV_LIQUIDITY_URL =
	"https://www.bcv.org.ve/sites/default/files/indicadores_sector_monetario/liquidez_monetaria_semanal1.xls";
export const BCV_LIQUIDITY_PAGE = "https://www.bcv.org.ve/estadisticas/liquidez-monetaria";

export type LiquidityWeek = {
	/** The Friday the week ends on, "YYYY-MM-DD" (Caracas). */
	readonly weekEnding: string;
	/** Balances in today's bolívares (the sheet's thousands × 1,000). */
	readonly currencyVes: number;
	readonly demandDepositsVes: number;
	readonly savingsDepositsVes: number;
	/** M1, "dinero": currency + demand + transferable savings deposits. */
	readonly m1Ves: number;
	readonly quasiMoneyVes: number;
	/** M2, "liquidez monetaria" = M1 + quasi-money. */
	readonly m2Ves: number;
	/** The BCV's own week-on-week % change of M2, as published (null where the cell is empty). */
	readonly publishedChangePct: number | null;
	/** "(*) Cifras provisionales". */
	readonly provisional: boolean;
	/** "* Cifras rectificadas". */
	readonly rectified: boolean;
};

/** The sheet in today's currency: its title row names "Miles de Bolívares Nueva Expresión Monetaria". */
export const CURRENT_UNIT = /miles de bol[ií]vares nueva expresi[oó]n monetaria/i;
/** The 2021 redenomination: the current sheet starts here; an older date in it means the layout moved. */
const FIRST_WEEK = "2021-10-01";

function text(cell: Cell | undefined): string {
	return typeof cell === "string" ? cell.trim() : "";
}

/** The header row: "Semana" in column A and "LIQUIDEZ" in column G (the second header line says "MONETARIA"). */
function headerRow(rows: readonly Cell[][]): number | null {
	for (let r = 0; r < Math.min(rows.length, 20); r++) {
		const row = rows[r] ?? [];
		if (/^semana$/i.test(text(row[0])) && /^liquidez$/i.test(text(row[6]))) return r;
	}
	return null;
}

export function currentSheet(sheets: readonly Sheet[]): Sheet | null {
	return (
		sheets.find((s) => !s.hidden && s.rows.slice(0, 6).some((row) => CURRENT_UNIT.test(text(row[0])))) ?? null
	);
}

const num = (cell: Cell | undefined): number | null =>
	typeof cell === "number" && Number.isFinite(cell) ? cell : null;

/** Thousands of bolívares → bolívares, to the céntimo (the sheet's extra decimals are floating-point noise). */
export const thousandsToVes = (thousands: number): number => Math.round(thousands * 100_000) / 100;

const conditional = new Conditional();

export const bcvLiquidity: Adapter<LiquidityWeek> = {
	id: "bcv-liquidity",
	layer: "money",
	name: { es: "Liquidez monetaria semanal (BCV)", en: "Weekly money supply (BCV)" },
	provider: "Banco Central de Venezuela",
	homepage: BCV_LIQUIDITY_PAGE,
	licence: BCV_LICENCE,
	keys: [],
	// Weekly data, published on a Friday; twice a day with If-None-Match costs a 304 almost every time.
	intervalMs: 12 * 3_600_000,
	// The newest week ends ~7 days before it is published and the next one is due 7 days later: a newest week
	// older than 21 days means a publication was missed.
	freshness: { fetchMs: 3 * 86_400_000, dataMs: 21 * 86_400_000 },

	async fetch(ctx) {
		const raw = await bcvRequest(ctx, BCV_LIQUIDITY_URL, {
			binary: true,
			maxBytes: 8 * 1024 * 1024,
			headers: conditional.headers(),
			okStatuses: conditional.okStatuses(),
		});
		conditional.remember(raw, () => bcvLiquidity.normalise([raw]));
		return [raw];
	},

	normalise(raws) {
		const raw = raws[0];
		if (!raw) throw new SchemaError("no response");
		if (raw.status === 304) return [];
		let sheets: readonly Sheet[];
		try {
			sheets = readXls(new Uint8Array(Buffer.from(raw.body, "base64"))).sheets;
		} catch (error) {
			throw new SchemaError(`BCV liquidez_monetaria_semanal1.xls ilegible: ${(error as Error).message}`);
		}
		const sheet = currentSheet(sheets);
		if (!sheet)
			throw new SchemaError("BCV liquidez: no hay hoja en «Miles de Bolívares Nueva Expresión Monetaria»");
		const header = headerRow(sheet.rows);
		if (header === null) throw new SchemaError("BCV liquidez: no se encontró la fila «Semana … LIQUIDEZ»");
		const latestAllowed = raw.fetchedAt + 86_400_000;
		const out: Observation<LiquidityWeek>[] = [];
		const seen = new Set<string>();
		const ambiguous = new Set<string>();
		for (const row of sheet.rows.slice(header + 1)) {
			const date = bcvDateCell(row[0] ?? null);
			if (!date) continue;
			const currency = num(row[1]);
			const demand = num(row[2]);
			const savings = num(row[3]);
			const m1 = num(row[4]);
			const quasi = num(row[5]);
			const m2 = num(row[6]);
			// Footnotes, blanks and malformed rows are skipped, not fatal.
			if (currency === null || demand === null || savings === null || m1 === null || quasi === null) continue;
			if (m2 === null || !(m2 > 0)) continue;
			if (date.date < FIRST_WEEK) {
				throw new SchemaError(
					`BCV liquidez: semana ${date.date} anterior a la reconversión en la hoja actual`,
				);
			}
			const observedAt = caracasDateToMs(date.date);
			if (observedAt === null || observedAt > latestAllowed) continue;
			// A week written twice cannot be told apart: both rows are dropped rather than one picked.
			if (seen.has(date.date)) {
				ambiguous.add(date.date);
				continue;
			}
			seen.add(date.date);
			out.push({
				source: "bcv-liquidity",
				series: "m2",
				sourceUrl: BCV_LIQUIDITY_PAGE,
				fetchedAt: raw.fetchedAt,
				observedAt,
				licence: BCV_LICENCE.id,
				value: {
					weekEnding: date.date,
					currencyVes: thousandsToVes(currency),
					demandDepositsVes: thousandsToVes(demand),
					savingsDepositsVes: thousandsToVes(savings),
					m1Ves: thousandsToVes(m1),
					quasiMoneyVes: thousandsToVes(quasi),
					m2Ves: thousandsToVes(m2),
					publishedChangePct: num(row[7]),
					provisional: date.provisional,
					rectified: date.rectified,
				},
				confidence: date.provisional ? 0.9 : 1,
				basis: "official",
			});
		}
		const kept = out.filter((o) => !ambiguous.has(o.value.weekEnding));
		if (kept.length < 52) throw new SchemaError(`BCV liquidez: solo ${kept.length} semanas legibles`);
		return kept;
	},
};
