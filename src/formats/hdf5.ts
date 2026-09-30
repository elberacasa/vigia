import { inflateSync } from "node:zlib";

/**
 * A minimal HDF5 reader: enough to read one-dimensional numeric datasets of the root group of a netCDF-4 file, such
 * as GOES-R GLM's `flash_lat`. Pure JS on top of `node:zlib`, so it runs everywhere Bun does and inside the single
 * binary, with no HDF5 library.
 *
 * It reads through a `ByteSource`, which may hold only parts of the file: when a structure lies outside what is
 * loaded, `NeedBytes` says which bytes to fetch, and the caller fetches them (an HTTP Range request) and parses again.
 * That is how a 630 KB GLM file is read for a few tens of kilobytes (adapters/goes-glm).
 *
 * Supported (HDF5 File Format Specification, version 3.0): superblock versions 2 and 3; object headers versions 1
 * and 2 with continuation blocks; links stored compactly (link messages) or densely (fractal heap + version 2
 * B-tree name index); dataspace versions 1 and 2; fixed-point and floating-point datatypes, little- or big-endian;
 * data layout version 3 (contiguous, compact, chunked with a version 1 B-tree) and version 4 single-chunk; filters
 * deflate (1) and shuffle (2). Anything else fails with `Hdf5Error` naming what it met, never a wrong number.
 * Checksums are not verified: a corrupt file fails on structure instead.
 */

export class Hdf5Error extends Error {
	override readonly name = "Hdf5Error";
}

/** The parse needs bytes [offset, offset + length) that the source does not hold. */
export class NeedBytes extends Error {
	override readonly name = "NeedBytes";
	constructor(
		readonly offset: number,
		readonly length: number,
	) {
		super(`need bytes ${offset}+${length}`);
	}
}

export interface ByteSource {
	/** The bytes at [offset, offset + length), or throw NeedBytes. */
	read(offset: number, length: number): Uint8Array;
}

/** A whole file in memory. */
export class WholeFile implements ByteSource {
	constructor(readonly bytes: Uint8Array) {}
	read(offset: number, length: number): Uint8Array {
		if (offset < 0 || offset + length > this.bytes.length) {
			throw new Hdf5Error(`read past the end of the file (${offset}+${length} > ${this.bytes.length})`);
		}
		return this.bytes.subarray(offset, offset + length);
	}
}

/** Loaded pieces of a file (non-overlapping after `add` merges them). */
export class SparseFile implements ByteSource {
	readonly #pieces: { offset: number; bytes: Uint8Array }[] = [];

	/** `size`, when known, lets reads past the end fail as errors rather than as missing bytes. */
	constructor(readonly size: number | null = null) {}

	add(offset: number, bytes: Uint8Array): void {
		this.#pieces.push({ offset, bytes });
		this.#pieces.sort((a, b) => a.offset - b.offset);
	}

	pieces(): readonly { offset: number; bytes: Uint8Array }[] {
		return this.#pieces;
	}

	read(offset: number, length: number): Uint8Array {
		if (this.size !== null && offset + length > this.size) {
			throw new Hdf5Error(`read past the end of the file (${offset}+${length} > ${this.size})`);
		}
		for (const p of this.#pieces) {
			if (p.offset <= offset && offset + length <= p.offset + p.bytes.length) {
				return p.bytes.subarray(offset - p.offset, offset - p.offset + length);
			}
		}
		// Spanning two adjacent pieces: copy when every byte is present.
		const out = new Uint8Array(length);
		let filled = 0;
		for (const p of this.#pieces) {
			const at = offset + filled;
			if (p.offset <= at && at < p.offset + p.bytes.length) {
				const n = Math.min(p.offset + p.bytes.length - at, length - filled);
				out.set(p.bytes.subarray(at - p.offset, at - p.offset + n), filled);
				filled += n;
				if (filled === length) return out;
			}
		}
		throw new NeedBytes(offset + filled, length - filled);
	}
}

// ---------------------------------------------------------------------------------------------------------
// Little-endian cursor over a source

const UNDEFINED = 0xffffffffffffffffn;

