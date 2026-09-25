/**
 * The landing page's numbers, derived from the code at build time (never typed by hand). Each carries the sentence
 * that says how it was measured, which the page prints under it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ADAPTERS } from "../../src/adapters/registry.ts";
import type { Adapter } from "../../src/core/types.ts";
import { PANELS } from "../../src/server/panel-registry.ts";

/** Adapters that measure broadcasters' availability rather than publish news themselves. */
const NOT_PUBLISHERS = new Set(["youtube-live", "radio-streams"]);

export interface Facts {
	/** Adapters in the registry. */
	sources: number;
	/** Adapters that work with no key and are on by default (the same rule as the README's sources block). */
	keyless: number;
	/** Distinct publishers behind the news feeds. */
	newsPublishers: number;
	/** Panels on the wall (web/src/lib/layout.ts PANEL_IDS), besides the map. */
	panels: number;
	panelIds: string[];
	/**
	 * `test(`/`it(` declarations in *.test.ts files under src, web and scripts, counting only the files the public
	 * repository ships (the public export drops its own tooling's tests), so a reader who clones it finds the same.
	 */
	tests: number;
	testFiles: number;
	/** Distinct licences the adapters declare. */
	licences: number;
	/** Publisher names per server panel id (src/server/panel-registry.ts), in registry order. */
	providers: Record<string, string[]>;
	/**
	 * Publishers that are off by default: every adapter of theirs needs a key ("key") or is opt-in ("opt-in"). The
	 * page marks them so a list of publishers never reads as what a fresh install shows.
	 */
	offByDefault: Record<string, "key" | "opt-in">;
}

/** How a publisher's adapters start: all keyed, all opt-in (or keyed), or at least one on by default. */
export function offByDefault(adapters: readonly Adapter[]): Record<string, "key" | "opt-in"> {
	const by = new Map<string, Adapter[]>();
	for (const a of adapters) by.set(a.provider, [...(by.get(a.provider) ?? []), a]);
	const out: Record<string, "key" | "opt-in"> = {};
	for (const [provider, list] of by) {
		if (list.every((a) => a.keys.length > 0)) out[provider] = "key";
		else if (list.every((a) => a.keys.length > 0 || a.optIn)) out[provider] = "opt-in";
	}
	return out;
}

/** One file of a release, as its notes list it. */
export interface ReleaseFile {
	/** The build target: windows-x64, darwin-arm64, darwin-x64, linux-x64, linux-arm64. */
	target: string;
	file: string;
	format: "zip" | "tar.xz";
	/** Size in megabytes, as the notes print it. */
	mb: number;
}

/**
 * The downloads table of a release's notes (docs/releases/v<version>.md, the notes GitHub shows): archive name and
 * size per target, so the landing page's install tabs say exactly what the release page offers.
 */
export function releaseFiles(notes: string, version: string): ReleaseFile[] {
	const out: ReleaseFile[] = [];
	const seen = new Set<string>();
	const row =
		/^\|[^|\n]*\|\s*`(vigia-([\d.]+)-([a-z0-9-]+)\.(zip|tar\.xz))`\s*\|\s*(\d+(?:[.,]\d+)?)\s*MB\s*\|/gm;
	for (const m of notes.matchAll(row)) {
		const [, file = "", v = "", target = "", format = "", mb = ""] = m;
		if (v !== version) throw new Error(`release notes list ${file}, not version ${version}`);
		if (seen.has(target)) continue;
		seen.add(target);
		out.push({ target, file, format: format as ReleaseFile["format"], mb: Number(mb.replace(",", ".")) });
	}
	if (out.length === 0) throw new Error("no downloads table found in the release notes");
	return out;
}

/** The licence an adapter declares, for a figure captured from it. */
export function licenceOf(
	adapters: readonly Adapter[],
	feed: string,
): { id: string; name: string; url: string } {
	const a = adapters.find((x) => x.id === feed);
	if (!a) throw new Error(`no adapter "${feed}" in the registry`);
	return { id: a.licence.id, name: a.licence.name, url: a.licence.url };
}

export function keyless(adapters: readonly Adapter[]): number {
	return adapters.filter((a) => a.keys.length === 0 && !a.optIn).length;
}

export function newsPublishers(adapters: readonly Adapter[]): number {
	return new Set(
		adapters.filter((a) => a.layer === "news" && !NOT_PUBLISHERS.has(a.id)).map((a) => a.provider),
	).size;
}

/** The wall's panel ids, read from the client's layout module's source (it needs a browser to import). */
export function panelIds(layoutSource: string): string[] {
	const block = /export const PANEL_IDS = \[([\s\S]*?)\] as const/.exec(layoutSource)?.[1];
	if (!block) throw new Error("PANEL_IDS not found in web/src/lib/layout.ts");
	return [...block.matchAll(/"([a-z-]+)"/g)].map((m) => m[1] ?? "").filter(Boolean);
}

/** Counts test declarations (`test(`, `it(`, `test.each(...)(`) in a test file's source. */
export function countTests(source: string): number {
	return source.match(/^[ \t]*(?:test|it)(?:\.(?:each|skipIf|if)\([^)]*\))?\(\s*["'`]/gm)?.length ?? 0;
}

function testFiles(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === "dist" || name === "fixtures") continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) testFiles(path, out);
		else if (name.endsWith(".test.ts")) out.push(path);
	}
	return out;
}

/**
 * @param shipped whether a repository path ships in the public repository (scripts/export/policy.ts isPublic, which
 *   the public repository itself does not have: there, every file ships).
 */
export function facts(root: string, shipped: (path: string) => boolean = () => true): Facts {
	const files = ["src", "web", "scripts"]
		.flatMap((d) => testFiles(join(root, d)))
		.filter((f) => shipped(relativeTo(root, f)));
	const byId = new Map(ADAPTERS.map((a) => [a.id, a]));
	const providers: Record<string, string[]> = {};
	for (const p of PANELS) {
		providers[p.id] = [...new Set(p.sources.map((s) => byId.get(s)?.provider ?? s))];
	}
	const ids = panelIds(readFileSync(join(root, "web", "src", "lib", "layout.ts"), "utf8"));
	return {
		sources: ADAPTERS.length,
		keyless: keyless(ADAPTERS),
		newsPublishers: newsPublishers(ADAPTERS),
		panels: ids.length,
		panelIds: ids,
		tests: files.reduce((n, f) => n + countTests(readFileSync(f, "utf8")), 0),
		testFiles: files.length,
		licences: new Set(ADAPTERS.map((a) => a.licence.name)).size,
		providers,
		offByDefault: offByDefault(ADAPTERS),
	};
}

/** An interface as written in src/core/types.ts, for the developers section (tabs as two spaces). */
export function contract(root: string, name: "Adapter" | "Observation"): string {
	const src = readFileSync(join(root, "src", "core", "types.ts"), "utf8");
	const start = src.indexOf(`export interface ${name}<`);
	const end = src.indexOf("\n}\n", start);
	if (start < 0 || end < 0) throw new Error(`${name} interface not found in src/core/types.ts`);
	let text = src.slice(start, end + 2);
	// Readable on a phone: the Adapter's two optional members lose their long comments; the Observation keeps
	// only its fields.
	text =
		name === "Adapter"
			? text.replace(/\n\t\/\*\*(?:(?!\*\/)[\s\S])*\*\/(?=\n\treadonly (?:optIn|blobs))/g, "")
			: text.replace(/\n\t\/\*\*(?:(?!\*\/)[\s\S])*\*\//g, "");
	return text.replace(/\t/g, "  ");
}

export const relativeTo = (root: string, path: string) => relative(root, path).split("\\").join("/");
