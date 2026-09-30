import { beforeAll, expect, test } from "bun:test";
import type { EntityView, NowItem } from "../../../src/ontology/view.ts";
import { keyFacts, liveValue, ofScope, signalWords, unitOfLabel } from "./entity-signals.ts";
import fixtures from "./fixtures/entities.json" with { type: "json" };

// Real answers of /api/v1/entities/{id} (copies of the live archive, 2026-09-29), trimmed.
const F = fixtures as unknown as Record<string, EntityView>;
const NOW = 1_790_654_400_000;
const view = (id: string) => F[id] as EntityView;
const item = (id: string, layer: string) => view(id).now.find((x) => x.layer === layer) as NowItem;

beforeAll(() => {
	Object.assign(globalThis, { localStorage: { getItem: () => null, setItem() {} } });
});

test("every signal gets a short name and a short source, never the sentence as its name", () => {
	for (const id of Object.keys(F))
		for (const it of view(id).now)
			for (const l of ["es", "en"] as const) {
				const w = signalWords(it, l, view(id).entity.type);
				expect(w.name.length).toBeGreaterThan(0);
				expect(w.name.length).toBeLessThanOrEqual(48);
				expect(w.name).not.toBe(it.text[l]);
				expect(w.source.length).toBeLessThanOrEqual(32);
			}
	const b = "ve.bolivar";
	expect(signalWords(item(b, "lightning"), "es")).toMatchObject({
		name: "Rayos, 24 h",
		source: "GOES-19 GLM",
		// Out of date: "the last hour" is the last one measured, not this one.
		context: "0 en su última hora medida",
	});
	expect(signalWords(item(b, "fires"), "es")).toMatchObject({
		name: "Probables incendios, 24 h",
		source: "NASA FIRMS",
		context: "de 52 focos de calor",
	});
	expect(signalWords(item(b, "weather"), "es").name).toBe("Tiempo en Ciudad Bolívar");
	expect(signalWords(item(b, "news"), "es").name).toBe("Titulares, 48 h");
	expect(signalWords(item(b, "broadcast"), "en").name).toBe("TV and radio in the directory");
});

test("signals with nothing to say fold with their reason; the rest never do", () => {
	const b = "ve.bolivar";
	// IODA had too few signals, the night was cloudy: said, not shown as a figure.
	expect(signalWords(item(b, "connectivity"), "es").silent).toBe("sin datos suficientes");
	expect(signalWords(item(b, "nightlights"), "es").silent).toBe("nublado, 28 % despejado");
	// Zero quakes is an answer, not silence.
	expect(signalWords(item(b, "quakes"), "es").silent).toBeUndefined();
	// A measured normal connectivity compares its lowest signal with its own baseline, and lists all three.
	const conn = item("ve.zulia.maracaibo", "connectivity");
	const w = signalWords(conn, "es");
	expect(w.silent).toBeUndefined();
	expect(w.vs).toMatch(/^\d+ % · (BGP|sondeo|telescopio)$/);
	expect(w.breakdown).toContain("BGP");
});

test("the BCV's figures: units out of the name, the INPC's base as context, the bracket source short", () => {
	const bcv = view("inst.bcv");
	const usd = bcv.now.find((x) => x.label.es === "Tasa oficial del dólar (Bs.)") as NowItem;
	expect(signalWords(usd, "es")).toMatchObject({ name: "Tasa oficial del dólar", source: "BCV" });
	const inpc = bcv.now.find((x) => x.label.es.startsWith("INPC")) as NowItem | undefined;
	if (inpc) expect(signalWords(inpc, "es")).toMatchObject({ name: "INPC", context: "índice" });
	// A unit in the bracket leaves the name and goes next to the value.
	expect(unitOfLabel("Reservas internacionales (MM US$)")).toBe("MM US$");
	expect(unitOfLabel("Última intervención cambiaria (Bs. por euro)")).toBe("Bs. por euro");
	expect(unitOfLabel("Inflación del mes (%)")).toBeNull();
	expect(unitOfLabel("INPC (índice)")).toBeNull();
});

