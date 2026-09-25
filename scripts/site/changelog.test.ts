import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anchor, changelog, highlights, parseChangelog, topic } from "./changelog.ts";

const ROOT = join(import.meta.dir, "..", "..");
const CHANGELOG = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");

const semver = (v: string) => v.split(/[.-]/).map((x) => Number(x));
const newer = (a: string, b: string) => {
	const [x, y] = [semver(a), semver(b)];
	for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
	return false;
};

test("the current CHANGELOG.md yields every released version, newest first", () => {
	const headings = [...CHANGELOG.matchAll(/^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/gm)].map(
		(m) => m[1],
	);
	const parsed = parseChangelog(CHANGELOG);
	expect(parsed.map((v) => v.version)).toEqual(headings as string[]);
	expect(parsed.length).toBeGreaterThanOrEqual(5);
	for (let i = 1; i < parsed.length; i++) {
		expect(newer(parsed[i - 1]?.version ?? "", parsed[i]?.version ?? "")).toBe(true);
		expect((parsed[i - 1]?.date ?? "") >= (parsed[i]?.date ?? "")).toBe(true);
	}
	for (const v of parsed) expect(v.groups.length).toBeGreaterThan(0);
});

test("the site's changelog.json is what CHANGELOG.md and the release notes say now (run bun scripts/site-data.ts)", () => {
	const json = JSON.parse(readFileSync(join(ROOT, "site", "src", "data", "changelog.json"), "utf8"));
	expect(json).toEqual(JSON.parse(JSON.stringify(changelog(ROOT))));
});

test("groups keep their items, wrapped lines joined, and their Keep a Changelog kind", () => {
	const [v] = parseChangelog(
		[
			"## [Unreleased]",
			"",
			"## [1.2.0] - 2026-10-01",
			"",
			"Intro line. Release notes: [x](docs/releases/v1.2.0.md).",
			"",
			"### Added",
			"- One thing that",
			"  wraps.",
			"- Another.",
			"",
			"### Fixed (found in testing)",
			"- A bug.",
			"",
			"Release notes: [docs/releases/v1.2.0.md](docs/releases/v1.2.0.md).",
		].join("\n"),
	);
	expect(v?.version).toBe("1.2.0");
	expect(v?.intro).toBe("Intro line.");
	expect(v?.groups).toEqual([
		{ title: "Added", kind: "added", items: ["One thing that wraps.", "Another."] },
		{ title: "Fixed (found in testing)", kind: "fixed", items: ["A bug."] },
	]);
	expect(() => parseChangelog("## Something else\n")).toThrow();
});

test("highlights come from the newest notes that describe the version, in both languages", () => {
	const notes = [
		"# Vigía 1.1.0",
		"## Qué cambia en 1.1.0",
		"- **Nuevo:** algo.",
		"## Qué cambió en 1.0.0",
		"- **Mapa:** otra cosa",
		"  que sigue.",
		"## Lo principal",
		"- **Todo**",
		"# Vigía 1.1.0 (English)",
		"## What changes in 1.1.0",
		"- **New:** something.",
		"## What changed in 1.0.0",
		"- **Map:** another thing.",
	].join("\n");
	expect(highlights("1.0.0", [notes], false)).toEqual({
		es: ["**Mapa:** otra cosa que sigue."],
		en: ["**Map:** another thing."],
	});
	expect(highlights("1.1.0", [notes], false).es).toEqual(["**Nuevo:** algo."]);
	expect(highlights("0.9.0", [notes], true).es).toEqual(["**Todo**"]);
	expect(topic("**Telegram:** 10 channels")).toBe("Telegram");
	expect(topic("no lead-in")).toBeNull();
	expect(anchor("0.1.5")).toBe("v0-1-5");
});

test("every version of the real changelog has a summary in Spanish and English", () => {
	for (const v of changelog(ROOT)) {
		expect(v.highlights.es.length).toBeGreaterThan(0);
		expect(v.highlights.en.length).toBe(v.highlights.es.length);
		expect(v.topics.es.length).toBeGreaterThan(0);
	}
});
