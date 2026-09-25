import { describe, expect, test } from "bun:test";
import {
	correlate,
	corroborationLabel,
	dedupe,
	type Evidence,
	type Incident,
	isActive,
	mergeEvidence,
	opens,
	RULES,
	rulesText,
	type Signal,
} from "./incidents.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 8, 25, 1, 30);
const names: Record<string, string> = { "VE-V": "Zulia", "VE-K": "Lara" };
const stateName = (iso: string) => names[iso] ?? iso;
/** Incidents only (watch items, "señal sin corroborar", are tested apart). */
const opened = (...args: Parameters<typeof correlate>) =>
	correlate(...args).filter((i) => i.tier === "incident");

function ev(partial: Partial<Evidence> & Pick<Evidence, "id" | "family">): Evidence {
	const at = partial.at ?? NOW - 30 * MIN;
	return {
		role: "signal",
		speaks: "connectivity",
		feed: partial.family,
		es: partial.id,
		en: partial.id,
		lastAt: partial.lastAt ?? at,
		fetchedAt: at,
		url: `https://example.org/${partial.id}`,
		outlet: null,
		refs: [],
		...partial,
		at,
	};
}

const corte = (evidence: Evidence, key = "VE-V"): Signal => ({
	kind: "corte",
	key,
	state: key,
	anchorAt: null,
	title: null,
	evidence,
});

const iodaDrop = (at = NOW - 20 * MIN) => ev({ id: "ioda:drop:VE-V", family: "ioda", at });
const iodaEvent = (at: number, lastAt: number) => ev({ id: `ioda:event:${at}`, family: "ioda", at, lastAt });
const news = (outlet: string, at = NOW - HOUR, speaks: Evidence["speaks"] = "power") =>
	ev({ id: `news:${outlet}:${at}`, family: "prensa", outlet, at, speaks });
const atlas = (at = NOW - 10 * MIN) => ev({ id: `atlas:VE-V:${at}`, family: "ripe-atlas", at });
const night = (at: number) => ev({ id: `viirs:VE-V:${at}`, family: "viirs", at, speaks: "power" });

