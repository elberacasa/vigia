/**
 * The proof of work, client side: find a counter such that SHA-256(`${challenge}:${nonce}`) starts with `difficulty`
 * zero bits. Pure TypeScript with no Bun, Node or DOM imports, so the web client can import it as is (run it in a
 * Web Worker so the page stays responsive). The server checks the answer with its native SHA-256
 * (src/crowd/challenge.ts); both are tested against each other.
 *
 * The hash is a plain SHA-256 (FIPS 180-4) over ASCII, tuned for this one job: the challenge's first 64-byte blocks
 * are compressed once (the "midstate"), and each attempt only hashes the last one or two blocks. WebCrypto's
 * `digest` would be slower here: it is asynchronous, one promise per attempt.
 */

const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
	0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
	0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
	0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
	0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
	0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
	0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
	0xc67178f2,
]);

const IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

/** Compresses one 64-byte block (as 16 big-endian words in `w[0..15]`) into `h`. `w` is scratch of 64 words. */
function compress(h: Uint32Array, w: Uint32Array): void {
	for (let i = 16; i < 64; i++) {
		const a = w[i - 15] as number;
		const b = w[i - 2] as number;
		const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
		const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
		w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) | 0;
	}
	let a = h[0] as number;
	let b = h[1] as number;
	let c = h[2] as number;
	let d = h[3] as number;
	let e = h[4] as number;
	let f = h[5] as number;
	let g = h[6] as number;
	let hh = h[7] as number;
	for (let i = 0; i < 64; i++) {
		const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
		const ch = (e & f) ^ (~e & g);
		const t1 = (hh + S1 + ch + (K[i] as number) + (w[i] as number)) | 0;
		const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
		const maj = (a & b) ^ (a & c) ^ (b & c);
		const t2 = (S0 + maj) | 0;
		hh = g;
		g = f;
		f = e;
		e = (d + t1) | 0;
		d = c;
		c = b;
		b = a;
		a = (t1 + t2) | 0;
	}
	h[0] = ((h[0] as number) + a) | 0;
	h[1] = ((h[1] as number) + b) | 0;
	h[2] = ((h[2] as number) + c) | 0;
	h[3] = ((h[3] as number) + d) | 0;
	h[4] = ((h[4] as number) + e) | 0;
	h[5] = ((h[5] as number) + f) | 0;
	h[6] = ((h[6] as number) + g) | 0;
	h[7] = ((h[7] as number) + hh) | 0;
}

function asciiBytes(text: string): Uint8Array {
	const out = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c > 0x7e || c < 0x20) throw new Error("solo texto ASCII imprimible");
		out[i] = c;
	}
	return out;
}

/** Loads bytes[from..from+64) into w[0..15] as big-endian words. */
function load(w: Uint32Array, bytes: Uint8Array, from: number): void {
	for (let i = 0; i < 16; i++) {
		const j = from + i * 4;
		w[i] =
			((bytes[j] as number) << 24) |
			((bytes[j + 1] as number) << 16) |
			((bytes[j + 2] as number) << 8) |
			(bytes[j + 3] as number);
	}
}

/** SHA-256 of an ASCII string, as 8 words (tests and one-off checks; the solver uses the midstate path). */
export function sha256Words(text: string): Uint32Array {
	const msg = asciiBytes(text);
	const total = Math.ceil((msg.length + 9) / 64) * 64;
	const buf = new Uint8Array(total);
	buf.set(msg);
	buf[msg.length] = 0x80;
	const bits = msg.length * 8;
	buf[total - 4] = (bits >>> 24) & 255;
	buf[total - 3] = (bits >>> 16) & 255;
	buf[total - 2] = (bits >>> 8) & 255;
	buf[total - 1] = bits & 255;
	const h = new Uint32Array(IV);
	const w = new Uint32Array(64);
	for (let off = 0; off < total; off += 64) {
		load(w, buf, off);
		compress(h, w);
	}
	return h;
}

export function sha256Hex(text: string): string {
	return Array.from(sha256Words(text), (x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
}

/** Leading zero bits of a digest given as 32-bit words. */
export function leadingZeroBits(h: ArrayLike<number>): number {
	let n = 0;
	for (let i = 0; i < h.length; i++) {
		const x = (h[i] as number) >>> 0;
		if (x === 0) {
			n += 32;
			continue;
		}
		return n + Math.clz32(x);
	}
	return n;
}

/** Leading zero bits of a digest given as bytes (the server's native hash). */
export function leadingZeroBitsBytes(bytes: ArrayLike<number>): number {
	let n = 0;
	for (let i = 0; i < bytes.length; i++) {
		const b = (bytes[i] as number) & 255;
		if (b === 0) {
			n += 8;
			continue;
		}
		return n + Math.clz32(b) - 24;
	}
	return n;
}

/** The longest nonce the server accepts (base-36 digits). */
export const MAX_NONCE_LENGTH = 16;

export type SolveOptions = {
	/** Stop after this many attempts (null: until found). */
	readonly maxAttempts?: number;
	/** Called every `progressEvery` attempts with the count so far (a worker can post progress). */
	readonly onProgress?: (attempts: number) => void;
	readonly progressEvery?: number;
};

/**
 * Finds a nonce for `challenge` at `difficulty` bits: tries the base-36 counter 0, 1, 2… Returns the nonce and the
 * attempts it took, or null when `maxAttempts` ran out.
 */
export function solve(
	challenge: string,
	difficulty: number,
	options: SolveOptions = {},
): { nonce: string; attempts: number } | null {
	const prefix = asciiBytes(`${challenge}:`);
	const fullBlocks = Math.floor(prefix.length / 64);
	const mid = new Uint32Array(IV);
	const w = new Uint32Array(64);
	for (let b = 0; b < fullBlocks; b++) {
		load(w, prefix, b * 64);
		compress(mid, w);
	}
	const rest = prefix.subarray(fullBlocks * 64);
	// The tail: what is left of the prefix, the nonce, 0x80, zeros and the length; one or two blocks.
	const tail = new Uint8Array(128);
	tail.set(rest);
	const h = new Uint32Array(8);
	const max = options.maxAttempts ?? Number.POSITIVE_INFINITY;
	const every = options.progressEvery ?? 65_536;
	for (let n = 0; n < max; n++) {
		const nonce = n.toString(36);
		if (nonce.length > MAX_NONCE_LENGTH) return null;
		const len = rest.length + nonce.length;
		for (let i = 0; i < nonce.length; i++) tail[rest.length + i] = nonce.charCodeAt(i);
		const blocks = len + 9 > 64 ? 2 : 1;
		const end = blocks * 64;
		tail[len] = 0x80;
		tail.fill(0, len + 1, end);
		const bits = (prefix.length + nonce.length) * 8;
		tail[end - 4] = (bits >>> 24) & 255;
		tail[end - 3] = (bits >>> 16) & 255;
		tail[end - 2] = (bits >>> 8) & 255;
		tail[end - 1] = bits & 255;
		h.set(mid);
		load(w, tail, 0);
		compress(h, w);
		if (blocks === 2) {
			load(w, tail, 64);
			compress(h, w);
		}
		if (leadingZeroBits(h) >= difficulty) return { nonce, attempts: n + 1 };
		if (options.onProgress && (n + 1) % every === 0) options.onProgress(n + 1);
	}
	return null;
}
