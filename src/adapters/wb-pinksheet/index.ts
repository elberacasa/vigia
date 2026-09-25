import type { Adapter, Licence, Observation } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { type Cell, readXlsx, type Sheet } from "../../formats/xlsx.ts";

/**
 * World Bank Commodity Price Data ("The Pink Sheet"): monthly average world prices in nominal US dollars, 1960 to
 * the previous month, published around the second business day of each month. We keep the commodities that matter
 * to Venezuela: what it exports or produced (gold from the Arco Minero, iron ore and aluminium from Guayana, urea
 * from Pequiven, cocoa and coffee) and what it imports to eat (wheat, maize, rice, sugar, soybean oil).
 *
 * Two requests per run: the World Bank's commodity page (55 KB), to find the current workbook link (its path
 * carries a document hash that changes every year), then `CMO-Historical-Data-Monthly.xlsx` (~590 KB). Verified
 * 2026-09-24: "Updated on September 02, 2026", newest month 2026M08, sheet "Monthly Prices", names in row 5,
 * units in row 6, then one row per month ("2026M08"). Missing values are "…" and are skipped, not zeros.
 *
 * Licence: the page links "Data Access and Licensing" to the World Bank's CC BY 4.0 licence. Some Pink Sheet
 * series are compiled from third-party price reporters; the World Bank publishes the monthly averages openly.
 * Author metadata inside the workbook (`docProps/*`) is never read.
 */

export const WORLD_BANK_CC_BY: Licence = {
	id: "world-bank-cc-by-4.0",
	name: "CC BY 4.0 (Banco Mundial)",
	url: "https://datacatalog.worldbank.org/public-licenses#cc-by",
	attribution: "Fuente: Banco Mundial, Commodity Price Data (The Pink Sheet)",
	commercial: true,
};

export const PINK_PAGE = "https://www.worldbank.org/en/research/commodity-markets";
const SHEET = "Monthly Prices";

/** The column names exactly as the workbook writes them (trimmed), and what we call them. */
export const PINK_SERIES = [
	{ column: "Gold", series: "gold", labelEs: "Oro", labelEn: "Gold", unit: "US$/oz troy" },
	{
		column: "Iron ore, cfr spot",
		series: "iron-ore",
		labelEs: "Mineral de hierro",
		labelEn: "Iron ore",
		unit: "US$/tmsd",
	},
	{ column: "Aluminum", series: "aluminium", labelEs: "Aluminio", labelEn: "Aluminium", unit: "US$/t" },
	{ column: "Urea", series: "urea", labelEs: "Urea", labelEn: "Urea", unit: "US$/t" },
	{ column: "Cocoa", series: "cocoa", labelEs: "Cacao", labelEn: "Cocoa", unit: "US$/kg" },
	{
		column: "Coffee, Arabica",
		series: "coffee-arabica",
		labelEs: "Café arábica",
		labelEn: "Arabica coffee",
		unit: "US$/kg",
	},
	{ column: "Wheat, US HRW", series: "wheat", labelEs: "Trigo (HRW)", labelEn: "Wheat (HRW)", unit: "US$/t" },
	{ column: "Maize", series: "maize", labelEs: "Maíz", labelEn: "Maize", unit: "US$/t" },
	{
		column: "Rice, Thai 5%",
		series: "rice",
		labelEs: "Arroz (Tailandia 5 %)",
		labelEn: "Rice (Thai 5%)",
		unit: "US$/t",
	},
	{ column: "Sugar, world", series: "sugar", labelEs: "Azúcar", labelEn: "Sugar", unit: "US$/kg" },
	{
		column: "Soybean oil",
		series: "soybean-oil",
		labelEs: "Aceite de soya",
		labelEn: "Soybean oil",
		unit: "US$/t",
	},
] as const;

export type PinkSeriesId = (typeof PINK_SERIES)[number]["series"];

export type MonthlyPrice = {
	readonly value: number;
	readonly unit: string;
	/** The month the average refers to, "YYYY-MM". */
	readonly month: string;
};

/** Five years of months: enough for year-on-year changes and a two-year line, ~660 rows per run. */
const KEEP_MONTHS = 60;

/** The monthly workbook's link on the World Bank page (absolute), or null. */
export function findWorkbookUrl(html: string): string | null {
	const m = /href="(https:\/\/thedocs\.worldbank\.org\/[^"]*\/CMO-Historical-Data-Monthly\.xlsx)"/.exec(html);
	return m?.[1] ?? null;
}

const MONTHS: Record<string, string> = {
	january: "01",
	february: "02",
	march: "03",
	april: "04",
	may: "05",
	june: "06",
	july: "07",
	august: "08",
	september: "09",
	october: "10",
	november: "11",
	december: "12",
};

