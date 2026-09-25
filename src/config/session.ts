import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The local session token: the proof that a browser was opened by the person at this machine.
 *
 * The loopback, Host and Origin checks cannot tell the user's browser from a request relayed by a reverse proxy
 * on the same machine (nginx sends `Host: 127.0.0.1` from 127.0.0.1 by default, and any client can forge Origin).
 * The token closes that gap: it is random, stored once in a 0600 file in the config directory next to keys.json,
 * printed by the CLI inside the URL it opens, and exchanged by the server for an HttpOnly, SameSite=Strict cookie.
 * Every write then needs that cookie on top of the other checks. Reads stay open.
 */

const FILE = "session-token";
const TOKEN = /^[0-9a-f]{64}$/;

export function loadSessionToken(configDir: string): string {
	const path = join(configDir, FILE);
	if (existsSync(path)) {
		const saved = readFileSync(path, "utf8").trim();
		if (TOKEN.test(saved)) {
			// A copied or restored file may have lost its mode; tighten it again.
			if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
			return saved;
		}
	}
	mkdirSync(configDir, { recursive: true });
	const token = randomBytes(32).toString("hex");
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
	if (process.platform !== "win32") chmodSync(tmp, 0o600);
	renameSync(tmp, path);
	return token;
}

/**
 * The cookie name carries a short fingerprint of the token, so two Vigía instances on different ports of the same
 * host (cookies ignore ports) keep separate cookies instead of overwriting each other's.
 */
export function sessionCookieName(token: string): string {
	return `vigia_session_${createHash("sha256").update(token).digest("hex").slice(0, 8)}`;
}

export function sameToken(expected: string, given: string | null | undefined): boolean {
	if (!given) return false;
	const a = Buffer.from(expected);
	const b = Buffer.from(given);
	return a.length === b.length && timingSafeEqual(a, b);
}

/** Reads one cookie value from a Cookie header (no decoding: the token is hex). */
export function readCookie(header: string | null, name: string): string | null {
	if (!header) return null;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
	}
	return null;
}
