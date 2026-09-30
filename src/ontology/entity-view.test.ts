import { expect, test } from "bun:test";
import { ADAPTERS } from "../adapters/registry.ts";
import { Store } from "../core/store.ts";
import type { Json, Observation } from "../core/types.ts";
import type { IncidentItem, IncidentsView } from "../panels/incidents.ts";
import { type EntityContext, entityView, populationAllowed, timelineView } from "./entity-view.ts";
import { linker } from "./linker.ts";
import { LinkIndex } from "./links-store.ts";
import { registry } from "./registry.ts";

const T0 = Date.UTC(2026, 8, 29, 12);
const HOUR = 3_600_000;
const reg = registry();

function context(
	panels: Record<string, unknown> = {},
	observations: Observation[] = [],
	figures: EntityContext["figures"] = () => [],
): EntityContext {
	const store = new Store(":memory:");
	store.insert(observations);
	const links = new LinkIndex(store);
	links.sync();
	return {
		registry: reg,
		linker: linker(),
		links,
		store,
		panel: (id) => panels[id] as Json | undefined,
		health: () => [],
		adapters: new Map(ADAPTERS.map((a) => [a.id, a])),
		figures,
		now: T0,
	};
}

/** An outage incident in Zulia with the given families (only the fields the entity page reads). */
const outage = (id: string, families: string[], tier: "incident" | "watch" = "incident"): IncidentItem =>
	({
		id,
		kind: "corte",
		key: "VE-V",
		state: "VE-V",
		stateName: "Zulia",
		title: { es: `Corte ${id}`, en: `Outage ${id}` },
		status: "active",
		tier,
		families,
		corroboration: families.length,
		reportsOnly: families.every((f) => f === "prensa" || f === "usuarios"),
		startAt: T0 - 2 * HOUR,
		lastEvidenceAt: T0 - HOUR,
	}) as unknown as IncidentItem;

test("people living in the area: only for incidents of two independent families, never press or reports alone", () => {
	const incidents = [
		outage("two", ["ioda", "prensa"]),
		// Press from two outlets opens an incident, but it is one family.
		outage("press", ["prensa"]),
		// Users' reports join an incident; they never count as the second family.
		outage("joined", ["ioda", "usuarios"]),
		outage("three", ["ioda", "ripe-atlas", "usuarios"]),
	];
	const watches = [outage("watch", ["ioda"], "watch")];
	const view = { incidents, watches } as unknown as IncidentsView;
	const zulia = entityView(context({ incidents: view }), "ve.zulia");
	const people = Object.fromEntries(
		(zulia?.incidents ?? []).map((i) => [i.id, i.populationInArea?.people ?? null]),
	);
	expect(people.two).toBeGreaterThan(1_000_000);
	expect(people.three).toBeGreaterThan(1_000_000);
	expect(people.press).toBeNull();
	expect(people.joined).toBeNull();
	expect(people.watch).toBeNull();
	expect(populationAllowed({ tier: "incident", families: ["usgs", "funvisis"] })).toBe(true);
	expect(populationAllowed({ tier: "watch", families: ["ioda", "prensa"] })).toBe(false);
});

test("nearby: nearest first, the same distance by kind, and the contract says so", () => {
	const ctx = context();
	const rankOf = (kind: string | null) => {
		const order = ["power-plant", "refinery", "petrochemical", "oil-terminal", "port", "airport", "dam"];
		const k = order.indexOf(kind ?? "");
		return k === -1 ? 99 : k;
	};
	for (const id of ["ve.zulia", "ve.distrito-capital.libertador", "infra.guri", "infra.refineria-amuay"]) {
		const n = entityView(ctx, id)?.nearby;
		expect(n?.order).toBe("distance");
		const items = n?.items ?? [];
		expect(items.length).toBeGreaterThan(2);
		for (let i = 1; i < items.length; i++) {
			const a = items[i - 1];
			const b = items[i];
			if (!a || !b) continue;
			expect(b.km).toBeGreaterThanOrEqual(a.km);
			if (a.km === b.km) expect(rankOf(b.entity.kind)).toBeGreaterThanOrEqual(rankOf(a.entity.kind));
		}
		expect(n?.rule.es).toContain("más cercana");
	}
	// Zulia lists its 40 facilities nearest to its point, not its 40 largest plants.
	const zulia = entityView(ctx, "ve.zulia")?.nearby;
	expect(zulia?.truncated).toBe(true);
	expect(zulia?.items.every((x) => x.relation === "inside")).toBe(true);
});

