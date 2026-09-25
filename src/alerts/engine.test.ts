import { describe, expect, test } from "bun:test";
import {
	BLOCK_RECENT_MS,
	type ConnectivityIn,
	EVENT_RECENT_MS,
	emptyMemory,
	evaluate,
	type FeedStateIn,
	type IncidentIn,
	type Memory,
	type MoneyIn,
	type NewsIn,
	type PlaceIn,
	phrases,
	type QuakeIn,
	type Snapshot,
} from "./engine.ts";
import { type AlertRule, AlertRulesSchema } from "./schema.ts";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 24, 18, 0);

const place = (id: string, name: string, level: PlaceIn["level"], lastBinAt = T0 - 20 * 60_000): PlaceIn => ({
	id,
	name,
	level,
	headline: `${name}: ${level}`,
	lastBinAt,
	sourceUrl: `https://ioda.inetintel.cc.gatech.edu/region/${id}`,
	feed: "ioda-states",
});

const conn = (states: PlaceIn[], country = place("VE", "Venezuela", "normal")): ConnectivityIn => ({
	country,
	states,
});

const money = (
	over: { gapPct?: number; usd?: number; stale?: boolean; observedAt?: number } = {},
): MoneyIn => ({
	official: {
		usd: {
			current: {
				vesPerUnit: over.usd ?? 190.5,
				validFrom: T0 - 10 * HOUR,
				fetchedAt: T0 - 9 * HOUR,
				sourceUrl: "https://www.bcv.org.ve/",
				feed: "bcv-official",
			},
			stale: false,
		},
	},
	yadio: {
		feed: "yadio",
		sourceUrl: "https://yadio.io/",
		stale: over.stale ?? false,
		figure: {
			vesPerUsd: 300,
			observedAt: over.observedAt ?? T0 - 10 * 60_000,
			gap: { pct: over.gapPct ?? 57.5, officialVesPerUsd: 190.5 },
		},
	},
});

const quake = (id: string, mag: number, at: number, lat = 10.6, lon = -67.55): QuakeIn => ({
	id,
	at,
	lat,
	lon,
	zone: "near",
	placeEs: "20 km al N de Catia La Mar",
	maxMag: mag,
	usgs: {
		label: "USGS",
		feed: "usgs-quakes",
		mag,
		url: `https://earthquake.usgs.gov/earthquakes/eventpage/${id}`,
	},
	funvisis: null,
});

const healthy = (): FeedStateIn => "ok";

function snap(over: Partial<Snapshot> = {}): Snapshot {
	return { now: T0, feedState: healthy, ...over };
}

let n = 0;
function rule<K extends AlertRule["kind"]>(kind: K, fields: Record<string, unknown>): AlertRule {
	const parsed = AlertRulesSchema.parse([
		{ id: `r-test${String(n++).padStart(4, "0")}`, enabled: true, createdAt: T0, kind, ...fields },
	]);
	return parsed[0] as AlertRule;
}

/** Evaluates twice: first a baseline at `before`, then `after`; returns the second evaluation. */
function afterBaseline(r: AlertRule, before: Snapshot, after: Snapshot) {
	const first = evaluate([r], before, emptyMemory());
	expect(first.fired).toEqual([]);
	return evaluate([r], after, first.memory);
}

describe("rule schema", () => {
	test("rejects malformed rules, unknown kinds and duplicate ids", () => {
		const ok = { id: "r-abcdef", enabled: true, createdAt: 1, kind: "gap", minPct: 50 };
		expect(AlertRulesSchema.safeParse([ok]).success).toBe(true);
		expect(AlertRulesSchema.safeParse([ok, ok]).success).toBe(false);
		expect(AlertRulesSchema.safeParse([{ ...ok, kind: "exec" }]).success).toBe(false);
		expect(AlertRulesSchema.safeParse([{ ...ok, minPct: -1 }]).success).toBe(false);
		expect(AlertRulesSchema.safeParse([{ ...ok, id: "../x" }]).success).toBe(false);
		expect(AlertRulesSchema.safeParse([{ ...ok, extra: 1 }]).success).toBe(false);
		expect(
			AlertRulesSchema.safeParse([
				{ id: "r-abcdef", enabled: true, createdAt: 1, kind: "blocked", domain: "javascript:alert(1)" },
			]).success,
		).toBe(false);
		expect(
			AlertRulesSchema.safeParse([
				{ id: "r-abcdef", enabled: true, createdAt: 1, kind: "connectivity", place: "VE-ZZ", level: "drop" },
			]).success,
		).toBe(false);
	});
});

