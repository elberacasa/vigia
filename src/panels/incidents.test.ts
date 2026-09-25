import { expect, test } from "bun:test";
import type { NewsItem } from "../adapters/rss/factory.ts";
import { Store } from "../core/store.ts";
import type { Observation } from "../core/types.ts";
import { INCIDENTS_SOURCE, incidentHistory } from "../intel/archive.ts";
import { incidentsPanel, incidentsView, listIncidents, SHOW_ENDED_MS } from "./incidents.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 8, 25, 1, 30);

function headline(outlet: string, n: number, title: string, at: number): Observation<NewsItem> {
	return {
		source: outlet,
		series: `item:${n}`,
		sourceUrl: `https://example.org/${outlet}/${n}`,
		fetchedAt: at + MIN,
		observedAt: at,
		licence: "headline",
		value: {
			outlet,
			title,
			link: `https://example.org/${outlet}/${n}`,
			summary: "",
			image: null,
			dateMissing: false,
			video: false,
		},
		confidence: 1,
		basis: "report",
	};
}

function seeded(): Store {
	const store = new Store(":memory:");
	store.insert([
		headline(
			"la-verdad",
			1,
			"Habitantes de San Jacinto en Maracaibo cacerolean ante constantes apagones",
			NOW - 5 * HOUR,
		),
		headline("el-pitazo", 2, "Zulia | Nuevo apagón deja sin luz a Maracaibo y San Francisco", NOW - HOUR),
		// One outlet about Lara: a single report is not an incident.
		headline("la-prensa-lara", 3, "Apagón en Barquisimeto por falla en subestación", NOW - HOUR),
	]);
	return store;
}

test("end to end: press alone from two outlets opens a 'solo reportes' incident; one outlet does not", () => {
	const store = seeded();
	const view = incidentsView(store, NOW);
	expect(view.incidents.map((i) => i.title.es)).toEqual(["Posible apagón en Zulia"]);
	const [zulia] = view.incidents;
	expect(zulia?.status).toBe("active");
	expect(zulia?.reportsOnly).toBe(true);
	expect(zulia?.strength.es).toBe("solo reportes (2 medios), sin medición que lo confirme");
	expect(zulia?.evidence.map((e) => e.url)).toEqual([
		"https://example.org/la-verdad/1",
		"https://example.org/el-pitazo/2",
	]);
	expect(view.counts).toEqual({ active: 1, corroborated: 0, reportsOnly: 1, ended: 0, watches: 0 });
	expect(view.rules.es.length).toBeGreaterThan(5);
});

test("archived as observations: recomputing an unchanged incident adds no row; history keeps revisions", () => {
	const store = seeded();
	incidentsView(store, NOW);
	const count = () =>
		store.db
			.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM obs WHERE source = ?")
			.get(INCIDENTS_SOURCE)?.n;
	expect(count()).toBe(1);
	incidentsView(store, NOW + MIN);
	expect(count()).toBe(1);
	// A third outlet reports: same incident (same id), a new revision.
	store.insert([
		headline("tal-cual", 4, "Apagones en Zulia: vecinos protestan en Maracaibo", NOW + 10 * MIN),
	]);
	const later = incidentsView(store, NOW + 15 * MIN);
	expect(later.incidents).toHaveLength(1);
	expect(later.incidents[0]?.outlets).toBe(3);
	expect(count()).toBe(2);
	const id = later.incidents[0]?.id ?? "";
	expect(incidentHistory(store, id, NOW + HOUR).map((i) => i.outlets)).toEqual([2, 3]);
});

test("an incident ends 3 h after its last evidence and stays listed 48 h, from the archive", () => {
	const store = seeded();
	const first = incidentsView(store, NOW).incidents[0];
	const t = (first?.lastEvidenceAt ?? 0) + 3 * HOUR + MIN;
	const ended = incidentsView(store, t).incidents[0];
	expect(ended?.id).toBe(first?.id);
	expect(ended?.status).toBe("ended");
	expect(ended?.endedAt).toBe(first?.lastEvidenceAt);
	// Long after the headlines left their window, the archive still lists it until 48 h have passed.
	expect(
		incidentsView(store, (first?.lastEvidenceAt ?? 0) + 20 * HOUR).incidents.map(
			(i) => i.id as string | undefined,
		),
	).toEqual([first?.id]);
	expect(incidentsView(store, (first?.lastEvidenceAt ?? 0) + SHOW_ENDED_MS + MIN).incidents).toEqual([]);
});

test("the panel recomputes at most every 30 s per store", () => {
	const store = seeded();
	const a = incidentsPanel.compute(store, NOW);
	expect(incidentsPanel.compute(store, NOW + 10_000)).toBe(a);
	expect(incidentsPanel.compute(store, NOW + 31_000)).not.toBe(a);
});

test("watch items are listed apart and never counted as incidents; late corroboration is spelled out", () => {
	const base = {
		kind: "corte" as const,
		key: "VE-V",
		state: "VE-V",
		anchorAt: null,
		title: { es: "Caída de conectividad en Zulia", en: "Connectivity drop in Zulia" },
		startAt: NOW - HOUR,
		lastEvidenceAt: NOW - 10 * 60_000,
		openedAt: NOW - HOUR,
		watchSince: null,
		families: ["ioda" as const],
		corroboration: 1,
		reportsOnly: false,
		outlets: 0,
		evidence: [],
		evidenceTotal: 1,
		context: [],
		late: [],
	};
	const watch = { ...base, id: "w", tier: "watch" as const, openedBy: "single" as const };
	const late = {
		...base,
		id: "i",
		tier: "incident" as const,
		openedBy: "families" as const,
		families: ["ioda" as const, "viirs" as const],
		corroboration: 2,
		late: [{ family: "viirs" as const, evidenceId: "viirs:VE-V:x", arrivedAt: NOW, delayMs: 38 * HOUR }],
	};
	const listed = listIncidents([watch, late], [], NOW);
	expect(listed.find((i) => i.id === "w")?.strength.es).toBe("señal sin corroborar (1 fuente medida)");
	expect(listed.find((i) => i.id === "i")?.lateNotes).toEqual([
		{
			es: "corroborado después por luces nocturnas (dato publicado 38 h después)",
			en: "corroborated later by night lights (published 38 h after)",
		},
	]);
	// Archived before watch items existed: read as an incident.
	const { tier: _t, late: _l, watchSince: _w, ...old } = late;
	expect(listIncidents([], [old as unknown as typeof late], NOW)[0]?.tier).toBe("incident");
});
