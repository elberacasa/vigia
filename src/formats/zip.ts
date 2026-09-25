import { inflateRawSync } from "node:zlib";

/**
 * A minimal ZIP reader (enough for .xlsx): reads the central directory, then inflates only the entries asked
 * for. Pure JS on top of `node:zlib`, so it runs on every OS and inside `bun build --compile`. Stored (0) and
 * deflate (8) entries only; ZIP64, encryption and multi-disk archives are rejected with a clear error.
 */

export class ZipError extends Error {
	override readonly name = "ZipError";
}

interface Entry {
	readonly method: number;
	readonly compressedSize: number;
	readonly size: number;
	readonly localOffset: number;
	readonly flags: number;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

export class ZipReader {
	readonly #bytes: Uint8Array;
	readonly #view: DataView;
	readonly #entries = new Map<string, Entry>();
	readonly #maxEntryBytes: number;

	/** `maxEntryBytes` caps any one inflated entry (zip-bomb guard). */
	constructor(bytes: Uint8Array, maxEntryBytes = 64 * 1024 * 1024) {
		this.#bytes = bytes;
		this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		this.#maxEntryBytes = maxEntryBytes;
		this.#readDirectory();
	}

	names(): string[] {
		return [...this.#entries.keys()];
	}

	has(name: string): boolean {
		return this.#entries.has(name);
	}

	read(name: string): Uint8Array {
		const entry = this.#entries.get(name);
		if (!entry) throw new ZipError(`entry not found: ${name}`);
		if (entry.flags & 0x1) throw new ZipError(`entry is encrypted: ${name}`);
		if (entry.size > this.#maxEntryBytes)
			throw new ZipError(`entry too large: ${name} (${entry.size} bytes)`);
		const at = entry.localOffset;
		if (at + 30 > this.#bytes.length || this.#view.getUint32(at, true) !== LOC_SIG) {
			throw new ZipError(`bad local header for ${name}`);
		}
		const nameLen = this.#view.getUint16(at + 26, true);
		const extraLen = this.#view.getUint16(at + 28, true);
		const start = at + 30 + nameLen + extraLen;
		const end = start + entry.compressedSize;
		if (end > this.#bytes.length) throw new ZipError(`truncated entry ${name}`);
		const data = this.#bytes.subarray(start, end);
		let out: Uint8Array;
		if (entry.method === 0) out = data;
		else if (entry.method === 8) {
			out = inflateRawSync(data, { maxOutputLength: this.#maxEntryBytes });
		} else throw new ZipError(`unsupported compression method ${entry.method} for ${name}`);
		if (out.length !== entry.size) throw new ZipError(`size mismatch for ${name}`);
		return out;
	}

	readText(name: string): string {
		return new TextDecoder("utf-8").decode(this.read(name));
	}

	#readDirectory(): void {
		const b = this.#bytes;
		const v = this.#view;
		// The end-of-central-directory record is in the last 22 + 65535 bytes (the comment is at most 64 KiB).
		let eocd = -1;
		for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
			if (v.getUint32(i, true) === EOCD_SIG) {
				eocd = i;
				break;
			}
		}
		if (eocd < 0) throw new ZipError("not a zip file (no end of central directory)");
		const count = v.getUint16(eocd + 10, true);
		const cdSize = v.getUint32(eocd + 12, true);
		const cdOffset = v.getUint32(eocd + 16, true);
		if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError("ZIP64 archives are not supported");
		if (cdOffset + cdSize > b.length) throw new ZipError("central directory out of range");
		const decoder = new TextDecoder("utf-8");
		let p = cdOffset;
		for (let i = 0; i < count; i++) {
			if (p + 46 > b.length || v.getUint32(p, true) !== CEN_SIG) throw new ZipError("bad central directory");
			const flags = v.getUint16(p + 8, true);
			const method = v.getUint16(p + 10, true);
			const compressedSize = v.getUint32(p + 20, true);
			const size = v.getUint32(p + 24, true);
			const nameLen = v.getUint16(p + 28, true);
			const extraLen = v.getUint16(p + 30, true);
			const commentLen = v.getUint16(p + 32, true);
			const localOffset = v.getUint32(p + 42, true);
			const name = decoder.decode(b.subarray(p + 46, p + 46 + nameLen));
			this.#entries.set(name, { method, compressedSize, size, localOffset, flags });
			p += 46 + nameLen + extraLen + commentLen;
		}
	}
}