class Cursor {
	constructor(
		readonly src: ByteSource,
		public at: number,
		readonly offsetSize: number,
		readonly lengthSize: number,
	) {}

	bytes(n: number): Uint8Array {
		const b = this.src.read(this.at, n);
		this.at += n;
		return b;
	}
	u8(): number {
		return this.bytes(1)[0] ?? 0;
	}
	u16(): number {
		const b = this.bytes(2);
		return (b[0] ?? 0) | ((b[1] ?? 0) << 8);
	}
	u32(): number {
		const b = this.bytes(4);
		return ((b[0] ?? 0) | ((b[1] ?? 0) << 8) | ((b[2] ?? 0) << 16)) + (b[3] ?? 0) * 2 ** 24;
	}
	/** Unsigned little-endian integer of `n` bytes (n ≤ 8); undefined addresses (all ones) come back as -1. */
	uint(n: number): number {
		const b = this.bytes(n);
		let v = 0n;
		for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i] ?? 0);
		if (n === 8 && v === UNDEFINED) return -1;
		if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Hdf5Error(`integer too large (${v})`);
		return Number(v);
	}
	offset(): number {
		return this.uint(this.offsetSize);
	}
	length(): number {
		return this.uint(this.lengthSize);
	}
	signature(expected: string): void {
		const got = new TextDecoder("latin1").decode(this.bytes(4));
		if (got !== expected)
			throw new Hdf5Error(`expected ${expected} at ${this.at - 4}, found ${JSON.stringify(got)}`);
	}
}

/**
 * Bob Jenkins' lookup3 `hashlittle` (initval 0), which HDF5 uses for names in dense link storage
 * (H5_checksum_lookup3).
 */
export function lookup3(key: Uint8Array, initval = 0): number {
	const rot = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;
	let length = key.length;
	let a = (0xdeadbeef + length + initval) >>> 0;
	let b = a;
	let c = a;
	let o = 0;
	const k = (i: number) => key[o + i] ?? 0;
	while (length > 12) {
		a = (a + (k(0) | (k(1) << 8) | (k(2) << 16) | (k(3) << 24))) >>> 0;
		b = (b + (k(4) | (k(5) << 8) | (k(6) << 16) | (k(7) << 24))) >>> 0;
		c = (c + (k(8) | (k(9) << 8) | (k(10) << 16) | (k(11) << 24))) >>> 0;
		a = (a - c) >>> 0;
		a = (a ^ rot(c, 4)) >>> 0;
		c = (c + b) >>> 0;
		b = (b - a) >>> 0;
		b = (b ^ rot(a, 6)) >>> 0;
		a = (a + c) >>> 0;
		c = (c - b) >>> 0;
		c = (c ^ rot(b, 8)) >>> 0;
		b = (b + a) >>> 0;
		a = (a - c) >>> 0;
		a = (a ^ rot(c, 16)) >>> 0;
		c = (c + b) >>> 0;
		b = (b - a) >>> 0;
		b = (b ^ rot(a, 19)) >>> 0;
		a = (a + c) >>> 0;
		c = (c - b) >>> 0;
		c = (c ^ rot(b, 4)) >>> 0;
		b = (b + a) >>> 0;
		length -= 12;
		o += 12;
	}
	if (length === 0) return c;
	// The tail: bytes 0-3 into a, 4-7 into b, 8-11 into c.
	for (let i = length - 1; i >= 0; i--) {
		const v = k(i) << ((i % 4) * 8);
		if (i >= 8) c = (c + v) >>> 0;
		else if (i >= 4) b = (b + v) >>> 0;
		else a = (a + v) >>> 0;
	}
	c = (c ^ b) >>> 0;
	c = (c - rot(b, 14)) >>> 0;
	a = (a ^ c) >>> 0;
	a = (a - rot(c, 11)) >>> 0;
	b = (b ^ a) >>> 0;
	b = (b - rot(a, 25)) >>> 0;
	c = (c ^ b) >>> 0;
	c = (c - rot(b, 16)) >>> 0;
	a = (a ^ c) >>> 0;
	a = (a - rot(c, 4)) >>> 0;
	b = (b ^ a) >>> 0;
	b = (b - rot(a, 14)) >>> 0;
	c = (c ^ b) >>> 0;
	c = (c - rot(b, 24)) >>> 0;
	return c;
}

