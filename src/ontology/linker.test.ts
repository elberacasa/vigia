import { expect, test } from "bun:test";
import { num } from "../core/format.ts";
import type { Json, Observation } from "../core/types.ts";
import {
	linker,
	linkRulesText,
	NearIndex,
	NOT_FOLLOWED_BY,
	RULES,
	repeatedParishesOf,
	segmentKm,
} from "./linker.ts";
import { registry } from "./registry.ts";

const lk = linker();
const reg = registry();
const ids = (links: readonly { entity: string }[]) => links.map((l) => l.entity).sort();

/** A point `km` north of an entity's point (1° of latitude ≈ 111.32 km). */
const north = (id: string, km: number) => {
	const p = reg.get(id)?.point;
	if (!p) throw new Error(`no point for ${id}`);
	return { lat: p.lat + km / 111.32, lon: p.lon };
};

const obs = (source: string, value: Json, location?: { lat: number; lon: number; state?: string }) =>
	({
		source,
		series: `${source}:x`,
		value,
		...(location ? { location } : {}),
	}) satisfies Pick<Observation, "source" | "series" | "value" | "location">;

test("a point links to its parish, municipality and state; the sea links to nothing; the lake to Zulia", () => {
	const plaza = lk.place(10.5061, -66.9146); // Caracas, Plaza Bolívar
	expect(ids(plaza)).toEqual([
		"ve",
		"ve.distrito-capital",
		"ve.distrito-capital.libertador",
		"ve.distrito-capital.libertador.catedral",
	]);
	expect(plaza.every((l) => l.rule === "located" && l.confidence === 1)).toBe(true);
	expect(lk.place(11.5, -66.0)).toEqual([]); // Caribbean
	expect(lk.place(7.1193, -73.1227)).toEqual([]); // Bucaramanga, Colombia
	const lake = lk.place(10.0, -71.5); // Lake Maracaibo: water, no municipality
	expect(ids(lake)).toEqual(["ve", "ve.zulia"]);
	// A state the source gives (e.g. from its own rule) is used when the polygons find none.
	expect(lk.place(12.9, -70.5, "VE-I")).toEqual([
		{ entity: "ve.falcon", rule: "state-code", confidence: 1 },
		{ entity: "ve", rule: "state-code", confidence: 1 },
	]);
});

test("quakes: the epicentre's place always; facilities within 30 km only from magnitude 4", () => {
	const at = north("infra.guri", 10);
	const strong = lk.observation(obs("usgs-quakes", { mag: 4.6, placeEs: "x" }, at));
	const near = strong.filter((l) => l.rule === "near");
	expect(near.map((l) => l.entity)).toContain("infra.guri");
	expect(near.find((l) => l.entity === "infra.guri")?.km).toBeCloseTo(10, 0);
	expect(near.every((l) => (l.km ?? 99) <= RULES.quake.km)).toBe(true);
	expect(strong.some((l) => l.entity === "ve.bolivar" && l.rule === "located")).toBe(true);
	const weak = lk.observation(obs("funvisis-quakes", { mag: 3.9, placeEs: "x" }, at));
	expect(weak.filter((l) => l.rule === "near")).toEqual([]);
	expect(weak.some((l) => l.entity === "ve.bolivar")).toBe(true);
	// Hospitals are within the quake rule; fuel depots are not.
	expect(RULES.quake.kinds).toContain("hospital");
	expect(RULES.quake.kinds).not.toContain("fuel-depot");
	expect(lk.observation(obs("usgs-quakes", { mag: 5 }))).toEqual([]); // no location, no link
});

test("fires: facilities within their kind's distance, measured from the pixel", () => {
	const detection = { kind: "detection", frpMW: 5, placeEs: "x" };
	const at1 = north("infra.planta-centro", 1.5);
	const close = lk.observation(obs("firms-fires", detection, at1));
	expect(close.find((l) => l.entity === "infra.planta-centro")).toMatchObject({ rule: "near", km: 1.5 });
	const far = lk.observation(obs("firms-fires", detection, north("infra.planta-centro", 2.6)));
	expect(far.some((l) => l.entity === "infra.planta-centro")).toBe(false);
	// A substation counts only within 1 km.
	const sub = reg.all.find((e) => e.kind === "substation" && e.point) ?? null;
	if (!sub) throw new Error("no substation");
	expect(
		lk.observation(obs("firms-fires", detection, north(sub.id, 0.8))).some((l) => l.entity === sub.id),
	).toBe(true);
	expect(
		lk.observation(obs("firms-fires", detection, north(sub.id, 1.3))).some((l) => l.entity === sub.id),
	).toBe(false);
	// A fire file summary is not an event.
	expect(lk.observation(obs("firms-fires", { kind: "file", rows: 3 }, at1))).toEqual([]);
});