const obs = (source: string, series: string, at: number, value: Json, location?: Observation["location"]) =>
	({
		source,
		series,
		sourceUrl: `https://example.org/${series}`,
		fetchedAt: at + 60_000,
		observedAt: at,
		licence: "x",
		value,
		...(location ? { location } : {}),
		confidence: 1,
		basis: "measurement",
	}) as Observation;

test("server text: Spanish decimals and nouns that agree ('1 detección', '6,82 MW', '1 titular')", () => {
	const maracaibo = reg.get("ve.zulia.maracaibo")?.point ?? { lat: 10.65, lon: -71.64 };
	const fire = obs(
		"firms-fires",
		"fire:1",
		T0 - HOUR,
		{ kind: "detection", frpMW: 6.82, placeEs: "Maracaibo (Zulia)", confidenceClass: "n", daynight: "N" },
		{ lat: maracaibo.lat, lon: maracaibo.lon, state: "VE-V" },
	);
	const headline = obs("el-pitazo", "item:1", T0 - HOUR, {
		outlet: "el-pitazo",
		title: "Apagón en Maracaibo deja sin luz a varios sectores",
		link: "https://example.org/n1",
		summary: "",
		image: null,
		dateMissing: false,
		video: false,
	});
	const ctx = context({}, [fire, headline]);
	const muni = entityView(ctx, "ve.zulia.maracaibo");
	const text = (layer: string) => muni?.now.find((n) => n.layer === layer)?.text;
	expect(text("fires")).toEqual({ es: "1 detección en 48 h", en: "1 detection in 48 h" });
	expect(text("news")).toEqual({ es: "1 titular en 48 h", en: "1 headline in 48 h" });
	const tl = timelineView(ctx, "ve.zulia.maracaibo", T0 - 6 * HOUR, T0, 50, ["fire"]);
	expect(tl?.items[0]?.title).toEqual({
		es: "Foco de calor VIIRS, Maracaibo (Zulia) (6,82 MW)",
		en: "VIIRS heat detection, Maracaibo (Zulia) (6.82 MW)",
	});
	// No Spanish string on the page writes an English decimal point.
	const spanish = [...(muni?.now ?? []).map((n) => n.text.es), ...(muni?.links.rules.es ?? [])];
	for (const t of spanish) expect(t).not.toMatch(/\d\.\d/);
});

test("INPC: the index carries its base as the BCV prints it, in the label, the text and the figures", () => {
	const figures: EntityContext["figures"] = (feed) =>
		feed === "bcv-inpc"
			? [
					{
						feed: "bcv-inpc",
						path: "inflation.latest.index",
						label: null,
						value: 637409769724325.1,
						sourceUrl: "https://www.bcv.org.ve/estadisticas/consumidor",
						observedAt: T0 - 30 * 24 * HOUR,
						fetchedAt: T0 - HOUR,
					},
				]
			: [];
	const bcv = entityView(context({}, [], figures), "inst.bcv");
	const inpc = bcv?.now.find((n) => n.figures.path === "inflation.latest.index");
	expect(inpc?.label.es).toBe("INPC (índice, base diciembre 2007 = 100)");
	expect(inpc?.text.es).toBe("INPC (índice, base diciembre 2007 = 100): 637.409.769.724.325,1");
	expect(inpc?.text.en).toBe("Consumer price index (base December 2007 = 100): 637,409,769,724,325.1");
	expect(inpc?.figures.base).toBe("diciembre 2007 = 100");
	expect(inpc?.computed).toBe(false);
});
