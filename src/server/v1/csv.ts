/**
 * CSV per RFC 4180 (comma, CRLF, double quotes doubled), UTF-8 with a byte-order mark so spreadsheet programs open
 * accents correctly. Every text cell is quoted, so a spreadsheet that splits on another character (Excel in Spanish
 * splits on `;`) can never cut one in two and start a new cell mid-text (review 4 L2). Text cells that a spreadsheet
 * would run as a formula (= + - @, tab or carriage return first, also after leading spaces, NBSP or other blanks)
 * get a leading apostrophe (OWASP "CSV injection"); numbers and booleans are written bare.
 */

export type Cell = string | number | boolean | null | undefined;

const FORMULA = /^[\s\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]*[=+\-@\t\r]/;

export function cell(v: Cell): string {
	if (v === null || v === undefined) return "";
	if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
	if (typeof v === "boolean") return v ? "true" : "false";
	const text = FORMULA.test(v) ? `'${v}` : v;
	return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv(header: readonly string[], rows: readonly (readonly Cell[])[]): string {
	const lines = [header.map(cell).join(","), ...rows.map((r) => r.map(cell).join(","))];
	return `﻿${lines.join("\r\n")}\r\n`;
}

/** ISO 8601 UTC, or empty. */
export function iso(t: number | null | undefined): string {
	return typeof t === "number" && Number.isFinite(t) ? new Date(t).toISOString() : "";
}
