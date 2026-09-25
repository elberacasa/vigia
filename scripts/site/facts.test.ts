import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { countTests, keyless, newsPublishers, offByDefault, panelIds, releaseFiles } from "./facts.ts";
import { rings } from "./map.ts";

const ROOT = join(import.meta.dir, "..", "..");

test("countTests counts test() and it() declarations, not mentions", () => {
	const src = [
		'test("a", () => {});',
		"\tit('b', async () => {});",
		'test.each([1, 2])("c %d", () => {});',
		'test.skipIf(x)("d", () => {});',
		'// a comment about test("x")',
		'const retest = 1; notatest("e");',
	].join("\n");
	expect(countTests(src)).toBe(4);
});

test("panelIds reads the wall's panel list from the client's layout module", () => {
	const ids = panelIds(readFileSync(join(ROOT, "web", "src", "lib", "layout.ts"), "utf8"));
	expect(ids).toContain("dinero");
	expect(ids).toContain("incidentes");
	expect(new Set(ids).size).toBe(ids.length);
	expect(() => panelIds("export const X = 1;")).toThrow();
});

test("keyless and newsPublishers follow their stated rules", () => {
	const a = (over: Record<string, unknown>) =>
		({ keys: [], layer: "money", provider: "P", id: "x", ...over }) as never;
	expect(keyless([a({}), a({ keys: ["K"] }), a({ optIn: { es: "", en: "" } })])).toBe(1);
	expect(
		newsPublishers([
			a({ layer: "news", provider: "A", id: "a1" }),
			a({ layer: "news", provider: "A", id: "a2" }),
			a({ layer: "news", provider: "B", id: "b" }),
			a({ layer: "news", provider: "YouTube", id: "youtube-live" }),
		]),
	).toBe(2);
});

test("rings turns the app's generated paths into closed polygon rings", () => {
	expect(rings("M10 20l5 0l0 5l-5 0zM100 100l1 0l0 1z")).toEqual([
		[10, 20, 15, 20, 15, 25, 10, 25],
		[100, 100, 101, 100, 101, 101],
	]);
});

test("releaseFiles reads the downloads table of the release notes, one archive per target", () => {
	const notes = [
		"| Sistema | Descarga | Tamaño | Cómo abrirlo |",
		"|---|---|---|---|",
		"| Windows (x64) | `vigia-0.1.0-windows-x64.zip` | 42 MB | clic derecho |",
		"| macOS (Intel) | `vigia-0.1.0-darwin-x64.tar.xz` | 23 MB | `tar -xf …` |",
		"| Windows (x64) | `vigia-0.1.0-windows-x64.zip` | 42 MB | the English table repeats it |",
		"Also `vigia-0.1.0-linux-x64` uncompressed (not a table row).",
	].join("\n");
	expect(releaseFiles(notes, "0.1.0")).toEqual([
		{ target: "windows-x64", file: "vigia-0.1.0-windows-x64.zip", format: "zip", mb: 42 },
		{ target: "darwin-x64", file: "vigia-0.1.0-darwin-x64.tar.xz", format: "tar.xz", mb: 23 },
	]);
	expect(() => releaseFiles(notes, "0.2.0")).toThrow();
	expect(() => releaseFiles("no table", "0.1.0")).toThrow();
});

test("the current release notes list an archive for every build target", () => {
	const version = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string })
		.version;
	const notes = readFileSync(join(ROOT, "docs", "releases", `v${version}.md`), "utf8");
	const targets = releaseFiles(notes, version).map((f) => f.target);
	expect(targets.sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-x64"]);
});

test("offByDefault marks publishers whose every feed needs a key or an opt-in", () => {
	const a = (provider: string, over: Record<string, unknown> = {}) =>
		({ keys: [], provider, id: provider, ...over }) as never;
	expect(
		offByDefault([
			a("Open"),
			a("Keyed", { keys: ["K"] }),
			a("Opt", { optIn: { es: "", en: "" } }),
			a("Mixed", { keys: ["K"] }),
			a("Mixed", { id: "m2" }),
		]),
	).toEqual({ Keyed: "key", Opt: "opt-in" });
});
