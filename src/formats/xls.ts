import type { Cell, Sheet, Workbook } from "./xlsx.ts";

/**
 * A minimal legacy Excel (.xls, BIFF8 inside an OLE2 compound file) reader: cell values only. The BCV still
 * publishes its INPC and quarterly exchange-rate tables in this format.
 *
 * It opens only the `Workbook` stream, never `\x05SummaryInformation` / `\x05DocumentSummaryInformation`,
 * which hold the author metadata (BCV staff names). Supported records: SST (with CONTINUE), LABELSST, LABEL,
 * NUMBER, RK, MULRK, FORMULA (cached result), STRING, BOOLERR. Encrypted workbooks and BIFF5 or older are
 * rejected with a clear error. Spec: [MS-CFB] and [MS-XLS].
 */

export class XlsError extends Error {
	override readonly name = "XlsError";
}

const END_OF_CHAIN = 0xfffffffe;
const FREE_SECT = 0xffffffff;

// ---------------------------------------------------------------------------------------------------------
// Compound File Binary

export function readCfbStream(bytes: Uint8Array, wanted: readonly string[]): Uint8Array {
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes.length < 512 || v.getUint32(0, true) !== 0xe011cfd0 || v.getUint32(4, true) !== 0xe11ab1a1) {
		throw new XlsError("not an OLE2 compound file (.xls)");
	}
	const sectorShift = v.getUint16(0x1e, true);
	const miniShift = v.getUint16(0x20, true);
	if (sectorShift !== 9 && sectorShift !== 12) throw new XlsError(`bad sector size 2^${sectorShift}`);
	if (miniShift !== 6) throw new XlsError(`bad mini sector size 2^${miniShift}`);
	const sectorSize = 1 << sectorShift;
	const miniSize = 1 << miniShift;
	const sectorsInFile = Math.floor(bytes.length / (1 << sectorShift));
	// A FAT or DIFAT larger than the file is corrupt or hostile; never trust the header's counts.
	const numFat = Math.min(v.getUint32(0x2c, true), sectorsInFile);
	const firstDir = v.getUint32(0x30, true);
	const miniCutoff = v.getUint32(0x38, true);
	const firstMiniFat = v.getUint32(0x3c, true);
	const numMiniFat = v.getUint32(0x40, true);
	let difatSector = v.getUint32(0x44, true);
	const numDifat = v.getUint32(0x48, true);
	const sectorCount = Math.floor((bytes.length - sectorSize) / sectorSize) + 1;

	const sectorOffset = (n: number): number => {
		const off = (n + 1) * sectorSize;
		if (n >= sectorCount || off >= bytes.length) throw new XlsError(`sector ${n} out of range`);
		return off;
	};

	// DIFAT: the first 109 FAT sector numbers are in the header, the rest in a chain of DIFAT sectors.
	const fatSectors: number[] = [];
	for (let i = 0; i < 109 && fatSectors.length < numFat; i++)
		fatSectors.push(v.getUint32(0x4c + i * 4, true));
	const visited = new Set<number>();
	for (let d = 0; d < numDifat && fatSectors.length < numFat; d++) {
		if (difatSector === END_OF_CHAIN || difatSector === FREE_SECT) break;
		if (visited.has(difatSector)) throw new XlsError("DIFAT chain loops");
		visited.add(difatSector);
		const off = sectorOffset(difatSector);
		const per = sectorSize / 4 - 1;
		for (let i = 0; i < per && fatSectors.length < numFat; i++)
			fatSectors.push(v.getUint32(off + i * 4, true));
		difatSector = v.getUint32(off + per * 4, true);
	}
	const fat: number[] = [];
	for (const s of fatSectors) {
		const off = sectorOffset(s);
		for (let i = 0; i < sectorSize / 4; i++) fat.push(v.getUint32(off + i * 4, true));
	}

	const chain = (start: number, table: readonly number[], limit: number): number[] => {
		const out: number[] = [];
		let s = start;
		while (s !== END_OF_CHAIN && s !== FREE_SECT) {
			if (out.length > limit) throw new XlsError("sector chain loops");
			out.push(s);
			const next = table[s];
			if (next === undefined) throw new XlsError(`sector ${s} outside the allocation table`);
			s = next;
		}
		return out;
	};
	const readChain = (start: number, size: number): Uint8Array => {
		// A stream cannot be larger than the file; refuse before allocating (hostile or corrupt headers).
		if (size > bytes.length) throw new XlsError(`stream size ${size} exceeds the file`);
		const out = new Uint8Array(size);
		let written = 0;
		for (const s of chain(start, fat, fat.length)) {
			if (written >= size) break;
			const off = sectorOffset(s);
			const n = Math.min(sectorSize, size - written, bytes.length - off);
			out.set(bytes.subarray(off, off + n), written);
			written += n;
		}
		if (written < size) throw new XlsError("stream truncated");
		return out;
	};

	// Directory: 128-byte entries in the directory chain.
	const dirSectors = chain(firstDir, fat, fat.length);
	const dir = new Uint8Array(dirSectors.length * sectorSize);
	dirSectors.forEach((s, i) => {
		const off = sectorOffset(s);
		dir.set(bytes.subarray(off, off + sectorSize), i * sectorSize);
	});
	const dv = new DataView(dir.buffer);
	interface DirEntry {
		name: string;
		type: number;
		start: number;
		size: number;
	}
	const entries: DirEntry[] = [];
	for (let off = 0; off + 128 <= dir.length; off += 128) {
		const nameLen = dv.getUint16(off + 0x40, true);
		const type = dir[off + 0x42] ?? 0;
		if (type === 0) continue;
		const chars = Math.max(0, Math.min(32, nameLen / 2 - 1));
		let name = "";
		for (let i = 0; i < chars; i++) name += String.fromCharCode(dv.getUint16(off + i * 2, true));
		entries.push({ name, type, start: dv.getUint32(off + 0x74, true), size: dv.getUint32(off + 0x78, true) });
	}
	const root = entries.find((e) => e.type === 5);
	const target = wanted
		.map((w) => entries.find((e) => e.type === 2 && e.name.toLowerCase() === w.toLowerCase()))
		.find((e) => e !== undefined);
	if (!target) throw new XlsError(`stream not found: ${wanted.join(" / ")}`);
	if (target.size >= miniCutoff) return readChain(target.start, target.size);

	// Small streams live in the mini stream (the root entry's data), addressed through the mini FAT.
	if (!root) throw new XlsError("no root entry");
	const miniStream = readChain(root.start, root.size);
	const miniFat: number[] = [];
	for (const s of chain(firstMiniFat, fat, numMiniFat + 1)) {
		const off = sectorOffset(s);
		for (let i = 0; i < sectorSize / 4; i++) miniFat.push(v.getUint32(off + i * 4, true));
	}
	if (target.size > miniStream.length) throw new XlsError("mini stream entry exceeds the mini stream");
	const out = new Uint8Array(target.size);
	let written = 0;
	for (const s of chain(target.start, miniFat, miniFat.length)) {
		if (written >= target.size) break;
		const n = Math.min(miniSize, target.size - written);
		if (s * miniSize + n > miniStream.length) throw new XlsError(`mini sector ${s} out of range`);
		out.set(miniStream.subarray(s * miniSize, s * miniSize + n), written);
		written += n;
	}
	if (written < target.size) throw new XlsError("mini stream truncated");
	return out;
}