describe("condition rules", () => {
	test("a connectivity drop fires once when it starts, not again while it lasts, again after it clears", () => {
		const r = rule("connectivity", { place: "VE-V", level: "drop" });
		const normal = snap({ connectivity: conn([place("VE-V", "Zulia", "normal")]) });
		const drop = snap({ now: T0 + 10 * 60_000, connectivity: conn([place("VE-V", "Zulia", "drop", T0)]) });
		const e1 = afterBaseline(r, normal, drop);
		expect(e1.fired.map((f) => f.title.es)).toEqual(["Zulia: caída de conexión"]);
		const f = e1.fired[0];
		expect(f?.source).toBe("IODA");
		expect(f?.sourceUrl).toMatch(/^https:\/\/ioda/);
		expect(f?.observedAt).toBe(T0);
		expect(f?.panel).toBe("conectividad");
		expect(f?.state).toBe("VE-V");
		expect(e1.status[r.id]?.state).toBe("matching");

		const still = evaluate([r], { ...drop, now: T0 + 20 * 60_000 }, e1.memory);
		expect(still.fired).toEqual([]);
		const cleared = evaluate([r], { ...normal, now: T0 + 30 * 60_000 }, still.memory);
		expect(cleared.fired).toEqual([]);
		expect(cleared.status[r.id]?.state).toBe("clear");
		const again = evaluate(
			[r],
			snap({
				now: T0 + 40 * 60_000,
				connectivity: conn([place("VE-V", "Zulia", "severe", T0 + 30 * 60_000)]),
			}),
			cleared.memory,
		);
		expect(again.fired.map((x) => x.title.es)).toEqual(["Zulia: caída fuerte de conexión"]);
	});

	test("a new rule never fires for what is already true: it is a baseline, shown as matching", () => {
		const r = rule("connectivity", { place: "*", level: "drop" });
		const e = evaluate([r], snap({ connectivity: conn([place("VE-V", "Zulia", "severe")]) }), emptyMemory());
		expect(e.fired).toEqual([]);
		expect(e.status[r.id]).toEqual({ state: "matching", matching: 1, note: null });
	});

	test("severe-only rules ignore a plain drop; any-state rules name each state", () => {
		const severe = rule("connectivity", { place: "*", level: "severe" });
		const base = snap({
			connectivity: conn([place("VE-V", "Zulia", "normal"), place("VE-K", "Lara", "normal")]),
		});
		const e = afterBaseline(
			severe,
			base,
			snap({ connectivity: conn([place("VE-V", "Zulia", "drop"), place("VE-K", "Lara", "severe")]) }),
		);
		expect(e.fired.map((f) => f.state)).toEqual(["VE-K"]);
	});

	test("no alert on stale data: a failing feed or an old bin is not judged, and does not re-arm", () => {
		const r = rule("connectivity", { place: "VE-V", level: "drop" });
		const drop = snap({ connectivity: conn([place("VE-V", "Zulia", "drop")]) });
		const base = evaluate([r], drop, emptyMemory());
		// The feed goes stale while the drop continues: not judged, memory kept.
		const staleFeed = evaluate([r], { ...drop, feedState: () => "stale" }, base.memory);
		expect(staleFeed.status[r.id]?.state).toBe("stale");
		expect(staleFeed.status[r.id]?.note?.es).toMatch(/desactualizada/);
		// Back to healthy with the same drop: not a new start, so no alert.
		expect(evaluate([r], drop, staleFeed.memory).fired).toEqual([]);
		// An old bin is not judged either.
		const old = snap({ connectivity: conn([place("VE-V", "Zulia", "drop", T0 - 5 * HOUR)]) });
		expect(evaluate([r], old, emptyMemory()).status[r.id]?.state).toBe("stale");
		// A place that loses fresh data mid-drop keeps its state, so its return does not re-fire.
		const any = rule("connectivity", { place: "*", level: "drop" });
		const both = snap({
			connectivity: conn([place("VE-V", "Zulia", "drop"), place("VE-K", "Lara", "normal")]),
		});
		const b0 = evaluate([any], both, emptyMemory());
		const gapInData = snap({
			connectivity: conn([place("VE-V", "Zulia", "no-data"), place("VE-K", "Lara", "normal")]),
		});
		const b1 = evaluate([any], gapInData, b0.memory);
		expect(evaluate([any], both, b1.memory).fired).toEqual([]);
	});

	test("the dollar gap fires at the threshold with the figures and both sources", () => {
		const r = rule("gap", { minPct: 55 });
		const e = afterBaseline(
			r,
			snap({ money: money({ gapPct: 40 }) }),
			snap({ money: money({ gapPct: 57.5 }) }),
		);
		expect(e.fired.map((f) => f.title.es)).toEqual(["Brecha del dólar: 57,5 %"]);
		expect(e.fired[0]?.detail.es).toContain("umbral: 55,0 %");
		expect(e.fired[0]?.source).toBe("Yadio · BCV");
		expect(e.fired[0]?.panel).toBe("dinero");
	});

	test("the gap is not judged on a stale quote", () => {
		const r = rule("gap", { minPct: 10 });
		expect(evaluate([r], snap({ money: money({ stale: true }) }), emptyMemory()).status[r.id]?.state).toBe(
			"stale",
		);
		expect(
			evaluate([r], snap({ money: money({ observedAt: T0 - 7 * HOUR }) }), emptyMemory()).status[r.id]?.state,
		).toBe("stale");
		expect(
			evaluate([r], snap({ money: money(), feedState: () => "failing" }), emptyMemory()).status[r.id]?.state,
		).toBe("stale");
	});

	test("the BCV rate fires when it reaches the threshold", () => {
		const r = rule("rate", { minVes: 200 });
		const e = afterBaseline(
			r,
			snap({ money: money({ usd: 199.99 }) }),
			snap({ money: money({ usd: 200.01 }) }),
		);
		expect(e.fired.map((f) => f.title.es)).toEqual(["Dólar BCV: 200,01 Bs"]);
		expect(e.fired[0]?.source).toBe("BCV");
	});
});