test("the header strip: census and WorldPop side by side, each with its own provenance; six at most", () => {
	const k = keyFacts(view("ve.bolivar"), "es");
	expect(k.map((x) => x.key)).toEqual(["census", "worldpop", "area", "capital", "incidents", "unusual"]);
	// Two labels a stranger tells apart; two sources, never one blended number.
	expect(k[0]).toMatchObject({
		label: "Censo 2011",
		source: "habitantes · INE",
		value: "1.413.115",
		computed: true,
	});
	expect(k[1]).toMatchObject({ label: "Estimación 2026", value: "2.617.702", computed: true });
	expect(k[1]?.source).toContain("WorldPop");
	expect(k[1]?.note).toContain("nunca mezclada");
	// The census note never borrows WorldPop's grid method.
	expect(k[0]?.note).not.toContain("celdas");
	expect(k[2]).toMatchObject({ value: "250.724", unit: "km²", source: "límites COD-AB" });
	expect(k[2]?.computed).toBeUndefined();
	// The capital comes from GeoNames, not from the boundaries.
	expect(k[3]).toMatchObject({ value: "Ciudad Bolívar", source: "GeoNames" });
	expect(k[4]).toMatchObject({ value: "0", computed: true, live: "incidents" });
	expect(k[4]?.jump).toBeUndefined();
	for (const x of k) expect(x.source.length).toBeGreaterThan(0);
});

test("a municipality's census is INE's own (not computed); its incidents and readings say when they are the state's", () => {
	const v = view("ve.zulia.maracaibo");
	const k = keyFacts(v, "es");
	expect(k.find((x) => x.key === "census")?.computed).toBeUndefined();
	expect(k.find((x) => x.key === "worldpop")?.computed).toBe(true);
	// Open, corroborated, measured incidents only: a watch or the press alone is not counted.
	const zulia = v.parents.find((p) => p.type === "state");
	if (!zulia) throw new Error("fixture");
	const brief = (over: Partial<EntityView["incidents"][number]>) => ({
		id: "x",
		kind: "corte",
		title: { es: "t", en: "t" },
		status: "active" as const,
		tier: "incident" as const,
		corroboration: 2,
		families: ["ioda", "prensa"],
		reportsOnly: false,
		startAt: 0,
		lastEvidenceAt: 0,
		scope: zulia,
		populationInArea: null,
		href: "",
		...over,
	});
	const withIncidents = {
		...v,
		incidents: [
			brief({ id: "a" }),
			brief({ id: "w", tier: "watch" }),
			brief({ id: "p", reportsOnly: true }),
			brief({ id: "e", status: "ended" }),
		],
	};
	const inc = keyFacts(withIncidents, "es").find((x) => x.key === "incidents");
	expect(inc).toMatchObject({ value: "1", jump: "esec-incidents" });
	expect(inc?.source).toBe("del estado Zulia · 1 terminado");
});

test("the country: no live counts that would read 0 beside a room full of them; its area is Vigía's sum", () => {
	const country = {
		...view("ve.bolivar"),
		entity: {
			...view("ve.bolivar").entity,
			id: "ve",
			type: "country" as const,
			attributes: { areaKm2: 913810 },
		},
		parents: [],
		children: { total: 25, byType: { state: 25, infrastructure: 2 }, items: [], truncated: false },
	};
	const k = keyFacts(country, "es");
	expect(k.map((x) => x.key)).toEqual(["census", "worldpop", "area", "children"]);
	expect(k.find((x) => x.key === "area")?.computed).toBe(true);
	expect(k.find((x) => x.key === "children")).toMatchObject({ label: "Entidades federales", value: "25" });
	// Dependencias Federales has an empty capital: no empty cell.
	const df = {
		...view("ve.bolivar"),
		entity: { ...view("ve.bolivar").entity, attributes: { capital: "", areaKm2: 343.2 } },
	};
	expect(keyFacts(df, "es").find((x) => x.key === "capital")).toBeUndefined();
});

test("a live zero from out-of-date inputs is not an answer", () => {
	const k = keyFacts(view("ve.bolivar"), "es").find((x) => x.key === "incidents");
	if (!k) throw new Error("fact");
	expect(liveValue(k, false, "es")).toEqual({ value: "0", source: k.source, stale: false });
	expect(liveValue(k, true, "es")).toEqual({
		value: "—",
		source: "sin datos recientes para juzgar",
		stale: true,
	});
	expect(liveValue({ ...k, value: "2" }, true, "es")).toMatchObject({ value: "2", stale: true });
});

test("the unusual-readings count carries how many series were judged (review M10)", () => {
	const none = keyFacts({ ...view("ve.bolivar"), anomaliesJudged: 0 }, "es").find((x) => x.key === "unusual");
	expect(none?.judged).toBe(0);
	const some = keyFacts({ ...view("ve.bolivar"), anomaliesJudged: 7 }, "es").find((x) => x.key === "unusual");
	expect(some?.judged).toBe(7);
});

test("scopes in words: del estado, de Venezuela, del Distrito Capital", () => {
	const ref = (type: string, es: string) => ({ type, name: { es, en: es }, short: null });
	expect(ofScope(ref("state", "Zulia"), "es")).toBe("del estado Zulia");
	expect(ofScope(ref("state", "Distrito Capital"), "es")).toBe("del Distrito Capital");
	expect(ofScope(ref("country", "Venezuela"), "es")).toBe("de Venezuela");
	expect(ofScope(ref("municipality", "Maracaibo"), "es")).toBe("del municipio Maracaibo");
	expect(ofScope(ref("state", "Zulia"), "en")).toBe("of Zulia state");
});