// ---------------------------------------------------------------------------------------------------------
// BIFF8

const R = {
	BOF: 0x0809,
	EOF: 0x000a,
	BOUNDSHEET: 0x0085,
	FILEPASS: 0x002f,
	SST: 0x00fc,
	CONTINUE: 0x003c,
	LABELSST: 0x00fd,
	LABEL: 0x0204,
	NUMBER: 0x0203,
	RK: 0x027e,
	MULRK: 0x00bd,
	FORMULA: 0x0006,
	STRING: 0x0207,
	BOOLERR: 0x0205,
	DATEMODE: 0x0022,
} as const;

interface RecordSlice {
	readonly type: number;
	readonly offset: number;
	readonly data: Uint8Array;
}

function records(stream: Uint8Array): RecordSlice[] {
	const out: RecordSlice[] = [];
	const v = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
	let p = 0;
	while (p + 4 <= stream.length) {
		const type = v.getUint16(p, true);
		const len = v.getUint16(p + 2, true);
		if (p + 4 + len > stream.length) break;
		out.push({ type, offset: p, data: stream.subarray(p + 4, p + 4 + len) });
		p += 4 + len;
	}
	return out;
}

/** Reads across a record and its CONTINUE records, as BIFF8 strings may be split between them. */
class SegmentReader {
	#seg = 0;
	#pos = 0;
	constructor(readonly segments: readonly Uint8Array[]) {}