describe("opening rules", () => {
	test("one signal alone is never an incident", () => {
		expect(opened([corte(iodaDrop())], [], NOW, stateName)).toEqual([]);
		expect(opened([corte(news("el-pitazo"))], [], NOW, stateName)).toEqual([]);
		expect(opened([corte(atlas())], [], NOW, stateName)).toEqual([]);
	});

	test("two signals of the same family are still one source", () => {
		const signals = [corte(iodaDrop()), corte(iodaEvent(NOW - 2 * HOUR, NOW - HOUR))];
		expect(opened(signals, [], NOW, stateName)).toEqual([]);
		expect(opens([iodaDrop(), iodaEvent(NOW - 2 * HOUR, NOW - HOUR)])).toBeNull();
	});

	test("the same outlet twice is one report", () => {
		expect(
			opened(
				[corte(news("la-verdad", NOW - HOUR)), corte(news("la-verdad", NOW - 2 * HOUR))],
				[],
				NOW,
				stateName,
			),
		).toEqual([]);
	});

	test("measurement + press: an incident with 2 independent sources and a power title", () => {
		const [i] = opened([corte(iodaDrop()), corte(news("la-verdad"))], [], NOW, stateName);
		expect(i?.title.es).toBe("Posible apagón en Zulia");
		expect(i?.families).toEqual(["ioda", "prensa"]);
		expect(i?.corroboration).toBe(2);
		expect(i?.reportsOnly).toBe(false);
		expect(i && corroborationLabel(i).es).toBe("2 fuentes independientes");
		expect(i?.startAt).toBe(NOW - HOUR);
		expect(i?.lastEvidenceAt).toBe(NOW - 20 * MIN);
		expect(i?.openedBy).toBe("families");
		expect(i?.id).toBe(`corte:VE-V:${NOW - HOUR}`);
	});

	test("two measurement networks without power evidence say connectivity, not blackout", () => {
		const [i] = opened([corte(iodaDrop()), corte(atlas())], [], NOW, stateName);
		expect(i?.title.es).toBe("Caída de conectividad en Zulia");
		expect(i?.corroboration).toBe(2);
	});

	test("internet reports make it an internet outage", () => {
		const [i] = opened([corte(iodaDrop()), corte(news("x", NOW - HOUR, "internet"))], [], NOW, stateName);
		expect(i?.title.es).toBe("Posible caída de internet en Zulia");
	});

	test("press alone from two outlets is labelled reports only", () => {
		const [i] = opened(
			[corte(news("la-verdad")), corte(news("el-pitazo", NOW - 2 * HOUR))],
			[],
			NOW,
			stateName,
		);
		expect(i?.reportsOnly).toBe(true);
		expect(i?.openedBy).toBe("reports");
		expect(i?.corroboration).toBe(1);
		expect(i?.outlets).toBe(2);
		expect(i && corroborationLabel(i).es).toBe("solo reportes (2 medios), sin medición que lo confirme");
	});

	test("four families that coincide in time: 4 fuentes independientes", () => {
		const [i] = opened(
			[corte(iodaDrop()), corte(atlas()), corte(news("a")), corte(night(NOW - 3 * HOUR))],
			[],
			NOW,
			stateName,
		);
		expect(i?.families).toEqual(["ioda", "ripe-atlas", "viirs", "prensa"]);
		expect(i && corroborationLabel(i).es).toBe("4 fuentes independientes");
	});

	test("context never counts, but rides along", () => {
		const quake = ev({ id: "usgs:q1", family: "usgs", role: "context", speaks: "quake" });
		expect(opened([corte(iodaDrop()), corte(quake)], [], NOW, stateName)).toEqual([]);
		const [i] = opened([corte(iodaDrop()), corte(quake), corte(news("a"))], [], NOW, stateName);
		expect(i?.corroboration).toBe(2);
		expect(i?.context.map((e) => e.id)).toEqual(["usgs:q1"]);
		expect(i?.evidence.some((e) => e.id === "usgs:q1")).toBe(false);
	});

	test("different states never mix", () => {
		expect(opened([corte(iodaDrop()), corte(news("a"), "VE-K")], [], NOW, stateName)).toEqual([]);
	});
});

describe("freshness", () => {
	test("stale signals do not count", () => {
		// An IODA outage that ended 13 h ago and a press report of 13 h ago: both past their 12 h window.
		const oldEvent = iodaEvent(NOW - 14 * HOUR, NOW - 13 * HOUR);
		expect(opened([corte(oldEvent), corte(news("a"))], [], NOW, stateName)).toEqual([]);
		expect(opened([corte(iodaDrop()), corte(news("a", NOW - 13 * HOUR))], [], NOW, stateName)).toEqual([]);
		// Night lights count up to 48 h (NASA's publication delay), not 50…
		const outage = iodaEvent(NOW - 45 * HOUR, NOW - 10 * MIN);
		expect(opened([corte(outage), corte(night(NOW - 50 * HOUR))], [], NOW, stateName)).toEqual([]);
		expect(opened([corte(outage), corte(night(NOW - 40 * HOUR))], [], NOW, stateName)).toHaveLength(1);
	});

	test("signals must coincide in time: a dip two nights ago and a drop now are not one event", () => {
		expect(opened([corte(iodaDrop()), corte(night(NOW - 40 * HOUR))], [], NOW, stateName)).toEqual([]);
		expect(opened([corte(iodaDrop()), corte(news("a", NOW - 11 * HOUR))], [], NOW, stateName)).toEqual([]);
		expect(opened([corte(iodaDrop()), corte(news("a", NOW - 5 * HOUR))], [], NOW, stateName)).toHaveLength(1);
		// Only the coinciding evidence enters the chain.
		const [i] = opened(
			[corte(iodaDrop()), corte(news("a", NOW - HOUR)), corte(night(NOW - 40 * HOUR))],
			[],
			NOW,
			stateName,
		);
		expect(i?.families).toEqual(["ioda", "prensa"]);
	});

	test("an outage that started long ago but is still open counts by its last time", () => {
		const long = iodaEvent(NOW - 20 * HOUR, NOW - 5 * MIN);
		const [i] = opened([corte(long), corte(news("a"))], [], NOW, stateName);
		expect(i?.startAt).toBe(NOW - 20 * HOUR);
	});

	test("evidence dated far in the future is ignored", () => {
		expect(opened([corte(iodaDrop()), corte(news("a", NOW + HOUR))], [], NOW, stateName)).toEqual([]);
	});
});