/** "Updated on September 02, 2026" → "2026-09-02". */
export function parseUpdated(rows: readonly (readonly Cell[])[]): string | null {
	for (const row of rows.slice(0, 10)) {
		for (const cell of row) {
			if (typeof cell !== "string") continue;
			const m = /Updated on\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(cell);
			const month = m ? MONTHS[(m[1] ?? "").toLowerCase()] : undefined;
			if (m && month) return `${m[3]}-${month}-${String(m[2]).padStart(2, "0")}`;
		}
	}
	return null;
}

/** "2026M08" → "2026-08". */
export function parsePeriod(cell: Cell): string | null {
	if (typeof cell !== "string") return null;
	const m = /^(\d{4})M(\d{2})$/.exec(cell.trim());
	if (!m) return null;
	const month = Number(m[2]);
	return month >= 1 && month <= 12 ? `${m[1]}-${m[2]}` : null;
}

/** Epoch ms of the first day of a "YYYY-MM" month, 00:00 UTC. */
export function monthStart(month: string): number {
	return Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1);
}

function headerRow(sheet: Sheet): number {
	const at = sheet.rows.findIndex((row) => row.some((c) => typeof c === "string" && c.trim() === "Gold"));
	if (at < 0) throw new SchemaError(`Pink Sheet: no se encontró la fila de nombres en «${SHEET}»`);
	return at;
}

export const wbPinksheet: Adapter<MonthlyPrice> = {
	id: "wb-pinksheet",
	layer: "money",
	name: {
		es: "Materias primas: precios mensuales del Banco Mundial (Pink Sheet)",
		en: "Commodities: World Bank monthly prices (Pink Sheet)",
	},
	provider: "Banco Mundial",
	homepage: PINK_PAGE,
	licence: WORLD_BANK_CC_BY,
	keys: [],
	// Published once a month; a daily check costs ~650 KB.
	intervalMs: 24 * 3_600_000,
	// observedAt is the first day of the month averaged. August arrives ~2 September; September ~2 October, so the
	// newest month is at most ~63 days old when the source is on time. Stale past 75 days.
	freshness: { fetchMs: 3 * 24 * 3_600_000, dataMs: 75 * 86_400_000 },

	async fetch(ctx) {
		const page = await ctx.http.request(PINK_PAGE, {
			headers: { accept: "text/html" },
			hostGapMs: 2_000,
			maxBytes: 2 * 1024 * 1024,
			signal: ctx.signal,
		});
		const url = findWorkbookUrl(page.body);
		if (!url) throw new SchemaError("Pink Sheet: la página ya no enlaza CMO-Historical-Data-Monthly.xlsx");
		const book = await ctx.http.request(url, {
			binary: true,
			hostGapMs: 2_000,
			maxBytes: 8 * 1024 * 1024,
			timeoutMs: 60_000,
			signal: ctx.signal,
		});
		return [book];
	},

	normalise(raws) {
		const raw = raws.find((r) => r.url.endsWith("CMO-Historical-Data-Monthly.xlsx"));
		if (!raw) throw new SchemaError("Pink Sheet: no llegó el libro mensual");
		let sheet: Sheet | undefined;
		try {
			sheet = readXlsx(new Uint8Array(Buffer.from(raw.body, "base64"))).sheets.find((s) => s.name === SHEET);
		} catch (error) {
			throw new SchemaError(`Pink Sheet: el archivo no es un xlsx legible (${(error as Error).message})`);
		}
		if (!sheet) throw new SchemaError(`Pink Sheet: falta la hoja «${SHEET}»`);
		// The "Updated on" line is checked, not stored: it changes every month and would make every row a revision.
		if (parseUpdated(sheet.rows) === null) throw new SchemaError("Pink Sheet: falta la línea «Updated on»");
		const head = headerRow(sheet);
		const names = (sheet.rows[head] ?? []).map((c) => (typeof c === "string" ? c.trim() : ""));
		const columns = PINK_SERIES.map((s) => {
			const col = names.indexOf(s.column);
			if (col < 0) throw new SchemaError(`Pink Sheet: falta la columna «${s.column}»`);
			return { ...s, col };
		});
		const months = sheet.rows
			.slice(head + 1)
			.map((row) => ({ row, month: parsePeriod(row[0] ?? null) }))
			.filter((r): r is { row: Cell[]; month: string } => r.month !== null)
			.slice(-KEEP_MONTHS);
		if (months.length === 0) throw new SchemaError("Pink Sheet: sin filas mensuales");
		const out: Observation<MonthlyPrice>[] = [];
		for (const { row, month } of months) {
			const observedAt = monthStart(month);
			if (observedAt > raw.fetchedAt) continue;
			for (const c of columns) {
				const value = row[c.col];
				if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
				out.push({
					source: "wb-pinksheet",
					series: c.series,
					sourceUrl: PINK_PAGE,
					fetchedAt: raw.fetchedAt,
					observedAt,
					licence: WORLD_BANK_CC_BY.id,
					value: { value, unit: c.unit, month },
					confidence: 1,
					basis: "official",
				});
			}
		}
		return out;
	},
};