test("fires under a transmission line link to that voltage's grid (1 km)", () => {
	const grid = reg.get("infra.red-765kv");
	expect(grid?.kind).toBe("power-grid");
	// A vertex of the mapped 765 kV grid: any point 0.5 km from it is within 1 km of the line.
	const index = new NearIndex([
		{
			id: "g",
			kind: "power-grid",
			lat: 0,
			lon: 0,
			lines: [
				[
					[8, -63],
					[8, -62],
				],
			],
		},
	]);
	expect(index.near(8.004, -62.5, { "power-grid": 1 })).toEqual([{ id: "g", kind: "power-grid", km: 0.4 }]);
	expect(index.near(8.02, -62.5, { "power-grid": 1 })).toEqual([]);
	expect(segmentKm(8.009, -62.5, [8, -63], [8, -62])).toBeCloseTo(1.0, 1);
	// Beyond the segment's ends, the distance is to the nearest end.
	expect(segmentKm(8, -61.9, [8, -63], [8, -62])).toBeCloseTo(11.0, 0);
});

test("flares link to the facility the adapter assigned, and to the place of the detection", () => {
	const amuay = reg.get("infra.refineria-amuay")?.point;
	if (!amuay) throw new Error("no Amuay");
	const links = lk.observation(
		obs("firms-flares", { kind: "detection", facilityId: "amuay", facilityKm: 0, frpMW: 30 }, amuay),
	);
	expect(links).toContainEqual({ entity: "infra.refineria-amuay", rule: "facility", confidence: 1 });
	expect(links.some((l) => l.entity === "ve.falcon")).toBe(true);
	expect(lk.observation(obs("firms-flares", { kind: "file", rows: 1 }))).toEqual([]);
});

test("headlines: the outlet, places at the news panel's confidence, institutions and facilities by name", () => {
	const item = (title: string, summary = "") =>
		({
			outlet: "el-pitazo",
			title,
			link: "https://example.org/a",
			summary,
			image: null,
			dateMissing: false,
			video: false,
		}) as Json;
	const a = lk.observation(obs("el-pitazo", item("Apagón en Maracaibo deja a varios sectores sin luz")));
	expect(a).toContainEqual({ entity: "outlet.el-pitazo", rule: "outlet", confidence: 1 });
	expect(ids(a.filter((l) => l.rule === "text-place"))).toEqual(["ve.zulia", "ve.zulia.maracaibo"]);
	// A feed of the same publisher (its YouTube channel) links to the same outlet.
	expect(lk.observation(obs("yt-el-pitazo", item("Hoy"))).map((l) => l.entity)).toEqual(["outlet.el-pitazo"]);
	// Institutions and facilities by their curated names; an acronym inside a word does not count.
	const b = lk.observation(obs("el-pitazo", item("El CNE y Corpoelec hablan del nivel del Guri")));
	expect(ids(b.filter((l) => l.rule === "text-name"))).toEqual(["infra.guri", "inst.cne", "inst.corpoelec"]);
	expect(
		lk.observation(obs("el-pitazo", item("Concejo municipal"))).filter((l) => l.rule === "text-name"),
	).toEqual([]);
	// "Sucre" alone is a person or a currency to the tagger: no state.
	expect(
		lk.observation(obs("el-pitazo", item("Homenaje a Sucre"))).filter((l) => l.rule === "text-place"),
	).toEqual([]);
	// The summary is read only when the headline names no place.
	const c = lk.observation(
		obs("el-pitazo", item("Protesta por el agua", "Vecinos de Barquisimeto, estado Lara, marcharon")),
	);
	expect(c.some((l) => l.entity === "ve.lara")).toBe(true);
	expect(c.filter((l) => l.rule === "text-place").every((l) => l.confidence >= RULES.textMinConfidence)).toBe(
		true,
	);
	// A parish named as such links the parish.
	const d = lk.observation(obs("el-pitazo", item("Cortes de agua en la parroquia 23 de Enero de Caracas")));
	expect(d.some((l) => l.entity === "ve.distrito-capital.libertador.23-de-enero")).toBe(true);
});

const headline = (title: string, summary = "", feed = "el-pitazo") =>
	lk.observation(
		obs(feed, {
			outlet: feed,
			title,
			link: "https://example.org/b",
			summary,
			image: null,
			dateMissing: false,
			video: false,
		}),
	);

