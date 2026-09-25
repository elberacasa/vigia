import { expect, test } from "bun:test";
import { isChunkError, RELOAD_GUARD_MS, shouldReload } from "./update.ts";

test("review 4 M8: failed chunk loads are recognised in each browser's wording", () => {
	expect(
		isChunkError(new TypeError("Failed to fetch dynamically imported module: http://x/Money-abcd1234.js")),
	).toBe(true);
	expect(isChunkError(new TypeError("error loading dynamically imported module"))).toBe(true);
	expect(isChunkError(new TypeError("Importing a module script failed."))).toBe(true);
	expect(isChunkError(new Error("NetworkError when attempting to fetch resource."))).toBe(false);
	expect(isChunkError(undefined)).toBe(false);
});

test("review 4 M8: reload once when online; never offline, never twice in five minutes, never without storage", () => {
	const err = new TypeError("Failed to fetch dynamically imported module: /x-abcdefgh.js");
	const now = 10 * RELOAD_GUARD_MS;
	expect(shouldReload(err, true, 0, now)).toBe(true);
	expect(shouldReload(err, false, 0, now)).toBe(false);
	expect(shouldReload(err, true, now - 60_000, now)).toBe(false);
	expect(shouldReload(err, true, now - RELOAD_GUARD_MS, now)).toBe(true);
	expect(shouldReload(err, true, null, now)).toBe(false);
	expect(shouldReload(new Error("boom"), true, 0, now)).toBe(false);
});
