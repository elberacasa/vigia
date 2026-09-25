import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * Keys live only on the user's machine: in keys.json (mode 600 where the OS supports it) or in environment
 * variables (a developer's .env). They are never logged, never sent to the browser (only "set / not set"),
 * and only ever sent to the provider they belong to.
 */

const KeyFile = z.record(z.string(), z.string().min(1).max(512));

export interface KeyStore {
	get(id: string): string | undefined;
	has(id: string): boolean;
	set(id: string, value: string): void;
	remove(id: string): void;
	/** Where each key comes from, for the UI. Never the value. */
	origin(id: string): "file" | "env" | null;
}

export function envVarFor(id: string): string {
	return id.toUpperCase().replaceAll("-", "_");
}

export function openKeyStore(
	configDir: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
): KeyStore {
	const path = join(configDir, "keys.json");
	let saved: Record<string, string> = {};
	if (existsSync(path)) {
		const parsed = KeyFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
		if (!parsed.success)
			throw new Error(`keys.json no es válido: ${path}. Bórralo y vuelve a añadir tus claves.`);
		saved = parsed.data;
	}

	const persist = () => {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
		if (process.platform !== "win32") chmodSync(tmp, 0o600);
		renameSync(tmp, path);
	};

	const fromEnv = (id: string) => {
		const value = env[envVarFor(id)]?.trim();
		return value ? value : undefined;
	};

	return {
		get: (id) => saved[id] ?? fromEnv(id),
		has: (id) => Boolean(saved[id] ?? fromEnv(id)),
		set: (id, value) => {
			saved[id] = value.trim();
			persist();
		},
		remove: (id) => {
			delete saved[id];
			persist();
		},
		origin: (id) => (saved[id] ? "file" : fromEnv(id) ? "env" : null),
	};
}

/** Masks a key for display: never more than the last 4 characters. */
export function maskKey(value: string): string {
	if (value.length <= 8) return "••••";
	return `••••${value.slice(-4)}`;
}
