import { Database } from "bun:sqlite";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeDatabase } from "../core/sqlite-files.ts";

/**
 * One Vigía per data directory (review 4 L5). A pid file is only a note: two servers started together both write
 * theirs and both run. This holds a real exclusive lock instead: an SQLite file (`vigia.lock`) kept in an EXCLUSIVE
 * transaction, which is an OS lock (fcntl on Unix, LockFileEx on Windows), portable with no native code, refused
 * immediately to any second holder (another process, or another connection in this one), and released by the OS
 * when the holder dies, so a crash never leaves a stale lock behind. `vigia.pid` stays as the human-readable note of
 * who holds it.
 */

export interface InstanceLock {
	release(): void;
}

export type LockResult =
	| { readonly ok: true; readonly lock: InstanceLock }
	| { readonly ok: false; readonly pid: number | null };

const LOCK_FILE = "vigia.lock";
const PID_FILE = "vigia.pid";

export function acquireInstanceLock(dataDir: string, pid = process.pid): LockResult {
	const db = tryLock(dataDir, pid);
	if (!db) return { ok: false, pid: readPid(dataDir) };
	const pidFile = join(dataDir, PID_FILE);
	writeFileSync(pidFile, `${pid}\n`);
	let released = false;
	return {
		ok: true,
		lock: {
			release() {
				if (released) return;
				released = true;
				rmSync(pidFile, { force: true });
				closeDatabase(db);
			},
		},
	};
}

/** Who holds the data directory: the pid it noted (null when unknown), or false when nobody does. */
export function lockHolder(dataDir: string): number | null | false {
	if (!existsSync(join(dataDir, LOCK_FILE))) return false;
	const probe = tryLock(dataDir, 0);
	if (!probe) return readPid(dataDir);
	closeDatabase(probe);
	return false;
}

/** The lock's connection, holding it, or null when someone else does. */
function tryLock(dataDir: string, pid: number): Database | null {
	let db: Database | null = null;
	try {
		db = new Database(join(dataDir, LOCK_FILE), { create: true });
		db.run("PRAGMA busy_timeout = 0");
		db.run("PRAGMA locking_mode = EXCLUSIVE");
		db.run("PRAGMA journal_mode = MEMORY");
		db.run("BEGIN EXCLUSIVE");
		// A write makes the lock stick for the life of the connection (EXCLUSIVE locking mode keeps it after commit).
		db.run("CREATE TABLE IF NOT EXISTS holder (pid INTEGER)");
		db.run("DELETE FROM holder");
		db.run("INSERT INTO holder (pid) VALUES (?)", [pid]);
		db.run("COMMIT");
		return db;
	} catch {
		closeDatabase(db);
		return null;
	}
}

function readPid(dataDir: string): number | null {
	try {
		const pid = Number(readFileSync(join(dataDir, PID_FILE), "utf8").trim());
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}
