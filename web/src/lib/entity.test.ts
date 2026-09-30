import { beforeAll, expect, test } from "bun:test";
import type { HealthLite } from "./fresh.ts";

beforeAll(() => {
	Object.assign(globalThis, { localStorage: { getItem: () => null, setItem() {} } });
});

const NOW = Date.UTC(2026, 8, 28, 22);
const MIN = 60_000;

function health(rows: Record<string, HealthLite["state"]>): Map<string, HealthLite> {
	return new Map(
		Object.entries(rows).map(([id, state]) => [
			id,
			{
				id,
				state,
				lastSuccessAt: NOW - 5 * MIN,
				newestObservedAt: NOW - 10 * MIN,
				fetchAgeMs: 5 * MIN,
				dataAgeMs: 10 * MIN,
			} as HealthLite,
		]),
	);
}

/** The slice of /api/panels a state's model reads, synthetic but shaped like the server's views. */
function input() {
	return {
		connectivity: {
			states: [
				{
					id: "VE-G",
					name: "Carabobo",
					kind: "state",
					level: "drop",
					headline: "Sondeo al 62 % de lo habitual",
					lastBinAt: NOW - 15 * MIN,
					feed: "ioda-states",
					sourceUrl: "https://ioda.inetintel.cc.gatech.edu/",
					signals: [
						{
							signal: "ping-slash24",
							level: "drop",
							noData: null,
							pctOfBaseline: 62,
							observedAt: NOW - 15 * MIN,
						},
					],
				},
			],
			events: [
				{
					id: "e1",
					kind: "state",
					name: "Carabobo",
					startAt: NOW - 2 * 3_600_000,
					durationMin: 55,
					openAtFetch: true,
					url: "https://ioda.example/e1",
				},
				{
					id: "old",
					kind: "state",
					name: "Carabobo",
					startAt: NOW - 9 * 86_400_000,
					durationMin: 20,
					openAtFetch: false,
					url: "https://ioda.example/old",
				},
			],
		},
		quakes: {
			items: [
				{
					id: "q1",
					at: NOW - 3 * 86_400_000,
					state: "VE-G",
					maxMag: 3.1,
					placeEs: "a 5 km de Valencia (Carabobo)",
					usgs: { url: "https://usgs.example/q1" },
					funvisis: null,
				},
				{
					id: "q2",
					at: NOW - 40 * 86_400_000,
					state: "VE-G",
					maxMag: 4.0,
					placeEs: "hace mucho",
					usgs: null,
					funvisis: { url: "https://funvisis.example/q2" },
				},
				{
					id: "q3",
					at: NOW - 3_600_000,
					state: "VE-V",
					maxMag: 2.5,
					placeEs: "Zulia",
					usgs: null,
					funvisis: null,
				},
			],
		},
		news: {
			stories: {
				s1: {
					id: "s1",
					title: "Sin luz en Naguanagua",
					url: "https://a.example/1",
					at: NOW - 30 * MIN,
					outletCount: 3,
					topics: ["electricidad"],
					state: "VE-G",
					states: ["VE-G"],
					places: ["Naguanagua"],
				},
				s2: {
					id: "s2",
					title: "Valencia amanece con lluvia",
					url: "https://a.example/2",
					at: NOW - 60 * MIN,
					outletCount: 1,
					topics: [],
					state: "VE-G",
					states: ["VE-G"],
					places: ["Valencia"],
				},
			},
			byState: { "VE-G": { items: 12, stories: 2, topics: { electricidad: 4 }, top: ["s1", "s2"] } },
		},
		incidents: {
			feeds: ["ioda-states"],
			incidents: [
				{
					id: "i1",
					state: "VE-G",
					title: { es: "Posible apagón en Carabobo", en: "Possible blackout in Carabobo" },
					lastEvidenceAt: NOW - 20 * MIN,
					status: "active",
					reportsOnly: false,
					strength: { es: "2 fuentes independientes", en: "2 independent sources" },
				},
				{
					id: "i2",
					state: "VE-G",
					title: { es: "Reportes de apagón", en: "Blackout reports" },
					lastEvidenceAt: NOW - 50 * MIN,
					status: "active",
					reportsOnly: true,
					strength: { es: "solo reportes", en: "reports only" },
				},
			],
		},
	};
}

