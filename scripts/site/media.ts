/**
 * Content-hashed names for the landing page's captured media (site/public/media), so a browser that cached a file for
 * a year (it is served `immutable`) still gets a new capture the moment the page points at it:
 *
 *   crops/dinero.webp  →  crops/dinero.3f9a0c2e71.webp
 *
 * and site/src/data/media-files.json maps each plain name to its hashed URL, which the page reads. Idempotent: a
 * file already named for its content stays; a new capture under the plain name replaces the older hashed file.
 *
 *   bun scripts/site/media.ts          (site-capture.ts runs it after every capture)
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const HASHED = /^(.+)\.([0-9a-f]{10})(\.[a-z0-9]+)$/;

/** The plain name of a possibly hashed file name. */
export function plainName(name: string): string {
	const m = HASHED.exec(name);
	return m ? `${m[1]}${m[3]}` : name;
}

export function hashedName(name: string, content: Uint8Array): string {
	const hash = createHash("sha256").update(content).digest("hex").slice(0, 10);
	const dot = name.lastIndexOf(".");
	return `${name.slice(0, dot)}.${hash}${name.slice(dot)}`;
}

function files(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) files(path, out);
		else out.push(path);
	}
	return out;
}

/**
 * Renames every file under `dir` to its content-hashed name and returns the manifest: plain path (relative to
 * `dir`) → URL under `urlBase`. A plain-named file (a fresh capture) wins over an older hashed file of the same name.
 */
export function hashMedia(dir: string, urlBase = "/media"): Record<string, string> {
	const all = files(dir);
	const byPlain = new Map<string, string[]>();
	for (const path of all) {
		const rel = relative(dir, path).split("\\").join("/");
		const slash = rel.lastIndexOf("/");
		const plain = rel.slice(0, slash + 1) + plainName(rel.slice(slash + 1));
		byPlain.set(plain, [...(byPlain.get(plain) ?? []), path]);
	}
	const manifest: Record<string, string> = {};
	for (const [plain, paths] of [...byPlain].sort(([a], [b]) => a.localeCompare(b))) {
		const fresh = paths.find((p) => relative(dir, p).split("\\").join("/") === plain);
		const keep = fresh ?? paths[0];
		if (!keep) continue;
		const target = join(dir, hashedName(plain, new Uint8Array(readFileSync(keep))));
		if (keep !== target) renameSync(keep, target);
		for (const p of paths) if (p !== keep && p !== target) rmSync(p);
		manifest[plain] = `${urlBase}/${relative(dir, target).split("\\").join("/")}`;
	}
	return manifest;
}

if (import.meta.main) {
	const root = join(import.meta.dir, "..", "..");
	const manifest = hashMedia(join(root, "site", "public", "media"));
	writeFileSync(
		join(root, "site", "src", "data", "media-files.json"),
		`${JSON.stringify(manifest, null, "\t")}\n`,
	);
	console.log(`media: ${Object.keys(manifest).length} files, content-hashed`);
}
