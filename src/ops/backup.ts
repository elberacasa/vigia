import { Database } from "bun:sqlite";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { SCHEMA_VERSION, Store } from "../core/store.ts";
import { chain, verifyChain } from "../intel/chain.ts";
import { acquireInstanceLock } from "./instance-lock.ts";

/**
 * `vigia backup` and `vigia restore`: the archive (observations, runs, the sealed hash chain and its leaves, the AI
 * ledger, the connectivity history) as one consistent SQLite file, verified before it is trusted.
 *
 * Backup uses `VACUUM INTO` on a read-only connection: it copies one read transaction's snapshot, so a Vigía writing
 * at the same time (WAL mode) never produces a torn copy, and it never blocks that writer. The copy is then opened on
 * its own and checked (integrity_check, schema version, every sealed day of the chain recomputed), and a manifest
 * with its SHA-256 and per-table row counts is written next to it.
 *
 * Restore refuses while Vigía is running, verifies the file (and its manifest when present), keeps the current
 * database aside instead of deleting it, puts the copy in place, and verifies again from the restored location
 * (integrity, chain, row counts equal to the backup's); any failure puts the previous database back.
 *
 * Keys and settings are not in the archive and are never copied (they live in the config directory; see
 * `vigia paths`). Stored images (blobs) are a rolling cache with their own retention and are not included.
 */

export const BACKUP_FORMAT = "vigia-backup/1";

export interface BackupCheck {
	readonly ok: boolean;
	readonly problems: string[];
	readonly schema: number | null;
	readonly tables: Record<string, number>;
	readonly sealedDays: number;
	readonly chainHead: string | null;
}

export interface Manifest {
	readonly format: typeof BACKUP_FORMAT;
	readonly createdAt: string;
	readonly vigia: string;
	readonly file: string;
	readonly bytes: number;
	readonly sha256: string;
	readonly schema: number | null;
	readonly tables: Record<string, number>;
	readonly sealedDays: number;
	readonly chainHead: string | null;
}

type Out = (line: string) => void;

export function sha256File(path: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(readFileSync(path));
	return hasher.digest("hex");
}

function tableCounts(db: Database): Record<string, number> {
	const names = db
		.query<{ name: string }, []>(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
		)
		.all()
		.map((r) => r.name);
	const out: Record<string, number> = {};
	for (const name of names) {
		if (!/^\w+$/.test(name)) continue;
		out[name] = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "${name}"`).get()?.n ?? 0;
	}
	return out;
}

/**
 * Checks a database file without changing it: integrity, schema version, then (on a private temporary copy, since
 * opening through Store may migrate) every sealed day of the chain.
 */
export function checkDatabase(path: string, scratchDir: string): BackupCheck {
	const problems: string[] = [];
	if (!existsSync(path))
		return {
			ok: false,
			problems: [`No existe ${path}.`],
			schema: null,
			tables: {},
			sealedDays: 0,
			chainHead: null,
		};
	let schema: number | null = null;
	let tables: Record<string, number> = {};
	let db: Database | null = null;
	try {
		db = new Database(path, { readonly: true, strict: true });
		const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
		if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok")
			problems.push(
				`SQLite encontró daños: ${integrity
					.map((r) => r.integrity_check)
					.slice(0, 3)
					.join("; ")}`,
			);
		const row = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema'").get();
		schema = row ? Number(row.value) : null;
		if (schema === null) problems.push("No es una base de datos de Vigía (sin versión de esquema).");
		else if (schema > SCHEMA_VERSION)
			problems.push(
				`Es de una versión más nueva de Vigía (esquema ${schema}, este Vigía usa ${SCHEMA_VERSION}). Actualiza Vigía.`,
			);
		tables = tableCounts(db);
		if (!("obs" in tables)) problems.push("Falta la tabla de observaciones.");
	} catch (error) {
		problems.push(`No se pudo abrir como SQLite: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		db?.close();
	}
	if (problems.length) return { ok: false, problems, schema, tables, sealedDays: 0, chainHead: null };

	// The chain check opens the file through Store (which may migrate an older schema): do it on a scratch copy.
	mkdirSync(scratchDir, { recursive: true });
	const scratch = join(scratchDir, `verificar-${process.pid}-${Date.now()}.sqlite`);
	let sealedDays = 0;
	let chainHead: string | null = null;
	try {
		copyFileSync(path, scratch);
		const store = new Store(scratch);
		try {
			const days = verifyChain(store);
			sealedDays = days.length;
			for (const d of days.filter((x) => !x.ok).slice(0, 5))
				problems.push(`Cadena: ${d.day} ${d.problem ?? ""}`);
			chainHead = chain(store).at(-1)?.digest ?? null;
		} finally {
			store.close();
		}
	} finally {
		for (const suffix of ["", "-wal", "-shm"]) rmSync(`${scratch}${suffix}`, { force: true });
	}
	return { ok: problems.length === 0, problems, schema, tables, sealedDays, chainHead };
}

function stamp(t: number): string {
	return new Date(t).toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
}

