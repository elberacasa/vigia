/**
 * Downloads the open inputs of the entity registry once, into a directory outside the tracked tree (default
 * data/ontology/raw, which git ignores), with a manifest of what was fetched, when, from where and how big. `build.ts` turns
 * them into the compact files under src/ontology/data.
 *
 *   bun scripts/ontology/fetch.ts [raw-dir] [--only id,id]
 *
 * Politeness: one request at a time, the project User-Agent, and a pause between Overpass queries (the public
 * instance asks for no more than a couple of concurrent slots per client; we use one, then wait). A file already
 * present is not fetched again unless it is named in --only.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { USER_AGENT } from "../../src/core/http.ts";

const OVERPASS = "https://overpass-api.de/api/interpreter";
/** Seconds between Overpass queries. */
const OVERPASS_GAP_S = 20;
const AREA = 'area["ISO3166-1"="VE"][admin_level=2]->.ve;';

type Input = {
	readonly id: string;
	readonly file: string;
	readonly url: string;
	/** Overpass QL; the request is a POST of `data=<query>`. */
	readonly overpass?: string;
	readonly licence: string;
	readonly note: string;
};

const q = (body: string, out = "out center tags;") => `[out:json][timeout:240];${AREA}(${body});${out}`;

export const INPUTS: readonly Input[] = [
	{
		id: "osm-power-plants",
		file: "osm-power-plants.json",
		url: OVERPASS,
		overpass: q('nwr["power"="plant"](area.ve);'),
		licence: "ODbL-1.0",
		note: "Every power=plant in Venezuela, with its centre and tags.",
	},
	{
		id: "osm-substations",
		file: "osm-substations.json",
		url: OVERPASS,
		overpass: q('nwr["power"="substation"](area.ve);'),
		licence: "ODbL-1.0",
		note: "Every power=substation (filtered by voltage in build.ts).",
	},
	{
		id: "osm-lines",
		file: "osm-lines.json",
		url: OVERPASS,
		overpass: q(
			'way["power"="line"]["voltage"~"(^|;)(765000|400000|230000)($|;)"](area.ve);',
			"out geom tags;",
		),
		licence: "ODbL-1.0",
		note: "Transmission lines at 230, 400 and 765 kV, with their geometry.",
	},
	{
		id: "osm-oil",
		file: "osm-oil.json",
		url: OVERPASS,
		overpass: q(
			'nwr["industrial"="refinery"](area.ve);nwr["industrial"="oil"](area.ve);nwr["man_made"="works"]["product"~"oil|petrol|gas",i](area.ve);',
		),
		licence: "ODbL-1.0",
		note: "Refineries and oil industry sites.",
	},
	{
		id: "osm-ports",
		file: "osm-ports.json",
		url: OVERPASS,
		overpass: q(
			'nwr["landuse"="port"](area.ve);nwr["industrial"="port"](area.ve);nwr["harbour"](area.ve);nwr["seamark:type"="harbour"](area.ve);',
		),
		licence: "ODbL-1.0",
		note: "Ports, harbours and terminals.",
	},
	{
		id: "osm-water",
		file: "osm-water.json",
		url: OVERPASS,
		overpass: q('nwr["waterway"="dam"]["name"](area.ve);nwr["water"="reservoir"]["name"](area.ve);'),
		licence: "ODbL-1.0",
		note: "Named dams and reservoirs.",
	},
	{
		id: "osm-hospitals",
		file: "osm-hospitals.json",
		url: OVERPASS,
		overpass: q('nwr["amenity"="hospital"](area.ve);'),
		licence: "ODbL-1.0",
		note: "Hospitals (amenity=hospital).",
	},
	{
		id: "ourairports",
		file: "ourairports-airports.csv",
		url: "https://davidmegginson.github.io/ourairports-data/airports.csv",
		licence: "Public domain (OurAirports)",
		note: "OurAirports' world airport list (filtered to VE in build.ts).",
	},
	{
		id: "imf-portwatch-ports",
		file: "portwatch-ports-ven.json",
		url: "https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/PortWatch_ports_database/FeatureServer/0/query?where=ISO3%3D%27VEN%27&outFields=portid,portname,lat,lon,LOCODE,vessel_count_total,vessel_count_tanker,industry_top1,share_country_maritime_import,share_country_maritime_export&returnGeometry=false&f=json",
		licence: "IMF terms (reuse with attribution)",
		note: "IMF PortWatch's port list for Venezuela: the ports and terminals the imf-portwatch feed reports on.",
	},
	{
		id: "ine-census-2011-adm2",
		file: "ven_admpop_adm2_2011_v3.csv",
		url: "https://data.humdata.org/dataset/5c74e336-3162-44da-8c52-d4818c31c37b/resource/08faf516-e8cd-4834-8ac5-5a5ec081d0c3/download/ven_admpop_adm2_2011_v3.csv",
		licence: "CC BY-IGO 3.0",
		note: "INE census 2011 population per municipality, via OCHA COD-PS (HDX cod-ps-ven).",
	},
	{
		id: "ine-census-2011-xlsx",
		file: "ven_admpop_2011_v2.xlsx",
		url: "https://data.humdata.org/dataset/5c74e336-3162-44da-8c52-d4818c31c37b/resource/88fdaeaf-61e8-465a-8830-1751f6d06b86/download/ven_admpop_2011_v2.xlsx",
		licence: "CC BY-IGO 3.0",
		note: "INE census 2011 population, every admin level (parishes included), via OCHA COD-PS.",
	},
	{
		id: "worldpop-2026-1km",
		file: "ven_pop_2026_CN_1km_R2025A_UA_v1.tif",
		url: "https://data.worldpop.org/GIS/Population/Global_2015_2030/R2025A/2026/VEN/v1/1km_ua/constrained/ven_pop_2026_CN_1km_R2025A_UA_v1.tif",
		licence: "CC BY 4.0",
		note: "WorldPop Global2 R2025A, constrained, 1 km, people per cell, 2026 (modelled estimate).",
	},
	{
		id: "worldpop-licence",
		file: "worldpop-licence.txt",
		url: "https://hub.worldpop.org/data/licence.txt",
		licence: "CC BY 4.0",
		note: "WorldPop's licence text, kept beside the grid.",
	},
];

