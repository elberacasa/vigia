import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sealDays } from "../intel/chain.ts";
import {
	closeDatabase,
	moveDatabase,
	openFilesUnder,
	removeDatabase,
	removePath,
	retryBusy,
} from "./sqlite-files.ts";
import { Store } from "./store.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) removePath(d);
});
const dir = () => {
	const d = mkdtempSync(join(tmpdir(), "vigia-sqlite-files-"));
	dirs.push(d);
	return d;
};
const onLinux = openFilesUnder(tmpdir()) !== null;

const DAY1 = Date.UTC(2026, 8, 22, 10);
const busy = (code: string) => Object.assign(new Error(code), { code });

test.if(onLinux)(
	"a closed Store holds no file open, prepared statements and WAL included (Windows reported it as EBUSY)",
	() => {
		const d = dir();
		const store = new Store(join(d, "vigia.sqlite"));
		store.insert([
			{
				source: "s",
				series: "a",
				sourceUrl: "https://example.org",
				fetchedAt: DAY1,
				observedAt: DAY1,
				licence: "x",
				value: { v: 1 },
				confidence: 1,
				basis: "measurement",
			},
		]);
		store.recordRun({
			source: "s",
			startedAt: 0,
			finishedAt: 1,
			ok: true,
			error: null,
			bytes: 0,
			received: 1,
			inserted: 1,
		});
		expect(sealDays(store, DAY1 + 3 * 86_400_000)).toHaveLength(1);
		expect(openFilesUnder(d)?.length).toBeGreaterThan(0);
		store.close();
		expect(openFilesUnder(d)).toEqual([]);
		// A bare connection with a statement still alive is released too.
		const db = new Database(join(d, "b.sqlite"), { create: true });
		db.prepare("SELECT 1").get();
		closeDatabase(db);
		expect(openFilesUnder(d)).toEqual([]);
	},
);

test("retryBusy retries a busy file briefly, then gives up; other errors are not retried", () => {
	let calls = 0;
	expect(
		retryBusy(
			() => {
				calls++;
				if (calls < 3) throw busy("EBUSY");
				return "ok";
			},
			{ delayMs: 1 },
		),
	).toBe("ok");
	expect(calls).toBe(3);

	calls = 0;
	expect(() =>
		retryBusy(
			() => {
				calls++;
				throw busy("EPERM");
			},
			{ tries: 4, delayMs: 1 },
		),
	).toThrow("EPERM");
	expect(calls).toBe(4);

	calls = 0;
	expect(() =>
		retryBusy(() => {
			calls++;
			throw busy("ENOENT");
		}),
	).toThrow("ENOENT");
	expect(calls).toBe(1);
});

test("a database moves and is removed together with its WAL, shared memory and journal; nothing is overwritten", () => {
	const d = dir();
	const from = join(d, "a.sqlite");
	const to = join(d, "b.sqlite");
	for (const suffix of ["", "-wal", "-shm"]) writeFileSync(`${from}${suffix}`, suffix || "db");
	moveDatabase(from, to);
	for (const suffix of ["", "-wal", "-shm"]) {
		expect(existsSync(`${from}${suffix}`)).toBe(false);
		expect(existsSync(`${to}${suffix}`)).toBe(true);
	}
	expect(existsSync(`${to}-journal`)).toBe(false);

	// A target whose sidecar already exists is refused before anything moves.
	writeFileSync(from, "db");
	writeFileSync(`${from}-journal`, "j");
	expect(() => moveDatabase(from, to)).toThrow("Ya existe");
	removeDatabase(to);
	expect(["", "-wal", "-shm"].some((s) => existsSync(`${to}${s}`))).toBe(false);
	writeFileSync(`${to}-wal`, "stale");
	expect(() => moveDatabase(from, to)).toThrow(`${to}-wal`);
	expect(existsSync(from)).toBe(true);
	removeDatabase(to);
	moveDatabase(from, to);
	expect(existsSync(`${to}-journal`)).toBe(true);
	expect(existsSync(`${from}-journal`)).toBe(false);
});
