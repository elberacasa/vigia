import { expect, test } from "bun:test";
import { ADAPTERS } from "../adapters/registry.ts";
import { Store } from "../core/store.ts";
import type { Json, Observation } from "../core/types.ts";
import { type EntityContext, entityView, flashesFor, TIMELINE_KINDS, timelineView } from "./entity-view.ts";
import { linker, RULES } from "./linker.ts";
import { LinkIndex } from "./links-store.ts";
import { registry } from "./registry.ts";

const T0 = Date.UTC(2026, 8, 28, 22);
const MIN = 60_000;
const HOUR = 60 * MIN;
const reg = registry();

const base = (source: string, series: string, at: number, value: Json, licence = "x"): Observation => ({
	source,
	series,
	sourceUrl: `https://example.org/${source}/${series}`,
	fetchedAt: at + MIN,
	observedAt: at,
	licence,
	value,
	confidence: 1,
	basis: "measurement",
});

function context(observations: Observation[]): EntityContext {
	const store = new Store(":memory:");
	store.insert(observations);
	const links = new LinkIndex(store);
	links.sync();
	return {
		registry: reg,
		linker: linker(),
		links,
		store,
		panel: () => undefined,
		health: () => [],
		adapters: new Map(ADAPTERS.map((a) => [a.id, a])),
		figures: () => [],
		now: T0,
	};
}

const plant = reg.get("infra.planta-centro")?.point ?? { lat: 10.5, lon: -68.2 };
const d = RULES.lightning.cellDeg;
const centre = (x: number) => (Math.floor(x / d) + 0.5) * d;
const glm = (at: number, flashes: number): Observation =>
	base("goes-glm", "window", at, {
		windowStart: new Date(at).toISOString(),
		windowMinutes: 15,
		filesListed: 45,
		filesRead: 45,
		complete: true,
		venezuela: flashes + 7,
		catatumbo: 0,
		lake: 0,
		byState: { "VE-G": flashes, "VE-F": 7 },
		cells: [[centre(plant.lat), centre(plant.lon), flashes]],
		flagged: 0,
		satellite: "GOES-19",
	});

test("lightning: per-entity flash counts in the now block and the timeline, which shows it only when asked", () => {
	const ctx = context([glm(T0 - 30 * MIN, 40), glm(T0 - 3 * HOUR, 60)]);
	const carabobo = entityView(ctx, "ve.carabobo");
	const now = carabobo?.now.find((n) => n.layer === "lightning");
	expect(now?.figures).toEqual({ flashes24h: 100, flashes1h: 40, windowsWithFlashes24h: 2 });
	expect(now?.computed).toBe(true);
	expect(now?.method).toContain("GLM");
	const plantNow = entityView(ctx, "infra.planta-centro")?.now.find((n) => n.layer === "lightning");
	expect(plantNow?.figures.flashes24h).toBe(100);
	// The default timeline holds events; lightning comes with kinds=lightning.
	expect(timelineView(ctx, "ve.carabobo", T0 - 6 * HOUR, T0, 100)?.items).toEqual([]);
	const tl = timelineView(ctx, "ve.carabobo", T0 - 6 * HOUR, T0, 100, ["lightning"]);
	expect(tl?.items.map((i) => [i.kind, i.figures?.flashes])).toEqual([
		["lightning", 40],
		["lightning", 60],
	]);
	expect(tl?.items[0]?.title.es).toContain("40 destellos en 15 min en Carabobo");
	const bolivar = reg.get("ve.bolivar");
	if (!bolivar) throw new Error("no Bolívar");
	expect(flashesFor(bolivar, glm(T0, 5).value as never)).toBe(7);
});

