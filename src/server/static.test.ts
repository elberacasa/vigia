import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticServer } from "./static.ts";

test("review 4 M8: a previous build's hashed chunk is still served after an upgrade; nothing else is", async () => {
	const base = mkdtempSync(join(tmpdir(), "vigia-static-"));
	const root = join(base, "dist");
	mkdirSync(root);
	mkdirSync(`${root}-previous`);
	writeFileSync(join(root, "index.html"), "<!doctype html>new");
	writeFileSync(join(root, "Money-newhash1.js"), "new");
	writeFileSync(join(`${root}-previous`, "Money-oldhash1.js"), "old");
	writeFileSync(join(`${root}-previous`, "notes.txt"), "not served");
	const serve = staticServer(root);
	const old = await serve("/Money-oldhash1.js");
	expect(await old?.text()).toBe("old");
	expect(old?.headers.get("cache-control")).toContain("immutable");
	expect(await (await serve("/Money-newhash1.js"))?.text()).toBe("new");
	expect(await serve("/notes.txt")).toBeNull();
	expect(await serve("/Money-gonehash.js")).toBeNull();
	expect(await serve("/../dist-previous/Money-oldhash1.js")).toBeNull();
});