test("names count in the title only: a name in the summary is not a link (the 2026-09-29 sample)", () => {
	// Found on the sample: a kidnapping rescue "en las instalaciones de Pdvsa San Tomé", linked to PDVSA.
	const rescue = headline(
		"Rescatan a tres víctimas de secuestro virtual y extorsión",
		"Funcionarios de la Policía Nacional Bolivariana (PNB) en las instalaciones de Pdvsa San Tomé",
	);
	expect(rescue.filter((l) => l.rule === "text-name")).toEqual([]);
	const named = headline("Pdvsa facturó US$ 17,2 mil millones en exportaciones", "Texto del resumen.");
	expect(named).toContainEqual({ entity: "inst.pdvsa", rule: "text-name", confidence: RULES.nameConfidence });
	// Places still follow the news panel's rule: the summary when the title names no state.
	expect(
		headline("Protesta por el agua", "Vecinos de Barquisimeto marcharon").some((l) => l.entity === "ve.lara"),
	).toBe(true);
});

test("the Asamblea Nacional of 2015 is not today's National Assembly", () => {
	const an = (title: string) => headline(title).some((l) => l.entity === "inst.an" && l.rule === "text-name");
	expect(an("Marco Rubio trabaja con la Asamblea Nacional de 2015 para celebrar elecciones")).toBe(false);
	expect(an("La representante de la Asamblea Nacional 2015, Dinorah Figuera, detalló resultados")).toBe(
		false,
	);
	expect(an("Reunión con la Asamblea Nacional (AN) electa en el 2015")).toBe(false);
	expect(an("La Asamblea Nacional aprueba en primera discusión la reforma")).toBe(true);
	expect(NOT_FOLLOWED_BY["inst.an"]?.test("aprueba la ley de 2015")).toBe(false);
});

test("a parish name other places share needs its municipality or state in the same text", () => {
	const reg = registry();
	const repeated = repeatedParishesOf(reg);
	expect(repeated.has("ve.distrito-capital.libertador.catedral")).toBe(true);
	expect(repeated.has("ve.distrito-capital.libertador.la-pastora")).toBe(true);
	expect(repeated.has("ve.distrito-capital.libertador.23-de-enero")).toBe(false);
	expect(repeated.has("ve.distrito-capital.libertador.antimano")).toBe(false);
	const catedral = "ve.distrito-capital.libertador.catedral";
	// Found on the sample: a Ciudad Bolívar hospital story linked to Caracas' Catedral (and to Distrito Capital).
	const bolivar = headline(
		"Servicio de Atención al Indígena del Hospital Ruiz y Páez conmemoró 21 años",
		"Prensa MinSalud / Bolívar.- El servicio conmemoró su aniversario en la parroquia Catedral del municipio Angostura del Orinoco",
	);
	expect(bolivar.some((l) => l.entity === catedral)).toBe(false);
	expect(bolivar.some((l) => l.entity === "ve.distrito-capital")).toBe(false);
	expect(
		headline("Cortes de agua en la parroquia Catedral de Caracas").some((l) => l.entity === catedral),
	).toBe(true);
	// Two repeated names cannot vouch for each other.
	expect(
		headline("Jornada en las parroquias La Pastora y San Agustín").some((l) =>
			l.entity.includes("libertador"),
		),
	).toBe(false);
	// A name only one parish has needs nothing more; a date is not a parish.
	expect(
		headline("Letal choque en Antímano").some((l) => l.entity === "ve.distrito-capital.libertador.antimano"),
	).toBe(true);
	expect(
		headline("Médicos", "El presidente habló el 23 de septiembre sobre los hospitales").some((l) =>
			l.entity.endsWith("23-de-enero"),
		),
	).toBe(false);
});