/** Bytes needed to encode `n` (HDF5's H5VM_limit_enc_size). */
const encSize = (n: number): number => Math.floor(Math.log2(Math.max(n, 1)) / 8) + 1;

// ---------------------------------------------------------------------------------------------------------
// Types

export type Datatype = {
	readonly kind: "int" | "float";
	readonly size: number;
	readonly signed: boolean;
	readonly bigEndian: boolean;
};

export type Filter = { readonly id: number; readonly flags: number; readonly values: readonly number[] };

type Layout =
	| { readonly kind: "compact"; readonly data: Uint8Array }
	| { readonly kind: "contiguous"; readonly address: number; readonly size: number }
	| { readonly kind: "chunked-btree"; readonly address: number; readonly chunk: readonly number[] }
	| {
			readonly kind: "single-chunk";
			readonly address: number;
			readonly size: number;
			readonly mask: number;
			readonly chunk: readonly number[];
	  };

export type DatasetInfo = {
	readonly name: string;
	readonly shape: readonly number[];
	readonly type: Datatype;
	readonly filters: readonly Filter[];
	readonly layout: Layout["kind"];
};

type Message = { readonly type: number; readonly at: number; readonly size: number };

// ---------------------------------------------------------------------------------------------------------

export class Hdf5File {
	readonly #src: ByteSource;
	readonly #o: number;
	readonly #l: number;
	readonly #root: number;

	constructor(src: ByteSource) {
		this.#src = src;
		const sig = src.read(0, 8);
		const expected = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];
		if (!expected.every((b, i) => sig[i] === b)) throw new Hdf5Error("not an HDF5 file (no signature at 0)");
		const version = src.read(8, 1)[0] ?? 0;
		if (version !== 2 && version !== 3) throw new Hdf5Error(`superblock version ${version} not supported`);
		const sizes = src.read(9, 2);
		this.#o = sizes[0] ?? 0;
		this.#l = sizes[1] ?? 0;
		if (this.#o !== 8 || this.#l !== 8)
			throw new Hdf5Error(`offset/length sizes ${this.#o}/${this.#l} not supported`);
		const c = this.#cursor(12);
		c.offset(); // base address
		c.offset(); // superblock extension
		c.offset(); // end of file
		this.#root = c.offset();
	}

	#cursor(at: number): Cursor {
		return new Cursor(this.#src, at, this.#o, this.#l);
	}