describe("tracking across time", () => {
	const first = () =>
		opened([corte(iodaDrop(NOW - 20 * MIN)), corte(news("a", NOW - HOUR))], [], NOW, stateName);

	test("an active incident continues with any new signal, keeping its id", () => {
		const [open] = first();
		if (!open) throw new Error("no incident");
		const later = NOW + 15 * MIN;
		const [next] = opened([corte(iodaDrop(later - 10 * MIN))], [open], later, stateName);
		expect(next?.id).toBe(open.id);
		expect(next?.lastEvidenceAt).toBe(later - 10 * MIN);
		expect(next?.startAt).toBe(open.startAt);
		expect(next?.openedAt).toBe(open.openedAt);
		// The drop is one fact seen over time: first seen at its first time, last seen now.
		const drop = next?.evidence.find((e) => e.id === "ioda:drop:VE-V");
		expect(drop?.at).toBe(NOW - 20 * MIN);
		expect(drop?.lastAt).toBe(later - 10 * MIN);
		// The press report stays in the chain.
		expect(next?.families).toEqual(["ioda", "prensa"]);
	});

	test("after 3 h without new evidence it has ended; its evidence cannot open a new one", () => {
		const [open] = first();
		if (!open) throw new Error("no incident");
		expect(isActive(open, NOW)).toBe(true);
		const later = open.lastEvidenceAt + RULES.activeMs + MIN;
		expect(isActive(open, later)).toBe(false);
		// Same report still inside its 12 h window, plus a new single signal: not enough for a new incident.
		const again = opened(
			[corte(news("a", NOW - HOUR)), corte(atlas(later - 5 * MIN))],
			[open],
			later,
			stateName,
		);
		expect(again).toEqual([]);
		// Two new families open a new incident with a new id.
		const fresh = opened(
			[corte(atlas(later - 5 * MIN)), corte(news("b", later - 10 * MIN))],
			[open],
			later,
			stateName,
		);
		expect(fresh).toHaveLength(1);
		expect(fresh[0]?.id).not.toBe(open.id);
	});

	test("a new drop in the same state after an incident ended can open a new one", () => {
		const [open] = opened(
			[corte(iodaDrop(NOW - 20 * MIN)), corte(atlas(NOW - 10 * MIN))],
			[],
			NOW,
			stateName,
		);
		if (!open) throw new Error("no incident");
		const later = NOW + 30 * HOUR;
		const next = opened(
			[corte(iodaDrop(later - 5 * MIN)), corte(atlas(later - 5 * MIN))],
			[open],
			later,
			stateName,
		);
		expect(next).toHaveLength(1);
		expect(next[0]?.id).not.toBe(open.id);
	});

	test("a drop that recovers and returns is two episodes on the timeline", () => {
		const first = iodaDrop(NOW - 2 * HOUR);
		const again = iodaDrop(NOW - 10 * MIN);
		const merged = mergeEvidence([first], [again]);
		expect(merged.map((e) => [e.id, e.at])).toEqual([
			["ioda:drop:VE-V", NOW - 2 * HOUR],
			[`ioda:drop:VE-V@${NOW - 10 * MIN}`, NOW - 10 * MIN],
		]);
		// The second episode goes on: it grows, no third one appears.
		const on = mergeEvidence(merged, [iodaDrop(NOW)]);
		expect(on.map((e) => [e.id, e.at, e.lastAt])).toEqual([
			["ioda:drop:VE-V", NOW - 2 * HOUR, NOW - 2 * HOUR],
			[`ioda:drop:VE-V@${NOW - 10 * MIN}`, NOW - 10 * MIN, NOW],
		]);
	});

	test("the last evidence time never moves back", () => {
		const [open] = first();
		if (!open) throw new Error("no incident");
		const [next] = opened([corte(news("c", NOW - 3 * HOUR))], [open], NOW + MIN, stateName);
		expect(next?.lastEvidenceAt).toBe(open.lastEvidenceAt);
	});

	test("merging keeps the earliest start and the latest end of each fact", () => {
		const a = iodaEvent(NOW - 2 * HOUR, NOW - HOUR);
		const b = { ...a, lastAt: NOW - 10 * MIN, es: "longer" };
		const [m] = mergeEvidence([a], [b]);
		expect(m).toMatchObject({ at: NOW - 2 * HOUR, lastAt: NOW - 10 * MIN, es: "longer" });
	});

	test("deterministic: same input, same output", () => {
		const signals = [corte(iodaDrop()), corte(news("a")), corte(atlas())];
		expect(opened(signals, [], NOW, stateName)).toEqual(opened([...signals].reverse(), [], NOW, stateName));
	});
});

