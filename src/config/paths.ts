import { homedir } from "node:os";
import { join } from "node:path";

export interface Paths {
	/** Settings and keys. */
	readonly config: string;
	/** Database and caches. */
	readonly data: string;
}

/**
 * Per-OS locations, following each platform's convention:
 * Linux: XDG ($XDG_CONFIG_HOME, $XDG_DATA_HOME); macOS: ~/Library/Application Support;
 * Windows: %APPDATA% (config) and %LOCALAPPDATA% (data). VIGIA_HOME overrides both (portable mode).
 */
export function resolvePaths(
	env: Readonly<Record<string, string | undefined>> = process.env,
	platform: NodeJS.Platform = process.platform,
	home: string = homedir(),
): Paths {
	const override = env.VIGIA_HOME;
	if (override) return { config: override, data: join(override, "data") };
	if (platform === "win32") {
		const roaming = env.APPDATA ?? join(home, "AppData", "Roaming");
		const local = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
		return { config: join(roaming, "Vigia"), data: join(local, "Vigia") };
	}
	if (platform === "darwin") {
		const base = join(home, "Library", "Application Support", "Vigia");
		return { config: base, data: join(base, "data") };
	}
	const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
	const dataHome = env.XDG_DATA_HOME || join(home, ".local", "share");
	return { config: join(configHome, "vigia"), data: join(dataHome, "vigia") };
}
