import { createHash, randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * Binary artefacts (satellite frames, night-lights mosaics) that adapters produce and the server serves from
 * its own origin, so the browser never contacts a third party (CSP `img-src 'self'`).
 *
 * Layout: `<root>/<source>/<key>.<ext>` plus `<root>/<source>/<key>.json` (metadata). A key is
 * `<name>-<hash>` (see `blobKey`): the adapter names the thing (a scan time, a date) and hashes whatever
 * determines the bytes (the source bytes and its pipeline version), so an adapter's pure `normalise` can
 * compute the same key from the raw response, and a URL always means the same bytes (served as immutable).
 * Writes are atomic (temp file in the same directory, then rename; the metadata is renamed last, so metadata
 * present means bytes present). Each source has its own retention: newest `observedAt` first, capped by
 * entries, bytes and age.
 */

export type BlobContentType = "image/jpeg" | "image/png" | "image/webp";

const EXTENSION: Record<BlobContentType, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
};

/** Source ids and blob names/keys: letters, digits, dash, underscore. No dots, no slashes: no traversal. */
export const BLOB_SOURCE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const BLOB_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
export const BLOB_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface BlobPolicy {
	/** Keep at most this many blobs (newest observedAt first). */
	readonly maxEntries: number;
	/** And at most this many bytes in total. */
	readonly maxBytes: number;
	/** And none older than this (by observedAt), or null for no age limit. */
	readonly maxAgeMs: number | null;
}

const Meta = z.object({
	source: z.string().regex(BLOB_SOURCE),
	key: z.string().regex(BLOB_KEY),
	name: z.string().regex(BLOB_NAME),
	contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
	bytes: z.number().int().nonnegative(),
	sha256: z.string().regex(/^[0-9a-f]{64}$/),
	observedAt: z.number(),
	createdAt: z.number(),
	width: z.number().int().positive().optional(),
	height: z.number().int().positive().optional(),
});

export type BlobMeta = z.infer<typeof Meta>;

export interface BlobInput {
	/** The thing this blob shows (a scan time, a date); the key is `<name>-<hash>`. */
	readonly name: string;
	readonly contentType: BlobContentType;
	/** When the source says the image is true (scan time, night of the composite). */
	readonly observedAt: number;
	readonly width?: number;
	readonly height?: number;
}

/** What an adapter sees: its own directory only, with its own retention policy. */
export interface BlobSink {
	/**
	 * Stores the bytes under `key` (from `blobKey(input.name, …)`), removes an older blob with the same name,
	 * applies retention. Storing an existing key is a no-op: a key's bytes never change.
	 */
	put(key: string, data: Uint8Array, input: BlobInput): BlobMeta;
	has(key: string): boolean;
	/** The stored blob for this name, if any. */
	find(name: string): BlobMeta | null;
	/** Every stored blob, newest observedAt first. */
	list(): BlobMeta[];
}

/** What the server needs to serve a blob. */
export interface BlobReader {
	read(source: string, key: string): { readonly meta: BlobMeta; readonly path: string } | null;
}

/** `<name>-<first 16 hex of sha256(parts)>`. Parts: whatever determines the bytes (source bytes, version). */
export function blobKey(name: string, ...parts: readonly (string | Uint8Array)[]): string {
	if (!BLOB_NAME.test(name)) throw new Error(`invalid blob name ${name}`);
	const hash = createHash("sha256");
	for (const part of parts) hash.update(part).update("\u0000");
	return `${name}-${hash.digest("hex").slice(0, 16)}`;
}

