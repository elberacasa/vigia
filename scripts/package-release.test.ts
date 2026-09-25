import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRelease, sha256File } from "./package-release.ts";

// Packing needs GNU tar, xz and zip, which the release workflow has (ubuntu); elsewhere the test says so and skips.
const tools = ["tar", "xz", "zip", "unzip"].every((t) => Bun.which(t) !== null);
const gnuTar = tools && Bun.spawnSync(["tar", "--version"]).stdout.toString().includes("GNU tar");

test.skipIf(!gnuTar)(
	"archives keep the executable bit, hold one folder with LICENSE and NOTICE, are reproducible, and SHA256SUMS covers every file",
	() => {
		const dir = mkdtempSync(join(tmpdir(), "vigia-pack-"));
		try {
			const dist = join(dir, "dist");
			Bun.spawnSync(["mkdir", "-p", dist]);
			writeFileSync(join(dist, "vigia-9.9.9-linux-x64"), "#!/bin/sh\necho linux\n");
			writeFileSync(join(dist, "vigia-9.9.9-windows-x64.exe"), "MZ fake");
			writeFileSync(join(dist, "unrelated.txt"), "not packed");
			const docs = { licence: join(dir, "LICENSE"), notice: join(dir, "NOTICE") };
			writeFileSync(docs.licence, "licence text");
			writeFileSync(docs.notice, "notice text");

			const packed = packageRelease(dist, docs, 1_790_000_000);
			expect(packed).toEqual([
				{ binary: "vigia-9.9.9-linux-x64", archive: "vigia-9.9.9-linux-x64.tar.xz" },
				{ binary: "vigia-9.9.9-windows-x64.exe", archive: "vigia-9.9.9-windows-x64.zip" },
			]);

			const listing = Bun.spawnSync(["tar", "-tvJf", join(dist, "vigia-9.9.9-linux-x64.tar.xz")])
				.stdout.toString()
				.trim()
				.split("\n");
			expect(listing.map((l) => l.split(/\s+/).at(-1))).toEqual([
				"vigia-9.9.9-linux-x64/",
				"vigia-9.9.9-linux-x64/LICENSE",
				"vigia-9.9.9-linux-x64/NOTICE",
				"vigia-9.9.9-linux-x64/vigia",
			]);
			expect(listing[3]).toStartWith("-rwxr-xr-x 0/0");

			const zip = Bun.spawnSync([
				"unzip",
				"-Z1",
				join(dist, "vigia-9.9.9-windows-x64.zip"),
			]).stdout.toString();
			expect(zip.trim().split("\n").sort()).toEqual([
				"vigia-9.9.9-windows-x64/",
				"vigia-9.9.9-windows-x64/LICENSE",
				"vigia-9.9.9-windows-x64/NOTICE",
				"vigia-9.9.9-windows-x64/vigia.exe",
			]);

			const sums = readFileSync(join(dist, "SHA256SUMS"), "utf8");
			const names = sums
				.trim()
				.split("\n")
				.map((l) => l.split("  ")[1]);
			expect(names).toEqual([
				"vigia-9.9.9-linux-x64",
				"vigia-9.9.9-linux-x64.tar.xz",
				"vigia-9.9.9-windows-x64.exe",
				"vigia-9.9.9-windows-x64.zip",
			]);
			expect(sums).toContain(
				`${sha256File(join(dist, "vigia-9.9.9-linux-x64.tar.xz"))}  vigia-9.9.9-linux-x64.tar.xz\n`,
			);

			// Same inputs, same archives (checksums a user can reproduce from the same binaries).
			packageRelease(dist, docs, 1_790_000_000);
			expect(readFileSync(join(dist, "SHA256SUMS"), "utf8")).toBe(sums);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);
