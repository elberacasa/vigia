import { expect, test } from "bun:test";
import { join } from "node:path";
import { bcvApi } from "../adapters/bcv-api/index.ts";
import { bcvHistory } from "../adapters/bcv-history/index.ts";
import { bcvOfficial } from "../adapters/bcv-official/index.ts";
import { yadio } from "../adapters/yadio/index.ts";
import { hasFixture, loadFixture } from "../core/fixtures.ts";
import { Store } from "../core/store.ts";
import type { Adapter } from "../core/types.ts";
import { moneyView } from "./money.ts";
import { pocketPanel, pocketView } from "./pocket.ts";
import { MINIMUM_WAGE, PENDING } from "./pocket-published.ts";

// Public fixtures only (BCV and Yadio are redistributable), so this runs in the public repository too.
const adapters = [bcvOfficial, bcvApi, bcvHistory, yadio] as readonly Adapter[];
const dir = (id: string) => join(import.meta.dir, "..", "adapters", id, "fixtures", "2026-09-24");
const NOW = Date.parse("2026-09-24T23:45:00Z");

function recordedStore(): Store {
	const store = new Store(":memory:");
	for (const a of adapters) if (hasFixture(dir(a.id))) store.insert(a.normalise(loadFixture(dir(a.id))));
	return store;
}

test("the minimum wage entry is the decree as read: Bs 130 from 15 March 2022, with its gazette and PDF", () => {
	expect(MINIMUM_WAGE.vesMonthly).toBe(130);
	expect(MINIMUM_WAGE.inForceFrom).toBe("2022-03-15");
	expect(MINIMUM_WAGE.instrument).toContain("4.653");
	expect(MINIMUM_WAGE.instrument).toContain("6.691");
	expect(MINIMUM_WAGE.documentUrl).toMatch(
		/^http:\/\/www\.gacetaoficial\.gob\.ve\/storage\/2022\/.*6\.691.*\.pdf$/,
	);
	expect(MINIMUM_WAGE.kind).toBe("official");
	for (const e of MINIMUM_WAGE.evidence) {
		expect(e.url).toMatch(/^https:\/\//);
		expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	}
	for (const p of PENDING) expect(p.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test("no money data: no rates and no conversions, the wage itself still shown", () => {
	const v = pocketPanel.compute(new Store(":memory:"), NOW);
	expect(v.rates).toEqual([]);
	expect(v.wage.vesMonthly).toBe(130);
	expect(v.wage.inCurrency).toEqual([]);
	expect(v.wage.vesDaily).toBeCloseTo(130 / 30, 12);
});

test.skipIf(!adapters.every((a) => hasFixture(dir(a.id))))(
	"recorded 2026-09-24: the BCV rate in force and Yadio, each named; the wage divided by each rate",
	() => {
		const store = recordedStore();
		const money = moneyView(store, NOW);
		const v = pocketView(money);
		// The recording holds Friday's EUR (not yet in force) and no EUR history, so no EUR rate is in force: none
		// is shown, rather than Friday's figure a day early.
		expect(money.official.eur.current).toBeNull();
		expect(v.rates.map((r) => r.id)).toEqual(["bcv-usd", "yadio"]);
		const usd = v.rates[0];
		// Thursday evening: the rate in force is Wednesday's, from the BCV's history file.
		expect(usd).toMatchObject({
			kind: "official",
			currency: "USD",
			vesPerUnit: 853.4993,
			feed: "bcv-history",
		});
		expect(usd?.noteEs).toContain("archivo histórico");
		expect(usd?.asOf).toBe(money.official.usd.current?.validFrom);
		expect(v.rates[1]).toMatchObject({ kind: "quote", vesPerUnit: 957.499994 });
		const at = (id: string) => v.wage.inCurrency.find((w) => w.rateId === id)?.amount;
		expect(at("bcv-usd")).toBeCloseTo(130 / 853.4993, 12);
		expect(at("yadio")).toBeCloseTo(130 / 957.499994, 12);
		// The panel reuses the money panel's cached view when one is given.
		expect(
			pocketPanel.compute(new Store(":memory:"), NOW, (id) => (id === "money" ? money : undefined)),
		).toEqual(v);
	},
);

test("a EUR rate in force is offered in euros, and the wage is converted to euros", () => {
	const money = moneyView(new Store(":memory:"), NOW);
	money.official.eur.current = {
		vesPerUnit: 972.648677,
		valueDate: "2026-09-24",
		validFrom: Date.UTC(2026, 8, 24, 4),
		fetchedAt: NOW - 3_600_000,
		feed: "bcv-official",
		sourceUrl: "https://www.bcv.org.ve/",
		conversion: null,
		confirmedBy: ["bcv-official"],
		route: null,
	};
	const v = pocketView(money);
	expect(v.rates).toHaveLength(1);
	expect(v.rates[0]).toMatchObject({ id: "bcv-eur", currency: "EUR", labelEs: "BCV oficial (EUR)" });
	expect(v.wage.inCurrency).toEqual([{ rateId: "bcv-eur", amount: 130 / 972.648677, currency: "EUR" }]);
});

test("a P2P venue counts only with enough ads, by its buy median, labelled by venue", () => {
	const money = moneyView(new Store(":memory:"), NOW);
	const base = {
		label: "Binance P2P, mediana de los 10 mejores anuncios (USDT/VES)",
		feed: "binance-p2p",
		sourceUrl: "https://p2p.binance.com/",
		attribution: "Binance P2P",
		asset: "USDT" as const,
		observedAt: NOW - 60_000,
		fetchedAt: NOW - 60_000,
		ageMs: 60_000,
		ticketVes: 10_000,
		sell: { status: "ok" as const, medianVesPerUsdt: 940, n: 10, considered: 20, gap: null },
		spreadPct: 1,
		stale: false,
	};
	money.p2p = [
		{
			...base,
			id: "binance-p2p",
			buy: { status: "ok", medianVesPerUsdt: 960, n: 10, considered: 20, gap: null },
		},
		{
			...base,
			id: "bybit-p2p",
			feed: "bybit-p2p",
			buy: { status: "insufficient", medianVesPerUsdt: null, n: 2, considered: 3, gap: null },
		},
	];
	const v = pocketView(money);
	expect(v.rates).toHaveLength(1);
	expect(v.rates[0]).toMatchObject({ id: "p2p:binance-p2p", labelEs: "Binance P2P (USDT)", vesPerUnit: 960 });
	expect(v.rates[0]?.noteEs).toContain("no un dólar en efectivo");
});
