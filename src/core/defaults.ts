import type { Adapter } from "./types.ts";

/**
 * Whether a feed is on before the user touches its switch, and how its default is explained, for a deployment mode.
 * `local`: a person's own Vigía; `public`: a read-only mirror (`--public`, VIGIA_MODE=public).
 *
 * - `defaultIn` decides when present (a feed on for a personal reader, off on a public mirror);
 * - otherwise a feed is on unless it is `optIn`.
 * The user's saved switch (config.json) always wins over the default.
 */
export type DeployMode = "local" | "public";

type Defaults = Pick<Adapter, "optIn" | "note" | "defaultIn">;
type Text = { readonly es: string; readonly en: string };

export function onByDefault(adapter: Defaults, mode: DeployMode): boolean {
	if (adapter.defaultIn) return adapter.defaultIn[mode];
	return adapter.optIn === undefined;
}

/**
 * The two texts the guide and /fuentes show, for this mode: `optIn` (off by default, and why) or `note` (on, with how
 * Vigía reads it). A per-mode feed shows its note where it is on, and the same text as the reason where it is off.
 */
export function defaultTexts(adapter: Defaults, mode: DeployMode): { optIn: Text | null; note: Text | null } {
	if (!adapter.defaultIn) return { optIn: adapter.optIn ?? null, note: adapter.note ?? null };
	const why = adapter.note ?? adapter.optIn ?? null;
	return adapter.defaultIn[mode] ? { optIn: null, note: why } : { optIn: why, note: null };
}
