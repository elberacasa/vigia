import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dir, "..");

/** Class names written in `class="…"` or `` class={`…`} `` in the .tsx files of a directory (recursive). */
function classesIn(dir: string, pick: RegExp): Set<string> {
	const out = new Set<string>();
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) for (const c of classesIn(p, pick)) out.add(c);
		else if (e.name.endsWith(".tsx"))
			for (const m of readFileSync(p, "utf8").matchAll(pick))
				for (const c of (m[1] as string).split(/[\s`${}]+/)) if (/^[a-z][\w-]*$/.test(c)) out.add(c);
	}
	return out;
}

/**
 * A page's container class must not also name an element inside a panel. `<main class="page place">` once shared
 * `.place` with the connectivity panel's rows (a three-column grid in panels.css): when that stylesheet loaded on
 * scroll, the whole place page collapsed into a 70 px column on phones.
 */
test("page containers use class names no panel element uses", () => {
	const pages = classesIn(join(WEB, "pages"), /<main class="([^"]+)"/g);
	pages.delete("page");
	expect(pages.size).toBeGreaterThan(0);
	const panels = classesIn(join(WEB, "panels"), /class(?:Name)?=[{"`]+([^"}]+)/g);
	expect(panels.has("place")).toBe(true); // the connectivity row this test was written for
	expect([...pages].filter((c) => panels.has(c))).toEqual([]);
});