	#current(): Uint8Array {
		for (;;) {
			const s = this.segments[this.#seg];
			if (!s) throw new XlsError("unexpected end of record");
			if (this.#pos < s.length) return s;
			this.#seg++;
			this.#pos = 0;
		}
	}

	u8(): number {
		const s = this.#current();
		return s[this.#pos++] ?? 0;
	}
	u16(): number {
		return this.u8() | (this.u8() << 8);
	}
	u32(): number {
		return (this.u16() | (this.u16() << 16)) >>> 0;
	}
	skip(n: number): void {
		for (let i = 0; i < n; i++) this.u8();
	}
	/** `count` characters; at a CONTINUE boundary a fresh option byte says whether the rest is 8- or 16-bit. */
	chars(count: number, highByte: boolean): string {
		let out = "";
		let wide = highByte;
		let left = count;
		while (left > 0) {
			const s = this.segments[this.#seg];
			if (!s) throw new XlsError("string runs past its record");
			if (this.#pos >= s.length) {
				this.#seg++;
				this.#pos = 0;
				const next = this.segments[this.#seg];
				if (!next) throw new XlsError("string runs past its record");
				wide = ((next[this.#pos++] ?? 0) & 1) === 1;
				continue;
			}
			if (wide) {
				out += String.fromCharCode((s[this.#pos] ?? 0) | ((s[this.#pos + 1] ?? 0) << 8));
				this.#pos += 2;
			} else {
				out += String.fromCharCode(s[this.#pos] ?? 0);
				this.#pos += 1;
			}
			left--;
		}
		return out;
	}
	/** XLUnicodeRichExtendedString (SST entries). */
	richString(): string {
		const cch = this.u16();
		const flags = this.u8();
		const runs = flags & 0x8 ? this.u16() : 0;
		const ext = flags & 0x4 ? this.u32() : 0;
		const text = this.chars(cch, (flags & 1) === 1);
		this.skip(runs * 4 + ext);
		return text;
	}
}

function unicodeString(data: Uint8Array, at: number): string {
	const r = new SegmentReader([data.subarray(at)]);
	const cch = r.u16();
	const flags = r.u8();
	const runs = flags & 0x8 ? r.u16() : 0;
	const ext = flags & 0x4 ? r.u32() : 0;
	void runs;
	void ext;
	return r.chars(cch, (flags & 1) === 1);
}

export function decodeRk(rk: number): number {
	let n: number;
	if (rk & 0x2) n = rk >> 2;
	else {
		const buf = new DataView(new ArrayBuffer(8));
		buf.setUint32(4, rk & 0xfffffffc, true);
		buf.setUint32(0, 0, true);
		n = buf.getFloat64(0, true);
	}
	return rk & 0x1 ? n / 100 : n;
}

export function readXls(bytes: Uint8Array): Workbook {
	const stream = readCfbStream(bytes, ["Workbook", "Book"]);
	const recs = records(stream);
	const first = recs[0];
	if (!first || first.type !== R.BOF) throw new XlsError("workbook stream does not start with BOF");
	const version = new DataView(first.data.buffer, first.data.byteOffset).getUint16(0, true);
	if (version !== 0x0600)
		throw new XlsError(`unsupported BIFF version 0x${version.toString(16)} (need BIFF8)`);

	const sheetsAt = new Map<number, { name: string; hidden: boolean; rows: Cell[][] }>();
	const order: { name: string; hidden: boolean; rows: Cell[][] }[] = [];
	let sst: string[] = [];
	let date1904 = false;

	// Workbook globals: up to the first EOF.
	let i = 1;
	for (; i < recs.length; i++) {
		const rec = recs[i];
		if (!rec) break;
		if (rec.type === R.EOF) break;
		const dv = new DataView(rec.data.buffer, rec.data.byteOffset, rec.data.byteLength);
		if (rec.type === R.FILEPASS) throw new XlsError("encrypted workbook");
		if (rec.type === R.DATEMODE) date1904 = dv.getUint16(0, true) === 1;
		if (rec.type === R.BOUNDSHEET) {
			const pos = dv.getUint32(0, true);
			const state = rec.data[4] ?? 0;
			const kind = rec.data[5] ?? 0;
			const cch = rec.data[6] ?? 0;
			const wide = ((rec.data[7] ?? 0) & 1) === 1;
			const name = new SegmentReader([rec.data.subarray(8)]).chars(cch, wide);
			const sheet = { name, hidden: state !== 0, rows: [] as Cell[][] };
			if (kind === 0) {
				sheetsAt.set(pos, sheet);
				order.push(sheet);
			}
		} else if (rec.type === R.SST) {
			const segments = [rec.data];
			while (recs[i + 1]?.type === R.CONTINUE) {
				i++;
				segments.push((recs[i] as RecordSlice).data);
			}
			const r = new SegmentReader(segments);
			r.u32();
			const unique = r.u32();
			sst = [];
			for (let k = 0; k < unique; k++) sst.push(r.richString());
		}
	}

	let current: { rows: Cell[][] } | null = null;
	let pendingFormula: { row: number; col: number } | null = null;
	const put = (row: number, col: number, value: Cell) => {
		if (!current) return;
		let cells = current.rows[row];
		if (!cells) {
			cells = [];
			current.rows[row] = cells;
		}
		while (cells.length < col) cells.push(null);
		cells[col] = value;
	};
	for (; i < recs.length; i++) {
		const rec = recs[i] as RecordSlice;
		const d = rec.data;
		const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
		switch (rec.type) {
			case R.BOF:
				current = sheetsAt.get(rec.offset) ?? null;
				break;
			case R.EOF:
				current = null;
				break;
			case R.LABELSST:
				put(dv.getUint16(0, true), dv.getUint16(2, true), sst[dv.getUint32(6, true)] ?? null);
				break;
			case R.LABEL:
				put(dv.getUint16(0, true), dv.getUint16(2, true), unicodeString(d, 6));
				break;
			case R.NUMBER:
				put(dv.getUint16(0, true), dv.getUint16(2, true), dv.getFloat64(6, true));
				break;
			case R.RK:
				put(dv.getUint16(0, true), dv.getUint16(2, true), decodeRk(dv.getUint32(6, true)));
				break;
			case R.MULRK: {
				const row = dv.getUint16(0, true);
				const colFirst = dv.getUint16(2, true);
				const n = (d.length - 6) / 6;
				for (let k = 0; k < n; k++) put(row, colFirst + k, decodeRk(dv.getUint32(4 + k * 6 + 2, true)));
				break;
			}
			case R.FORMULA: {
				const row = dv.getUint16(0, true);
				const col = dv.getUint16(2, true);
				if (dv.getUint16(12, true) === 0xffff) {
					const kind = d[6];
					if (kind === 0) pendingFormula = { row, col };
					else if (kind === 1) put(row, col, d[8] === 1);
					else put(row, col, null);
				} else put(row, col, dv.getFloat64(6, true));
				break;
			}
			case R.STRING:
				if (pendingFormula) put(pendingFormula.row, pendingFormula.col, unicodeString(d, 0));
				pendingFormula = null;
				break;
			case R.BOOLERR:
				put(dv.getUint16(0, true), dv.getUint16(2, true), d[7] === 0 ? d[6] === 1 : null);
				break;
		}
	}
	const sheets: Sheet[] = order.map((s) => {
		for (let r = 0; r < s.rows.length; r++) s.rows[r] ??= [];
		return s;
	});
	return { sheets, date1904 };
}