type ManifestEntry = {
	id: string;
	file: string;
	url: string;
	fetchedAt: string;
	bytes: number;
	sha256: string;
};

async function fetchOne(input: Input): Promise<Uint8Array> {
	const init: RequestInit = {
		headers: { "user-agent": USER_AGENT, accept: "*/*" },
		signal: AbortSignal.timeout(300_000),
	};
	if (input.overpass) {
		init.method = "POST";
		init.body = new URLSearchParams({ data: input.overpass });
		(init.headers as Record<string, string>)["content-type"] = "application/x-www-form-urlencoded";
	}
	const response = await fetch(input.url, init);
	if (!response.ok) throw new Error(`${input.id}: HTTP ${response.status}`);
	return new Uint8Array(await response.arrayBuffer());
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const onlyAt = args.indexOf("--only");
	const only = onlyAt >= 0 ? new Set((args[onlyAt + 1] ?? "").split(",")) : null;
	const dir = args.find((a, i) => !a.startsWith("--") && i !== onlyAt + 1) ?? "data/ontology/raw";
	mkdirSync(dir, { recursive: true });
	const manifestPath = join(dir, "manifest.json");
	const manifest: Record<string, ManifestEntry> = existsSync(manifestPath)
		? (JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, ManifestEntry>)
		: {};
	let lastOverpass = 0;
	for (const input of INPUTS) {
		const path = join(dir, input.file);
		if (only ? !only.has(input.id) : existsSync(path)) continue;
		if (input.overpass) {
			const wait = lastOverpass + OVERPASS_GAP_S * 1000 - Date.now();
			if (wait > 0) await Bun.sleep(wait);
		}
		const started = performance.now();
		const bytes = await fetchOne(input);
		if (input.overpass) lastOverpass = Date.now();
		writeFileSync(path, bytes);
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		manifest[input.id] = {
			id: input.id,
			file: input.file,
			url: input.url,
			fetchedAt: new Date().toISOString(),
			bytes: bytes.byteLength,
			sha256,
		};
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
		console.log(
			`${input.id}: ${bytes.byteLength.toLocaleString("en")} bytes in ${Math.round(performance.now() - started)} ms`,
		);
	}
}
