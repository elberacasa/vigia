import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireInstanceLock, lockHolder } from "./instance-lock.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const dir = () => {
	const d = mkdtempSync(join(tmpdir(), "vigia-lock-"));
	dirs.push(d);
	return d;
};

test("one holder per data directory; the second is refused with the first's pid; release frees it (review 4 L5)", () => {
	const d = dir();
	expect(lockHolder(d)).toBe(false);
	const first = acquireInstanceLock(d, 4242);
	expect(first.ok).toBe(true);
	expect(readFileSync(join(d, "vigia.pid"), "utf8").trim()).toBe("4242");
	const second = acquireInstanceLock(d, 4343);
	expect(second).toEqual({ ok: false, pid: 4242 });
	expect(lockHolder(d)).toBe(4242);
	if (first.ok) first.lock.release();
	expect(existsSync(join(d, "vigia.pid"))).toBe(false);
	expect(lockHolder(d)).toBe(false);
	const third = acquireInstanceLock(d);
	expect(third.ok).toBe(true);
	if (third.ok) third.lock.release();
});

test("another process is refused while this one holds the lock, and gets it once this one lets go", async () => {
	const d = dir();
	const held = acquireInstanceLock(d, process.pid);
	const script = `import { acquireInstanceLock } from ${JSON.stringify(join(import.meta.dir, "instance-lock.ts"))};
		const r = acquireInstanceLock(${JSON.stringify(d)}); console.log(JSON.stringify(r.ok ? "ok" : r.pid)); if (r.ok) r.lock.release();`;
	const run = async () => {
		const p = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "inherit" });
		return (await new Response(p.stdout).text()).trim();
	};
	expect(await run()).toBe(String(process.pid));
	if (held.ok) held.lock.release();
	expect(await run()).toBe('"ok"');
});

test("a holder that dies without releasing leaves no stale lock", async () => {
	const d = dir();
	const script = `import { acquireInstanceLock } from ${JSON.stringify(join(import.meta.dir, "instance-lock.ts"))};
		acquireInstanceLock(${JSON.stringify(d)}); process.exit(0);`;
	await Bun.spawn([process.execPath, "-e", script]).exited;
	// The pid file is left behind, but the OS dropped the lock with the process.
	expect(existsSync(join(d, "vigia.pid"))).toBe(true);
	expect(lockHolder(d)).toBe(false);
	const r = acquireInstanceLock(d);
	expect(r.ok).toBe(true);
	if (r.ok) r.lock.release();
});
