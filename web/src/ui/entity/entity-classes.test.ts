import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dir, "..", "..");
const OWN = join(import.meta.dir, "entity.css");

function stylesheets(dir: string, out: string[] = []): string[] {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) stylesheets(p, out);
		else if (e.name.endsWith(".css")) out.push(p);
	}
	return out;
}

/** Every class a stylesheet's selectors name. */
function classesOf(css: string): Set<string> {
	const out = new Set<string>();
	for (const block of css.replace(/\/\*[\s\S]*?\*\//g, "").split("{")) {
		const selector = block.split("}").at(-1) ?? "";
		for (const m of selector.matchAll(/\.([a-zA-Z][\w-]*)/g)) out.add(m[1] as string);
	}
	return out;
}

/**
 * Classes the entity stylesheet shares on purpose: utilities (btn, mono, data…), state flags, the map it frames, and
 * the page and inspector containers other stylesheets place things in.
 */
const SHARED = new Set([
	"btn",
	"data",
	"entity--page",
	"entity__main",
	"entpage",
	"icon-btn",
	"insp__label",
	"is-on",
	"is-open",
	"is-stale",
	"link-button",
	"map",
	"map__hover",
	"mono",
	"state-slot",
]);

/**
 * The entity page's own blocks (the key strip, the signals table, its rows and chips) must not be styled by any
 * other stylesheet: a global `.chip` once made every basis chip 26 px tall, and a shared `.place` collapsed the
 * page on phones (page-classes.test.ts). A new overlap is either renamed or added above on purpose.
 */
test("the entity view's classes are its own, except the ones shared on purpose", () => {
	const own = classesOf(readFileSync(OWN, "utf8"));
	expect(own.has("sigt")).toBe(true);
	const clashes: string[] = [];
	for (const file of stylesheets(WEB)) {
		if (file === OWN) continue;
		for (const c of classesOf(readFileSync(file, "utf8")))
			if (own.has(c) && !SHARED.has(c)) clashes.push(`${c} (${file.slice(WEB.length + 1)})`);
	}
	expect(clashes).toEqual([]);
});
