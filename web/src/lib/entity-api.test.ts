import { beforeAll, expect, test } from "bun:test";
import type { EntityView } from "../../../src/ontology/view.ts";
import fixtures from "./fixtures/entities.json" with { type: "json" };

// Real answers of /api/v1/entities/{id} (a copy of the live archive, 2026-09-29), trimmed.
const F = fixtures as unknown as Record<string, EntityView>;
const NOW = 1_790_654_400_000;

beforeAll(() => {
	Object.assign(globalThis, { localStorage: { getItem: () => null, setItem() {} } });
});

test("a municipality: its own figures, its state's marked as the state's, people in census and WorldPop apart", async () => {
	const { adaptEntity } = await import("./entity-api.ts");
	const m = adaptEntity(F["ve.zulia.maracaibo"] as EntityView, "es", NOW);
	expect(m.origin).toBe("api");
	expect(m.ref).toMatchObject({
		id: "ve.zulia.maracaibo",
		kind: "municipality",
		path: "/lugar/zulia/maracaibo",
	});
	expect(m.crumbs?.map((c) => c.id)).toEqual(["ve", "ve.zulia"]);
	expect(m.map).toEqual({ iso: "VE-V", muni: "VE2313" });
	// IODA measures per state: the municipality shows Zulia's figure, labelled as Zulia's.
	const conn = m.facts.find((f) => f.key.startsWith("connectivity"));
	expect(conn).toMatchObject({ inherited: true, value: "Normal", tone: "ok", computed: true });
	expect(conn?.label).toContain("(estado Zulia)");
	expect(conn?.prov).toMatchObject({ basis: "measured", feeds: ["ioda-states"] });
	// Its own fires count is its own, with the method.
	const fires = m.facts.find((f) => f.key.startsWith("fires"));
	expect(fires?.inherited).toBeUndefined();
	expect(fires?.value).toBe("0");
	// Weather is a model's forecast, whatever the payload calls it.
	expect(m.facts.find((f) => f.key.startsWith("weather"))?.prov.basis).toBe("forecast");
	// Headlines are keyword location, and say so.
	expect(m.facts.find((f) => f.key.startsWith("news"))?.prov.basis).toBe("keyword");
	// Population: two sources, never summed or averaged.
	expect(m.population?.census?.people).toBe(1_459_448);
	expect(m.population?.worldpop?.people).toBe(1_859_347);
	// This incident is one family (the press) only: no "people living in the area", whatever the payload carries.
	const inc = m.sections.find((s) => s.key === "incidents")?.items[0];
	expect(inc?.meta).toContain("sobre Zulia");
	expect(inc?.unverified).toBe(true);
	expect(inc?.estimate).toBeUndefined();
	// The deciding reading is the state's: the verdict says whose it is.
	expect(m.status.text.startsWith("Zulia (estado): ")).toBe(true);
	expect(m.childGroups?.map((g) => [g.key, g.total])).toEqual([["parish", 18]]);
	expect(m.timeline).toBe("/api/v1/entities/ve.zulia.maracaibo/timeline");
});

test("a facility: operator relation, stated capacity, nearby with distances, no population", async () => {
	const { adaptEntity } = await import("./entity-api.ts");
	const m = adaptEntity(F["infra.guri"] as EntityView, "es", NOW);
	expect(m.ref).toMatchObject({ kind: "infrastructure", sub: "Planta eléctrica", path: "/infra/guri" });
	expect(m.relations?.map((r) => [r.label, r.ref.id])).toEqual([["Operador", "inst.corpoelec"]]);
	expect(m.attributes).toContainEqual({ key: "capacity", label: "Capacidad declarada", value: "10.235 MW" });
	expect(m.codes).toContainEqual({
		label: "OSM",
		value: "relation/15238110",
		url: "https://www.openstreetmap.org/relation/15238110",
	});
	expect(m.map?.iso).toBe("VE-F");
	expect(m.nearby?.items[0]?.km).toBeGreaterThanOrEqual(0);
	expect(m.nearby?.byKind.reduce((a, b) => a + b.n, 0)).toBe(22);
	expect(m.population).toBeNull();
	// A place's incident section is only for places (or when there are incidents).
	expect(m.sections.map((s) => s.key)).toEqual(["news"]);
});

