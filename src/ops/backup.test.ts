import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFilesUnder, removePath } from "../core/sqlite-files.ts";
import { Store } from "../core/store.ts";
import type { Observation } from "../core/types.ts";
import { chain, sealDays } from "../intel/chain.ts";
import { BACKUP_FORMAT, backup, type Manifest, restore } from "./backup.ts";
import { acquireInstanceLock } from "./instance-lock.ts";

const HOUR = 3_600_000;
const D1 = Date.UTC(2026, 8, 22, 10);
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) {
		// Every connection must be closed by now: Windows refuses to delete an open file (EBUSY), and on Linux the
		// open descriptors show it directly.
		expect(openFilesUnder(d) ?? []).toEqual([]);
		removePath(d);
	}
});

const obs = (series: string, at: number, v: number): Observation => ({
	source: "demo",
	series,
	sourceUrl: "https://example.org",
	fetchedAt: at,
	observedAt: at - HOUR,
	licence: "demo",
	value: { v },
	confidence: 1,
	basis: "measurement",
});

/** A data directory with two sealed days, a run log and an unsealed row. */
function seeded(bump = 0): { dir: string; db: string; head: string } {
	const dir = mkdtempSync(join(tmpdir(), "vigia-backup-"));
	dirs.push(dir);
	const db = join(dir, "vigia.sqlite");
	const store = new Store(db);
	store.insert([
		obs("a", D1, 1 + bump),
		obs("b", D1 + HOUR, 2),
		obs("a", D1 + 24 * HOUR, 3),
		obs("c", D1 + 60 * HOUR, 4),
	]);
	store.recordRun({
		source: "demo",
		startedAt: D1,
		finishedAt: D1 + 900,
		ok: true,
		error: null,
		bytes: 1,
		received: 1,
		inserted: 1,
	});
	sealDays(store, D1 + 48 * HOUR);
	const head = chain(store).at(-1)?.digest ?? "";
	store.close();
	return { dir, db, head };
}

const lines = () => {
	const out: string[] = [];
	return { out, push: (l: string) => out.push(l) };
};

