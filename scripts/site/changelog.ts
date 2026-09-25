/**
 * The landing page's changelog (site/src/data/changelog.json), read from CHANGELOG.md (Keep a Changelog) and each
 * version's release notes (docs/releases/v<version>.md). Adding a version to CHANGELOG.md and running
 * `bun scripts/site-data.ts` is all the page needs; a test fails if the JSON falls behind CHANGELOG.md.
 *
 * - CHANGELOG.md gives the versions, their dates and the grouped items (Added, Changed, Fixed, ...), in English.
 * - The release notes give the short bilingual summary GitHub shows: the "Qué cambia en X" / "What changes in X"
 *   bullets (for the first release, "Lo principal" / "Highlights"), and the downloads table.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ReleaseFile, releaseFiles } from "./facts.ts";

export interface ChangeGroup {
	/** The heading as written ("Added", "Fixed (found running the release binary as a new user)"). */
	title: string;
	/** The Keep a Changelog kind it starts with, lower case ("added", "changed", "fixed", ...), or "other". */
	kind: string;
	/** Items as Markdown (inline only: bold, code, links), continuation lines joined. */
	items: string[];
}

export interface Version {
	version: string;
	/** ISO date (YYYY-MM-DD), as the changelog heading gives it. */
	date: string;
	/** Free text under the heading, before the first group (Markdown, may be empty). */
	intro: string;
	groups: ChangeGroup[];
	/** The release notes' summary bullets for this version, per language (Markdown). Empty if there are no notes. */
	highlights: { es: string[]; en: string[] };
	/** The topics of the highlights (their bold lead-ins), for a one-line summary. */
	topics: { es: string[]; en: string[] };
	/** The downloads table of this version's notes (empty when there are none). */
	downloads: ReleaseFile[];
	/** Path of the notes in the repository, when they exist. */
	notes: string | null;
}

const KINDS = ["added", "changed", "deprecated", "removed", "fixed", "security", "known limits"];

/** Joins wrapped list items: a line indented under a "- " item continues it. */
function listItems(lines: readonly string[]): string[] {
	const items: string[] = [];
	for (const line of lines) {
		const m = /^[-*]\s+(.*)$/.exec(line);
		if (m) items.push((m[1] ?? "").trim());
		else if (/^\s+\S/.test(line) && items.length > 0) items[items.length - 1] += ` ${line.trim()}`;
	}
	return items;
}

/** Every released version in CHANGELOG.md, in file order (newest first). "Unreleased" is skipped. */
export function parseChangelog(
	text: string,
): Omit<Version, "highlights" | "topics" | "downloads" | "notes">[] {
	const out: Omit<Version, "highlights" | "topics" | "downloads" | "notes">[] = [];
	const blocks = text.split(/^## /m).slice(1);
	for (const block of blocks) {
		const [head = "", ...body] = block.split("\n");
		const m = /^\[(\d+\.\d+\.\d+(?:-[\w.]+)?)\]\s*-\s*(\d{4}-\d{2}-\d{2})\s*$/.exec(head.trim());
		if (!m) {
			if (/^\[unreleased\]/i.test(head.trim())) continue;
			throw new Error(`CHANGELOG.md: unexpected heading "## ${head.trim()}"`);
		}
		const groups: ChangeGroup[] = [];
		const intro: string[] = [];
		let current: { title: string; lines: string[] } | null = null;
		const flush = () => {
			if (!current) return;
			const items = listItems(current.lines);
			const lower = current.title.toLowerCase();
			if (items.length > 0)
				groups.push({ title: current.title, kind: KINDS.find((k) => lower.startsWith(k)) ?? "other", items });
		};
		for (const line of body) {
			const g = /^###\s+(.+)$/.exec(line);
			if (g) {
				flush();
				current = { title: (g[1] ?? "").trim(), lines: [] };
			} else if (current) current.lines.push(line);
			else if (line.trim() && !/^Release notes/i.test(line.trim())) intro.push(line.trim());
		}
		flush();
		// The link to the notes is the page's own button; the sentence that introduces it goes with it.
		const text = intro
			.join(" ")
			.replace(/\s*Release notes\b.*$/is, "")
			.trim();
		out.push({ version: m[1] ?? "", date: m[2] ?? "", intro: text, groups });
	}
	return out;
}

/** The bullets under the first heading of `notes` that matches, up to the next heading. */
function section(notes: string, headings: readonly RegExp[]): string[] {
	const lines = notes.split("\n");
	for (const h of headings) {
		const start = lines.findIndex((l) => h.test(l));
		if (start < 0) continue;
		const end = lines.findIndex((l, i) => i > start && /^#{1,2}\s/.test(l));
		return listItems(lines.slice(start + 1, end < 0 ? undefined : end));
	}
	return [];
}

const esc = (v: string) => v.replace(/\./g, "\\.");

/** The version's own summary, from the newest notes that describe it (each release's notes repeat older ones). */
export function highlights(
	version: string,
	notesFiles: readonly string[],
	first: boolean,
): { es: string[]; en: string[] } {
	const es = [new RegExp(`^## Qué cambi(a|ó) en ${esc(version)}\\s*$`)];
	const en = [new RegExp(`^## What change(s|d) in ${esc(version)}\\s*$`)];
	// The first release has no "what changes" section: its highlights are the release itself.
	if (first) {
		es.push(/^## Lo principal\s*$/);
		en.push(/^## Highlights\s*$/);
	}
	for (const notes of notesFiles) {
		const [spanish = "", english = ""] = notes.split(/^# .*\(English\)\s*$/m);
		const r = { es: section(spanish, es), en: section(english, en) };
		if (r.es.length > 0 || r.en.length > 0) return r;
	}
	return { es: [], en: [] };
}

/** "**Telegram:** 10 channels" → "Telegram". Items without a bold lead-in give no topic. */
export function topic(item: string): string | null {
	const m = /^\*\*([^*]+?)\*\*/.exec(item);
	return m ? (m[1] ?? "").replace(/[:.]\s*$/, "").trim() : null;
}

export function changelog(root: string): Version[] {
	const parsed = parseChangelog(readFileSync(join(root, "CHANGELOG.md"), "utf8"));
	const notesPath = (v: string) => `docs/releases/v${v}.md`;
	const read = (v: string) =>
		existsSync(join(root, notesPath(v))) ? readFileSync(join(root, notesPath(v)), "utf8") : null;
	const oldest = parsed.at(-1)?.version;
	return parsed.map((v, i) => {
		const own = read(v.version);
		// Its own notes first, then newer releases' notes (they carry "What changed in <older>").
		const newer = parsed
			.slice(0, i)
			.reverse()
			.map((x) => read(x.version))
			.filter((x): x is string => x !== null);
		const h = highlights(v.version, own ? [own, ...newer] : newer, v.version === oldest);
		const pick = (list: string[]) => list.map(topic).filter((x): x is string => x !== null);
		return {
			...v,
			highlights: h,
			topics: { es: pick(h.es), en: pick(h.en) },
			downloads: own ? releaseFiles(own, v.version) : [],
			notes: own ? notesPath(v.version) : null,
		};
	});
}

/** Anchor of a version on the page: 0.1.5 → "v0-1-5". */
export const anchor = (version: string) => `v${version.replace(/\./g, "-")}`;
