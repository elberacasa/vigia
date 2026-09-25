import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DATA = join(import.meta.dir, "..", "..", "site", "src", "data");
const read = <T>(name: string): T => JSON.parse(readFileSync(join(DATA, name), "utf8")) as T;

test("the hero still shows the same map snapshot as the live scene (phones only ever see the still)", () => {
	const map = read<{ live: { capturedAt: number } }>("map.json");
	const still = read<{ mapCapturedAt: number }>("map-still.json");
	// If this fails: build and serve the site, then run ONLY=mapstill bun scripts/site-capture.ts <vigia> <site>.
	expect(still.mapCapturedAt).toBe(map.live.capturedAt);
});