describe("a fixed point (review 3, H4)", () => {
	/** What the panel does: compute, archive (latest revision per id), list the union. */
	const tick = (signals: readonly Signal[], archived: Map<string, Incident>, now: number) => {
		const current = correlate(signals, [...archived.values()], now, stateName);
		for (const i of current) archived.set(i.id, i);
		return [...archived.values()]
			.map((i) => ({
				id: i.id,
				active: isActive(i, now),
				outlets: i.outlets,
				families: i.families,
				evidence: i.evidence.map((e) => e.id),
			}))
			.sort((a, b) => a.id.localeCompare(b.id));
	};

	test("an old measured drop and fresh reports: the same incidents on every recompute", () => {
		// A drop and a report 10 h ago, ended; two new outlets 25 min ago, 9 h after it.
		const signals = [
			corte(iodaEvent(NOW - 11 * HOUR, NOW - 10 * HOUR)),
			corte(news("a", NOW - 10 * HOUR)),
			corte(news("b", NOW - 25 * MIN)),
			corte(news("c", NOW - 25 * MIN)),
		];
		const archived = new Map<string, Incident>();
		const first = tick(signals, archived, NOW);
		expect(first).toEqual([
			{
				id: `corte:VE-V:${NOW - 11 * HOUR}`,
				active: false,
				outlets: 1,
				families: ["ioda", "prensa"],
				evidence: [`ioda:event:${NOW - 11 * HOUR}`, `news:a:${NOW - 10 * HOUR}`],
			},
			{
				id: `corte:VE-V:${NOW - 25 * MIN}`,
				active: true,
				outlets: 2,
				families: ["prensa"],
				evidence: [`news:b:${NOW - 25 * MIN}`, `news:c:${NOW - 25 * MIN}`],
			},
		]);
		expect(tick(signals, archived, NOW + 31_000)).toEqual(first);
		expect(tick(signals, archived, NOW + 62_000)).toEqual(first);
	});

	test("recomputing on the same data changes nothing, in any order of arrival", () => {
		const signals = [corte(iodaDrop()), corte(news("a")), corte(atlas()), corte(night(NOW - 3 * HOUR))];
		const archived = new Map<string, Incident>();
		const first = tick(signals, archived, NOW);
		expect(first).toHaveLength(1);
		expect(tick([...signals].reverse(), archived, NOW + 30_000)).toEqual(first);
	});

	test("a fact cited under two ids counts once", () => {
		const ref = { source: "la-verdad", series: "item:9", observedAt: NOW - HOUR };
		const a = ev({ id: "news:la-verdad:item:9", family: "prensa", outlet: "la-verdad", refs: [ref] });
		const b = { ...a, id: "news:la-verdad:item:9-copy", outlet: "la-verdad-2" };
		expect(dedupe([a, b]).map((e) => e.id)).toEqual(["news:la-verdad:item:9"]);
		// So two copies of one headline are not two outlets.
		expect(opened([corte(a), corte(b)], [], NOW, stateName)).toEqual([]);
	});
});