test("codes in the data: IODA events, the Gazette's organs, incidents; VE sin Filtro stays out of timelines", () => {
	const region = lk.observation(
		obs("ioda-events", { entityType: "region", entityCode: "4493", key: "VE-U" }),
	);
	expect(region).toEqual([{ entity: "ve.yaracuy", rule: "state-code", confidence: 1 }]);
	const asn = lk.observation(obs("ioda-events", { entityType: "asn", entityCode: "27717", key: "digitel" }));
	expect(ids(asn)).toEqual(["asn.27717", "net.digitel"]);
	const site = {
		domain: "example.org",
		isps: [
			{ isp: "cantv", methods: ["DNS"], status: "blocked" },
			{ isp: "digitel", methods: [], status: "ok" },
		],
	};
	// The list is republished whole with a new date: every old block would look new, so it is not linked.
	expect(lk.observation(obs("vesinfiltro-blocks", site))).toEqual([]);
	expect(lk.sources.has("vesinfiltro-blocks")).toBe(false);
	const issue = {
		acts: [
			{
				organ: "BANCO CENTRAL DE VENEZUELA",
				title: "Resolución",
				instrument: null,
				entity: null,
				withheld: null,
			},
			{ organ: "ÓRGANO DESCONOCIDO", title: null, instrument: null, entity: null, withheld: null },
		],
	};
	expect(lk.observation(obs("gaceta-oficial", issue))).toEqual([
		{ entity: "inst.bcv", rule: "organ", confidence: 1 },
	]);
	expect(lk.observation(obs("vigia-incidents", { id: "corte:VE-V:1", state: "VE-V" }))).toEqual([
		{ entity: "ve.zulia", rule: "incident", confidence: 1 },
		{ entity: "ve", rule: "incident", confidence: 1 },
	]);
	// IODA's country-level outages make the country's timeline.
	expect(lk.observation(obs("ioda-events", { entityType: "country", entityCode: "VE", key: "VE" }))).toEqual([
		{ entity: "ve", rule: "state-code", confidence: 1 },
	]);
	expect(lk.observation(obs("vigia-incidents", { id: "sismo:x", state: null }))).toEqual([]);
	// Sources that are series, not events, are never linked here.
	expect(lk.sources.has("ioda-states")).toBe(false);
	expect(lk.observation(obs("ioda-states", { v: 1 }, { lat: 10.5, lon: -66.9 }))).toEqual([]);
});

test("RIPEstat prefix snapshots link only when the netwatch panel's rule counts an event", () => {
	const base = {
		asn: "8048",
		isp: "cantv",
		announced: { v4: 0, v6: 0 },
		withdrawn: { v4: 0, v6: 0 },
		movedIn: [],
		movedOut: [],
		prevAt: 1,
		v4Addresses: 2_000_000,
		v4AddressesGained: 0,
		v4AddressesLost: 0,
		v4Prefixes: 400,
		v6Prefixes: 2,
		timingDated: 0,
		timingSampled: 0,
		withdrawalAt: null,
	};
	const quiet = lk.observation({ ...obs("ripestat-prefixes", base), observedAt: 2 });
	expect(quiet).toEqual([]);
	const big = lk.observation({
		...obs("ripestat-prefixes", { ...base, withdrawn: { v4: 50, v6: 0 }, v4AddressesLost: 400_000 }),
		observedAt: 2,
	});
	expect(big).toEqual([{ entity: "asn.8048", rule: "network", confidence: 1 }]);
});

test("an international desk's institution names count only when the story is about Venezuela", () => {
	const item = (title: string) =>
		({
			title,
			link: "https://example.org/b",
			summary: "",
			image: null,
			dateMissing: false,
			video: false,
		}) as Json;
	const foreign = "bbc-mundo";
	const other = lk.observation(obs(foreign, item("El CNE de Colombia fija la fecha de las elecciones")));
	expect(other.some((l) => l.entity === "inst.cne")).toBe(false);
	const ours = lk.observation(obs(foreign, item("El CNE de Venezuela fija la fecha de las elecciones")));
	expect(ours.some((l) => l.entity === "inst.cne")).toBe(true);
	// A Venezuelan outlet's "CNE" is the Venezuelan one.
	expect(
		lk.observation(obs("el-pitazo", item("El CNE fija la fecha"))).some((l) => l.entity === "inst.cne"),
	).toBe(true);
});

test("the published rules are generated from the constants", () => {
	const text = linkRulesText();
	expect(text.es.length).toBe(text.en.length);
	const all = text.es.join(" ");
	expect(all).toContain(`${RULES.quake.km} km`);
	expect(all).toContain(`al menos ${RULES.quake.minMag}`);
	expect(all).toContain(`${RULES.fire.km["power-plant"]} km`);
	// Spanish decimals in the Spanish text, English ones in the English text.
	expect(all).toContain(`al menos ${num(RULES.textMinConfidence)}`);
	expect(all).toContain("al menos 0,7");
	expect(all).not.toMatch(/\b0\.\d/);
	expect(text.en.join(" ")).toContain(`at least ${num(RULES.textMinConfidence, "en")}`);
	expect(all).toContain(`solo en el título (confianza ${num(RULES.nameConfidence)})`);
});

