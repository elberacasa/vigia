import { expect, test } from "bun:test";
import {
	type FeedState,
	feedCounts,
	type HealthLite,
	internetWord,
	type MetaLite,
	panelFreshness,
} from "./fresh.ts";

const NOW = Date.UTC(2026, 8, 25, 2);
const MIN = 60_000;
const h = (id: string, state: FeedState, ageMin = 5): HealthLite => ({
	id,
	state,
	lastSuccessAt: NOW - ageMin * MIN,
	newestObservedAt: NOW - ageMin * MIN,
	nextRunAt: null,
});
const map = (...rows: HealthLite[]) => new Map(rows.map((r) => [r.id, r]));
const meta = new Map<string, MetaLite>([
	["bcv-official", { provider: "BCV", freshness: { dataMs: 86_400_000 } }],
	["yadio", { provider: "Yadio", freshness: { dataMs: 3_600_000 } }],
	["bcv-history", { provider: "BCV", freshness: { dataMs: 86_400_000 } }],
	["ioda-states", { provider: "IODA, Georgia Tech", freshness: { dataMs: 3_600_000 } }],
	["ioda-asn", { provider: "IODA, Georgia Tech", freshness: { dataMs: 3_600_000 } }],
]);

test("one feed count: off and locked feeds are not counted; degraded is current (review 3, M9)", () => {
	const states: FeedState[] = ["ok", "ok", "degraded", "stale", "failing", "pending", "off", "locked"];
	expect(feedCounts(states.map((state) => ({ state })))).toEqual({
		enabled: 6,
		live: 3,
		late: 1,
		down: 1,
		waiting: 1,
	});
});

test("badge and band come from one verdict", () => {
	const all = panelFreshness(
		["bcv-official", "yadio"],
		map(h("bcv-official", "ok"), h("yadio", "ok")),
		meta,
		NOW,
		"es",
	);
	expect(all.badge).toEqual({ text: "hace 5 min", tone: "ok" });
	expect(all.band).toBeNull();

	const part = panelFreshness(
		["bcv-official", "yadio", "bcv-history"],
		map(h("bcv-official", "ok"), h("yadio", "stale", 120), h("bcv-history", "ok")),
		meta,
		NOW,
		"es",
	);
	expect(part.badge.tone).toBe("late");
	expect(part.badge.text).toStartWith("Parcial");
	expect(part.band).toEqual({ text: "2 de 3 fuentes al día · con retraso: Yadio", tone: "warn" });

	const stale = panelFreshness(
		["ioda-states", "ioda-asn"],
		map(h("ioda-states", "stale", 90), h("ioda-asn", "stale", 90)),
		meta,
		NOW,
		"es",
	);
	expect(stale.badge).toEqual({ text: "Desactualizado · hace 1 h", tone: "old" });
	expect(stale.band?.text).toBe("Desactualizado: último dato hace 1 h");

	const down = panelFreshness(["yadio"], map(h("yadio", "failing", 300)), meta, NOW, "es");
	expect(down.badge.tone).toBe("old");
	expect(down.band?.tone).toBe("alert");
});

test("provider names are said once, and a never-run feed waits instead of 'Cargando' forever", () => {
	const r = panelFreshness(
		["ioda-states", "ioda-asn", "bcv-official"],
		map(h("ioda-states", "stale"), h("ioda-asn", "stale"), h("bcv-official", "ok")),
		meta,
		NOW,
		"es",
	);
	expect(r.band?.text).toBe("1 de 3 fuentes al día · con retraso: IODA, Georgia Tech");
	const waiting = panelFreshness(
		["yadio"],
		map({ id: "yadio", state: "pending", lastSuccessAt: null }),
		meta,
		NOW,
		"es",
	);
	expect(waiting.badge).toEqual({ text: "Esperando datos", tone: "muted" });
});

test("'sin caídas' only with the server's all-clear and a live feed (review 3, H5)", () => {
	const view = (normal: number, drop: number, noData: number, allClear: boolean) => ({
		summary: { states: { normal, drop, severe: 0, noData }, allClear },
	});
	expect(internetWord(view(0, 0, 25, false), false, "es")?.short).toBe("sin datos");
	expect(internetWord(view(24, 0, 1, true), false, "es")?.short).toBe("sin datos");
	expect(internetWord(view(24, 0, 1, true), true, "es")?.short).toBe("sin caídas");
	expect(internetWord(view(12, 0, 13, false), true, "es")?.short).toBe("12 de 25 con datos");
	expect(internetWord(view(10, 2, 13, false), true, "es")).toMatchObject({
		short: "2 caídas",
		long: "2 estados con caída de señal · 12 de 25 con datos",
		tone: "warn",
	});
});
