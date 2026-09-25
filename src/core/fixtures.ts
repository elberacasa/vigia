import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { RawResponse } from "./types.ts";

/**
 * Recorded fixtures: real responses saved byte-for-byte next to a manifest, so adapter tests replay exactly
 * what the source sent. Binary responses (images, fetched with `binary: true`, so their body is base64) are
 * saved as the real bytes (`.jpg`, `.png`) with `encoding: "base64"` in the manifest.
 */
const Manifest = z.array(
	z.object({
		file: z.string(),
		url: z.string(),
		status: z.number(),
		contentType: z.string(),
		fetchedAt: z.number(),
		encoding: z.literal("base64").optional(),
	}),
);

const IMAGE_EXTENSION: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
};

/**
 * Whether a recorded fixture is present: a fixture directory with its manifest, or a single fixture file.
 * Recorded fixtures of sources whose terms do not allow redistribution are not in the public repository; the tests
 * that replay them are skipped there, and each such adapter has a synthetic test that runs everywhere.
 */
export function hasFixture(pathToDirOrFile: string): boolean {
	if (!existsSync(pathToDirOrFile)) return false;
	return statSync(pathToDirOrFile).isDirectory() ? existsSync(join(pathToDirOrFile, "manifest.json")) : true;
}

export function loadFixture(dir: string): RawResponse[] {
	const manifest = Manifest.parse(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
	return manifest.map((entry) => ({
		url: entry.url,
		status: entry.status,
		contentType: entry.contentType,
		fetchedAt: entry.fetchedAt,
		body:
			entry.encoding === "base64"
				? readFileSync(join(dir, entry.file)).toString("base64")
				: readFileSync(join(dir, entry.file), "utf8"),
	}));
}

export function saveFixture(dir: string, raws: readonly RawResponse[], extension = "txt"): void {
	mkdirSync(dir, { recursive: true });
	const manifest = raws.map((raw, i) => {
		const image = IMAGE_EXTENSION[raw.contentType.split(";")[0]?.trim() ?? ""];
		const file = `${String(i).padStart(2, "0")}.${image ?? extension}`;
		writeFileSync(join(dir, file), image ? Buffer.from(raw.body, "base64") : raw.body);
		const entry = {
			file,
			url: raw.url,
			status: raw.status,
			contentType: raw.contentType,
			fetchedAt: raw.fetchedAt,
		};
		return image ? { ...entry, encoding: "base64" as const } : entry;
	});
	writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}