test("offices from Wikidata on an institution's and a governorship's page; OFAC status of a state body", () => {
	const office = (qid: string, state: string | null, label: string) =>
		base(
			"wikidata-officials",
			`office:${qid}`,
			T0 - HOUR,
			{
				office: { qid, label },
				kind: state ? "governor" : "central-bank",
				state,
				status: "current",
				latestTerm: {
					person: { qid: "Q1", label: "Persona Pública" },
					start: "2025-01-10",
					end: null,
					died: null,
					datesInconsistent: false,
				},
				termsRecorded: 3,
				undatedTerms: 0,
				wikidataUrl: `https://www.wikidata.org/wiki/${qid}`,
			},
			"cc0",
		);
	const snapshot = base("ofac-sdn", "snapshot", T0 - 5 * HOUR, {
		kind: "snapshot",
		publicationId: 984,
		counts: { total: 2, individuals: 0, entities: 2, vessels: 0, aircraft: 0 },
		byProgram: {},
		officials: [],
		unnamedIndividuals: 0,
		entities: [
			{ uid: "26727", name: "BANCO CENTRAL DE VENEZUELA", programs: ["VENEZUELA-EO13850"] },
			{ uid: "26219", name: "SEGUROS LA VITALICIA C.A.", programs: ["VENEZUELA-EO13850"] },
		],
		vessels: [],
		aircraftByModel: [],
		wikidataChecked: true,
	});
	const ctx = context([
		office("Q137530422", null, "Presidente del Banco Central de Venezuela"),
		office("Q6572236", "VE-V", "Gobernador del Estado Zulia"),
		snapshot,
	]);
	const bcv = entityView(ctx, "inst.bcv");
	const o = bcv?.now.find((n) => n.layer === "office");
	expect(o?.text.es).toBe("Persona Pública, desde 2025-01-10 (en el cargo según Wikidata)");
	expect(o?.figures.status).toBe("current");
	const sanctions = bcv?.now.find((n) => n.layer === "sanctions");
	expect(sanctions?.figures).toEqual({ listed: true, changesRead: 0, programs: "VENEZUELA-EO13850" });
	expect(entityView(ctx, "ve.zulia")?.now.some((n) => n.layer === "office")).toBe(true);
	// PDVSA is mapped but not on this list; an institution OFAC does not list has no sanctions item at all.
	expect(entityView(ctx, "inst.pdvsa")?.now.find((n) => n.layer === "sanctions")?.figures.listed).toBe(false);
	expect(entityView(ctx, "inst.cne")?.now.some((n) => n.layer === "sanctions")).toBe(false);
	// Offices are a directory kind: in the timeline only when asked for.
	expect(timelineView(ctx, "inst.bcv", 0, T0, 100)?.items).toEqual([]);
	expect(timelineView(ctx, "inst.bcv", 0, T0, 100, ["office"])?.items[0]?.title.es).toContain(
		"Presidente del Banco Central de Venezuela: Persona Pública",
	);
});

test("the new event kinds are in the default timeline with titles of their own (never read as headlines)", () => {
	const ctx = context([
		base(
			"ofac-sdn",
			"change:959:0",
			T0 - 2 * HOUR,
			{
				kind: "change",
				publicationId: 959,
				action: "remove",
				subject: { type: "entity", uid: "26367", name: "PETROLEOS DE VENEZUELA, S.A." },
				programs: ["VENEZUELA-EO13850"],
				listedOn: null,
			},
			"us-gov-public-domain-ofac",
		),
		base("ofac-venezuela", "gl:52", T0 - 3 * HOUR, {
			kind: "licence",
			id: "52C",
			number: "52",
			revision: "C",
			title: "Authorizing Certain Transactions Involving Petróleos de Venezuela, S.A.",
			issued: "2026-09-14",
			url: "https://ofac.treasury.gov/media/936926/download?inline",
		}),
	]);
	const tl = timelineView(ctx, "inst.pdvsa", 0, T0, 100);
	expect(tl?.items.map((i) => [i.kind, i.title.es])).toEqual([
		["sanction", "OFAC: exclusión de la lista de PETROLEOS DE VENEZUELA, S.A."],
		[
			"licence",
			"OFAC: licencia general 52C (2026-09-14): Authorizing Certain Transactions Involving Petróleos de Venezuela, S.A.",
		],
	]);
	for (const k of [
		"sanction",
		"licence",
		"intervention",
		"gdelt",
		"lightning",
		"broadcast",
		"office",
		"market",
	])
		expect(Object.hasOwn(TIMELINE_KINDS, k), k).toBe(true);
});

test("every flood day stays on the state's timeline, not only the newest (review M5)", () => {
	const stats = (floodKm2: number) =>
		({ floodKm2, recurringKm2: 0, insufficientKm2: 0, nodataKm2: 0, areaKm2: 19_800 }) as unknown as Json;
	const day = (daysAgo: number, km2: number) =>
		base("modis-floods", "day", T0 - daysAgo * 24 * HOUR, {
			date: new Date(T0 - daysAgo * 24 * HOUR).toISOString().slice(0, 10),
			layer: "x",
			level: 8,
			venezuela: stats(km2),
			states: { "VE-K": stats(km2) },
			municipalities: {},
			cells: [],
		} as unknown as Json);
	const ctx = context([day(3, 40), day(2, 25), day(1, 30)]);
	const tl = timelineView(ctx, "ve.lara", T0 - 7 * 24 * HOUR, T0, 50, ["flood"]);
	expect(tl?.items.map((i) => i.kind)).toEqual(["flood", "flood", "flood"]);
});
