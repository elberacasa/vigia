import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashedName, hashMedia, plainName } from "./media.ts";

test("hashedName puts a content hash before the extension, and plainName takes it out", () => {
	const a = hashedName("map-still-dark.webp", new TextEncoder().encode("a"));
	expect(a).toMatch(/^map-still-dark\.[0-9a-f]{10}\.webp$/);
	expect(plainName(a)).toBe("map-still-dark.webp");
	expect(hashedName("x.webp", new TextEncoder().encode("b"))).not.toBe(
		hashedName("x.webp", new TextEncoder().encode("a")),
	);
	expect(plainName("hero.webm")).toBe("hero.webm");
});

test("hashMedia names files for their content, idempotently, and a fresh capture replaces the old one", () => {
	const dir = mkdtempSync(join(tmpdir(), "vigia-media-"));
	try {
		mkdirSync(join(dir, "crops"));
		writeFileSync(join(dir, "hero.webm"), "v1");
		writeFileSync(join(dir, "crops", "dinero.webp"), "c1");
		const first = hashMedia(dir);
		expect(Object.keys(first)).toEqual(["crops/dinero.webp", "hero.webm"]);
		expect(first["hero.webm"]).toBe(`/media/${hashedName("hero.webm", new TextEncoder().encode("v1"))}`);
		expect(hashMedia(dir)).toEqual(first);
		// A new capture under the plain name.
		writeFileSync(join(dir, "hero.webm"), "v2");
		const second = hashMedia(dir);
		expect(second["hero.webm"]).toBe(`/media/${hashedName("hero.webm", new TextEncoder().encode("v2"))}`);
		expect(readdirSync(dir).filter((n) => n.startsWith("hero."))).toHaveLength(1);
		expect(second["crops/dinero.webp"]).toBe(first["crops/dinero.webp"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
