import { expect, test } from "bun:test";
import { join } from "node:path";
import { bcvApi } from "../adapters/bcv-api/index.ts";
import { bcvHistory } from "../adapters/bcv-history/index.ts";
import { bcvInpc } from "../adapters/bcv-inpc/index.ts";
import { bcvOfficial } from "../adapters/bcv-official/index.ts";
import { binanceP2p } from "../adapters/binance-p2p/index.ts";
import { bybitP2p } from "../adapters/bybit-p2p/index.ts";
import { yadio } from "../adapters/yadio/index.ts";
import { hasFixture, loadFixture } from "../core/fixtures.ts";
import { Store } from "../core/store.ts";
import type { Adapter } from "../core/types.ts";
import { moneyView } from "./money.ts";

const adapters = [
	bcvOfficial,
	bcvApi,
	bcvHistory,
	yadio,
	binanceP2p,
	bybitP2p,
	bcvInpc,
] as readonly Adapter[];
const dir = (id: string) => join(import.meta.dir, "..", "adapters", id, "fixtures", "2026-09-24");
// The P2P recordings are not in the public repository (see hasFixture); this end-to-end test runs where they are.
const recorded = adapters.every((a) => hasFixture(dir(a.id)));

/** End to end on the real responses recorded on 2026-09-24 between 23:33 and 23:42 UTC. */
test.skipIf(!recorded)("money panel on the recorded fixtures", () => {
	const store = new Store(":memory:");
	for (const a of adapters) {
		store.insert(a.normalise(loadFixture(dir(a.id))));
	}
	const now = Date.parse("2026-09-24T23:45:00Z");
	const started = performance.now();
	const v = moneyView(store, now);
	const ms = performance.now() - started;

	// Thursday evening: the page shows Friday's rate; the file stops at Wednesday 23 Sep.
	expect(v.official.usd.next?.vesPerUnit).toBe(855.6625);
	expect(v.official.usd.current).toMatchObject({
		valueDate: "2026-09-23",
		vesPerUnit: 853.4993,
		feed: "bcv-history",
	});
	expect(v.official.usd.possiblyMissed).toBe(true);
	expect(v.official.eur.next?.vesPerUnit).toBe(972.648677);
	// bcv-api's recording (a few hours later) carries the same Friday figures: confirmed by both routes.
	expect(v.official.usd.next?.confirmedBy).toEqual(["bcv-official", "bcv-api"]);
	expect(v.official.eur.next?.confirmedBy).toEqual(["bcv-official", "bcv-api"]);
	expect(v.official.usd.discrepancies).toEqual([]);

	expect(v.yadio.figure?.vesPerUsd).toBe(957.499994);
	expect(v.yadio.figure?.gap?.pct).toBeCloseTo((957.499994 / 853.4993 - 1) * 100, 10);
	expect(v.p2p.map((q) => q.id)).toEqual(["binance-p2p", "bybit-p2p"]);
	for (const q of v.p2p) {
		expect(q.buy.gap?.pct).toBeGreaterThan(10);
		expect(q.buy.gap?.pct).toBeLessThan(16);
	}

	expect(v.series90d.official.length).toBeGreaterThan(55);
	expect(v.series90d.official.at(-1)?.date).toBe("2026-09-23");
	expect(v.inflation.latest?.period).toBe("2026-08");
	expect(v.inflation.yearOnYearPct).toBeCloseTo(534.2134, 3);
	expect(v.inflation.yearToDatePct).toBeCloseTo(200.1, 1);
	expect(v.inflation.series24m.length).toBe(24);
	// Measured: a few ms on 2,588 history rows + 225 INPC months.
	expect(ms).toBeLessThan(250);
});
