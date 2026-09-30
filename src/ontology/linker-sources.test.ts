import { expect, test } from "bun:test";
import type { Json, Observation } from "../core/types.ts";
import { linker, linkRulesText, RULES } from "./linker.ts";
import { registry } from "./registry.ts";
import { OFAC_STATE_BODIES, STATE_PHRASES, stateNamesIn, WIKIDATA_OFFICES } from "./state-names.ts";

// The sources merged after the linker was first written (sources-media and sources-data), one rule each.

const lk = linker();
const reg = registry();
const ids = (links: readonly { entity: string }[]) => links.map((l) => l.entity).sort();

const obs = (
	source: string,
	value: Json,
	series = `${source}:x`,
	location?: { lat: number; lon: number; state?: string },
) =>
	({
		source,
		series,
		value,
		...(location ? { location } : {}),
	}) satisfies Pick<Observation, "source" | "series" | "value" | "location">;

test("the rules version is at least 4 (5: names in titles only, parish rule), and every new source is linked and stated in words", () => {
	expect(RULES.version).toBeGreaterThanOrEqual(4);
	for (const s of [
		"gdelt-ve",
		"goes-glm",
		"iptv-ve",
		"radio-browser",
		"ofac-sdn",
		"ofac-venezuela",
		"federal-register",
		"wikidata-officials",
		"bcv-intervention",
		"polymarket",
		"kalshi",
		// fact-checkers and Google News were linked as outlets from the start: checked here.
		"cazadores-fake-news",
		"cotejo",
		"gn-cotejo",
		"gn-el-nacional",
	])
		expect(lk.sources.has(s), s).toBe(true);
	const es = linkRulesText().es.join(" ");
	for (const phrase of ["GDELT", "GOES-19 GLM", "Canales de TV", "OFAC", "Wikidata", "kinds"])
		expect(es).toContain(phrase);
	expect(linkRulesText().en).toHaveLength(linkRulesText().es.length);
});

test("GDELT: the article's coded place at confidence 0.5 (never the country), its outlet; batches are not linked", () => {
	const article = {
		url: "https://elpitazo.net/regiones/protesta-en-maracaibo/",
		domain: "elpitazo.net",
		stream: "tr",
		events: 2,
		roots: ["14"],
		quads: [3],
		goldsteinMin: -6.5,
		tone: -4.2,
		place: "Maracaibo, Zulia, Venezuela",
		state: "VE-V",
		placedBy: "point",
		numArticles: 3,
	};
	const at = { lat: 10.6545, lon: -71.6406, state: "VE-V" }; // Maracaibo
	const links = lk.observation(obs("gdelt-ve", article, "gdelt:article:abc", at));
	expect(links.find((l) => l.entity === "ve.zulia")).toEqual({
		entity: "ve.zulia",
		rule: "coded-place",
		confidence: RULES.gdeltConfidence,
	});
	expect(links.some((l) => l.entity === "ve.zulia.maracaibo" && l.rule === "coded-place")).toBe(true);
	expect(links.some((l) => l.entity === "ve")).toBe(false);
	expect(links.find((l) => l.rule === "outlet")?.entity).toBe("outlet.el-pitazo");
	// Placed only by GDELT's state code (no point): the state, at the same low confidence.
	const byCode = lk.observation(
		obs("gdelt-ve", { ...article, url: "https://example.com/x", placedBy: "adm1" }, "gdelt:article:def"),
	);
	expect(byCode).toEqual([{ entity: "ve.zulia", rule: "coded-place", confidence: RULES.gdeltConfidence }]);
	// A country-level article links nothing but its outlet; a batch (counts) links nothing.
	expect(
		lk.observation(obs("gdelt-ve", { ...article, state: null, placedBy: "country" }, "gdelt:article:ghi")),
	).toEqual([{ entity: "outlet.el-pitazo", rule: "outlet", confidence: 1 }]);
	expect(lk.observation(obs("gdelt-ve", { byState: { "VE-V": 9 }, events: 9 }, "gdelt:batch:en"))).toEqual(
		[],
	);
});

