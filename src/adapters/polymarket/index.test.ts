import { expect, test } from "bun:test";
import { join } from "node:path";
import { hasFixture, loadFixture } from "../../core/fixtures.ts";
import { polymarket } from "./index.ts";

// Recorded 2026-09-29 02:4x UTC. Internal: the trade records name traders (wallets, pseudonyms, pictures), and
// Polymarket's data terms are unpublished. The synthetic test covers the parser everywhere.
const dir = join(import.meta.dir, "fixtures", "2026-09-28");
const recorded = hasFixture(dir);

test.skipIf(!recorded)("15 Venezuela events, their leading options with the time of their last trade", () => {
	const obs = polymarket.normalise(loadFixture(dir));
	expect(obs.length).toBe(33);
	expect(new Set(obs.map((o) => o.value.eventId)).size).toBe(15);
	const leader = obs.filter((o) => o.value.eventTitle === "Venezuela leader end of 2026?");
	expect(leader.map((o) => o.value.outcome).slice(0, 2)).toEqual(["Nicolás Maduro", "Delcy Rodríguez"]);
	expect(leader[0]?.value).toMatchObject({ lastPrice: 0.645, volumeUnit: "USD", optionsInEvent: 16 });
	expect(obs.filter((o) => o.value.lastTradeAt !== null).length).toBeGreaterThan(30);
	const text = JSON.stringify(obs);
	expect(text).not.toContain("proxyWallet");
	expect(text).not.toContain("pseudonym");
});