	/** Every message of the object header at `address`, continuation blocks included. */
	#messages(address: number): Message[] {
		const first = this.#src.read(address, 4);
		const v2 = first[0] === 0x4f && first[1] === 0x48 && first[2] === 0x44 && first[3] === 0x52; // "OHDR"
		return v2 ? this.#messagesV2(address) : this.#messagesV1(address);
	}

	#messagesV2(address: number): Message[] {
		const c = this.#cursor(address);
		c.signature("OHDR");
		const version = c.u8();
		if (version !== 2) throw new Hdf5Error(`object header version ${version} at ${address}`);
		const flags = c.u8();
		if (flags & 0x20) c.bytes(16);
		if (flags & 0x10) c.bytes(4);
		const chunkSize = c.uint(1 << (flags & 0x03));
		const out: Message[] = [];
		const blocks: { start: number; end: number }[] = [{ start: c.at, end: c.at + chunkSize }];
		const creationOrder = (flags & 0x04) !== 0;
		for (let i = 0; i < blocks.length; i++) {
			const block = blocks[i];
			if (!block) break;
			const m = this.#cursor(block.start);
			// Each block ends with a 4-byte checksum; a tail shorter than a message header is a gap.
			const headerSize = creationOrder ? 6 : 4;
			while (m.at + headerSize <= block.end - 4) {
				const type = m.u8();
				const size = m.u16();
				m.u8(); // message flags
				if (creationOrder) m.u16();
				const at = m.at;
				if (type === 0x10) {
					const cont = this.#cursor(at);
					const where = cont.offset();
					const length = cont.length();
					const k = this.#cursor(where);
					k.signature("OCHK");
					blocks.push({ start: where + 4, end: where + length });
				} else if (type !== 0) out.push({ type, at, size });
				m.at = at + size;
			}
		}
		return out;
	}

	#messagesV1(address: number): Message[] {
		const c = this.#cursor(address);
		const version = c.u8();
		if (version !== 1) throw new Hdf5Error(`object header version ${version} at ${address}`);
		c.u8();
		const count = c.u16();
		c.u32(); // reference count
		const size = c.u32();
		const out: Message[] = [];
		// The first block starts after the 12-byte prefix, aligned to 8 bytes (16).
		const blocks: { start: number; end: number }[] = [{ start: address + 16, end: address + 16 + size }];
		for (let i = 0; i < blocks.length && out.length < count; i++) {
			const block = blocks[i];
			if (!block) break;
			const m = this.#cursor(block.start);
			while (m.at + 8 <= block.end) {
				const type = m.u16();
				const msgSize = m.u16();
				m.bytes(4); // flags + reserved
				const at = m.at;
				if (type === 0x10) {
					const cont = this.#cursor(at);
					const where = cont.offset();
					blocks.push({ start: where, end: where + cont.length() });
				} else if (type !== 0) out.push({ type, at, size: msgSize });
				m.at = at + msgSize;
			}
		}
		return out;
	}

	/**
	 * Name → object header address of the links in the root group: every link, or only those named in `only` (a
	 * densely stored group is then searched by name hash, reading only the matching links from its heap).
	 */
	rootLinks(only?: readonly string[]): Map<string, number> {
		const links = new Map<string, number>();
		const wanted = only ? new Set(only) : null;
		for (const msg of this.#messages(this.#root)) {
			if (msg.type === 0x06) {
				const link = this.#link(this.#cursor(msg.at));
				if (link && (!wanted || wanted.has(link.name))) links.set(link.name, link.address);
			} else if (msg.type === 0x02) {
				for (const [name, address] of this.#denseLinks(msg.at, wanted)) links.set(name, address);
			} else if (msg.type === 0x11) {
				throw new Hdf5Error("old-style symbol-table groups are not supported");
			}
		}
		return links;
	}

	/** A link message; null for soft and external links. */
	#link(c: Cursor): { name: string; address: number } | null {
		const version = c.u8();
		if (version !== 1) throw new Hdf5Error(`link message version ${version}`);
		const flags = c.u8();
		const linkType = flags & 0x08 ? c.u8() : 0;
		if (flags & 0x04) c.bytes(8);
		if (flags & 0x10) c.u8();
		const nameLength = c.uint(1 << (flags & 0x03));
		const name = new TextDecoder("utf-8").decode(c.bytes(nameLength));
		if (linkType !== 0) return null;
		return { name, address: c.offset() };
	}

	#denseLinks(at: number, wanted: ReadonlySet<string> | null): [string, number][] {
		const c = this.#cursor(at);
		const version = c.u8();
		if (version !== 0) throw new Hdf5Error(`link info version ${version}`);
		const flags = c.u8();
		if (flags & 0x01) c.bytes(8);
		const heapAddress = c.offset();
		const nameIndex = c.offset();
		if (heapAddress < 0 || nameIndex < 0) return [];
		const heap = new FractalHeap(this.#src, heapAddress);
		const hashes = wanted ? new Set([...wanted].map((n) => lookup3(new TextEncoder().encode(n)))) : null;
		const out: [string, number][] = [];
		for (const record of v2BtreeRecords(this.#src, nameIndex)) {
			// Name-index records (type 5): the name's Jenkins lookup3 hash, then the heap ID of the link message.
			const hash = new DataView(record.buffer, record.byteOffset, 4).getUint32(0, true);
			if (hashes && !hashes.has(hash)) continue;
			const link = this.#link(
				new Cursor(new WholeFile(heap.object(record.subarray(4))), 0, this.#o, this.#l),
			);
			if (link && (!wanted || wanted.has(link.name))) out.push([link.name, link.address]);
		}
		return out;
	}

	#describe(name: string, address: number): { info: DatasetInfo; layout: Layout } {
		let shape: number[] | null = null;
		let type: Datatype | null = null;
		let filters: Filter[] = [];
		let layout: Layout | null = null;
		for (const msg of this.#messages(address)) {
			const c = this.#cursor(msg.at);
			if (msg.type === 0x01) shape = dataspace(c);
			else if (msg.type === 0x03) type = datatype(c);
			else if (msg.type === 0x0b) filters = pipeline(c);
			else if (msg.type === 0x08) layout = this.#layout(c);
		}
		if (!shape || !type || !layout)
			throw new Hdf5Error(`${name} is not a dataset (no dataspace, type or layout)`);
		return { info: { name, shape, type, filters, layout: layout.kind }, layout };
	}

	#layout(c: Cursor): Layout {
		const version = c.u8();
		if (version === 3) {
			const cls = c.u8();
			if (cls === 0) {
				const size = c.u16();
				return { kind: "compact", data: c.bytes(size) };
			}
			if (cls === 1) return { kind: "contiguous", address: c.offset(), size: c.length() };
			if (cls === 2) {
				const rank = c.u8();
				const address = c.offset();
				const chunk: number[] = [];
				for (let i = 0; i < rank; i++) chunk.push(c.u32());
				return { kind: "chunked-btree", address, chunk };
			}
			throw new Hdf5Error(`layout class ${cls}`);
		}
		if (version === 4) {
			const cls = c.u8();
			if (cls === 1) return { kind: "contiguous", address: c.offset(), size: c.length() };
			if (cls !== 2) throw new Hdf5Error(`layout v4 class ${cls}`);
			const flags = c.u8();
			const rank = c.u8();
			const encoded = c.u8();
			const chunk: number[] = [];
			for (let i = 0; i < rank; i++) chunk.push(c.uint(encoded));
			const index = c.u8();
			if (index !== 1)
				throw new Hdf5Error(`chunk index type ${index} (only single-chunk is supported in layout v4)`);
			const filtered = (flags & 0x02) !== 0;
			const size = filtered ? c.length() : -1;
			const mask = filtered ? c.u32() : 0;
			return { kind: "single-chunk", address: c.offset(), size, mask, chunk };
		}
		throw new Hdf5Error(`data layout version ${version}`);
	}

	/** Shape, type, filters and layout of a root-group dataset. */
	info(name: string): DatasetInfo {
		const address = this.rootLinks([name]).get(name);
		if (address === undefined) throw new Hdf5Error(`no dataset named ${name}`);
		return this.#describe(name, address).info;
	}

	/** The values of a one-dimensional numeric root-group dataset, as numbers (no scale or offset applied). */
	read1d(name: string, address = this.rootLinks([name]).get(name)): number[] {
		if (address === undefined) throw new Hdf5Error(`no dataset named ${name}`);
		const { info, layout } = this.#describe(name, address);
		if (info.shape.length !== 1) throw new Hdf5Error(`${name} has ${info.shape.length} dimensions, not 1`);
		const n = info.shape[0] ?? 0;
		const size = info.type.size;
		const out = new Array<number>(n).fill(Number.NaN);
		if (n === 0) return [];
		const decode = (bytes: Uint8Array, start: number) => {
			const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			const count = Math.min(Math.floor(bytes.length / size), n - start);
			for (let i = 0; i < count; i++) out[start + i] = element(view, i * size, info.type);
		};
		switch (layout.kind) {
			case "compact":
				decode(layout.data, 0);
				break;
			case "contiguous":
				if (layout.address < 0) break; // never written: fill value, which NaN stands for here
				decode(this.#src.read(layout.address, Math.min(layout.size, n * size)), 0);
				break;
			case "single-chunk": {
				const stored = layout.size >= 0 ? layout.size : (layout.chunk[0] ?? 0) * size;
				decode(unfilter(this.#src.read(layout.address, stored), info.filters, layout.mask, size), 0);
				break;
			}
			case "chunked-btree":
				for (const chunk of chunkIndex(this.#cursor(0), layout.address, 1)) {
					const raw = this.#src.read(chunk.address, chunk.size);
					decode(unfilter(raw, info.filters, chunk.mask, size), chunk.offsets[0] ?? 0);
				}
				break;
		}
		return out;
	}
}

// ---------------------------------------------------------------------------------------------------------
// Messages

function dataspace(c: Cursor): number[] {
	const version = c.u8();
	const rank = c.u8();
	const flags = c.u8();
	if (version === 1) c.bytes(5);
	else if (version === 2) {
		const type = c.u8();
		if (type === 2) return []; // null dataspace
	} else throw new Hdf5Error(`dataspace version ${version}`);
	const dims: number[] = [];
	for (let i = 0; i < rank; i++) dims.push(c.length());
	if (flags & 0x01) for (let i = 0; i < rank; i++) c.length();
	return dims;
}

function datatype(c: Cursor): Datatype {
	const classAndVersion = c.u8();
	const cls = classAndVersion & 0x0f;
	const bits = c.bytes(3);
	const size = c.u32();
	const b0 = bits[0] ?? 0;
	if (cls === 0) return { kind: "int", size, signed: (b0 & 0x08) !== 0, bigEndian: (b0 & 0x01) !== 0 };
	if (cls === 1) return { kind: "float", size, signed: true, bigEndian: (b0 & 0x01) !== 0 };
	throw new Hdf5Error(`datatype class ${cls} not supported`);
}

function pipeline(c: Cursor): Filter[] {
	const version = c.u8();
	const count = c.u8();
	if (version === 1) c.bytes(6);
	else if (version !== 2) throw new Hdf5Error(`filter pipeline version ${version}`);
	const out: Filter[] = [];
	for (let i = 0; i < count; i++) {
		const id = c.u16();
		const nameLength = version === 1 || id >= 256 ? c.u16() : 0;
		const flags = c.u16();
		const nValues = c.u16();
		if (nameLength > 0) c.bytes(version === 1 ? Math.ceil(nameLength / 8) * 8 : nameLength);
		const values: number[] = [];
		for (let k = 0; k < nValues; k++) values.push(c.u32());
		if (version === 1 && nValues % 2 === 1) c.bytes(4);
		out.push({ id, flags, values });
	}
	return out;
}

function element(view: DataView, at: number, t: Datatype): number {
	const le = !t.bigEndian;
	if (t.kind === "float") {
		if (t.size === 4) return view.getFloat32(at, le);
		if (t.size === 8) return view.getFloat64(at, le);
	} else {
		if (t.size === 1) return t.signed ? view.getInt8(at) : view.getUint8(at);
		if (t.size === 2) return t.signed ? view.getInt16(at, le) : view.getUint16(at, le);
		if (t.size === 4) return t.signed ? view.getInt32(at, le) : view.getUint32(at, le);
		if (t.size === 8) return Number(t.signed ? view.getBigInt64(at, le) : view.getBigUint64(at, le));
	}
	throw new Hdf5Error(`${t.kind} of ${t.size} bytes not supported`);
}

/** Undo the filter pipeline, last filter first; a set bit in `mask` means that filter was skipped. */
export function unfilter(
	bytes: Uint8Array,
	filters: readonly Filter[],
	mask: number,
	elementSize: number,
): Uint8Array {
	let data = bytes;
	for (let i = filters.length - 1; i >= 0; i--) {
		const f = filters[i];
		if (!f || mask & (1 << i)) continue;
		if (f.id === 1) data = new Uint8Array(inflateSync(data));
		else if (f.id === 2) data = unshuffle(data, f.values[0] ?? elementSize);
		else throw new Hdf5Error(`filter ${f.id} not supported`);
	}
	return data;
}

export function unshuffle(data: Uint8Array, size: number): Uint8Array {
	if (size <= 1) return data;
	const n = Math.floor(data.length / size);
	const out = new Uint8Array(data.length);
	for (let b = 0; b < size; b++) for (let i = 0; i < n; i++) out[i * size + b] = data[b * n + i] ?? 0;
	out.set(data.subarray(n * size), n * size);
	return out;
}

// ---------------------------------------------------------------------------------------------------------
// Chunk index: version 1 B-tree, node type 1

type ChunkRef = { address: number; size: number; mask: number; offsets: number[] };

function chunkIndex(c: Cursor, address: number, rank: number): ChunkRef[] {
	const out: ChunkRef[] = [];
	const visit = (node: number, depth: number) => {
		if (depth > 32) throw new Hdf5Error("chunk B-tree too deep");
		const n = new Cursor(c.src, node, c.offsetSize, c.lengthSize);
		n.signature("TREE");
		const type = n.u8();
		if (type !== 1) throw new Hdf5Error(`B-tree node type ${type} where chunks were expected`);
		const level = n.u8();
		const entries = n.u16();
		n.offset();
		n.offset();
		const keys: { size: number; mask: number; offsets: number[] }[] = [];
		const children: number[] = [];
		const key = () => {
			const size = n.u32();
			const mask = n.u32();
			const offsets: number[] = [];
			for (let i = 0; i <= rank; i++) offsets.push(n.uint(8));
			return { size, mask, offsets };
		};
		for (let i = 0; i < entries; i++) {
			keys.push(key());
			children.push(n.offset());
		}
		for (let i = 0; i < entries; i++) {
			const child = children[i] ?? -1;
			const k = keys[i];
			if (!k) continue;
			if (level === 0) out.push({ address: child, size: k.size, mask: k.mask, offsets: k.offsets });
			else visit(child, depth + 1);
		}
	};
	if (address >= 0) visit(address, 0);
	return out;
}

// ---------------------------------------------------------------------------------------------------------
// Version 2 B-tree: every record, in order

export function v2BtreeRecords(src: ByteSource, address: number): Uint8Array[] {
	const c = new Cursor(src, address, 8, 8);
	c.signature("BTHD");
	c.u8(); // version
	c.u8(); // type
	const nodeSize = c.u32();
	const recordSize = c.u16();
	const depth = c.u16();
	c.u8();
	c.u8();
	const root = c.offset();
	const rootRecords = c.u16();
	// Sizes of the child-pointer fields per depth (H5B2__hdr_init).
	const prefix = 10;
	const maxRecords: number[] = [Math.floor((nodeSize - prefix) / recordSize)];
	const cumulative: number[] = [maxRecords[0] ?? 0];
	const recordsFieldSize: number[] = [encSize(maxRecords[0] ?? 0)];
	const totalFieldSize: number[] = [encSize(cumulative[0] ?? 0)];
	for (let u = 1; u <= depth; u++) {
		const pointer = 8 + (recordsFieldSize[u - 1] ?? 1) + (u > 1 ? (totalFieldSize[u - 1] ?? 1) : 0);
		const max = Math.floor((nodeSize - prefix - pointer) / (recordSize + pointer));
		maxRecords.push(max);
		const cum = (max + 1) * (cumulative[u - 1] ?? 0) + max;
		cumulative.push(cum);
		recordsFieldSize.push(encSize(max));
		totalFieldSize.push(encSize(cum));
	}
	const out: Uint8Array[] = [];
	const visit = (node: number, records: number, level: number) => {
		const n = new Cursor(src, node, 8, 8);
		n.signature(level === 0 ? "BTLF" : "BTIN");
		n.u8();
		n.u8();
		const recs: Uint8Array[] = [];
		for (let i = 0; i < records; i++) recs.push(n.bytes(recordSize));
		if (level === 0) {
			out.push(...recs);
			return;
		}
		const children: { address: number; records: number }[] = [];
		for (let i = 0; i <= records; i++) {
			const address = n.offset();
			const count = n.uint(recordsFieldSize[level - 1] ?? 1);
			if (level > 1) n.uint(totalFieldSize[level - 1] ?? 1);
			children.push({ address, records: count });
		}
		for (let i = 0; i <= records; i++) {
			const child = children[i];
			if (child) visit(child.address, child.records, level - 1);
			const rec = recs[i];
			if (rec) out.push(rec);
		}
	};
	if (root >= 0 && rootRecords > 0) visit(root, rootRecords, depth);
	return out;
}

// ---------------------------------------------------------------------------------------------------------
// Fractal heap: managed and tiny objects

class FractalHeap {
	readonly #src: ByteSource;
	readonly idLength: number;
	readonly #width: number;
	readonly #startBlock: number;
	readonly #maxDirect: number;
	readonly #maxHeapBits: number;
	readonly #root: number;
	readonly #rootRows: number;
	readonly #filtered: boolean;
	readonly #maxManaged: number;

	constructor(src: ByteSource, address: number) {
		this.#src = src;
		const c = new Cursor(src, address, 8, 8);
		c.signature("FRHP");
		c.u8();
		this.idLength = c.u16();
		const filterLength = c.u16();
		this.#filtered = filterLength > 0;
		const flags = c.u8();
		// Bit 1 (checksummed direct blocks) does not move objects: their heap offsets count from the block start.
		void flags;
		this.#maxManaged = c.u32();
		c.length(); // next huge id
		c.offset(); // huge objects B-tree
		c.length(); // free space
		c.offset(); // free-space manager
		c.length(); // managed space
		c.length(); // allocated managed space
		c.length(); // direct block allocation iterator
		c.length(); // managed objects
		c.length(); // huge objects size
		c.length(); // huge objects
		c.length(); // tiny objects size
		c.length(); // tiny objects
		this.#width = c.u16();
		this.#startBlock = c.length();
		this.#maxDirect = c.length();
		this.#maxHeapBits = c.u16();
		c.u16(); // starting rows
		this.#root = c.offset();
		this.#rootRows = c.u16();
		if (this.#filtered) throw new Hdf5Error("filtered fractal heaps are not supported");
	}

	get #offsetBytes(): number {
		return Math.ceil(this.#maxHeapBits / 8);
	}

	/** The object a heap ID names. */
	object(id: Uint8Array): Uint8Array {
		const type = ((id[0] ?? 0) >> 4) & 0x03;
		if (type === 2) {
			const length = ((id[0] ?? 0) & 0x0f) + 1;
			return id.subarray(1, 1 + length);
		}
		if (type !== 0) throw new Hdf5Error("huge fractal-heap objects are not supported");
		const c = new Cursor(new WholeFile(id), 1, 8, 8);
		const offset = c.uint(this.#offsetBytes);
		const length = c.uint(encSize(Math.min(this.#maxDirect, this.#maxManaged)));
		const block = this.#findBlock(offset);
		return this.#src.read(block.address + (offset - block.offset), length);
	}

	#rowSize(row: number): number {
		return row < 2 ? this.#startBlock : this.#startBlock * 2 ** (row - 1);
	}

	/** Rows of direct blocks an indirect block can hold before switching to indirect children. */
	get #maxDirectRows(): number {
		return Math.log2(this.#maxDirect) - Math.log2(this.#startBlock) + 2;
	}

	#findBlock(offset: number): { address: number; offset: number } {
		if (this.#rootRows === 0) return { address: this.#root, offset: 0 };
		return this.#inIndirect(this.#root, this.#rootRows, 0, offset, 0);
	}

	#inIndirect(
		address: number,
		rows: number,
		base: number,
		offset: number,
		depth: number,
	): { address: number; offset: number } {
		if (depth > 16) throw new Hdf5Error("fractal heap too deep");
		const c = new Cursor(this.#src, address, 8, 8);
		c.signature("FHIB");
		c.u8();
		c.offset(); // heap header
		c.uint(this.#offsetBytes); // block offset
		let blockOffset = base;
		const directRows = Math.min(rows, this.#maxDirectRows);
		for (let r = 0; r < rows; r++) {
			const size = this.#rowSize(r);
			for (let k = 0; k < this.#width; k++) {
				const child = c.offset();
				if (offset >= blockOffset && offset < blockOffset + size) {
					if (child < 0) throw new Hdf5Error("heap object in an unallocated block");
					if (r < directRows) return { address: child, offset: blockOffset };
					// An indirect child of this row size holds the rows that add up to it.
					const childRows = Math.log2(size) - Math.log2(this.#startBlock) + 1;
					return this.#inIndirect(child, childRows, blockOffset, offset, depth + 1);
				}
				blockOffset += size;
			}
		}
		throw new Hdf5Error(`heap offset ${offset} outside the heap`);
	}
}
