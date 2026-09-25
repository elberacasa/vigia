/**
 * The bundled local news classifier: linear heads over hashed features (features.ts), distilled from Jev's
 * probabilities. Inference is a sparse dot product per head, microseconds per item, on any CPU, offline.
 *
 * Binary format (little endian): magic "VGM1", u32 heads-count, then per head: u8 kind (0 sigmoid, 1 softmax),
 * u16 name length + name, u16 class count, classes (u16 length + utf8 each), f32 scale; then u32 row count, then
 * rows: u32 bucket + int8 × total-output-count (weights ÷ their head's scale).
 */
import { type FeatureInput, features } from "./features.ts";

export interface HeadSpec {
	readonly name: string;
	readonly kind: "sigmoid" | "softmax";
	/** Softmax: class names. Sigmoid: a single "yes". */
	readonly classes: readonly string[];
}

export interface Prediction {
	/** Sigmoid heads: probability of yes. */
	readonly yes: Readonly<Record<string, number>>;
	/** Softmax heads: class probabilities. */
	readonly dist: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export class LinearModel {
	readonly width: number;
	readonly offsets: number[];

	constructor(
		readonly heads: readonly HeadSpec[],
		/** bucket → weights for all outputs (width = sum of head class counts). */
		readonly rows: Map<number, Float32Array>,
	) {
		this.offsets = [];
		let w = 0;
		for (const h of heads) {
			this.offsets.push(w);
			w += h.classes.length;
		}
		this.width = w;
	}

	logits(x: ReadonlyMap<number, number>): Float32Array {
		const z = new Float32Array(this.width);
		for (const [bucket, v] of x) {
			const row = this.rows.get(bucket);
			if (!row) continue;
			for (let j = 0; j < this.width; j++) z[j] = (z[j] ?? 0) + (row[j] ?? 0) * v;
		}
		return z;
	}

	predict(item: FeatureInput): Prediction {
		return this.fromLogits(this.logits(features(item)));
	}

	fromLogits(z: Float32Array): Prediction {
		const yes: Record<string, number> = {};
		const dist: Record<string, Record<string, number>> = {};
		this.heads.forEach((h, i) => {
			const o = this.offsets[i] ?? 0;
			if (h.kind === "sigmoid") yes[h.name] = 1 / (1 + Math.exp(-(z[o] ?? 0)));
			else {
				let max = Number.NEGATIVE_INFINITY;
				for (let k = 0; k < h.classes.length; k++) max = Math.max(max, z[o + k] ?? 0);
				let sum = 0;
				const e = h.classes.map((_, k) => {
					const v = Math.exp((z[o + k] ?? 0) - max);
					sum += v;
					return v;
				});
				dist[h.name] = Object.fromEntries(h.classes.map((c, k) => [c, (e[k] ?? 0) / sum]));
			}
		});
		return { yes, dist };
	}

	serialize(minAbs = 0.02): Uint8Array<ArrayBuffer> {
		// Per-head scale so int8 keeps each head's range.
		const scales = this.heads.map((_, i) => {
			const o = this.offsets[i] ?? 0;
			const n = this.heads[i]?.classes.length ?? 0;
			let max = 1e-9;
			for (const row of this.rows.values())
				for (let k = 0; k < n; k++) max = Math.max(max, Math.abs(row[o + k] ?? 0));
			return max / 127;
		});
		const kept = [...this.rows.entries()].filter(([, row]) => row.some((v) => Math.abs(v) >= minAbs));
		const enc = new TextEncoder();
		const parts: number[] = [];
		const u8 = (v: number) => parts.push(v & 0xff);
		const u16 = (v: number) => {
			u8(v);
			u8(v >> 8);
		};
		const u32 = (v: number) => {
			u16(v & 0xffff);
			u16(v >>> 16);
		};
		const str = (s: string) => {
			const b = enc.encode(s);
			u16(b.length);
			for (const x of b) u8(x);
		};
		for (const c of "VGM1") u8(c.charCodeAt(0));
		u32(this.heads.length);
		const f32 = new Float32Array(1);
		const f32b = new Uint8Array(f32.buffer);
		this.heads.forEach((h, i) => {
			u8(h.kind === "sigmoid" ? 0 : 1);
			str(h.name);
			u16(h.classes.length);
			for (const c of h.classes) str(c);
			f32[0] = scales[i] ?? 1;
			for (const b of f32b) u8(b);
		});
		u32(kept.length);
		const out = new Uint8Array(parts.length + kept.length * (4 + this.width));
		out.set(parts);
		let p = parts.length;
		const view = new DataView(out.buffer);
		for (const [bucket, row] of kept) {
			view.setUint32(p, bucket, true);
			p += 4;
			this.heads.forEach((h, i) => {
				const o = this.offsets[i] ?? 0;
				const s = scales[i] ?? 1;
				for (let k = 0; k < h.classes.length; k++) {
					view.setInt8(p++, Math.max(-127, Math.min(127, Math.round((row[o + k] ?? 0) / s))));
				}
			});
		}
		return out;
	}

	static deserialize(bytes: Uint8Array): LinearModel {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const dec = new TextDecoder();
		let p = 0;
		const magic = dec.decode(bytes.subarray(0, 4));
		if (magic !== "VGM1") throw new Error("modelo local no válido");
		p = 4;
		const u16 = () => {
			const v = view.getUint16(p, true);
			p += 2;
			return v;
		};
		const u32 = () => {
			const v = view.getUint32(p, true);
			p += 4;
			return v;
		};
		const str = () => {
			const n = u16();
			const s = dec.decode(bytes.subarray(p, p + n));
			p += n;
			return s;
		};
		const heads: HeadSpec[] = [];
		const scales: number[] = [];
		const nh = u32();
		for (let i = 0; i < nh; i++) {
			const kind = view.getUint8(p++) === 0 ? "sigmoid" : "softmax";
			const name = str();
			const nc = u16();
			const classes: string[] = [];
			for (let k = 0; k < nc; k++) classes.push(str());
			scales.push(view.getFloat32(p, true));
			p += 4;
			heads.push({ name, kind, classes });
		}
		const width = heads.reduce((s, h) => s + h.classes.length, 0);
		const rows = new Map<number, Float32Array>();
		const nr = u32();
		for (let r = 0; r < nr; r++) {
			const bucket = u32();
			const row = new Float32Array(width);
			let j = 0;
			heads.forEach((h, i) => {
				for (let k = 0; k < h.classes.length; k++) row[j++] = view.getInt8(p++) * (scales[i] ?? 1);
			});
			rows.set(bucket, row);
		}
		return new LinearModel(heads, rows);
	}
}