test("backup: one consistent, verified file with a manifest; keys are never in it", () => {
	const { dir, db, head } = seeded();
	const log = lines();
	const made = backup({ dbPath: db, version: "test", now: D1 + 72 * HOUR, out: log.push });
	expect(made).not.toBeNull();
	if (!made) return;
	expect(made.path).toBe(join(dir, "respaldos", "vigia-20260925-100000.sqlite"));
	const manifest = JSON.parse(readFileSync(`${made.path}.json`, "utf8")) as Manifest;
	expect(manifest).toMatchObject({
		format: BACKUP_FORMAT,
		vigia: "test",
		schema: 2,
		sealedDays: 2,
		chainHead: head,
	});
	expect(manifest.tables).toMatchObject({ obs: 4, runs: 1, chain: 2, chain_leaves: 2 });
	expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
	// The copy is a standalone database: no WAL beside it.
	expect(existsSync(`${made.path}-wal`)).toBe(false);
	const copy = new Database(made.path, { readonly: true });
	expect(copy.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM obs").get()?.n).toBe(4);
	copy.close();
	// Never overwrite an existing file.
	expect(backup({ dbPath: db, dest: made.path, version: "test", out: log.push })).toBeNull();
	expect(log.out.at(-1)).toContain("Ya existe");
});

test("backup while another connection is writing gives a consistent snapshot", () => {
	const { dir, db } = seeded();
	const writer = new Store(db);
	writer.db.run("BEGIN IMMEDIATE");
	writer.insert([obs("d", D1 + 70 * HOUR, 5)]);
	// Uncommitted: the snapshot must not contain it, and the backup must not wait for it.
	const made = backup({ dbPath: db, dest: join(dir, "b.sqlite"), version: "test", out: () => {} });
	writer.db.run("COMMIT");
	writer.close();
	expect(made?.manifest.tables.obs).toBe(4);
});

test("restore: refuses while Vigía runs, verifies, keeps the old database aside, and checks again in place", () => {
	const { dir, db, head } = seeded();
	const made = backup({ dbPath: db, dest: join(dir, "copia.sqlite"), version: "test", out: () => {} });
	if (!made) throw new Error("no backup");
	// Diverge the live database after the backup.
	const live = new Store(db);
	live.insert([obs("late", D1 + 80 * HOUR, 9)]);
	live.close();

	// A running Vigía holds the instance lock (a pid file alone no longer counts: review 4 L5).
	const running = acquireInstanceLock(dir, 4242);
	const blocked = lines();
	expect(restore({ file: made.path, dbPath: db, force: false, out: blocked.push }).code).toBe(1);
	expect(blocked.out[0]).toContain("Vigía está corriendo (proceso 4242)");
	if (running.ok) running.lock.release();
	// A stale pid file of a Vigía that is gone does not block.
	writeFileSync(join(dir, "vigia.pid"), `${process.ppid}\n`);

	const log = lines();
	const result = restore({ file: made.path, dbPath: db, force: false, now: D1 + 90 * HOUR, out: log.push });
	expect(result.code).toBe(0);
	expect(log.out).toContain("✓ Huella SHA-256 igual a la del manifiesto");
	expect(result.aside).toBe(`${db}.antes-de-restaurar-20260926-040000`);
	const restored = new Store(db);
	expect(restored.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM obs").get()?.n).toBe(4);
	expect(chain(restored).at(-1)?.digest).toBe(head);
	restored.close();
	// The previous database, with the late row, is kept as one self-contained file: no log or shared memory beside
	// it (macOS read an aside moved without them as "disk I/O error"), readable wherever it is copied alone.
	const aside = result.aside ?? "";
	for (const suffix of ["-wal", "-shm", "-journal"]) expect(existsSync(`${aside}${suffix}`)).toBe(false);
	mkdirSync(join(dir, "elsewhere"));
	const alone = join(dir, "elsewhere", "old.sqlite");
	copyFileSync(aside, alone);
	for (const path of [aside, alone]) {
		const old = new Database(path, { readonly: true });
		expect(old.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM obs").get()?.n).toBe(5);
		expect(old.query<{ ok: string }, []>("PRAGMA integrity_check").get()?.ok ?? "ok").toBe("ok");
		old.close();
	}
	// Nothing temporary is left in the data directory.
	expect(existsSync(join(dir, ".verificando"))).toBe(false);
	expect(existsSync(`${db}.restaurando`)).toBe(false);
});

test("restore sets apart a log left without its database instead of replaying it into the restored file", () => {
	const { dir, db } = seeded();
	const made = backup({ dbPath: db, dest: join(dir, "copia.sqlite"), version: "test", out: () => {} });
	if (!made) throw new Error("no backup");
	removePath(db);
	writeFileSync(`${db}-wal`, "not a log of this file");
	const log = lines();
	const result = restore({ file: made.path, dbPath: db, force: false, now: D1 + 90 * HOUR, out: log.push });
	expect(result.code).toBe(0);
	expect(result.aside).toBeNull();
	expect(existsSync(`${db}.huerfanos-20260926-040000-wal`)).toBe(true);
	expect(log.out.join("\n")).toContain("sin su base de datos");
	const restored = new Store(db);
	expect(restored.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM obs").get()?.n).toBe(4);
	restored.close();
});

test("restore refuses a database whose changes still sit in a log beside it", () => {
	const { dir, db } = seeded();
	// A live database copied with its WAL: the file alone would lose the logged rows.
	const live = new Database(join(dir, "vivo.sqlite"), { create: true });
	live.run("PRAGMA journal_mode = WAL");
	live.run("PRAGMA wal_autocheckpoint = 0");
	live.run("CREATE TABLE t (x)");
	live.run("INSERT INTO t VALUES (1)");
	copyFileSync(join(dir, "vivo.sqlite"), join(dir, "copia.sqlite"));
	copyFileSync(join(dir, "vivo.sqlite-wal"), join(dir, "copia.sqlite-wal"));
	live.close(true);
	const log = lines();
	expect(restore({ file: join(dir, "copia.sqlite"), dbPath: db, force: false, out: log.push }).code).toBe(1);
	expect(log.out.join("\n")).toContain("copia.sqlite-wal");
	expect(existsSync(db)).toBe(true);
});

test("restore refuses a tampered backup and changes nothing", () => {
	const { dir, db } = seeded();
	const made = backup({ dbPath: db, dest: join(dir, "copia.sqlite"), version: "test", out: () => {} });
	if (!made) throw new Error("no backup");
	// Edit a sealed row in the copy, then fix the manifest's hash so only the chain can tell.
	const copy = new Database(made.path);
	copy.run(`UPDATE obs SET value = '{"v":99}' WHERE series = 'a' AND observed_at = ?`, [D1 - HOUR]);
	copy.close();
	const manifest = JSON.parse(readFileSync(`${made.path}.json`, "utf8")) as Manifest;
	const log = lines();
	expect(restore({ file: made.path, dbPath: db, force: false, out: log.push }).code).toBe(1);
	expect(log.out.join("\n")).toContain("no coincide con su manifiesto");
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(readFileSync(made.path));
	writeFileSync(`${made.path}.json`, JSON.stringify({ ...manifest, sha256: hasher.digest("hex") }));
	const again = lines();
	expect(restore({ file: made.path, dbPath: db, force: false, out: again.push }).code).toBe(1);
	expect(again.out.join("\n")).toMatch(/Cadena: 2026-09-22 .*modificadas/);
	expect(existsSync(db)).toBe(true);
	const untouched = new Database(db, { readonly: true });
	expect(untouched.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM obs").get()?.n).toBe(4);
	untouched.close();
	// Not a database at all.
	writeFileSync(join(dir, "basura.sqlite"), "hola");
	const junk = lines();
	expect(restore({ file: join(dir, "basura.sqlite"), dbPath: db, force: false, out: junk.push }).code).toBe(
		1,
	);
});

test("restore refuses a forged but self-consistent archive that rewrites a day sealed here, unless told explicitly (review 4 M10)", () => {
	const local = seeded();
	// Another machine (or a forger) with a different value on 2026-09-22, sealed coherently with itself.
	const forged = seeded(40);
	const made = backup({
		dbPath: forged.db,
		dest: join(forged.dir, "falso.sqlite"),
		version: "test",
		out: () => {},
	});
	if (!made) throw new Error("no backup");
	expect(forged.head).not.toBe(local.head);

	const log = lines();
	const refused = restore({ file: made.path, dbPath: local.db, force: false, out: log.push });
	expect(refused.code).toBe(1);
	const text = log.out.join("\n");
	expect(text).toContain("coherente consigo mismo");
	expect(text).toContain("2026-09-22");
	expect(text).toContain("--force-replace-sealed");
	expect(text).not.toContain("✓ Restaurado");
	const untouched = new Store(local.db);
	expect(chain(untouched).at(-1)?.digest).toBe(local.head);
	untouched.close();

	const forcedLog = lines();
	const forced = restore({
		file: made.path,
		dbPath: local.db,
		force: false,
		forceReplaceSealed: true,
		out: forcedLog.push,
	});
	expect(forced.code).toBe(0);
	expect(forcedLog.out.join("\n")).toContain("reemplazados a petición");
	const replaced = new Store(local.db);
	expect(chain(replaced).at(-1)?.digest).toBe(forged.head);
	replaced.close();
});

test("restore of this machine's own older backup passes the sealed-day comparison", () => {
	const { dir, db } = seeded();
	const made = backup({ dbPath: db, dest: join(dir, "copia.sqlite"), version: "test", out: () => {} });
	if (!made) throw new Error("no backup");
	const log = lines();
	expect(restore({ file: made.path, dbPath: db, force: false, out: log.push }).code).toBe(0);
	expect(log.out.join("\n")).toContain("2 días sellados en este equipo coinciden");
});
