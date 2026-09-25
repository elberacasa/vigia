/**
 * A tamper-evident archive: each UTC day of received observations is sealed into a digest chained to the day
 * before, so changing, adding or deleting any stored row of a sealed day changes that day's digest and every
 * digest after it.
 *
 * - Row hash (format 2): SHA-256 of the canonical JSON (sorted keys) of every stored field but the database id,
 *   with the value replaced by `valueHash` = SHA-256 of the value's canonical JSON. So a row whose value may not be
 *   handed out (a display-only licence) can still be checked field by field: its source, series, times, link,
 *   licence and place are all bound by the hash. Format 1 (the first sealed days) hashed the value itself.
 * - Day root: a Merkle tree over the day's row hashes in sorted order (leaf = SHA-256(0x00 ‖ row hash), node =
 *   SHA-256(0x01 ‖ left ‖ right), an odd node is carried up unchanged). A Merkle tree lets an evidence bundle
 *   prove that one observation belongs to a sealed day without shipping the whole day.
 * - Digest: SHA-256 of "{format}\n{previous digest}\n{day}\n{rows}\n{root}"; the first day's previous digest is 64
 *   zeros. The format is part of the digest, so a day's hashing rule cannot be swapped after sealing.
 * - A day is the UTC calendar day of `fetched_at` (when Vigía received the row), which only grows while the day is
 *   open; a day is sealed once it has been closed for an hour.
 * - The row hashes of each sealed day are kept (`chain_leaves`), so bundles prove rows without re-hashing the day,
 *   and a retention period can delete old rows without breaking the chain: each deleted row of a sealed day leaves
 *   its hash in `chain_pruned`, and `verifyChain` accounts for it.
 *
 * This proves the archive has not changed since a digest was seen. It cannot prove the digests themselves were
 * not rebuilt; for that, copy the chain head (/api/archive/digests) somewhere else, or keep an evidence bundle.
 */

import type { Store } from "../core/store.ts";
import { canonicalJson } from "../core/store.ts";
import type { Basis, Json, Observation } from "../core/types.ts";

/** The format new days are sealed with. */
export const CHAIN_FORMAT = "vigia-chain/2";
/** The first format: the row hash covered the value itself (days sealed before 25 Sept 2026 keep it). */
export const CHAIN_FORMAT_V1 = "vigia-chain/1";
export const CHAIN_FORMATS: readonly string[] = [CHAIN_FORMAT_V1, CHAIN_FORMAT];
export const GENESIS = "0".repeat(64);
const DAY = 86_400_000;
/** A day is sealed this long after it closes (a fetch in flight at midnight still lands in its day). */
export const SEAL_AFTER_MS = 3_600_000;
/** Rows received before this are not part of any sealed day (Vigía did not exist; a bogus time). */
const EARLIEST = Date.UTC(2026, 0, 1);
/** Rows read and hashed per step while sealing or pruning; the async driver yields between steps. */
const CHUNK = 4_000;

export type ChainEntry = {
	/** UTC day, "YYYY-MM-DD". */
	day: string;
	rows: number;
	root: string;
	prev: string;
	digest: string;
	sealedAt: number;
	/** How the day's rows were hashed (CHAIN_FORMAT or CHAIN_FORMAT_V1). */
	format: string;
};

/** The stored fields of an observation row, as hashed (and as shipped in evidence bundles). */
export type ArchivedRow = {
	source: string;
	series: string;
	observedAt: number;
	fetchedAt: number;
	sourceUrl: string;
	licence: string;
	confidence: number;
	basis: string;
	value: Json;
	lat: number | null;
	lon: number | null;
	state: string | null;
	place: string | null;
};

/** What a format-2 row hash covers: every field, the value by its hash. */
export type LeafFields = Omit<ArchivedRow, "value"> & { valueHash: string };

export interface RawRow {
	source: string;
	series: string;
	observed_at: number;
	fetched_at: number;
	value: string;
	source_url: string;
	licence: string;
	confidence: number;
	basis: string;
	lat: number | null;
	lon: number | null;
	state: string | null;
	place: string | null;
}