test("a state's model: each figure with its source, its time and its stale verdict", async () => {
	const { stateModel } = await import("./entity.ts");
	const m = stateModel(
		"VE-G",
		input() as never,
		health({ "ioda-states": "ok", "usgs-quakes": "stale", "funvisis-quakes": "failing" }),
		NOW,
		"es",
	);
	expect(m.ref).toMatchObject({
		id: "ve.carabobo",
		kind: "state",
		name: "Carabobo",
		path: "/lugar/carabobo",
	});
	expect(m.origin).toBe("panels");
	expect(m.codes).toEqual([{ label: "ISO 3166-2", value: "VE-G" }]);
	const internet = m.facts.find((f) => f.key === "internet");
	expect(internet).toMatchObject({ value: "Caída de señal", tone: "warn", stale: false });
	expect(internet?.prov).toMatchObject({
		source: "IODA (Georgia Tech)",
		feeds: ["ioda-states"],
		observedAt: NOW - 15 * MIN,
		basis: "measured",
	});
	// Two active incidents; one of them reports only: the count says 2, the tone is set by the measured one.
	expect(m.facts.find((f) => f.key === "incidents")).toMatchObject({ value: "2", tone: "alert" });
	// Quakes: 30 days only, this state only; both quake feeds late, so the figure is stale, never shown as live.
	expect(m.facts.find((f) => f.key === "quakes")).toMatchObject({ value: "1", stale: true });
	// Headlines are located by keyword and say so.
	expect(m.facts.find((f) => f.key === "news")?.prov.basis).toBe("keyword");
	expect(m.status).toMatchObject({ tone: "alert" });
	const internetSection = m.sections.find((s) => s.key === "internet");
	expect(internetSection?.items.map((i) => i.id)).toEqual(["outage:e1"]);
	const incidents = m.sections.find((s) => s.key === "incidents");
	expect(incidents?.items.find((i) => i.id === "incident:i2")?.unverified).toBe(true);
	expect(m.asOf).toBe(NOW - 15 * MIN);
});

test("durations read as people say them", async () => {
	const { duration } = await import("./entity.ts");
	expect([duration(55), duration(60), duration(504), duration(1440), duration(1530)]).toEqual([
		"55 min",
		"1 h",
		"8 h 24 min",
		"1 d",
		"1 d 2 h",
	]);
});

test("no green verdict from silence or from old data", async () => {
	const { stateModel } = await import("./entity.ts");
	const p = input();
	const conn = p.connectivity.states[0] as { level: string };
	conn.level = "normal";
	(p as { incidents?: unknown }).incidents = undefined;
	// IODA says normal but its feed is late: no "sin anomalías".
	const late = stateModel("VE-G", p as never, health({ "ioda-states": "stale" }), NOW, "es");
	expect(late.status).toEqual({ tone: "muted", text: "Sin mediciones al día para dar un veredicto" });
	const live = stateModel("VE-G", p as never, health({ "ioda-states": "ok" }), NOW, "es");
	expect(live.status).toEqual({ tone: "ok", text: "Sin anomalías en las señales medidas" });
	// Headlines are stale when none of the outlets' feeds is current.
	const withFeeds = { ...p, newsFeeds: ["el-pitazo", "tal-cual"] };
	const news = stateModel(
		"VE-G",
		withFeeds as never,
		health({ "el-pitazo": "stale", "tal-cual": "failing" }),
		NOW,
		"es",
	);
	expect(news.facts.find((f) => f.key === "news")?.stale).toBe(true);
});

test("incidents built only from press reports are reported, not measured", async () => {
	const { stateModel } = await import("./entity.ts");
	const p = input();
	p.incidents.incidents = p.incidents.incidents.filter((i) => i.reportsOnly);
	const m = stateModel("VE-G", p as never, health({ "ioda-states": "ok" }), NOW, "es");
	expect(m.facts.find((f) => f.key === "incidents")).toMatchObject({
		tone: "warn",
		prov: { basis: "reported" },
	});
});

test("a state with nothing reported says so instead of inventing figures", async () => {
	const { stateModel } = await import("./entity.ts");
	const m = stateModel("VE-Z", {}, new Map(), NOW, "en");
	expect(m.facts.map((f) => f.key)).toEqual(["quakes"]);
	expect(m.facts[0]).toMatchObject({ value: "0" });
	expect(m.status).toMatchObject({ tone: "muted", text: "Waiting for data" });
	expect(m.sections.find((s) => s.key === "news")?.empty).toBe("No headline located here in 24 h.");
});

test("a municipality's page keeps its own headlines and marks the state's figures as the state's", async () => {
	const { municipalityModel } = await import("./entity.ts");
	const m = municipalityModel(
		{ code: "VE0810", name: "Naguanagua", stateIso: "VE-G" },
		input() as never,
		health({ "ioda-states": "ok" }),
		NOW,
		"es",
	);
	expect(m.ref).toMatchObject({
		id: "ve.carabobo.naguanagua",
		kind: "municipality",
		path: "/lugar/carabobo/naguanagua",
	});
	expect(m.ref.parent?.id).toBe("ve.carabobo");
	expect(m.map).toEqual({ iso: "VE-G", muni: "VE0810" });
	expect(m.status.text.startsWith("Carabobo (estado): ")).toBe(true);
	expect(m.sections[0]?.items.map((i) => i.title)).toEqual(["Sin luz en Naguanagua"]);
	// The state's lists say they are the state's.
	for (const s of m.sections.slice(1)) expect(s.title).toContain("(estado Carabobo)");
	expect(m.facts.length).toBeGreaterThan(0);
	for (const f of m.facts) {
		expect(f.inherited).toBe(true);
		expect(f.label).toContain("(estado)");
	}
});