describe("watch items and late corroboration", () => {
	const nightAt = (overpass: number, fetchedAt: number) =>
		ev({ id: `viirs:VE-V:${overpass}`, family: "viirs", at: overpass, fetchedAt, speaks: "power" });

	test("IODA's own outage events alone make a watch item unless the rule says otherwise", () => {
		const event = { ...iodaEvent(NOW - 2 * HOUR, NOW - HOUR), feed: "ioda-events" };
		expect(correlate([corte(event)], [], NOW, stateName)[0]?.tier).toBe("watch");
		const saved = RULES.watch.iodaEvents;
		RULES.watch.iodaEvents = false;
		try {
			expect(correlate([corte(event)], [], NOW, stateName)).toEqual([]);
			// It still counts toward an incident with another family.
			expect(opened([corte(event), corte(atlas(NOW - HOUR))], [], NOW, stateName)).toHaveLength(1);
		} finally {
			RULES.watch.iodaEvents = saved;
		}
	});

	test("one measured family alone is a watch item, never an incident; one outlet alone is nothing", () => {
		const [w] = correlate([corte(iodaDrop())], [], NOW, stateName);
		expect(w).toMatchObject({ tier: "watch", openedBy: "single", families: ["ioda"], watchSince: null });
		expect(w?.title).toEqual({ es: "Caída de conectividad en Zulia", en: "Connectivity drop in Zulia" });
		expect(correlate([corte(news("a"))], [], NOW, stateName)).toEqual([]);
	});

	test("a watch item that a second family joins becomes an incident from that moment", () => {
		const [w] = correlate([corte(iodaDrop(NOW - 20 * MIN))], [], NOW, stateName);
		if (!w) throw new Error("no watch");
		const later = NOW + 30 * MIN;
		const [i] = correlate(
			[corte(iodaDrop(later - 10 * MIN)), corte(atlas(later - 5 * MIN))],
			[w],
			later,
			stateName,
		);
		expect(i).toMatchObject({
			id: w.id,
			tier: "incident",
			openedAt: later,
			watchSince: NOW,
			openedBy: "families",
		});
		expect(i?.startAt).toBe(w.startAt);
	});

	test("a night published 40 h later corroborates the ended incident it overlaps, keeping its start", () => {
		const t0 = NOW - 40 * HOUR;
		const [open] = correlate(
			[corte(iodaEvent(t0 - HOUR, t0 + 2 * HOUR)), corte(atlas(t0))],
			[],
			t0 + 2 * HOUR,
			stateName,
		);
		if (!open) throw new Error("no incident");
		const night = nightAt(t0 + HOUR, NOW);
		const [i] = correlate([corte(night)], [open], NOW, stateName);
		expect(i).toMatchObject({
			id: open.id,
			startAt: open.startAt,
			openedAt: open.openedAt,
			tier: "incident",
		});
		expect(i?.families).toEqual(["ioda", "ripe-atlas", "viirs"]);
		expect(i?.late).toEqual([{ family: "viirs", evidenceId: night.id, arrivedAt: NOW, delayMs: 39 * HOUR }]);
		expect(isActive(i as Incident, NOW)).toBe(false);
	});

	test("a late night turns an ended watch item into an incident, detected when the night arrived", () => {
		const t0 = NOW - 40 * HOUR;
		const [w] = correlate([corte(iodaEvent(t0 - HOUR, t0 + 2 * HOUR))], [], t0 + 2 * HOUR, stateName);
		if (!w) throw new Error("no watch");
		const [i] = correlate([corte(nightAt(t0 + HOUR, NOW))], [w], NOW, stateName);
		expect(i).toMatchObject({ id: w.id, tier: "incident", openedAt: NOW, watchSince: t0 + 2 * HOUR });
		expect(i?.startAt).toBe(t0 - HOUR);
	});

	test("late evidence never reaches an item older than 72 h, nor one it does not overlap", () => {
		const t0 = NOW - 80 * HOUR;
		const [old] = correlate([corte(iodaEvent(t0 - HOUR, t0))], [], t0, stateName);
		if (!old) throw new Error("no watch");
		const far = correlate([corte(nightAt(t0 - HOUR / 2, NOW))], [old], NOW, stateName);
		expect(far.map((x) => x.id)).not.toContain(old.id);
		const t1 = NOW - 40 * HOUR;
		const [recent] = correlate([corte(iodaEvent(t1 - HOUR, t1))], [], t1, stateName);
		if (!recent) throw new Error("no watch");
		// A night 20 h after the drop ended is a different night.
		const apart = correlate([corte(nightAt(t1 + 20 * HOUR, NOW))], [recent], NOW, stateName);
		expect(apart.map((x) => x.id)).not.toContain(recent.id);
	});

	test("late corroboration is a fixed point too", () => {
		const t0 = NOW - 40 * HOUR;
		const archived = new Map<string, Incident>();
		for (const i of correlate([corte(iodaEvent(t0 - HOUR, t0 + 2 * HOUR))], [], t0 + 2 * HOUR, stateName))
			archived.set(i.id, i);
		const signals = [corte(nightAt(t0 + HOUR, NOW))];
		for (const i of correlate(signals, [...archived.values()], NOW, stateName)) archived.set(i.id, i);
		const first = JSON.stringify([...archived.values()]);
		for (const i of correlate(signals, [...archived.values()], NOW + 30_000, stateName))
			archived.set(i.id, i);
		expect(JSON.stringify([...archived.values()])).toBe(first);
	});
});

