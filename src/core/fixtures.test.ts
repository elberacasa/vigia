import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasFixture, loadFixture, saveFixture } from "./fixtures.ts";

test("binary responses are saved as real bytes and replayed as base64; text stays text", () => {
	const dir = mkdtempSync(join(tmpdir(), "vigia-fixture-"));
	try {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
		const raws = [
			{
				url: "https://a/x.png",
				status: 200,
				contentType: "image/png",
				body: png.toString("base64"),
				fetchedAt: 1,
			},
			{ url: "https://a/x.xml", status: 200, contentType: "text/xml", body: "<a>é</a>", fetchedAt: 2 },
		];
		saveFixture(dir, raws);
		expect(readFileSync(join(dir, "00.png"))).toEqual(png);
		expect(loadFixture(dir)).toEqual(raws);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("hasFixture: a directory needs its manifest; a file only needs to exist", () => {
	const dir = mkdtempSync(join(tmpdir(), "vigia-fixture-"));
	try {
		expect(hasFixture(dir)).toBe(false);
		expect(hasFixture(join(dir, "feed.xml"))).toBe(false);
		writeFileSync(join(dir, "feed.xml"), "<rss/>");
		expect(hasFixture(join(dir, "feed.xml"))).toBe(true);
		saveFixture(dir, [
			{ url: "https://a/", status: 200, contentType: "text/plain", body: "x", fetchedAt: 1 },
		]);
		expect(hasFixture(dir)).toBe(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