function sha256(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

export class BlobStore implements BlobReader {
	constructor(
		readonly root: string,
		readonly now: () => number = Date.now,
	) {}

	scope(source: string, policy: BlobPolicy): BlobSink {
		if (!BLOB_SOURCE.test(source)) throw new Error(`invalid blob source ${source}`);
		const dir = join(this.root, source);
		return {
			put: (key, data, input) => this.#put(dir, source, key, data, input, policy),
			has: (key) => BLOB_KEY.test(key) && readMeta(join(dir, `${key}.json`)) !== null,
			find: (name) => this.#list(dir).find((m) => m.name === name) ?? null,
			list: () => this.#list(dir),
		};
	}

	read(source: string, key: string): { meta: BlobMeta; path: string } | null {
		if (!BLOB_SOURCE.test(source) || !BLOB_KEY.test(key)) return null;
		const dir = join(this.root, source);
		const meta = readMeta(join(dir, `${key}.json`));
		if (!meta || meta.source !== source || meta.key !== key) return null;
		const path = join(dir, `${key}.${EXTENSION[meta.contentType]}`);
		return existsSync(path) ? { meta, path } : null;
	}

	#put(
		dir: string,
		source: string,
		key: string,
		data: Uint8Array,
		input: BlobInput,
		policy: BlobPolicy,
	): BlobMeta {
		const name = input.name;
		if (!BLOB_NAME.test(name)) throw new Error(`invalid blob name ${name}`);
		if (!BLOB_KEY.test(key) || !key.startsWith(`${name}-`)) throw new Error(`invalid blob key ${key}`);
		if (data.byteLength === 0) throw new Error("empty blob");
		mkdirSync(dir, { recursive: true });
		const meta: BlobMeta = {
			source,
			key,
			name,
			contentType: input.contentType,
			bytes: data.byteLength,
			sha256: sha256(data),
			observedAt: input.observedAt,
			createdAt: this.now(),
			...(input.width === undefined ? {} : { width: input.width }),
			...(input.height === undefined ? {} : { height: input.height }),
		};
		const existing = this.#list(dir);
		if (!existing.some((m) => m.key === key)) {
			atomicWrite(join(dir, `${key}.${EXTENSION[input.contentType]}`), data);
			atomicWrite(join(dir, `${key}.json`), new TextEncoder().encode(JSON.stringify(meta)));
		}
		// Same name, different bytes (reprocessed): the old one goes.
		for (const old of existing) if (old.name === name && old.key !== key) remove(dir, old);
		this.#evict(dir, policy);
		return this.#list(dir).find((m) => m.key === key) ?? meta;
	}

	#evict(dir: string, policy: BlobPolicy): void {
		const now = this.now();
		let bytes = 0;
		let count = 0;
		// Once a cap is reached everything older goes too: retention never leaves holes in a sequence.
		let full = false;
		for (const meta of this.#list(dir)) {
			const tooOld = policy.maxAgeMs !== null && now - meta.observedAt > policy.maxAgeMs;
			full ||= count + 1 > policy.maxEntries || bytes + meta.bytes > policy.maxBytes;
			if (tooOld || full) {
				remove(dir, meta);
				continue;
			}
			count++;
			bytes += meta.bytes;
		}
		sweepOrphans(dir, now);
	}

	#list(dir: string): BlobMeta[] {
		if (!existsSync(dir)) return [];
		const out: BlobMeta[] = [];
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".json")) continue;
			const meta = readMeta(join(dir, file));
			if (meta) out.push(meta);
		}
		return out.sort((a, b) => b.observedAt - a.observedAt || b.createdAt - a.createdAt);
	}
}

function readMeta(path: string): BlobMeta | null {
	try {
		const parsed = Meta.safeParse(JSON.parse(readFileSync(path, "utf8")));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

function atomicWrite(path: string, data: Uint8Array): void {
	const temp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
	writeFileSync(temp, data);
	renameSync(temp, path);
}

function remove(dir: string, meta: BlobMeta): void {
	try {
		// Metadata first: a reader never sees metadata without its bytes.
		rmSync(join(dir, `${meta.key}.json`), { force: true });
		rmSync(join(dir, `${meta.key}.${EXTENSION[meta.contentType]}`), { force: true });
	} catch {
		// Windows: a file held open (antivirus, a reader) cannot be removed now; the next sweep retries.
	}
}

/** Temp files and metadata-less bytes left by a crash mid-write, once they are an hour old. */
function sweepOrphans(dir: string, now: number): void {
	const files = new Set(readdirSync(dir));
	for (const file of files) {
		const dot = file.indexOf(".");
		const orphan = !file.endsWith(".json") && dot > 0 && !files.has(`${file.slice(0, dot)}.json`);
		if (!file.includes(".tmp-") && !orphan) continue;
		const path = join(dir, file);
		try {
			if (now - statSync(path).mtimeMs > 3_600_000) rmSync(path, { force: true });
		} catch {
			// raced with another sweep
		}
	}
}