export const ROW_COLUMNS =
	"source, series, observed_at, fetched_at, value, source_url, licence, confidence, basis, lat, lon, state, place";

export function toArchived(r: RawRow): ArchivedRow {
	return {
		source: r.source,
		series: r.series,
		observedAt: r.observed_at,
		fetchedAt: r.fetched_at,
		sourceUrl: r.source_url,
		licence: r.licence,
		confidence: r.confidence,
		basis: r.basis,
		value: JSON.parse(r.value) as Json,
		lat: r.lat,
		lon: r.lon,
		state: r.state,
		place: r.place,
	};
}

export function sha256(data: string | Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

export function valueHash(value: Json): string {
	return sha256(canonicalJson(value));
}

export function leafFields(row: ArchivedRow): LeafFields {
	const { value, ...rest } = row;
	return { ...rest, valueHash: valueHash(value) };
}

/** Format 2: every field bound, the value by its hash (computable without the value). */
export function fieldsHash(fields: LeafFields): string {
	const f: LeafFields = {
		source: fields.source,
		series: fields.series,
		observedAt: fields.observedAt,
		fetchedAt: fields.fetchedAt,
		sourceUrl: fields.sourceUrl,
		licence: fields.licence,
		confidence: fields.confidence,
		basis: fields.basis,
		valueHash: fields.valueHash,
		lat: fields.lat,
		lon: fields.lon,
		state: fields.state,
		place: fields.place,
	};
	return sha256(canonicalJson(f as unknown as Json));
}

/** The row's hash under a day's format (format 2 unless told otherwise). */
export function rowHash(row: ArchivedRow, format: string = CHAIN_FORMAT): string {
	if (format === CHAIN_FORMAT_V1) {
		const r: ArchivedRow = {
			source: row.source,
			series: row.series,
			observedAt: row.observedAt,
			fetchedAt: row.fetchedAt,
			sourceUrl: row.sourceUrl,
			licence: row.licence,
			confidence: row.confidence,
			basis: row.basis,
			value: row.value,
			lat: row.lat,
			lon: row.lon,
			state: row.state,
			place: row.place,
		};
		return sha256(canonicalJson(r as unknown as Json));
	}
	return fieldsHash(leafFields(row));
}

const LEAF = new Uint8Array([0]);
const NODE = new Uint8Array([1]);
const bytes = (hex: string) => Buffer.from(hex, "hex");

function leaf(hash: string): string {
	return new Bun.CryptoHasher("sha256").update(LEAF).update(bytes(hash)).digest("hex");
}

function node(left: string, right: string): string {
	return new Bun.CryptoHasher("sha256").update(NODE).update(bytes(left)).update(bytes(right)).digest("hex");
}

/** Every level of the Merkle tree over row hashes (sorted; duplicates are identical rows and count once). */
export type MerkleTree = { sorted: string[]; index: Map<string, number>; levels: string[][] };

export function merkleTree(hashes: readonly string[]): MerkleTree {
	return run(treeWork(hashes));
}

/** Builds the tree a chunk of hashes at a time (a generator, like the sealing work it is part of). */
function* treeWork(hashes: readonly string[]): Generator<void, MerkleTree> {
	const sorted = [...new Set(hashes)].sort();
	const first: string[] = [];
	for (let i = 0; i < sorted.length; i++) {
		first.push(leaf(sorted[i] as string));
		if (i % CHUNK === CHUNK - 1) yield;
	}
	const levels: string[][] = [first];
	for (let level = first; level.length > 1; ) {
		const next: string[] = [];
		for (let i = 0; i < level.length; i += 2) {
			const l = level[i] as string;
			const r = level[i + 1];
			next.push(r === undefined ? l : node(l, r));
			if (i % (2 * CHUNK) === 2 * CHUNK - 2) yield;
		}
		levels.push(next);
		level = next;
	}
	yield;
	return { sorted, index: new Map(sorted.map((h, i) => [h, i])), levels };
}

export function treeRoot(tree: MerkleTree): string {
	return tree.levels.at(-1)?.[0] ?? sha256("");
}

export function merkleRoot(hashes: readonly string[]): string {
	return treeRoot(merkleTree(hashes));
}

export type ProofStep = { side: "L" | "R"; hash: string };

/** The sibling path from one row hash to the root; null when the hash is not in the tree. */
export function proofIn(tree: MerkleTree, target: string): ProofStep[] | null {
	let index = tree.index.get(target);
	if (index === undefined) return null;
	const proof: ProofStep[] = [];
	for (const level of tree.levels.slice(0, -1)) {
		const sibling = index % 2 === 0 ? index + 1 : index - 1;
		const hash = level[sibling];
		if (hash !== undefined) proof.push({ side: index % 2 === 0 ? "R" : "L", hash });
		index = Math.floor(index / 2);
	}
	return proof;
}

export function merkleProof(hashes: readonly string[], target: string): ProofStep[] | null {
	return proofIn(merkleTree(hashes), target);
}

/** Folds a proof from a row hash up to the root it implies. */
export function rootFromProof(hash: string, proof: readonly ProofStep[]): string {
	let acc = leaf(hash);
	for (const step of proof) acc = step.side === "R" ? node(acc, step.hash) : node(step.hash, acc);
	return acc;
}

export function chainDigest(
	prev: string,
	day: string,
	rows: number,
	root: string,
	format: string = CHAIN_FORMAT,
): string {
	return sha256(`${format}\n${prev}\n${day}\n${rows}\n${root}`);
}

export function utcDay(t: number): string {
	return new Date(t).toISOString().slice(0, 10);
}

const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** Row hash straight from a stored row. Values are stored as canonical JSON, so format 2 hashes the text as is. */
function rawHash(r: RawRow, format: string): string {
	if (format === CHAIN_FORMAT_V1) return rowHash(toArchived(r), format);
	return fieldsHash({
		source: r.source,
		series: r.series,
		observedAt: r.observed_at,
		fetchedAt: r.fetched_at,
		sourceUrl: r.source_url,
		licence: r.licence,
		confidence: r.confidence,
		basis: r.basis,
		valueHash: sha256(r.value),
		lat: r.lat,
		lon: r.lon,
		state: r.state,
		place: r.place,
	});
}

/** Every row received on a UTC day, as hashed. */
export function dayRows(store: Store, day: string): ArchivedRow[] {
	const from = dayStart(day);
	return store.db
		.query<RawRow, [number, number]>(
			`SELECT ${ROW_COLUMNS} FROM obs WHERE fetched_at >= ? AND fetched_at < ?`,
		)
		.all(from, from + DAY)
		.map(toArchived);
}

/** Hashes a day's stored rows a chunk at a time (a generator: the async driver yields between chunks). */
function* hashDay(store: Store, day: string, format: string): Generator<void, string[]> {
	const from = dayStart(day);
	// Keyset paging on (fetched_at, id): each chunk starts where the last ended, through the fetched_at index.
	const q = store.db.query<RawRow & { id: number }, [number, number, number, number, number]>(
		`SELECT id, ${ROW_COLUMNS} FROM obs
		 WHERE fetched_at >= ?1 AND fetched_at < ?2 AND (fetched_at > ?3 OR id > ?4)
		 ORDER BY fetched_at, id LIMIT ?5`,
	);
	const out: string[] = [];
	let at = from;
	let id = -1;
	for (;;) {
		const rows = q.all(at, from + DAY, at, id, CHUNK);
		for (const r of rows) out.push(rawHash(r, format));
		const last = rows.at(-1);
		if (!last || rows.length < CHUNK) return out;
		at = last.fetched_at;
		id = last.id;
		yield;
	}
}

export function dayHashes(store: Store, day: string, format: string = CHAIN_FORMAT): string[] {
	return run(hashDay(store, day, format));
}

const ready = new WeakSet<Store>();

function ensureTable(store: Store): void {
	if (ready.has(store)) return;
	ready.add(store);
	store.db.run(`CREATE TABLE IF NOT EXISTS chain (
		day TEXT PRIMARY KEY,
		rows INTEGER NOT NULL,
		root TEXT NOT NULL,
		prev TEXT NOT NULL,
		digest TEXT NOT NULL,
		sealed_at INTEGER NOT NULL
	)`);
	const columns = store.db.query<{ name: string }, []>("PRAGMA table_info(chain)").all();
	// Days sealed before format 2 keep format 1 and have no stored leaves until they are backfilled.
	if (!columns.some((c) => c.name === "format"))
		store.db.run(`ALTER TABLE chain ADD COLUMN format TEXT NOT NULL DEFAULT '${CHAIN_FORMAT_V1}'`);
	// 1: the day's row hashes are in chain_leaves; 0: not yet; 2: the rows had changed before they could be kept.
	if (!columns.some((c) => c.name === "leaves"))
		store.db.run("ALTER TABLE chain ADD COLUMN leaves INTEGER NOT NULL DEFAULT 0");
	// A sealed day's row hashes, sorted, concatenated (32 bytes each): one row per day, written at once.
	store.db.run("CREATE TABLE IF NOT EXISTS chain_leaves (day TEXT PRIMARY KEY, hashes BLOB NOT NULL)");
	store.db.run(`CREATE TABLE IF NOT EXISTS chain_pruned (
		day TEXT NOT NULL, hash BLOB NOT NULL, pruned_at INTEGER NOT NULL, PRIMARY KEY (day, hash)
	) WITHOUT ROWID`);
	// Days are read by receive time; without this each seal would scan the whole archive.
	store.db.run("CREATE INDEX IF NOT EXISTS obs_fetched ON obs (fetched_at)");
}

interface ChainRow {
	day: string;
	rows: number;
	root: string;
	prev: string;
	digest: string;
	sealed_at: number;
	format: string;
	leaves: number;
}

const fromChainRow = (r: ChainRow): ChainEntry => ({
	day: r.day,
	rows: r.rows,
	root: r.root,
	prev: r.prev,
	digest: r.digest,
	sealedAt: r.sealed_at,
	format: r.format,
});

export function chain(store: Store, from = "0000-00-00", to = "9999-99-99"): ChainEntry[] {
	ensureTable(store);
	return store.db
		.query<ChainRow, [string, string]>("SELECT * FROM chain WHERE day >= ? AND day <= ? ORDER BY day")
		.all(from, to)
		.map(fromChainRow);
}

export function chainEntry(store: Store, day: string): ChainEntry | null {
	ensureTable(store);
	const row = store.db.query<ChainRow, [string]>("SELECT * FROM chain WHERE day = ?").get(day);
	return row ? fromChainRow(row) : null;
}

/** The kept row hashes of a sealed day, or null when the day has none kept (an old day whose rows had changed). */
export function sealedLeaves(store: Store, day: string): string[] | null {
	ensureTable(store);
	const kept = store.db
		.query<{ leaves: number }, [string]>("SELECT leaves FROM chain WHERE day = ?")
		.get(day);
	if (kept?.leaves !== 1) return null;
	const row = store.db
		.query<{ hashes: Uint8Array }, [string]>("SELECT hashes FROM chain_leaves WHERE day = ?")
		.get(day);
	if (!row) return null;
	const hex = Buffer.from(row.hashes).toString("hex");
	const out: string[] = [];
	for (let i = 0; i < hex.length; i += 64) out.push(hex.slice(i, i + 64));
	return out;
}

function prunedHashes(store: Store, day: string): Set<string> {
	return new Set(
		store.db
			.query<{ hash: Uint8Array }, [string]>("SELECT hash FROM chain_pruned WHERE day = ?")
			.all(day)
			.map((r) => Buffer.from(r.hash).toString("hex")),
	);
}

/** Stores a day's sorted row hashes as one blob (the chain entry, written with it, is what makes them count). */
function keepLeaves(store: Store, day: string, sorted: readonly string[]): void {
	store.db.run("INSERT OR REPLACE INTO chain_leaves (day, hashes) VALUES (?, ?)", [
		day,
		bytes(sorted.join("")),
	]);
}

/** Runs a sealing or pruning generator to the end, synchronously (tests, the CLI). */
export function run<T>(work: Generator<void, T>): T {
	for (;;) {
		const step = work.next();
		if (step.done) return step.value;
	}
}

/**
 * Runs a generator off the request path: steps until `sliceMs` has passed, then yields to the event loop (so
 * requests, the stream and the scheduler keep running), until it is done.
 */
export async function runSliced<T>(work: Generator<void, T>, sliceMs = 15, signal?: AbortSignal): Promise<T> {
	for (;;) {
		// Stopping between steps is safe: each day is sealed (and each chunk pruned) in one transaction.
		signal?.throwIfAborted();
		const until = performance.now() + sliceMs;
		for (;;) {
			const step = work.next();
			if (step.done) return step.value;
			if (performance.now() >= until) break;
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

/**
 * Seals every closed day after the last sealed one that has rows, in order, keeping each day's row hashes, and
 * backfills the kept hashes of days sealed before they were kept. Returns the new entries. Days received before
 * the first seal are sealed too (the chain starts at the archive's first day).
 */
export function* sealWork(store: Store, now: number): Generator<void, ChainEntry[]> {
	ensureTable(store);
	// Days sealed before row hashes were kept: keep them now if the rows still match the seal.
	for (const old of store.db.query<ChainRow, []>("SELECT * FROM chain WHERE leaves = 0 ORDER BY day").all()) {
		const hashes = yield* hashDay(store, old.day, old.format);
		const tree = yield* treeWork(hashes);
		const matches = treeRoot(tree) === old.root;
		store.db.transaction(() => {
			if (matches) keepLeaves(store, old.day, tree.sorted);
			store.db.run("UPDATE chain SET leaves = ? WHERE day = ?", [matches ? 1 : 2, old.day]);
		})();
		yield;
	}
	const last = store.db.query<ChainRow, []>("SELECT * FROM chain ORDER BY day DESC LIMIT 1").get();
	const first = last
		? dayStart(last.day) + DAY
		: // A row with a bogus receive time (0, 1970) must not make the first seal walk every day since then.
			(store.db
				.query<{ t: number | null }, [number]>("SELECT MIN(fetched_at) AS t FROM obs WHERE fetched_at >= ?")
				.get(EARLIEST)?.t ?? null);
	if (first === null) return [];
	const insert = store.db.prepare(
		"INSERT INTO chain (day, rows, root, prev, digest, sealed_at, format, leaves) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
	);
	const sealed: ChainEntry[] = [];
	let prev = last?.digest ?? GENESIS;
	for (let start = dayStart(utcDay(first)); start + DAY + SEAL_AFTER_MS <= now; start += DAY) {
		const day = utcDay(start);
		const hashes = yield* hashDay(store, day, CHAIN_FORMAT);
		if (hashes.length === 0) continue;
		const tree = yield* treeWork(hashes);
		yield;
		const rows = tree.sorted.length;
		const root = treeRoot(tree);
		const digest = chainDigest(prev, day, rows, root, CHAIN_FORMAT);
		store.db.transaction(() => {
			keepLeaves(store, day, tree.sorted);
			insert.run(day, rows, root, prev, digest, now, CHAIN_FORMAT);
		})();
		sealed.push({ day, rows, root, prev, digest, sealedAt: now, format: CHAIN_FORMAT });
		prev = digest;
		yield;
	}
	return sealed;
}

/** Seals synchronously (tests, the CLI). The server uses `sealInBackground`. */
export function sealDays(store: Store, now: number): ChainEntry[] {
	return run(sealWork(store, now));
}

/** One sealing or pruning job at a time per archive: they must never interleave on the same rows. */
const busy = new WeakMap<Store, Promise<unknown>>();

async function exclusive<T>(store: Store, job: () => Promise<T>): Promise<T> {
	for (let pending = busy.get(store); pending; pending = busy.get(store)) await pending.catch(() => {});
	const p = job();
	busy.set(store, p);
	try {
		return await p;
	} finally {
		if (busy.get(store) === p) busy.delete(store);
	}
}

/** Seals off the request path, a slice at a time (a large archive's first seal takes seconds of hashing). */
export function sealInBackground(
	store: Store,
	now: number,
	options: { sliceMs?: number; signal?: AbortSignal } = {},
): Promise<ChainEntry[]> {
	return exclusive(store, () => runSliced(sealWork(store, now), options.sliceMs, options.signal));
}

/**
 * Retention that keeps the chain: deletes observations observed and received before `before` (except the newest
 * row of every series, as `Store.pruneObservations`), and for each deleted row of a sealed day records its hash in
 * `chain_pruned`, so the day still verifies ("N filas borradas por la retención") and its kept hashes still prove
 * the rows that remain.
 */
export function* pruneWork(store: Store, before: number, now: number): Generator<void, number> {
	ensureTable(store);
	// The candidates once (ids only); then their rows a chunk at a time.
	const ids = store.db
		.query<{ id: number }, [number, number]>(
			`SELECT id FROM obs WHERE observed_at < ? AND fetched_at < ? AND id NOT IN (
				SELECT id FROM (
					SELECT id, ROW_NUMBER() OVER (PARTITION BY source, series ORDER BY observed_at DESC, id DESC) AS rn
					FROM obs
				) WHERE rn = 1
			)`,
		)
		.all(before, before)
		.map((r) => r.id);
	const pick = store.db.query<RawRow & { id: number }, [string]>(
		`SELECT id, ${ROW_COLUMNS} FROM obs WHERE id IN (SELECT value FROM json_each(?))`,
	);
	const formats = new Map<string, string | null>();
	const formatOf = (day: string) => {
		if (!formats.has(day)) formats.set(day, chainEntry(store, day)?.format ?? null);
		return formats.get(day) ?? null;
	};
	const tomb = store.db.prepare("INSERT OR IGNORE INTO chain_pruned (day, hash, pruned_at) VALUES (?, ?, ?)");
	const del = store.db.prepare("DELETE FROM obs WHERE id = ?");
	let deleted = 0;
	for (let i = 0; i < ids.length; i += CHUNK) {
		const rows = pick.all(JSON.stringify(ids.slice(i, i + CHUNK)));
		store.db.transaction(() => {
			for (const r of rows) {
				const day = utcDay(r.fetched_at);
				const format = formatOf(day);
				if (format !== null) tomb.run(day, bytes(rawHash(r, format)), now);
				del.run(r.id);
			}
		})();
		deleted += rows.length;
		yield;
	}
	return deleted;
}

export function pruneObservations(store: Store, before: number, now: number): number {
	return run(pruneWork(store, before, now));
}

export function pruneInBackground(
	store: Store,
	before: number,
	now: number,
	options: { sliceMs?: number; signal?: AbortSignal } = {},
): Promise<number> {
	return exclusive(store, () => runSliced(pruneWork(store, before, now), options.sliceMs, options.signal));
}

/**
 * A privacy fix applied to rows stored by an older version: `rewrite` returns a row's new value, or null to leave it.
 * A row of an unsealed day is replaced with the same times. A row of a sealed day is deleted with its hash kept in
 * `chain_pruned`, exactly as retention does, so the day still verifies wherever its row hashes were kept, and the
 * rewritten value is stored as a new row received at `now` (what was sealed stays provable; what is kept is safe).
 * Returns how many rows were rewritten.
 */
export function redactRows(
	store: Store,
	source: string,
	rewrite: (value: Json) => Json | null,
	now: number,
): number {
	ensureTable(store);
	const rows = store.db
		.query<RawRow & { id: number }, [string]>(`SELECT id, ${ROW_COLUMNS} FROM obs WHERE source = ?`)
		.all(source);
	const tomb = store.db.prepare("INSERT OR IGNORE INTO chain_pruned (day, hash, pruned_at) VALUES (?, ?, ?)");
	const del = store.db.prepare("DELETE FROM obs WHERE id = ?");
	const formats = new Map<string, string | null>();
	let rewritten = 0;
	store.db.transaction(() => {
		for (const r of rows) {
			const next = rewrite(JSON.parse(r.value) as Json);
			if (next === null || canonicalJson(next) === r.value) continue;
			const day = utcDay(r.fetched_at);
			if (!formats.has(day)) formats.set(day, chainEntry(store, day)?.format ?? null);
			const format = formats.get(day) ?? null;
			if (format !== null) tomb.run(day, bytes(rawHash(r, format)), now);
			del.run(r.id);
			const o: Observation = {
				source: r.source,
				series: r.series,
				sourceUrl: r.source_url,
				fetchedAt: format === null ? r.fetched_at : Math.max(now, r.fetched_at),
				observedAt: r.observed_at,
				licence: r.licence,
				value: next,
				confidence: r.confidence,
				basis: r.basis as Basis,
				...(r.lat !== null && r.lon !== null
					? {
							location: {
								lat: r.lat,
								lon: r.lon,
								...(r.state !== null ? { state: r.state } : {}),
								...(r.place !== null ? { place: r.place } : {}),
							},
						}
					: {}),
			};
			store.insert([o]);
			rewritten++;
		}
	})();
	return rewritten;
}

export type DayCheck = {
	day: string;
	ok: boolean;
	/** Why not, in Spanish; null when ok. */
	problem: string | null;
	rowsSealed: number;
	rowsNow: number;
	/** Sealed rows deleted since by the configured retention (recorded when deleted). */
	pruned: number;
};

/** Recomputes every sealed day from the rows stored now and checks each link of the chain. */
export function verifyChain(store: Store): DayCheck[] {
	const out: DayCheck[] = [];
	let prev = GENESIS;
	for (const e of chain(store)) {
		const hashes = dayHashes(store, e.day, e.format);
		const now = new Set(hashes);
		const rowsNow = now.size;
		let problem: string | null = null;
		let pruned = 0;
		const kept = sealedLeaves(store, e.day);
		if (!CHAIN_FORMATS.includes(e.format)) problem = `formato desconocido (${e.format})`;
		else if (e.prev !== prev) problem = "el enlace con el día anterior no coincide (la cadena fue alterada)";
		else if (chainDigest(e.prev, e.day, e.rows, e.root, e.format) !== e.digest)
			problem = "el resumen guardado no corresponde a sus datos (la cadena fue alterada)";
		else if (kept) {
			const sealedSet = new Set(kept);
			const tombs = prunedHashes(store, e.day);
			const added = [...now].filter((h) => !sealedSet.has(h)).length;
			const missing = kept.filter((h) => !now.has(h));
			const unexplained = missing.filter((h) => !tombs.has(h)).length;
			pruned = missing.length - unexplained;
			if (kept.length !== e.rows || merkleRoot(kept) !== e.root)
				problem = "las huellas guardadas del día no corresponden a su sello (fueron alteradas)";
			else if (added > 0 && unexplained > 0) problem = "hay filas modificadas desde que se selló";
			else if (added > 0) problem = `hay ${added} filas más que al sellarlo`;
			else if (unexplained > 0)
				problem = `faltan ${unexplained} filas desde que se selló (y no las borró la retención)`;
		} else if (merkleRoot(hashes) !== e.root)
			problem =
				rowsNow < e.rows
					? `faltan ${e.rows - rowsNow} filas desde que se selló`
					: rowsNow > e.rows
						? `hay ${rowsNow - e.rows} filas más que al sellarlo`
						: "hay filas modificadas desde que se selló";
		out.push({ day: e.day, ok: problem === null, problem, rowsSealed: e.rows, rowsNow, pruned });
		prev = e.digest;
	}
	return out;
}
