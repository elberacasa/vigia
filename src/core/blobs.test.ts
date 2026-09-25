import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore, blobKey } from "./blobs.ts";

const dirs: string[] = [];
function root(): string {
	const dir = mkdtempSync(join(tmpdir(), "vigia-blobs-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill);
const policy = { maxEntries: 3, maxBytes: 1_000, maxAgeMs: null };

test("keys are deterministic, name-prefixed and change with any part", () => {
	expect(blobKey("20262671600", "abc", "v1")).toBe(blobKey("20262671600", "abc", "v1"));
	expect(blobKey("20262671600", "abc", "v1")).toMatch(/^20262671600-[0-9a-f]{16}$/);
	expect(blobKey("20262671600", "abc", "v2")).not.toBe(blobKey("20262671600", "abc", "v1"));
	expect(blobKey("x", "ab", "c")).not.toBe(blobKey("x", "a", "bc"));
	expect(() => blobKey("../etc", "a")).toThrow();
});

test("put stores bytes and metadata atomically; read serves them back", () => {
	const store = new BlobStore(root(), () => 5_000);
	const sink = store.scope("goes-nsa", policy);
	const key = blobKey("f1", "src");
	const meta = sink.put(key, bytes(10), {
		name: "f1",
		contentType: "image/jpeg",
		observedAt: 4_000,
		width: 2,
	});
	expect(meta).toMatchObject({
		key,
		name: "f1",
		bytes: 10,
		contentType: "image/jpeg",
		width: 2,
		createdAt: 5_000,
	});
	expect(sink.has(key)).toBe(true);
	expect(sink.find("f1")?.key).toBe(key);
	const found = store.read("goes-nsa", key);
	expect(found?.path.endsWith(`${key}.jpg`)).toBe(true);
	expect(readdirSync(join(store.root, "goes-nsa")).some((f) => f.includes(".tmp-"))).toBe(false);
});

test("an existing key is never rewritten; a new key for the same name replaces the old one", () => {
	const store = new BlobStore(root());
	const sink = store.scope("s", policy);
	const k1 = blobKey("n", "a");
	sink.put(k1, bytes(10, 1), { name: "n", contentType: "image/png", observedAt: 1 });
	sink.put(k1, bytes(12, 2), { name: "n", contentType: "image/png", observedAt: 1 });
	expect(store.read("s", k1)?.meta.bytes).toBe(10);
	const k2 = blobKey("n", "b");
	sink.put(k2, bytes(11), { name: "n", contentType: "image/png", observedAt: 1 });
	expect(store.read("s", k1)).toBeNull();
	expect(sink.list().map((m) => m.key)).toEqual([k2]);
});

test("retention keeps the newest by observedAt within entries, bytes and age", () => {
	let now = 100_000;
	const store = new BlobStore(root(), () => now);
	const sink = store.scope("s", { maxEntries: 3, maxBytes: 250, maxAgeMs: 50_000 });
	for (let i = 0; i < 5; i++) {
		sink.put(blobKey(`f${i}`, "x"), bytes(100), {
			name: `f${i}`,
			contentType: "image/jpeg",
			observedAt: 90_000 + i,
		});
	}
	// 250 bytes allow only two of 100 bytes.
	expect(sink.list().map((m) => m.name)).toEqual(["f4", "f3"]);
	now = 200_000;
	sink.put(blobKey("new", "x"), bytes(100), { name: "new", contentType: "image/jpeg", observedAt: 199_000 });
	expect(sink.list().map((m) => m.name)).toEqual(["new"]);
	expect(readdirSync(join(store.root, "s")).sort()).toHaveLength(2);
});

test("sources are isolated and names, keys and sources are validated", () => {
	const store = new BlobStore(root());
	const a = store.scope("a", policy);
	const key = blobKey("f", "x");
	a.put(key, bytes(3), { name: "f", contentType: "image/jpeg", observedAt: 1 });
	expect(store.read("b", key)).toBeNull();
	expect(() => store.scope("../a", policy)).toThrow();
	expect(() => a.put("f-..", bytes(3), { name: "f", contentType: "image/jpeg", observedAt: 1 })).toThrow();
	expect(() =>
		a.put(blobKey("g", "x"), bytes(3), { name: "f", contentType: "image/jpeg", observedAt: 1 }),
	).toThrow();
	expect(() =>
		a.put(key, new Uint8Array(0), { name: "f", contentType: "image/jpeg", observedAt: 1 }),
	).toThrow();
	for (const bad of ["..", "../a/f", "f.jpg", "", "a/b", "%2e%2e"]) expect(store.read("a", bad)).toBeNull();
});

test("metadata without bytes is not served; old orphans and temp files are swept", () => {
	const store = new BlobStore(root(), () => Date.now());
	const sink = store.scope("s", policy);
	const key = blobKey("f", "x");
	sink.put(key, bytes(3), { name: "f", contentType: "image/jpeg", observedAt: Date.now() });
	rmSync(join(store.root, "s", `${key}.jpg`));
	expect(store.read("s", key)).toBeNull();
	const dir = join(store.root, "s");
	writeFileSync(join(dir, "orphan-1.jpg"), "x");
	writeFileSync(join(dir, "g-1.json.tmp-abc"), "x");
	const old = new Date(Date.now() - 2 * 3_600_000);
	utimesSync(join(dir, "orphan-1.jpg"), old, old);
	utimesSync(join(dir, "g-1.json.tmp-abc"), old, old);
	sink.put(blobKey("h", "x"), bytes(3), { name: "h", contentType: "image/jpeg", observedAt: Date.now() });
	expect(existsSync(join(dir, "orphan-1.jpg"))).toBe(false);
	expect(existsSync(join(dir, "g-1.json.tmp-abc"))).toBe(false);
});

test("the byte cap never leaves holes: once reached, everything older goes", () => {
	const store = new BlobStore(root(), () => 1_000);
	const sink = store.scope("s", { maxEntries: 10, maxBytes: 250, maxAgeMs: null });
	const put = (name: string, size: number, at: number) =>
		sink.put(blobKey(name, "x"), bytes(size), { name, contentType: "image/jpeg", observedAt: at });
	put("old-small", 10, 1);
	put("mid-big", 200, 2);
	put("new", 100, 3);
	// new (100) fits, mid-big (200) would exceed 250: it and the older small one both go.
	expect(sink.list().map((m) => m.name)).toEqual(["new"]);
});
