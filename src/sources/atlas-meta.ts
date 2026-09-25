import type { Adapter } from "../core/types.ts";
import { type AtlasEntry, buildAtlas } from "./atlas.ts";

/** The atlas fields /api/meta adds to each feed. */
export interface AtlasMeta extends Omit<AtlasEntry, "stance"> {
	readonly stance?: string;
	/** "run": `added` is this machine's first run of the feed, not the day it joined Vigía. */
	readonly addedBy?: "run";
	/** Panel ids this feed is an input of. */
	readonly panels: readonly string[];
}

/**
 * Per-feed atlas metadata for /api/meta. The table part is static and built once; a feed not yet in the generated
 * dates table is dated by its first run here (`firstRunAt`), cached once known.
 */
export function atlasMeta(
	adapters: readonly Adapter[],
	panels: readonly { readonly id: string; readonly sources: readonly string[] }[],
	firstRunAt: (id: string) => number | null,
): (id: string) => AtlasMeta | Record<string, never> {
	const table = buildAtlas(adapters);
	const feeds = new Map<string, string[]>();
	for (const p of panels) {
		for (const s of p.sources) feeds.set(s, [...(feeds.get(s) ?? []), p.id]);
	}
	const seen = new Map<string, string>();
	return (id) => {
		const entry = table.get(id);
		if (!entry) return {};
		const { stance, ...rest } = entry;
		let added = rest.added;
		let addedBy: "run" | undefined;
		if (added === null) {
			const cached = seen.get(id);
			const t = cached ? null : firstRunAt(id);
			if (t !== null) seen.set(id, `${new Date(t).toISOString().slice(0, 16)}Z`);
			added = seen.get(id) ?? null;
			if (added) addedBy = "run";
		}
		return {
			...rest,
			added,
			...(addedBy ? { addedBy } : {}),
			...(stance ? { stance } : {}),
			panels: feeds.get(id) ?? [],
		};
	};
}
