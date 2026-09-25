import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readlinkSync, renameSync, rmSync } from "node:fs";

/**
 * Moving and deleting SQLite files safely on every system.
 *
 * `Database.close()` without arguments uses `sqlite3_close_v2`: while any statement made with `prepare` is still
 * alive, the connection stays open as a "zombie" and keeps its file handles (database, -wal, -shm) until garbage
 * collection. On Linux nobody notices; on Windows deleting or renaming the file then fails with EBUSY, and on macOS
 * a file moved from under the zombie (with its WAL and shared memory still mapped by it) reads back as "disk I/O
 * error". `closeDatabase` finalizes every statement and releases the connection immediately.
 */

/** Files SQLite may keep beside a database: the write-ahead log, its shared-memory index, a rollback journal. */
export const SIDECARS = ["-wal", "-shm", "-journal"] as const;

/** Closes now: finalizes every outstanding statement and releases every file handle (`sqlite3_close`). */
export function closeDatabase(db: Database | null | undefined): void {
	db?.close(true);
}

/** Errors a virus scanner, an indexer or a handle closing a moment late can cause on Windows: worth a retry. */
const TRANSIENT = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);

/**
 * Runs a file operation, retrying briefly (about a second in all) while Windows reports the file busy. Anything
 * else, or a busy file that stays busy, throws.
 */
export function retryBusy<T>(op: () => T, options: { tries?: number; delayMs?: number } = {}): T {
	const tries = options.tries ?? 8;
	let delay = options.delayMs ?? 25;
	for (let attempt = 1; ; attempt++) {
		try {
			return op();
		} catch (error) {
			const code = (error as NodeJS.ErrnoException | null)?.code;
			if (attempt >= tries || !code || !TRANSIENT.has(code)) throw error;
			Bun.sleepSync(delay);
			delay = Math.min(delay * 2, 250);
		}
	}
}

/** Removes a file or a directory tree if present, retrying while it is busy. */
export function removePath(path: string): void {
	retryBusy(() => rmSync(path, { recursive: true, force: true }));
}

/** Removes a database file and every sidecar it may have. Close every connection to it first. */
export function removeDatabase(path: string): void {
	for (const suffix of ["", ...SIDECARS]) removePath(`${path}${suffix}`);
}

/**
 * Moves a database and its sidecars together (a WAL separated from its database is lost data, and a stale one next
 * to another database corrupts it). The target and its sidecars must not exist. Close every connection first.
 */
export function moveDatabase(from: string, to: string): void {
	for (const suffix of ["", ...SIDECARS])
		if (existsSync(`${to}${suffix}`)) throw new Error(`Ya existe ${to}${suffix}; no se sobrescribe.`);
	retryBusy(() => renameSync(from, to));
	for (const suffix of SIDECARS)
		if (existsSync(`${from}${suffix}`)) retryBusy(() => renameSync(`${from}${suffix}`, `${to}${suffix}`));
}

/**
 * The files under `dir` this process holds open, read from /proc (Linux only; null elsewhere). Tests use it to prove
 * every connection really released its files, which Windows otherwise reports only as EBUSY much later.
 */
export function openFilesUnder(dir: string): string[] | null {
	if (!existsSync("/proc/self/fd")) return null;
	const out: string[] = [];
	for (const fd of readdirSync("/proc/self/fd")) {
		try {
			const target = readlinkSync(`/proc/self/fd/${fd}`);
			if (target.startsWith(dir)) out.push(target);
		} catch {
			// The descriptor closed while listing (readdir's own one does).
		}
	}
	return out.sort();
}