test("GLM lightning: states with flashes, the cell centre's municipality at 0.5, facilities inside a flashing cell", () => {
	const plant = reg.get("infra.planta-centro")?.point;
	if (!plant) throw new Error("no Planta Centro");
	const d = RULES.lightning.cellDeg;
	const centre = (x: number) => (Math.floor(x / d) + 0.5) * d;
	const window = {
		windowStart: "2026-09-29T02:00:00.000Z",
		windowMinutes: 15,
		filesListed: 45,
		filesRead: 45,
		complete: true,
		venezuela: 120,
		catatumbo: 0,
		lake: 0,
		byState: { "VE-G": 100, "VE-F": 20, "VE-Z": 0 },
		cells: [
			[centre(plant.lat), centre(plant.lon), 100],
			[11.875, -66.125, 5], // open sea
			[6.125, -62.125, 0], // a zero cell counts for nothing
		],
		flagged: 3,
		satellite: "GOES-19",
	};
	const links = lk.observation(obs("goes-glm", window as unknown as Json, "window"));
	expect(
		links
			.filter((l) => l.rule === "located")
			.map((l) => l.entity)
			.sort(),
	).toEqual(["ve.bolivar", "ve.carabobo"]);
	expect(links.some((l) => l.entity === "ve.amazonas")).toBe(false);
	const plantLink = links.find((l) => l.entity === "infra.planta-centro");
	expect(plantLink).toMatchObject({ rule: "grid-cell", confidence: 1 });
	expect(plantLink?.km ?? 99).toBeLessThanOrEqual(20); // within half the cell's diagonal
	const muni = links.find((l) => l.rule === "grid-cell" && l.entity.startsWith("ve.carabobo."));
	expect(muni?.confidence).toBe(RULES.lightning.municipalityConfidence);
	// Neither the country (every storm) nor the transmission grid (it crosses dozens of cells).
	expect(links.some((l) => l.entity === "ve" || l.entity.startsWith("infra.red-"))).toBe(false);
	expect(RULES.lightning.kinds).not.toContain("power-grid");
	expect(RULES.lightning.kinds).not.toContain("hospital");
});

test("TV and radio directories: the states they serve and their own outlet; excluded listings and summaries link nothing", () => {
	const tv = {
		key: "Telesur.ve/SD/abc",
		channel: "Telesur.ve",
		feed: "SD",
		name: "Telesur",
		url: "https://example.org/live.m3u8",
		https: true,
		quality: "720p",
		categories: ["news"],
		notAlways: false,
		geoBlocked: false,
		country: "VE",
		states: ["VE-K"],
		statesFrom: "vigia",
		ownership: "state-funded",
		website: "https://www.telesurtv.net/",
		status: "on",
		reason: null,
		reasonDetail: null,
	};
	expect(ids(lk.observation(obs("iptv-ve", tv, "iptv:x")))).toEqual(["outlet.telesur", "ve.lara"]);
	expect(lk.observation(obs("iptv-ve", { ...tv, status: "excluded", reason: "pay-ve" }, "iptv:y"))).toEqual(
		[],
	);
	const radio = {
		uuid: "u1",
		name: "Radio Nacional de Venezuela - Informativa",
		frequency: "630 AM",
		url: "https://example.org/rnv",
		https: true,
		hls: false,
		homepage: "http://www.rnv.gob.ve/",
		codec: "MP3",
		bitrateKbps: 64,
		states: ["VE-A", "VE-M"],
		statesFrom: "geo",
		curatedWhy: null,
		ownership: "state",
		status: "on",
		reason: null,
		reasonDetail: null,
	};
	const r = lk.observation(obs("radio-browser", radio, "rb:u1"));
	expect(ids(r)).toEqual(["outlet.rnv", "ve.distrito-capital", "ve.miranda"]);
	expect(r.filter((l) => l.rule === "broadcast-area")).toHaveLength(2);
	// A homepage on a host many outlets share (YouTube) names no outlet.
	expect(
		ids(lk.observation(obs("radio-browser", { ...radio, homepage: "https://www.youtube.com/@x" }, "rb:u2"))),
	).toEqual(["ve.distrito-capital", "ve.miranda"]);
	expect(lk.observation(obs("radio-browser", { listed: 203, broadcasters: 123 }, "rb:summary"))).toEqual([]);
});

