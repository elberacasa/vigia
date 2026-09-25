import { ZipReader } from "./zip.ts";

/**
 * A minimal .xlsx reader: cell values only (numbers, strings, booleans), no styles or formulas. It reads
 * `xl/workbook.xml`, its relationships, `xl/sharedStrings.xml` and the worksheets, and nothing else: in
 * particular never `docProps/*`, which carries author metadata (for the BCV files, staff names).
 *
 * Why not SheetJS: the npm build is frozen at 0.18.5 (2022) and the maintained builds are served from the
 * vendor's CDN only; it is ~1 MB for features we do not use. This reader plus the ZIP reader is ~250 lines
 * and has no dependency beyond `node:zlib`.
 */

export type Cell = number | string | boolean | null;

export interface Sheet {
	readonly name: string;
	/** Hidden or very hidden sheets are listed too; callers decide. */
	readonly hidden: boolean;
	/** Rows by 0-based row index; each row by 0-based column index. Missing cells are null. */
	readonly rows: Cell[][];
}

export interface Workbook {
	readonly sheets: readonly Sheet[];
	/** True when dates are counted from 1904 (old Mac workbooks). */
	readonly date1904: boolean;
}

export function readXlsx(bytes: Uint8Array): Workbook {
	const zip = new ZipReader(bytes);
	const workbookXml = zip.readText("xl/workbook.xml");
	const relsXml = zip.readText("xl/_rels/workbook.xml.rels");
	const strings = zip.has("xl/sharedStrings.xml") ? sharedStrings(zip.readText("xl/sharedStrings.xml")) : [];

	const targets = new Map<string, string>();
	for (const m of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
		const attrs = attributes(m[1] ?? "");
		const id = attrs.get("Id");
		const target = attrs.get("Target");
		if (id && target) targets.set(id, target);
	}

	const date1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(workbookXml);
	const sheets: Sheet[] = [];
	for (const m of workbookXml.matchAll(/<sheet\b([^>]*)\/?>/g)) {
		const attrs = attributes(m[1] ?? "");
		const name = attrs.get("name");
		const rid = attrs.get("r:id");
		const target = rid ? targets.get(rid) : undefined;
		if (name === undefined || !target) continue;
		const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
		if (!zip.has(path)) continue;
		const state = attrs.get("state");
		sheets.push({
			name: decodeXml(name),
			hidden: state === "hidden" || state === "veryHidden",
			rows: sheetRows(zip.readText(path), strings),
		});
	}
	return { sheets, date1904 };
}

function sharedStrings(xml: string): string[] {
	const out: string[] = [];
	for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)) {
		// Phonetic runs (<rPh>) are annotations, not part of the text.
		const body = (m[1] ?? "").replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
		let text = "";
		for (const t of body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g)) text += decodeXml(t[1] ?? "");
		out.push(text);
	}
	return out;
}

const MAX_ROWS = 1_048_576;
const MAX_COLS = 16_384;
const MAX_CELLS = 5_000_000;

function sheetRows(xml: string, strings: readonly string[]): Cell[][] {
	const rows: Cell[][] = [];
	let cellCount = 0;
	let implicitRow = 0;
	for (const r of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
		const rowAttr = attributes(r[1] ?? "").get("r");
		const rowIndex = rowAttr ? Number(rowAttr) - 1 : implicitRow;
		// Excel's own limits; anything beyond is a corrupt or hostile file (dense arrays would exhaust memory).
		if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= MAX_ROWS) {
			throw new Error(`row ${rowAttr ?? rowIndex} out of range`);
		}
		implicitRow = rowIndex + 1;
		const cells: Cell[] = [];
		let implicitCol = 0;
		for (const c of (r[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
			const attrs = attributes(c[1] ?? "");
			const ref = attrs.get("r");
			const col = ref ? columnIndex(ref) : implicitCol;
			if (col < 0 || col >= MAX_COLS) throw new Error(`column ${ref ?? col} out of range`);
			if (++cellCount > MAX_CELLS) throw new Error("too many cells");
			implicitCol = col + 1;
			const value = cellValue(attrs.get("t"), c[2] ?? "", strings);
			while (cells.length < col) cells.push(null);
			cells[col] = value;
		}
		rows[rowIndex] = cells;
	}
	for (let i = 0; i < rows.length; i++) rows[i] ??= [];
	return rows;
}

function cellValue(type: string | undefined, inner: string, strings: readonly string[]): Cell {
	if (type === "inlineStr") {
		let text = "";
		for (const t of inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) text += decodeXml(t[1] ?? "");
		return text;
	}
	const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
	if (v === undefined) return null;
	switch (type) {
		case "s":
			return strings[Number(v)] ?? null;
		case "str":
			return decodeXml(v);
		case "b":
			return v === "1";
		case "e":
			return null;
		default: {
			const n = Number(v);
			return Number.isFinite(n) ? n : null;
		}
	}
}

/** "AB12" → 27. */
export function columnIndex(ref: string): number {
	let n = 0;
	for (const ch of ref) {
		const code = ch.charCodeAt(0);
		if (code < 65 || code > 90) break;
		n = n * 26 + (code - 64);
	}
	return n - 1;
}

function attributes(text: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const m of text.matchAll(/([\w:]+)="([^"]*)"/g)) out.set(m[1] ?? "", m[2] ?? "");
	return out;
}

export function decodeXml(text: string): string {
	return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
		switch (e) {
			case "amp":
				return "&";
			case "lt":
				return "<";
			case "gt":
				return ">";
			case "quot":
				return '"';
			case "apos":
				return "'";
			default: {
				const cp = e[1] === "x" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
				return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "\uFFFD";
			}
		}
	});
}

/** Excel serial day → epoch ms at 00:00 UTC of that calendar day (the caller applies the real time zone). */
export function excelSerialToUtcDay(serial: number, date1904 = false): number {
	const days = Math.floor(serial) + (date1904 ? 1462 : 0);
	// 25569 = days from 1899-12-30 (Excel's effective epoch, absorbing the 1900 leap-year bug) to 1970-01-01.
	return (days - 25_569) * 86_400_000;
}
