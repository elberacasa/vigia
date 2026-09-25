import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSessionToken, readCookie, sameToken, sessionCookieName } from "./session.ts";

test("the session token is created once, 0600, and reused on the next launch", () => {
	const dir = mkdtempSync(join(tmpdir(), "vigia-session-"));
	try {
		const first = loadSessionToken(join(dir, "cfg"));
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(loadSessionToken(join(dir, "cfg"))).toBe(first);
		const path = join(dir, "cfg", "session-token");
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
		// A damaged file is replaced by a fresh token.
		writeFileSync(path, "not a token");
		const fresh = loadSessionToken(join(dir, "cfg"));
		expect(fresh).not.toBe(first);
		expect(readFileSync(path, "utf8").trim()).toBe(fresh);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cookie helpers", () => {
	const t = "ab".repeat(32);
	expect(sessionCookieName(t)).toMatch(/^vigia_session_[0-9a-f]{8}$/);
	expect(sessionCookieName(t)).not.toBe(sessionCookieName("cd".repeat(32)));
	expect(readCookie("a=1; vigia_x=2 ;b=3", "vigia_x")).toBe("2");
	expect(readCookie(null, "a")).toBeNull();
	expect(sameToken(t, t)).toBe(true);
	expect(sameToken(t, t.slice(1))).toBe(false);
	expect(sameToken(t, null)).toBe(false);
});