test("OFAC: a state body's designation by OFAC's record id; a named official's institutions by title; nobody else", () => {
	const change = (subject: Json, action = "add") => ({
		kind: "change",
		publicationId: 959,
		action,
		subject,
		programs: ["VENEZUELA-EO13850"],
		listedOn: null,
	});
	expect(
		lk.observation(
			obs(
				"ofac-sdn",
				change({ type: "entity", uid: "26727", name: "BANCO CENTRAL DE VENEZUELA" }),
				"change:1:0",
			),
		),
	).toEqual([{ entity: "inst.bcv", rule: "sanctioned", confidence: 1 }]);
	expect(
		lk.observation(
			obs("ofac-sdn", change({ type: "entity", uid: "26219", name: "SEGUROS LA VITALICIA C.A." })),
		),
	).toEqual([]);
	const official = {
		type: "individual",
		named: true,
		uid: "1",
		name: "Public Official",
		title:
			"Magistrate of the Constitutional Chamber of Venezuela's Supreme Court of Justice; Former President of Venezuela's Supreme Court of Justice",
		basis: "ofac-title",
		wikidata: { qid: "Q1", label: "x", position: "rector del Consejo Nacional Electoral de Venezuela" },
	};
	const off = lk.observation(obs("ofac-sdn", change(official, "remove"), "change:2:0"));
	expect(ids(off)).toEqual(["inst.cne", "inst.tsj"]);
	expect(off.every((l) => l.rule === "office" && l.confidence === RULES.titleConfidence)).toBe(true);
	// Unnamed people, vessels, aircraft, publications and snapshots link nothing.
	expect(lk.observation(obs("ofac-sdn", change({ type: "individual", named: false })))).toEqual([]);
	expect(lk.observation(obs("ofac-sdn", change({ type: "aircraft", model: "Falcon" })))).toEqual([]);
	expect(lk.observation(obs("ofac-sdn", { kind: "publication", publicationId: 1 }, "publication:1"))).toEqual(
		[],
	);
	// Every mapped record points at an entity that exists.
	for (const [uid, b] of Object.entries(OFAC_STATE_BODIES)) expect(reg.get(b.entity), uid).toBeDefined();
});

test("licences, OFAC notices and the Federal Register: institutions their titles name", () => {
	const gl = (title: string) => ({
		kind: "licence",
		id: "5Z",
		number: "5",
		revision: "Z",
		title,
		issued: "2026-09-16",
		url: "https://ofac.treasury.gov/media/936946/download?inline",
	});
	expect(
		ids(
			lk.observation(
				obs(
					"ofac-venezuela",
					gl(
						"Authorizing Certain Transactions Related to the Petróleos de Venezuela, S.A. 2020 8.5 Percent Bond on or After November 5, 2026",
					),
					"gl:5",
				),
			),
		),
	).toEqual(["inst.pdvsa"]);
	expect(
		ids(
			lk.observation(
				obs(
					"ofac-venezuela",
					gl("Authorizing Certain Activities Involving PDV Holding, Inc. and CITGO Holding, Inc."),
				),
			),
		),
	).toEqual(["inst.citgo", "inst.pdv-holding"]);
	expect(
		ids(
			lk.observation(
				obs(
					"ofac-venezuela",
					gl("Certain Transactions Involving the IV Venezuelan National Assembly and Certain Other Persons"),
				),
			),
		),
	).toEqual(["inst.an"]);
	expect(
		lk.observation(
			obs("ofac-venezuela", gl("Authorizing Transactions Related to Earthquake Relief Efforts in Venezuela")),
		),
	).toEqual([]);
	expect(lk.observation(obs("ofac-venezuela", { kind: "list", ids: ["5Z"] }, "list"))).toEqual([]);
	const fr = {
		number: "2026-1",
		type: "Notice",
		publicationDate: "2026-09-01",
		agencies: ["Treasury Department"],
		relevance: "title",
		title: "Unblocking of Banco Central de Venezuela",
		abstract: null,
		htmlUrl: "https://www.federalregister.gov/d/2026-1",
		pdfUrl: null,
	};
	expect(lk.observation(obs("federal-register", fr, "doc:2026-1"))).toEqual([
		{ entity: "inst.bcv", rule: "text-name", confidence: RULES.titleConfidence },
	]);
	expect(lk.observation(obs("federal-register", { ...fr, title: null }, "doc:2026-2"))).toEqual([]);
});