test("a former official is never the current value; a feed's state is Vigía's judgement, with a Caracas date", async () => {
	const { factOf } = await import("./entity-api.ts");
	const bcv = view("inst.bcv");
	const scope = bcv.now[0]?.scope;
	if (!scope) throw new Error("fixture");
	const office: NowItem = {
		layer: "office",
		scope,
		label: { es: "Presidente del Banco Central de Venezuela (Wikidata)", en: "x" },
		text: { es: "Laura Guerra Angulo, desde 2025-04-11 hasta 2026-01-03", en: "x" },
		figures: { holder: "Laura Guerra Angulo", start: "2025-04-11", end: "2026-01-03", status: "ended" },
		source: {
			feed: "wikidata-officials",
			name: "Wikidata",
			sourceUrl: null,
			licence: "CC0",
			attribution: "",
		},
		observedAt: NOW,
		fetchedAt: NOW,
		stale: false,
		basis: "report",
		computed: false,
		method: null,
	};
	const f = factOf(office, bcv.entity.id, 0, "es", "institution");
	expect(f.value).toBe("Sin titular registrado");
	expect(f.context).toBe("último: Laura Guerra Angulo, hasta 2026-01-03; Wikidata no registra sucesor");
	const current = factOf(
		{ ...office, figures: { ...office.figures, status: "current" } },
		bcv.entity.id,
		0,
		"es",
	);
	expect(current.value).toBe("Laura Guerra Angulo");
	const feed = bcv.now.find((x) => x.layer === "feed") as NowItem;
	const ff = factOf(feed, bcv.entity.id, 0, "es", "institution");
	expect(ff.prov.basis).toBe("status");
	expect(ff.computed).toBe(true);
	// 2026-09-25 04:00 UTC is 25 Sept at midnight in Caracas.
	expect(
		signalWords({ ...feed, observedAt: Date.UTC(2026, 8, 25, 3, 30), figures: { state: "ok" } }, "es")
			.context,
	).toBe("última publicación: 24 sept 2026");
});

test("a censorship row names only the sources whose figure is present", () => {
	const c = item("net.cantv", "censorship");
	expect(signalWords(c, "es").source).toBe("VE sin Filtro · OONI");
	expect(signalWords({ ...c, figures: { ...c.figures, vsfBlocked: null } }, "es").source).toBe("OONI");
});

test("the header strip by type: a facility's capacity and operator, a network's systems", () => {
	const guri = keyFacts(view("infra.guri"), "es");
	expect(guri.find((x) => x.key === "capacity")).toMatchObject({ value: "10.235", unit: "MW" });
	expect(guri.find((x) => x.key === "operator")).toMatchObject({ entity: "inst.corpoelec" });
	expect(guri.map((x) => x.key)).toContain("incidents");
	const cantv = keyFacts(view("net.cantv"), "es");
	expect(cantv.find((x) => x.key === "asns")?.value).toBe("AS8048");
	const bcv = keyFacts(view("inst.bcv"), "es");
	expect(bcv.find((x) => x.key === "unusual")).toBeDefined();
	// A municipality has no capital in the registry: its parishes instead.
	const mcbo = keyFacts(view("ve.zulia.maracaibo"), "es");
	expect(mcbo.find((x) => x.key === "children")).toMatchObject({ label: "Parroquias", value: "18" });
});

test("the adapted model carries the table's words and the strip; the record does not repeat the strip", async () => {
	const { adaptEntity } = await import("./entity-api.ts");
	const m = adaptEntity(view("ve.zulia.maracaibo"), "es", NOW);
	const conn = m.facts.find((f) => f.key.startsWith("connectivity"));
	expect(conn).toMatchObject({ name: "Internet", sourceShort: "IODA", scopeName: "estado Zulia" });
	expect(m.keyFacts?.length).toBeGreaterThan(3);
	const b = adaptEntity(view("ve.bolivar"), "es", NOW);
	expect(b.attributes?.find((a) => a.key === "capital")).toBeDefined();
	expect(b.keyFacts?.find((k) => k.key === "capital")).toBeDefined();
	const bcv = adaptEntity(view("inst.bcv"), "es", NOW);
	const euro = bcv.facts.find((f) => f.label.startsWith("Tasa oficial del euro"));
	expect(euro).toMatchObject({ name: "Tasa oficial del euro", unit: "Bs.", sourceShort: "BCV" });
	const office = bcv.facts.find((f) => f.key.startsWith("office"));
	if (office) expect(office.textValue).toBeUndefined();
});