describe("event rules", () => {
	test("a quake fires once, only if recent, only above the magnitude, only near the state", () => {
		const r = rule("quake", { minMag: 4, state: "VE-X", radiusKm: 50 });
		const base = snap({ quakes: { items: [quake("q-old", 5, T0 - HOUR)] } });
		const next = snap({
			now: T0 + 10 * 60_000,
			quakes: {
				items: [
					quake("q-new", 4.3, T0 + 5 * 60_000),
					quake("q-small", 3.9, T0 + 5 * 60_000),
					quake("q-far", 5.1, T0 + 5 * 60_000, 8.0, -63.5),
					quake("q-old", 5, T0 - HOUR),
				],
			},
		});
		const e = afterBaseline(r, base, next);
		expect(e.fired.map((f) => f.title.es)).toEqual(["Sismo M4,3 · 20 km al N de Catia La Mar"]);
		expect(e.fired[0]?.source).toBe("USGS");
		expect(e.fired[0]?.sourceUrl).toContain("q-new");
		expect(e.fired[0]?.observedAt).toBe(T0 + 5 * 60_000);
		// Seen once: never again.
		expect(evaluate([r], { ...next, now: T0 + 20 * 60_000 }, e.memory).fired).toEqual([]);
	});

	test("an event first seen long after it happened is not announced (a restart after days)", () => {
		const r = rule("quake", { minMag: 3, state: "*", radiusKm: 0 });
		const base = snap({ quakes: { items: [] } });
		const late = snap({
			now: T0 + 3 * 24 * HOUR,
			quakes: { items: [quake("q-then", 4, T0 + 3 * 24 * HOUR - EVENT_RECENT_MS - 1)] },
		});
		expect(afterBaseline(r, base, late).fired).toEqual([]);
	});

	test("a new block on a watched domain fires; unblocks and other domains do not", () => {
		const r = rule("blocked", { domain: "example.com" });
		const change = (domain: string, kind: "blocked" | "unblocked" | "flagged", by: number) => ({
			source: kind === "flagged" ? ("ooni" as const) : ("vesinfiltro" as const),
			kind,
			domain,
			isp: "CANTV",
			by,
			url: "https://vesinfiltro.org/",
		});
		const base = snap({ censorship: { timeline: { changes: [] } } });
		const next = snap({
			censorship: {
				timeline: {
					changes: [
						change("www.example.com", "blocked", T0 - HOUR),
						change("example.com", "flagged", T0 - 2 * HOUR),
						change("example.com", "unblocked", T0 - HOUR),
						change("other.org", "blocked", T0 - HOUR),
						change("example.com", "blocked", T0 - BLOCK_RECENT_MS - HOUR),
					],
				},
			},
		});
		const e = afterBaseline(r, base, next);
		expect(e.fired.map((f) => f.title.es)).toEqual([
			"Bloqueo: www.example.com en CANTV",
			"Posible bloqueo: example.com en CANTV",
		]);
		expect(e.fired.map((f) => f.source)).toEqual(["VE sin Filtro", "OONI"]);
	});

	test("an incident opening in the state fires with its evidence link", () => {
		const r = rule("incident", { state: "VE-K", incident: "corte" });
		const inc = (
			id: string,
			state: string,
			kind: "corte" | "sismo",
			status: "active" | "ended",
		): IncidentIn => ({
			id,
			kind,
			state,
			stateName: state,
			title: { es: `Corte en ${state}`, en: `Outage in ${state}` },
			openedAt: T0,
			status,
			strength: { es: "2 familias de señales", en: "2 signal families" },
			evidence: [{ feed: "ioda-states", url: "https://ioda.example/lara", at: T0 - HOUR }],
		});
		const e = afterBaseline(
			r,
			snap({ incidents: { incidents: [] } }),
			snap({
				incidents: {
					incidents: [
						inc("i1", "VE-K", "corte", "active"),
						inc("i2", "VE-V", "corte", "active"),
						inc("i3", "VE-K", "sismo", "active"),
						inc("i4", "VE-K", "corte", "ended"),
					],
				},
			}),
		);
		expect(e.fired.map((f) => f.title.es)).toEqual(["Corte en VE-K"]);
		expect(e.fired[0]?.sourceUrl).toBe("https://ioda.example/lara");
	});

	test("a headline with every word of a phrase fires, accent- and case-free, never for undated items", () => {
		const r = rule("news", { terms: "apagón maracaibo, gasolina", state: "*" });
		const story = (id: string, title: string, dateMissing = false, stance = "independent") => ({
			id,
			title,
			url: `https://news.example/${id}`,
			firstAt: T0,
			states: ["VE-V"],
			outlets: [{ id: "el-pitazo", name: "El Pitazo", stance, dateMissing }],
		});
		const empty: NewsIn = { stories: {} };
		const next: NewsIn = {
			stories: {
				a: story("a", "Reportan APAGON en Maracaibo esta tarde"),
				b: story("b", "Apagón en Valencia"),
				c: story("c", "Colas por Gasolina en Zulia", true),
				d: story("d", "Suben precios de la gasolina", false, "user"),
			},
		};
		const e = afterBaseline(r, snap({ news: [empty] }), snap({ news: [next] }));
		expect(e.fired.map((f) => f.title.es)).toEqual([
			"Reportan APAGON en Maracaibo esta tarde",
			"Suben precios de la gasolina",
		]);
		expect(e.fired[1]?.detail.es).toContain("añadida por ti");
		expect(e.fired[1]?.source).toBe("El Pitazo (añadida por ti)");
		expect(phrases(" Apagón , , Maracaibo  ")).toEqual([["apagon"], ["maracaibo"]]);
	});
});