test("the hand-checked phrases: whole words, longest first, and a longer name of another body blocks a shorter one", () => {
	expect(stateNamesIn("Miembro de la Asamblea Nacional Constituyente")).toEqual([]);
	expect(stateNamesIn("Presidente de la Asamblea Nacional de Venezuela")).toEqual(["inst.an"]);
	expect(stateNamesIn("Vicepresidente de Venezuela")).toEqual(["inst.vicepresidencia"]);
	expect(stateNamesIn("Venezuela's Minster of Culture")).toEqual(["inst.mpp-cultura"]);
	expect(
		stateNamesIn("Bolivarian National Guard; Former Director of the Bolivarian National Police"),
	).toEqual(["inst.gnb", "inst.pnb"]);
	// "CITGO" inside another word, or "Banco Central de Venezuela" read as "Banco de Venezuela", never match.
	expect(stateNamesIn("Citgoland; Banco Central de Venezuela")).toEqual(["inst.bcv"]);
	for (const [phrase, id] of STATE_PHRASES) if (id) expect(reg.get(id), phrase).toBeDefined();
	for (const [qid, id] of Object.entries(WIKIDATA_OFFICES)) expect(reg.get(id), qid).toBeDefined();
});

test("Wikidata offices, BCV interventions and prediction markets", () => {
	const office = (qid: string, state: string | null) => ({
		office: { qid, label: "x" },
		kind: state ? "governor" : "minister",
		state,
		status: "current",
		latestTerm: null,
		termsRecorded: 1,
		undatedTerms: 0,
		wikidataUrl: `https://www.wikidata.org/wiki/${qid}`,
	});
	expect(lk.observation(obs("wikidata-officials", office("Q137530422", null), "office:Q137530422"))).toEqual([
		{ entity: "inst.bcv", rule: "office", confidence: 1 },
	]);
	expect(lk.observation(obs("wikidata-officials", office("Q6572236", "VE-V"), "office:Q6572236"))).toEqual([
		{ entity: "ve.zulia", rule: "office", confidence: 1 },
	]);
	// An office of a ministry Vigía has no entity for (Alimentación) links nothing.
	expect(lk.observation(obs("wikidata-officials", office("Q16607785", null)))).toEqual([]);
	expect(
		lk.observation(obs("bcv-intervention", { number: "030-26", vesPerEur: 976.9 }, "intervention")),
	).toEqual([{ entity: "inst.bcv", rule: "publisher", confidence: 1 }]);
	expect(lk.observation(obs("kalshi", { question: "x" }, "market:K"))).toEqual([
		{ entity: "ve", rule: "market", confidence: 1 },
	]);
});

test("fact-checkers and Google News feeds link to their outlets, as every headline does", () => {
	const item = (outlet: string) => ({
		outlet,
		title: "Falso: el CNE no anunció nada",
		link: "https://example.org/1",
		summary: "",
		image: null,
		dateMissing: false,
		video: false,
	});
	expect(ids(lk.observation(obs("cazadores-fake-news", item("cazadores-fake-news"))))).toEqual([
		"inst.cne",
		"outlet.cazadores-fake-news",
	]);
	expect(lk.observation(obs("gn-cotejo", item("gn-cotejo"))).find((l) => l.rule === "outlet")?.entity).toBe(
		"outlet.cotejo",
	);
});