test("space sources: plumes, floods, forest alerts, radar ship counts and Cloudflare notes (rules version 6)", () => {
	expect(RULES.version).toBeGreaterThanOrEqual(6);
	const plume = lk.observation(
		obs(
			"carbon-mapper",
			{ plumeId: "p", facilityId: "faja-carabobo" },
			{ lat: 8.6676, lon: -62.9861, state: "VE-N" },
		),
	);
	expect(plume.find((l) => l.rule === "facility")?.entity).toBe("infra.campo-faja-carabobo");
	expect(plume.some((l) => l.entity === "ve.monagas")).toBe(true);
	const flood = (km2: number) => ({
		floodKm2: km2,
		recurringKm2: 50,
		waterKm2: 0,
		insufficientKm2: 0,
		nodataKm2: 0,
		areaKm2: 1,
		pixels: 1,
	});
	const day = lk.observation(
		obs("modis-floods", {
			date: "2026-09-27",
			states: { "VE-C": flood(12), "VE-V": flood(9.9) },
			municipalities: { VE0401: flood(5), VE0402: flood(4.9) },
		} as unknown as Json),
	);
	expect(ids(day)).toEqual(["ve", "ve.apure", reg.byCode("pcode:VE0401")?.id ?? "missing"].sort());
	expect(day.every((l) => l.rule === "threshold")).toBe(true);
	const split = (high: number) => ({ forestHa: [999, high, 0], otherHa: [0, 0, 0], forestAlerts: 1 });
	const week = lk.observation(
		obs("gfw-alerts", {
			kind: "week",
			week: "2026-09-14",
			states: { "VE-F": split(100), "VE-Z": split(99.9) },
			municipalities: {
				"6.1": { ...split(60), municipality: "VE0707", gadmName: "Angostura", state: "VE-F" },
				"6.2": { ...split(500), municipality: null, gadmName: "Caroní", state: "VE-F" },
			},
		} as unknown as Json),
	);
	// Nominal-confidence hectares never count; an unlinked GADM municipality is never linked.
	expect(ids(week)).toEqual(["ve", "ve.bolivar", reg.byCode("pcode:VE0707")?.id ?? ""].sort());
	const ships = lk.observation(
		obs("gfw-vessels", { area: "jose", date: "2026-09-20", detections: 3, withoutAis: 1 }),
	);
	expect(ids(ships)).toEqual(["infra.complejo-jose", "infra.terminal-jose"]);
	expect(ships.every((l) => l.rule === "area")).toBe(true);
	expect(
		lk.observation(obs("gfw-vessels", { area: "jose", date: "2026-09-20", detections: 0, withoutAis: 0 })),
	).toEqual([]);
	const note = lk.observation(
		obs("cloudflare-radar", {
			kind: "outage",
			scope: "Zulia",
			description: null,
			outageType: "REGIONAL",
			asns: [{ asn: 8048, name: "CANTV" }],
			locations: ["VE"],
		} as unknown as Json),
	);
	expect(ids(note)).toEqual(["asn.8048", "ve", "ve.zulia"]);
	expect(lk.observation(obs("cloudflare-radar", { kind: "traffic", points: [] } as unknown as Json))).toEqual(
		[],
	);
	const flight = (plausible: boolean) =>
		lk.observation(
			obs("adsb-flights", {
				kind: "flight",
				callsign: "CMP180",
				route: ["MPTO", "SVMI", "SVMC"],
				veAirports: ["SVMI", "SVMC"],
				routePlausible: plausible,
				class: "arrival",
			} as unknown as Json),
		);
	expect(ids(flight(true))).toEqual([reg.byCode("icao:SVMC")?.id ?? "?", "infra.aeropuerto-ccs"].sort());
	expect(flight(false)).toEqual([]);
	const text = linkRulesText();
	expect(text.es.join(" ")).toContain(`${RULES.flood.stateKm2} km²`);
	expect(text.en.join(" ")).toContain(`${RULES.forest.municipalityHa} ha`);
});

test("a name right after 'parroquia' is never read as a state, municipality or town (review M6)", () => {
	const lk = linker();
	const places = (title: string) =>
		lk
			.observation({
				source: "el-pitazo",
				series: "item:x",
				value: { outlet: "el-pitazo", title, link: "https://x", summary: "" },
			} as never)
			.filter((l) => l.rule === "text-place")
			.map((l) => l.entity);
	expect(places("Sin agua la parroquia Bolívar de Maturín")).not.toContain("ve.bolivar");
	expect(places("Protesta en la parroquia Concepción, municipio Iribarren")).toEqual([
		"ve.lara",
		"ve.lara.iribarren",
	]);
	expect(places("Vecinos de la parroquia Catedral de Caracas")).toContain(
		"ve.distrito-capital.libertador.catedral",
	);
});