test("an institution: official figures stay official, Vigía's derived one says computed", async () => {
	const { adaptEntity } = await import("./entity-api.ts");
	const m = adaptEntity(F["inst.bcv"] as EntityView, "es", NOW);
	const usd = m.facts.find((f) => f.label === "Tasa oficial del dólar (Bs.)");
	expect(usd).toMatchObject({ value: "857,89", unit: "Bs." });
	expect(usd?.computed).toBeUndefined();
	// "Label: 857.8876" says nothing the figure does not: no raw repeat under it.
	expect(usd?.detail).toBeUndefined();
	expect(usd?.prov.basis).toBe("official");
	const yoy = m.facts.find((f) => f.label === "Inflación interanual (%)");
	expect(yoy?.computed).toBe(true);
	expect(yoy?.prov.basis).toBe("derived");
	expect(m.map).toEqual({ iso: null, muni: null });
});

test("a network: its connectivity, blocks and routing, each with its source", async () => {
	const { adaptEntity } = await import("./entity-api.ts");
	const m = adaptEntity(F["net.cantv"] as EntityView, "es", NOW);
	expect(m.ref.sub).toBe("Proveedor de internet");
	expect(m.facts.map((f) => f.key.split(":")[0])).toEqual(["connectivity", "censorship", "routing"]);
	expect(m.facts[1]).toMatchObject({ value: "100", unit: "sitios bloqueados" });
	expect(m.attributes).toContainEqual({ key: "asns", label: "Sistemas autónomos", value: "AS8048" });
	expect(m.childGroups?.[0]?.items[0]?.path).toBe("/red/as8048");
});

test("a stale signal is never shown as live; a sentence without a figure stays a sentence", async () => {
	const { factOf } = await import("./entity-api.ts");
	const f = factOf(
		{
			layer: "something-new",
			scope: {
				id: "x",
				type: "state",
				kind: null,
				name: { es: "Zulia", en: "Zulia" },
				short: null,
				href: "",
			},
			label: { es: "Algo", en: "Something" },
			text: { es: "Una frase", en: "A sentence" },
			figures: {},
			source: { feed: "f", name: "F", sourceUrl: "javascript:alert(1)", licence: "l", attribution: "a" },
			observedAt: 1,
			fetchedAt: 2,
			stale: true,
			basis: "measurement",
			computed: false,
			method: null,
		},
		"x",
		0,
		"es",
	);
	expect(f).toMatchObject({ stale: true, value: "Una frase", textValue: true });
	// Only http(s) links reach the page.
	expect(f.prov.url).toBeUndefined();
});

test("a corroborated incident carries its people-in-the-area estimate, rounded, with its caveat", async () => {
	const { incidentItem, roughPeople } = await import("./entity-api.ts");
	const zulia = F["ve.zulia.maracaibo"] as EntityView;
	const base = zulia.incidents[0];
	if (!base) throw new Error("fixture");
	const item = incidentItem({ ...base, reportsOnly: false, corroboration: 2 }, "ve.zulia.maracaibo", "es");
	expect(item.estimate?.label).toContain("Personas que viven en Zulia");
	expect(item.estimate?.value).toBe("4,5 millones");
	expect(item.estimate?.caveat).toContain("No es el número de personas sin servicio");
	expect(roughPeople(186_432, "es")).toBe("186.000");
	expect(roughPeople(9_312, "es")).toBe("9.300");
});

test("headline counts say how they are linked; non-places never claim 'no anomaly'", async () => {
	const { adaptEntity } = await import("./entity-api.ts");
	const bcv = adaptEntity(F["inst.bcv"] as EntityView, "es", NOW);
	expect(bcv.facts.find((f) => f.key.startsWith("news"))?.prov.basis).toBe("name");
	expect(bcv.status.text).toMatch(/^\d+ señales vinculadas/);
	expect(bcv.status.text).not.toContain("fuera de lo común");
	const guri = adaptEntity(F["infra.guri"] as EntityView, "es", NOW);
	expect(guri.status).toEqual({ tone: "muted", text: "1 señal vinculada" });
	// A count over linked rows has no observed time: the fact keeps when it was read, never "now".
	const fires = guri.facts[0];
	expect(fires?.prov.observedAt).toBeNull();
	expect(fires?.prov).toHaveProperty("fetchedAt");
});