describe("earthquakes", () => {
	const q = (family: "usgs" | "funvisis", at: number): Signal => ({
		kind: "sismo",
		key: `${family}-id`,
		state: "VE-K",
		anchorAt: at,
		title: { es: "Sismo M4,1 a 20 km de Carora (Lara)", en: "M4.1 earthquake" },
		evidence: ev({ id: `${family}:${at}`, family, at, speaks: "quake" }),
	});

	test("one network alone is not an incident; two networks are", () => {
		const t = NOW - 2 * HOUR;
		expect(opened([q("usgs", t)], [], NOW, stateName)).toEqual([]);
		const [i] = opened([q("usgs", t), q("funvisis", t + 40_000)], [], NOW, stateName);
		expect(i?.title.es).toBe("Sismo M4,1 a 20 km de Carora (Lara)");
		expect(i?.families).toEqual(["usgs", "funvisis"]);
	});

	test("readings more than 90 s apart are different quakes", () => {
		const t = NOW - 2 * HOUR;
		expect(opened([q("usgs", t), q("funvisis", t + 5 * MIN)], [], NOW, stateName)).toEqual([]);
	});
});

test("the rules text states the numbers in the code", () => {
	const text = rulesText();
	expect(text.es.join(" ")).toContain(`${RULES.activeMs / HOUR} h sin evidencia nueva`);
	expect(text.es.join(" ")).toContain(`al menos ${RULES.minOutletsReportsOnly} medios distintos`);
	expect(text.en.join(" ")).toContain(`night lights ${RULES.freshMs.viirs / HOUR} h`);
	expect(text.es.join(" ")).toContain(`IODA hasta ${RULES.freshMs.ioda / HOUR} h después de terminar`);
	expect(text.es.join(" ")).toContain(`terminados hace menos de ${RULES.lateMs / HOUR} h`);
	expect(text.es).toHaveLength(text.en.length);
});

test("an incident is plain JSON (it is archived as an observation value)", () => {
	const [i] = opened([corte(iodaDrop()), corte(news("a"))], [], NOW, stateName);
	const round = JSON.parse(JSON.stringify(i)) as Incident;
	expect(round).toEqual(i as Incident);
});
