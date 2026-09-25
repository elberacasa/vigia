import { expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { caracasDateToMs, caracasDay, caracasMidnight, parseVeNumber, startOfCaracasDay } from "./time.ts";
import { decodeRk, readCfbStream, XlsError } from "./xls.ts";
import { columnIndex, decodeXml, excelSerialToUtcDay, readXlsx } from "./xlsx.ts";
import { ZipError, ZipReader } from "./zip.ts";

/** Builds a small ZIP (deflate) in memory, to test the reader without a binary fixture. */
function zip(files: Record<string, string>): Uint8Array {
	const enc = new TextEncoder();
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;
	for (const [name, text] of Object.entries(files)) {
		const nameBytes = enc.encode(name);
		const data = enc.encode(text);
		const packed = deflateRawSync(data);
		const local = new Uint8Array(30 + nameBytes.length + packed.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(8, 8, true);
		lv.setUint32(18, packed.length, true);
		lv.setUint32(22, data.length, true);
		lv.setUint16(26, nameBytes.length, true);
		local.set(nameBytes, 30);
		local.set(packed, 30 + nameBytes.length);
		const central = new Uint8Array(46 + nameBytes.length);
		const cv = new DataView(central.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(10, 8, true);
		cv.setUint32(20, packed.length, true);
		cv.setUint32(24, data.length, true);
		cv.setUint16(28, nameBytes.length, true);
		cv.setUint32(42, offset, true);
		central.set(nameBytes, 46);
		locals.push(local);
		centrals.push(central);
		offset += local.length;
	}
	const cdSize = centrals.reduce((s, c) => s + c.length, 0);
	const eocd = new Uint8Array(22);
	const ev = new DataView(eocd.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, centrals.length, true);
	ev.setUint16(10, centrals.length, true);
	ev.setUint32(12, cdSize, true);
	ev.setUint32(16, offset, true);
	return new Uint8Array(Buffer.concat([...locals, ...centrals, eocd]));
}

const MAIN = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';

test("xlsx: shared, inline and typed cells, sparse columns, hidden sheets, entities", () => {
	const book = readXlsx(
		zip({
			"xl/workbook.xml": `<workbook ${MAIN}><sheets><sheet name="2026" sheetId="1" r:id="rId1"/><sheet name="M" sheetId="2" state="veryHidden" r:id="rId2"/></sheets></workbook>`,
			"xl/_rels/workbook.xml.rels":
				'<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
			"xl/sharedStrings.xml":
				"<sst><si><t>FECHA</t></si><si><r><t>Tasa </t></r><r><t>A&amp;B</t></r><rPh><t>x</t></rPh></si></sst>",
			"xl/worksheets/sheet1.xml": `<worksheet ${MAIN}><sheetData><row r="2"><c r="A2" t="s"><v>0</v></c><c r="C2" t="s"><v>1</v></c></row><row r="3"><c r="A3"><v>46288</v></c><c r="B3" t="b"><v>1</v></c><c r="C3" t="inlineStr"><is><t>&#233;</t></is></c><c r="D3" t="e"><v>#N/A</v></c></row></sheetData></worksheet>`,
			"xl/worksheets/sheet2.xml": `<worksheet ${MAIN}><sheetData/></worksheet>`,
			"docProps/core.xml": "<cp:coreProperties><dc:creator>SENTINEL</dc:creator></cp:coreProperties>",
		}),
	);
	expect(book.sheets.map((s) => [s.name, s.hidden])).toEqual([
		["2026", false],
		["M", true],
	]);
	expect(book.sheets[0]?.rows).toEqual([[], ["FECHA", null, "Tasa A&B"], [46288, true, "é", null]]);
	expect(JSON.stringify(book)).not.toContain("SENTINEL");
});

test("zip: rejects non-zip input and missing entries", () => {
	expect(() => new ZipReader(new Uint8Array(100))).toThrow(ZipError);
	expect(() => new ZipReader(zip({ a: "1" })).read("b")).toThrow("not found");
	expect(new ZipReader(zip({ a: "hola" })).readText("a")).toBe("hola");
});

test("xls: rejects files that are not OLE2 compound files", () => {
	expect(() => readCfbStream(new Uint8Array(1024), ["Workbook"])).toThrow(XlsError);
});

test("RK numbers: integer, float, and ×100 forms", () => {
	expect(decodeRk((42 << 2) | 0x2)).toBe(42);
	expect(decodeRk((1234 << 2) | 0x3)).toBe(12.34);
	// 1.0 as a double has high word 0x3FF00000.
	expect(decodeRk(0x3ff00000)).toBe(1);
	expect(decodeRk(0x3ff00000 | 0x1)).toBe(0.01);
});

test("cell refs, entities and Excel serial days", () => {
	expect(columnIndex("A1")).toBe(0);
	expect(columnIndex("AB12")).toBe(27);
	expect(decodeXml("&lt;a&gt; &#x41;&#66;")).toBe("<a> AB");
	expect(new Date(excelSerialToUtcDay(46288)).toISOString()).toBe("2026-09-23T00:00:00.000Z");
	expect(new Date(excelSerialToUtcDay(43333)).toISOString()).toBe("2018-08-21T00:00:00.000Z");
});

test("Caracas time is UTC−4 all year", () => {
	expect(caracasMidnight(2026, 9, 25)).toBe(Date.UTC(2026, 8, 25, 4));
	expect(caracasDateToMs("2026-02-30")).toBeNull();
	expect(caracasDay(Date.UTC(2026, 8, 25, 3, 59))).toBe("2026-09-24");
	expect(caracasDay(Date.UTC(2026, 8, 25, 4, 0))).toBe("2026-09-25");
	expect(startOfCaracasDay(Date.UTC(2026, 8, 25, 2))).toBe(Date.UTC(2026, 8, 24, 4));
});

test("Venezuelan number format", () => {
	expect(parseVeNumber("855,66250000")).toBe(855.6625);
	expect(parseVeNumber(" 637.409.769.724.325,0")).toBe(637409769724325);
	expect(parseVeNumber("5.368,9281")).toBe(5368.9281);
	expect(parseVeNumber("12")).toBe(12);
	expect(parseVeNumber("1,2,3")).toBeNull();
	expect(parseVeNumber("855.66")).toBeNull();
});

test("hostile inputs fail fast instead of hanging (found by review)", () => {
	const sheet = (row: string) =>
		zip({
			"xl/workbook.xml": `<workbook ${MAIN}><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
			"xl/_rels/workbook.xml.rels":
				'<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
			"xl/worksheets/sheet1.xml": `<worksheet ${MAIN}><sheetData>${row}</sheetData></worksheet>`,
		});
	expect(() => readXlsx(sheet('<row r="400000000"><c r="A400000000"><v>1</v></c></row>'))).toThrow(
		"out of range",
	);
	expect(() => readXlsx(sheet('<row r="1"><c r="ZZZZZZZ1"><v>1</v></c></row>'))).toThrow("out of range");

	// OLE2 header claiming 2^32 FAT/DIFAT sectors with a self-linked DIFAT sector.
	const b = new Uint8Array(1024);
	const v = new DataView(b.buffer);
	v.setUint32(0, 0xe011cfd0, true);
	v.setUint32(4, 0xe11ab1a1, true);
	v.setUint16(0x1e, 9, true);
	v.setUint16(0x20, 6, true);
	v.setUint32(0x2c, 0xffffffff, true);
	v.setUint32(0x44, 0, true);
	v.setUint32(0x48, 0xffffffff, true);
	const started = performance.now();
	expect(() => readCfbStream(b, ["Workbook"])).toThrow(XlsError);
	expect(performance.now() - started).toBeLessThan(500);
});
