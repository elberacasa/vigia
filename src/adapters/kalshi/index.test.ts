import { expect, test } from "bun:test";
import { join } from "node:path";
import { hasFixture, loadFixture } from "../../core/fixtures.ts";
import { kalshi } from "./index.ts";

// Recorded 2026-09-29 02:4x UTC: the 17 Venezuela series found that day, 6 with open events, and the last trade of
// their leading markets. Internal (Kalshi publishes no data licence); the synthetic test covers the parser.
const dir = join(import.meta.dir, "fixtures", "2026-09-28");
const recorded = hasFixture(dir);

test.skipIf(!recorded)("6 open Venezuela events and their leading options", () => {
	const obs = kalshi.normalise(loadFixture(dir));
	expect(obs.length).toBe(25);
	expect(new Set(obs.map((o) => o.value.eventId)).size).toBe(6);
	const leader = obs.filter((o) => o.value.eventId === "KXVENEZUELALEADER-26DEC31");
	expect(leader[0]?.value).toMatchObject({
		outcome: "Nicolás Maduro",
		lastPrice: 0.73,
		volumeUnit: "contracts",
	});
	// The API answered in Spanish (Vigía asks with Accept-Language: es-VE).
	expect(leader[0]?.value.eventTitle).toStartWith("¿Quién liderará oficialmente Venezuela");
	for (const o of obs) expect(o.sourceUrl).toStartWith("https://kalshi.com/markets/kx");
});
