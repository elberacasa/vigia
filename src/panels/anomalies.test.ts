import { expect, test } from "bun:test";
import type { Evaluation } from "../intel/anomaly.ts";
import { type Judged, METRICS } from "../intel/anomaly-series.ts";
import { anomaliesFrom, explainingIncident } from "./anomalies.ts";
import type { IncidentItem } from "./incidents.ts";

const NOW = Date.UTC(2026, 8, 28, 22);
const HOUR = 3_600_000;

const unusual = (over: Partial<Evaluation> = {}): Evaluation => ({
	unusual: true,
	direction: "down",
	value: 300,
	baseline: 1_000,
	changePct: -70,
	score: -14,
	tail: null,
	points: 7,
	...over,
});

const judged = (over: Partial<Judged>): Judged => ({
	metric: METRICS.connectivity,
	entity: "ve.zulia",
	feed: "ioda-states",
	sourceUrl: "https://ioda.inetintel.cc.gatech.edu/region/4492",
	observedAt: NOW - 20 * 60_000,
	fetchedAt: NOW - 10 * 60_000,
	result: unusual(),
	from: NOW - 7 * 24 * HOUR,
	to: NOW - 24 * HOUR,
	detail: { level: "severe" },
	...over,
});

const incident = (over: Partial<IncidentItem>): IncidentItem =>
	({
		id: "corte:VE-V:1",
		kind: "corte",
		key: "VE-V",
		state: "VE-V",
		title: { es: "Posible apagón en Zulia", en: "Possible blackout in Zulia" },
		tier: "incident",
		status: "active",
		startAt: NOW - 2 * HOUR,
		lastEvidenceAt: NOW - 30 * 60_000,
		...over,
	}) as IncidentItem;

test("the list: ranked by |score|, licence-aware values, counts of every gate, and the rule in words", () => {
	const view = anomaliesFrom(
		[
			judged({}),
			judged({
				metric: METRICS.bcvUsd,
				entity: "inst.bcv",
				feed: "bcv-official",
				result: unusual({
					direction: "up",
					value: 900,
					baseline: 855,
					changePct: 5.3,
					score: 22.5,
					points: 60,
				}),
			}),
			judged({ entity: "ve.lara", result: { ...unusual(), unusual: false } }),
			judged({ entity: "ve.merida", result: "thin" }),
			judged({ entity: "ve.tachira", result: "stale" }),
			judged({ entity: "net.cantv", result: "weak" }),
		],
		NOW,
		[],
	);
	expect(view.items.map((i) => [i.entity.id, i.metric.id, i.score])).toEqual([
		["inst.bcv", "bcv.usd", 22.5],
		["ve.zulia", "connectivity", -14],
	]);
	expect(view.counts).toMatchObject({
		series: 6,
		judged: 3,
		unusual: 2,
		explained: 0,
		thin: 1,
		stale: 1,
		weak: 1,
	});
	expect(view.counts.byClass.connectivity).toEqual({ series: 5, judged: 2, unusual: 1 });
	const [bcv, zulia] = view.items;
	// The BCV publishes its rate for reuse: value and baseline travel. IODA's terms do not allow it: derived only.
	expect(bcv).toMatchObject({ value: 900, baseline: 855, computed: true, basis: "derived" });
	expect(zulia).toMatchObject({ value: null, baseline: null, changePct: -70 });
	expect(zulia?.source).toMatchObject({ feed: "ioda-states" });
	expect(zulia?.rule.es).toContain("Caída fuerte según la regla del panel de conectividad");
	expect(bcv?.rule.es).toContain("60 cambios diarios anteriores");
	expect(bcv?.method).toContain("Calculado por Vigía");
	expect(zulia?.ageMs).toBe(20 * 60_000);
	expect(view.rules.es.length).toBeGreaterThan(5);
});

test("an anomaly an open incident in the same state explains points to it; other states and families do not", () => {
	const j = judged({});
	expect(explainingIncident(j, [incident({})])).toEqual({
		id: "corte:VE-V:1",
		title: { es: "Posible apagón en Zulia", en: "Possible blackout in Zulia" },
		tier: "incident",
		href: "/api/v1/incidents/corte%3AVE-V%3A1",
	});
	// Another state's incident explains nothing here.
	expect(explainingIncident(j, [incident({ state: "VE-L" })])).toBeNull();
	// An incident that ended long before the reading does not; one that just ended does.
	expect(explainingIncident(j, [incident({ status: "ended", lastEvidenceAt: NOW - 10 * HOUR })])).toBeNull();
	expect(explainingIncident(j, [incident({ status: "ended", lastEvidenceAt: NOW - HOUR })])?.id).toBe(
		"corte:VE-V:1",
	);
	// An outage does not explain an unusual exchange rate.
	expect(
		explainingIncident(judged({ metric: METRICS.bcvUsd, entity: "inst.bcv" }), [incident({})]),
	).toBeNull();
	// A facility's reading is matched through its state.
	const planta = judged({ metric: METRICS.headlines, entity: "infra.planta-centro" });
	expect(explainingIncident(planta, [incident({ state: "VE-G", id: "corte:VE-G:1" })])?.id).toBe(
		"corte:VE-G:1",
	);
	const view = anomaliesFrom([j], NOW, [incident({})]);
	expect(view.counts.explained).toBe(1);
	expect(view.items[0]?.explainedBy?.id).toBe("corte:VE-V:1");
});

test("an incident that began long after a reading does not explain it", () => {
	const old = judged({ observedAt: NOW - 36 * HOUR, metric: METRICS.nightlights });
	expect(explainingIncident(old, [incident({ startAt: NOW - 2 * HOUR })])).toBeNull();
	expect(explainingIncident(old, [incident({ startAt: NOW - 37 * HOUR, status: "active" })])?.id).toBe(
		"corte:VE-V:1",
	);
	// A lone signal can explain, and says so by its tier.
	expect(explainingIncident(judged({}), [incident({ tier: "watch" })])?.tier).toBe("watch");
});
