import { caracasDateToMs } from "../../formats/time.ts";
import { type Cell, excelSerialToUtcDay } from "../../formats/xlsx.ts";

/**
 * Date cells of the BCV's statistics workbooks. The same column mixes Excel serials and hand-typed text, and the
 * text carries the BCV's own marks (measured 2026-09-28 in `liquidez_monetaria_semanal1.xls` and `2_1_1.xlsx`):
 * "18/09/2026 (*)" and "25/09/2026(*)" are provisional ("(*) Cifras provisionales"), "11/09/2026 *" is rectified
 * ("* Cifras rectificadas"), "03/7/2026" has a one-digit month, and plain serials (46234) carry no mark.
 */
export type BcvDateCell = {
	/** "YYYY-MM-DD" (a Caracas calendar day). */
	readonly date: string;
	/** Marked "(*)": provisional figure. */
	readonly provisional: boolean;
	/** Marked "*" without parentheses: a rectified figure. */
	readonly rectified: boolean;
};

export function bcvDateCell(cell: Cell): BcvDateCell | null {
	if (typeof cell === "number") {
		if (!(cell > 30_000 && cell < 80_000)) return null;
		const date = new Date(excelSerialToUtcDay(cell)).toISOString().slice(0, 10);
		return { date, provisional: false, rectified: false };
	}
	if (typeof cell !== "string") return null;
	const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(\(\s*\*\s*\)|\*)?\s*$/.exec(cell);
	if (!m) return null;
	const date = `${m[3]}-${(m[2] ?? "").padStart(2, "0")}-${(m[1] ?? "").padStart(2, "0")}`;
	if (caracasDateToMs(date) === null) return null;
	const mark = (m[4] ?? "").replace(/\s/g, "");
	return { date, provisional: mark === "(*)", rectified: mark === "*" };
}