/** Creates a verified backup of `dbPath`. Returns the backup's path, or null on failure (reasons printed). */
export function backup(options: {
	readonly dbPath: string;
	readonly dest?: string;
	readonly version: string;
	readonly now?: number;
	readonly out: Out;
}): { path: string; manifest: Manifest; ms: number } | null {
	const started = performance.now();
	const { dbPath, out } = options;
	if (!existsSync(dbPath)) {
		out(`No hay base de datos en ${dbPath}. ¿Vigía ya corrió en este equipo? (vigia paths)`);
		return null;
	}
	const now = options.now ?? Date.now();
	const dest = resolve(options.dest ?? join(dirname(dbPath), "respaldos", `vigia-${stamp(now)}.sqlite`));
	if (existsSync(dest)) {
		out(`Ya existe ${dest}; elige otro nombre.`);
		return null;
	}
	mkdirSync(dirname(dest), { recursive: true });
	const source = new Database(dbPath, { readonly: true, strict: true });
	try {
		source.run("PRAGMA busy_timeout = 10000");
		source.run("VACUUM INTO ?", [dest]);
	} catch (error) {
		out(`No se pudo copiar: ${error instanceof Error ? error.message : String(error)}`);
		rmSync(dest, { force: true });
		return null;
	} finally {
		source.close();
	}
	const check = checkDatabase(dest, join(dirname(dest), ".verificando"));
	rmSync(join(dirname(dest), ".verificando"), { recursive: true, force: true });
	if (!check.ok) {
		for (const p of check.problems) out(`✗ ${p}`);
		out("La copia no pasó la verificación; se borró.");
		rmSync(dest, { force: true });
		return null;
	}
	const manifest: Manifest = {
		format: BACKUP_FORMAT,
		createdAt: new Date(now).toISOString(),
		vigia: options.version,
		file: basename(dest),
		bytes: statSync(dest).size,
		sha256: sha256File(dest),
		schema: check.schema,
		tables: check.tables,
		sealedDays: check.sealedDays,
		chainHead: check.chainHead,
	};
	writeFileSync(`${dest}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
	return { path: dest, manifest, ms: Math.round(performance.now() - started) };
}

/** Day → digest of every sealed day in a database file, read-only; null when the file cannot be read. */
function sealedDigests(path: string): Map<string, string> | null {
	if (!existsSync(path)) return new Map();
	let db: Database | null = null;
	try {
		db = new Database(path, { readonly: true, strict: true });
		const table = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chain'").get();
		if (!table) return new Map();
		const rows = db.query<{ day: string; digest: string }, []>("SELECT day, digest FROM chain").all();
		return new Map(rows.map((r) => [r.day, r.digest]));
	} catch {
		return null;
	} finally {
		db?.close();
	}
}

function listDays(days: readonly string[]): string {
	const sorted = [...days].sort();
	return sorted.length <= 6 ? sorted.join(", ") : `${sorted.slice(0, 5).join(", ")} … ${sorted.at(-1)}`;
}

type RestoreOptions = Parameters<typeof restoreLocked>[0];

/**
 * Restores `file` as the database at `dbPath`. Returns the exit code (0 ok). Holds the data directory's instance
 * lock throughout, so it refuses while a Vigía runs there and no Vigía can start halfway through (review 4 L5).
 */
export function restore(options: RestoreOptions): { code: number; ms: number; aside: string | null } {
	const dataDir = dirname(options.dbPath);
	mkdirSync(dataDir, { recursive: true });
	const held = acquireInstanceLock(dataDir);
	if (!held.ok && !options.force) {
		options.out(
			`Vigía está corriendo (proceso ${held.pid ?? "desconocido"}) con estos datos. Ciérralo (Ctrl+C) y vuelve a intentarlo.`,
		);
		return { code: 1, ms: 0, aside: null };
	}
	try {
		return restoreLocked(options);
	} finally {
		if (held.ok) held.lock.release();
	}
}

function restoreLocked(options: {
	readonly file: string;
	readonly dbPath: string;
	readonly force: boolean;
	/** Replace days sealed on this machine with the archive's different version of them (`--force-replace-sealed`). */
	readonly forceReplaceSealed?: boolean;
	readonly now?: number;
	readonly out: Out;
}): { code: number; ms: number; aside: string | null } {
	const started = performance.now();
	const { dbPath, out } = options;
	const file = resolve(options.file);
	const done = (code: number, aside: string | null = null) => ({
		code,
		ms: Math.round(performance.now() - started),
		aside,
	});
	const dataDir = dirname(dbPath);

	if (resolve(file) === resolve(dbPath)) {
		out("Ese archivo ya es la base de datos en uso.");
		return done(1);
	}

	const manifestPath = `${file}.json`;
	if (existsSync(manifestPath)) {
		let manifest: Partial<Manifest> = {};
		try {
			manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Partial<Manifest>;
		} catch {
			out(`El manifiesto ${manifestPath} no se puede leer.`);
			return done(1);
		}
		if (manifest.format !== BACKUP_FORMAT || typeof manifest.sha256 !== "string") {
			out(`${manifestPath} no es un manifiesto de respaldo de Vigía.`);
			return done(1);
		}
		if (sha256File(file) !== manifest.sha256) {
			out(
				"✗ La huella SHA-256 del respaldo no coincide con su manifiesto: el archivo cambió o está incompleto.",
			);
			return done(1);
		}
		out("✓ Huella SHA-256 igual a la del manifiesto");
	} else out("(Sin manifiesto junto al archivo: se verifica solo su contenido.)");

	const scratch = join(dataDir, ".verificando");
	const before = checkDatabase(file, scratch);
	if (!before.ok) {
		for (const p of before.problems) out(`✗ ${p}`);
		out("El respaldo no pasó la verificación; no se cambió nada.");
		rmSync(scratch, { recursive: true, force: true });
		return done(1);
	}
	out(
		`✓ Respaldo coherente consigo mismo: ${before.tables.obs ?? 0} observaciones, ${before.sealedDays} días sellados`,
	);

	// Self-consistency proves nothing about authenticity: a forger can seal a rewritten history coherently. What
	// this machine sealed itself is the reference, so any day it sealed must come back with the same digest
	// (review 4 M10).
	const mine = sealedDigests(dbPath);
	if (mine === null) {
		out("(La base de datos actual no se puede leer: no hay días sellados aquí con los que comparar.)");
	} else if (mine.size > 0) {
		const theirs = sealedDigests(file) ?? new Map<string, string>();
		const differ = [...mine]
			.filter(([day, digest]) => theirs.has(day) && theirs.get(day) !== digest)
			.map(([d]) => d);
		const missing = [...mine.keys()].filter((day) => !theirs.has(day));
		if (differ.length > 0 && !options.forceReplaceSealed) {
			out(
				`✗ El respaldo trae otra versión de ${differ.length} ${differ.length === 1 ? "día sellado" : "días sellados"} en este equipo: ${listDays(differ)}.`,
			);
			out(
				"  Es coherente consigo mismo, pero no es lo que este equipo selló: puede venir de otra instalación o estar alterado.",
			);
			out(
				"No se cambió nada. Si de verdad quiere reemplazar esos días, repita con --force-replace-sealed (la base de datos actual se guarda aparte).",
			);
			return done(1);
		}
		if (differ.length > 0)
			out(
				`! ${differ.length} días sellados en este equipo reemplazados a petición (--force-replace-sealed): ${listDays(differ)}.`,
			);
		else out(`✓ Los ${mine.size - missing.length} días sellados en este equipo coinciden con el respaldo`);
		if (missing.length > 0)
			out(
				`! ${missing.length} días sellados aquí no están en el respaldo (${listDays(missing)}); quedan en la copia aparte de la base de datos actual.`,
			);
	}

	// Keep the current database aside (checkpointed into one file first), never delete it.
	let aside: string | null = null;
	if (existsSync(dbPath)) {
		try {
			const current = new Database(dbPath, { strict: true });
			current.run("PRAGMA wal_checkpoint(TRUNCATE)");
			current.close();
		} catch {
			// A damaged current database is exactly why one restores; move it aside as it is.
		}
		aside = `${dbPath}.antes-de-restaurar-${stamp(options.now ?? Date.now())}`;
		renameSync(dbPath, aside);
		for (const suffix of ["-wal", "-shm"])
			if (existsSync(`${dbPath}${suffix}`)) renameSync(`${dbPath}${suffix}`, `${aside}${suffix}`);
	}
	const rollback = () => {
		for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
		if (aside) {
			renameSync(aside, dbPath);
			for (const suffix of ["-wal", "-shm"])
				if (existsSync(`${aside}${suffix}`)) renameSync(`${aside}${suffix}`, `${dbPath}${suffix}`);
		}
	};
	try {
		copyFileSync(file, `${dbPath}.restaurando`);
		renameSync(`${dbPath}.restaurando`, dbPath);
		const after = checkDatabase(dbPath, scratch);
		const same =
			JSON.stringify(after.tables) === JSON.stringify(before.tables) && after.chainHead === before.chainHead;
		if (!after.ok || !same) {
			for (const p of after.problems) out(`✗ ${p}`);
			if (!same) out("✗ Lo restaurado no coincide con el respaldo (filas o cadena distintas).");
			rollback();
			out("Se devolvió la base de datos anterior; no se cambió nada.");
			return done(1);
		}
	} catch (error) {
		out(`No se pudo restaurar: ${error instanceof Error ? error.message : String(error)}`);
		rollback();
		out("Se devolvió la base de datos anterior.");
		return done(1);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
		rmSync(`${dbPath}.restaurando`, { force: true });
	}
	out("✓ Restaurado y verificado en su lugar: mismas filas por tabla y misma cabeza de la cadena");
	if (aside) out(`La base de datos anterior quedó en ${aside} (bórrela cuando ya no la necesite).`);
	return done(0, aside);
}