describe("rule lifecycle", () => {
	test("a disabled rule is off and restarts from a new baseline when turned back on", () => {
		const r = rule("gap", { minPct: 50 });
		const off = { ...r, enabled: false };
		const e0 = evaluate([r], snap({ money: money({ gapPct: 40 }) }), emptyMemory());
		const e1 = evaluate([off], snap({ money: money({ gapPct: 60 }) }), e0.memory);
		expect(e1.status[r.id]?.state).toBe("off");
		const e2 = evaluate([r], snap({ money: money({ gapPct: 60 }) }), e1.memory);
		expect(e2.fired).toEqual([]);
		expect(e2.status[r.id]?.state).toBe("matching");
	});

	test("a deleted rule's memory is dropped; ids of fired alerts are unique per rule, subject and time", () => {
		const a = rule("gap", { minPct: 50 });
		const b = rule("rate", { minVes: 100 });
		const mem: Memory = evaluate([a, b], snap({ money: money({ gapPct: 1, usd: 1 }) }), emptyMemory()).memory;
		const e = evaluate([a, b], snap({ money: money({ gapPct: 60, usd: 150 }) }), mem);
		expect(new Set(e.fired.map((f) => f.id)).size).toBe(2);
		expect(Object.keys(evaluate([a], snap({ money: money() }), e.memory).memory.rules)).toEqual([a.id]);
	});
});
