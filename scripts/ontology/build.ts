/**
 * Builds the entity registry's generated data files from the raw inputs `fetch.ts` downloaded:
 *
 *   src/ontology/data/parishes.geo.json        1,134 parishes: simplified shapes, names, label points, areas
 *   src/ontology/data/infrastructure.json      power plants, substations, the transmission grid, refineries,
 *                                              oil and gas fields, ports and terminals, airports, dams,
 *                                              reservoirs and hospitals, each already placed in its parish
 *   src/ontology/data/population.json          INE census 2011 per municipality, WorldPop 2026 per municipality
 *                                              and parish, and a coarse WorldPop grid for "people within R km"
 *
 *   bun scripts/ontology/build.ts [raw-dir] [cod-fixed-dir]
 *
 * Inputs: raw-dir (default data/ontology/raw, from fetch.ts), the COD-AB admin-3 layer and label points (default
 * data/geo/raw: the OCHA COD-AB download with the spelling fixes in cod-fixed/), <raw-dir>/../population-worldpop.json
 * (population.py),
 * and src/adapters/firms-flares/facilities.json. Deterministic: the same inputs give the same bytes (no clock; the
 * inputs' own dates are recorded). Heavy steps run pinned to cores 8-15 (shared machine).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FACILITIES } from "../../src/adapters/firms-flares/facilities.ts";
import { distanceKm, stateByIso } from "../../src/geo/index.ts";
import { shortMunicipalityName, slug } from "../../src/ontology/slug.ts";

const ROOT = join(import.meta.dir, "..", "..");
const OUT = join(ROOT, "src", "ontology", "data");
const RAW = process.argv[2] ?? "data/ontology/raw";
const GEO_RAW = process.argv[3] ?? "data/geo/raw";
const WORLDPOP = join(RAW, "..", "population-worldpop.json");

type Manifest = Record<string, { fetchedAt: string; url: string; sha256: string }>;
let manifest: Manifest | null = null;
/** The day an input was fetched (fetch.ts's manifest), read on first use so the helpers import without inputs. */
const fetchedDay = (id: string) => {
	manifest ??= JSON.parse(readFileSync(join(RAW, "manifest.json"), "utf8")) as Manifest;
	return manifest[id]?.fetchedAt.slice(0, 10) ?? "unknown";
};

const round = (x: number, digits: number) => {
	const f = 10 ** digits;
	return Math.round(x * f) / f;
};

// ——— parishes ———

/** Same simplification family as the municipal layer (scripts/geo/02_boundaries.sh), at 3 % for 1,134 parishes. */
const PARISH_SIMPLIFY = "3%";

async function buildParishes(): Promise<void> {
	const tmp = mkdtempSync(join(tmpdir(), "vigia-ontology-"));
	const shapesPath = join(tmp, "parishes-simplified.json");
	const proc = Bun.spawn(
		[
			"nice",
			"-n",
			"10",
			"taskset",
			"-c",
			"8-15",
			"bunx",
			"mapshaper@0.7.67",
			join(GEO_RAW, "cod-fixed", "ven_admin3.geojson"),
			"-filter",
			'adm1_pcode != "VE25"',
			"-each",
			"code=adm3_pcode, m=adm2_pcode",
			"-filter-fields",
			"code,m",
			"-simplify",
			"weighted",
			`percentage=${PARISH_SIMPLIFY}`,
			"keep-shapes",
			"-o",
			shapesPath,
			"format=geojson",
			"precision=0.0001",
		],
		{ stdout: "inherit", stderr: "inherit" },
	);
	if ((await proc.exited) !== 0) throw new Error("mapshaper failed");

	type Props = Record<string, unknown>;
	const full = JSON.parse(readFileSync(join(GEO_RAW, "cod-fixed", "ven_admin3.geojson"), "utf8")) as {
		features: { properties: Props }[];
	};
	const points = JSON.parse(readFileSync(join(GEO_RAW, "cod", "ven_adminpoints.geojson"), "utf8")) as {
		features: { properties: Props }[];
	};
	const label = new Map<string, { lat: number; lon: number }>();
	for (const f of points.features) {
		const p = f.properties;
		if (p.admin_level === 3 && typeof p.adm3_pcode === "string")
			label.set(p.adm3_pcode, { lat: Number(p.y_coord), lon: Number(p.x_coord) });
	}
	const info = new Map<string, { name: string; areaKm2: number; lat: number; lon: number }>();
	for (const f of full.features) {
		const p = f.properties;
		const code = String(p.adm3_pcode);
		const at = label.get(code) ?? { lat: Number(p.center_lat), lon: Number(p.center_lon) };
		info.set(code, {
			name: String(p.adm3_name),
			areaKm2: round(Number(p.area_sqkm), 1),
			lat: round(at.lat, 5),
			lon: round(at.lon, 5),
		});
	}
	const simplified = JSON.parse(readFileSync(shapesPath, "utf8")) as {
		features: { type: string; properties: { code: string; m: string }; geometry: unknown }[];
	};
	const features = simplified.features
		.map((f) => {
			const i = info.get(f.properties.code);
			if (!i) throw new Error(`parish ${f.properties.code} has no attributes`);
			return {
				type: "Feature",
				properties: { code: f.properties.code, m: f.properties.m, ...i },
				geometry: f.geometry,
			};
		})
		.sort((a, b) => a.properties.code.localeCompare(b.properties.code));
	rmSync(tmp, { recursive: true, force: true });
	const doc = {
		type: "FeatureCollection",
		meta: {
			source: "OCHA COD-AB Venezuela v01 (HDX cod-ab-ven), admin level 3",
			licence: "CC BY-IGO 3.0",
			attribution: "Instituto Nacional de Estadística (INE) Venezuela; OCHA Venezuela; OCHA FIS / HDX",
			simplify: `mapshaper weighted ${PARISH_SIMPLIFY}, keep-shapes, precision 0.0001`,
			note: "Dependencias Federales has no parishes (OCHA's placeholder VE250101 is left out). Names carry the spelling fixes of scripts/geo/01_fix_names.py.",
		},
		features,
	};
	writeFileSync(join(OUT, "parishes.geo.json"), `${JSON.stringify(doc)}\n`);
	console.log(`parishes: ${features.length}`);
}

// ——— infrastructure ———

type OsmElement = {
	type: "node" | "way" | "relation";
	id: number;
	lat?: number;
	lon?: number;
	center?: { lat: number; lon: number };
	tags?: Record<string, string>;
	geometry?: { lat: number; lon: number }[];
};

const readOsm = (file: string) =>
	(JSON.parse(readFileSync(join(RAW, file), "utf8")) as { elements: OsmElement[] }).elements;

const osmRef = (e: OsmElement) => `${e.type}/${e.id}`;
const centreOf = (e: OsmElement) =>
	e.center ?? (e.lat !== undefined ? { lat: e.lat, lon: e.lon ?? 0 } : null);

export type InfraRecord = {
	id: string;
	kind: string;
	name: { es: string; en: string };
	aliases: string[];
	lat: number;
	lon: number;
	state: string | null;
	municipality: string | null;
	parish: string | null;
	placement: string;
	dataset: "osm" | "ourairports" | "imf-portwatch-ports" | "flare-facilities";
	codes: Record<string, string>;
	attributes: Record<string, string | number | boolean | string[] | number[] | null>;
	operator: string | null;
	/** Power grid only: simplified polylines, [lat, lon] pairs. */
	lines?: [number, number][][];
};

/** A record whose id is chosen later (from its name), unless a curated one is given. */
type Rest = Omit<InfraRecord, "id" | "state" | "municipality" | "parish" | "placement"> & { id?: string };

/** Institutions an operator tag points to (matched on the normalised text; unknown operators stay text). */
const OPERATORS: readonly [RegExp, string][] = [
	[/corpoelec|edelca|cadafe|cadela|eleval|enelven|enelbar|electricidad de caracas/i, "inst.corpoelec"],
	[/pequiven/i, "inst.pequiven"],
	[/pdvsa|petr[oó]leos de venezuela/i, "inst.pdvsa"],
	[/bolipuertos/i, "inst.bolipuertos"],
];
const operatorOf = (text: string | undefined): string | null => {
	if (!text) return null;
	for (const [re, id] of OPERATORS) if (re.test(text)) return id;
	return null;
};

/** "10235 MW" → 10235; "2376 Mw." → 2376; "100.32 MW" → 100.32; "5 kW" → 0.005; "yes" or a bare number → null. */
export function capacityMW(raw: string | undefined): number | null {
	if (!raw) return null;
	const m = /^\s*([\d.,]+)\s*(gw|mw|kw)\b/i.exec(raw);
	if (!m?.[1] || !m[2]) return null;
	const n = Number(m[1].replace(",", "."));
	if (!Number.isFinite(n)) return null;
	const unit = m[2].toLowerCase();
	return round(unit === "gw" ? n * 1000 : unit === "kw" ? n / 1000 : n, 3);
}

/**
 * The big Caroní plants and Tacoa carry OSM names that are unit lists or lack the name people use; these are the
 * public names (Corpoelec's), keyed by OSM id. Nothing else is renamed by hand.
 */
const PLANT_NAMES: Record<string, { id: string; es: string; en: string; aliases: string[] }> = {
	"relation/15238110": {
		id: "infra.guri",
		es: "Central Hidroeléctrica Simón Bolívar (Guri)",
		en: "Simón Bolívar hydroelectric plant (Guri)",
		aliases: ["Guri", "Central Hidroeléctrica Guri"],
	},
	"way/791395086": {
		id: "infra.tocoma",
		es: "Central Hidroeléctrica Manuel Piar (Tocoma)",
		en: "Manuel Piar hydroelectric plant (Tocoma)",
		aliases: ["Tocoma"],
	},
	"way/497224777": {
		id: "infra.caruachi",
		es: "Central Hidroeléctrica Francisco de Miranda (Caruachi)",
		en: "Francisco de Miranda hydroelectric plant (Caruachi)",
		aliases: ["Caruachi"],
	},
	"way/677304875": {
		id: "infra.macagua-i",
		es: "Macagua I (Central Hidroeléctrica Antonio José de Sucre)",
		en: "Macagua I (Antonio José de Sucre hydroelectric plant)",
		aliases: ["Macagua I"],
	},
	"way/265095243": {
		id: "infra.macagua-ii",
		es: "Macagua II (Central Hidroeléctrica Antonio José de Sucre)",
		en: "Macagua II (Antonio José de Sucre hydroelectric plant)",
		aliases: ["Macagua II"],
	},
	"way/309152562": {
		id: "infra.macagua-iii",
		es: "Macagua III (Central Hidroeléctrica Antonio José de Sucre)",
		en: "Macagua III (Antonio José de Sucre hydroelectric plant)",
		aliases: ["Macagua III"],
	},
	"way/704227276": {
		id: "infra.planta-centro",
		es: "Planta Centro",
		en: "Planta Centro power plant",
		aliases: [],
	},
};

/** "Termozulia I Power Plant" → "Planta Termozulia I" (several OSM plants carry an English name only). */
export function plantNameEs(name: string): string {
	return name.replace(/^(.*?)\s+(Power Plant|Power Station|Thermoelectric Complex)$/i, "Planta $1");
}

const SOURCE_ES: Record<string, string> = {
	hydro: "hidroeléctrica",
	gas: "a gas",
	oil: "a fueloil",
	diesel: "a diésel",
	gasoline: "a gasolina",
	wind: "eólica",
	solar: "solar",
};

function powerPlants(): Rest[] {
	const out: Rest[] = [];
	for (const e of readOsm("osm-power-plants.json")) {
		const t = e.tags ?? {};
		const c = centreOf(e);
		if (!c) continue;
		const mw = capacityMW(t["plant:output:electricity"]);
		const source = t["plant:source"] ?? null;
		if (!t.name && mw === null) continue;
		const kindEs = source ? (SOURCE_ES[source.split(";")[0] ?? ""] ?? source) : null;
		const unnamed = `Planta eléctrica ${kindEs ?? ""}${mw !== null ? ` de ${mw} MW` : ""} (sin nombre en OSM)`
			.replace(/\s+/g, " ")
			.replace(" )", ")");
		const curated = PLANT_NAMES[osmRef(e)];
		const name = curated?.es ?? (t.name ? plantNameEs(t.name) : unnamed);
		out.push({
			...(curated ? { id: curated.id } : {}),
			kind: "power-plant",
			name: { es: name, en: curated?.en ?? t["name:en"] ?? t.name ?? name },
			aliases: [...(curated?.aliases ?? []), ...(t.name && t.name !== name ? [t.name] : [])],
			lat: round(c.lat, 5),
			lon: round(c.lon, 5),
			dataset: "osm",
			codes: { osm: osmRef(e) },
			attributes: {
				source,
				capacityMW: mw,
				capacityTag: t["plant:output:electricity"] ?? null,
				operatorTag: t.operator ?? null,
			},
			operator: operatorOf(t.operator) ?? operatorOf(t.name),
		});
	}
	return out;
}

const kv = (v: string) =>
	v
		.split(";")
		.map((x) => Number(x.trim()) / 1000)
		.filter((x) => Number.isFinite(x) && x > 0);

function substations(): Rest[] {
	const out: Rest[] = [];
	for (const e of readOsm("osm-substations.json")) {
		const t = e.tags ?? {};
		const c = centreOf(e);
		if (!c) continue;
		const volts = kv(t.voltage ?? "");
		const top = volts.length ? Math.max(...volts) : null;
		// Named substations, and unnamed ones of the bulk grid (230 kV and up); unnamed distribution ones add noise.
		if (!t.name && (top === null || top < 230)) continue;
		const name = t.name ? `Subestación ${t.name.replace(/^(S\/E|Subestaci[oó]n|SE)\s+/i, "")}` : null;
		const es = name ?? `Subestación de ${top} kV (sin nombre en OSM)`;
		out.push({
			kind: "substation",
			name: { es, en: name ? `${t.name?.replace(/^(S\/E|Subestaci[oó]n|SE)\s+/i, "")} substation` : es },
			aliases: t.name ? [t.name] : [],
			lat: round(c.lat, 5),
			lon: round(c.lon, 5),
			dataset: "osm",
			codes: { osm: osmRef(e) },
			attributes: { voltagesKV: volts, operatorTag: t.operator ?? null },
			operator: operatorOf(t.operator),
		});
	}
	return out;
}

/** Douglas–Peucker on [lat, lon] in a local km projection; tolerance in km. */
export function simplifyLine(points: [number, number][], toleranceKm: number): [number, number][] {
	if (points.length <= 2) return points;
	const lat0 = points[0]?.[0] ?? 0;
	const k = Math.cos((lat0 * Math.PI) / 180) * 111.32;
	const xy = points.map(([lat, lon]) => [lon * k, lat * 111.32] as const);
	const keep = new Uint8Array(points.length);
	keep[0] = 1;
	keep[points.length - 1] = 1;
	const stack: [number, number][] = [[0, points.length - 1]];
	while (stack.length) {
		const [a, b] = stack.pop() as [number, number];
		const [ax, ay] = xy[a] as readonly [number, number];
		const [bx, by] = xy[b] as readonly [number, number];
		const dx = bx - ax;
		const dy = by - ay;
		const len2 = dx * dx + dy * dy;
		let worst = -1;
		let at = -1;
		for (let i = a + 1; i < b; i++) {
			const [px, py] = xy[i] as readonly [number, number];
			const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
			const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
			if (d > worst) {
				worst = d;
				at = i;
			}
		}
		if (worst > toleranceKm && at > 0) {
			keep[at] = 1;
			stack.push([a, at], [at, b]);
		}
	}
	return points.filter((_, i) => keep[i] === 1);
}

/** Transmission lines are drawn at 100 m tolerance: far below the 1 km "near a line" rule. */
const LINE_TOLERANCE_KM = 0.1;

function powerGrid(): Omit<InfraRecord, "state" | "municipality" | "parish" | "placement">[] {
	const byVoltage = new Map<
		number,
		{ lines: [number, number][][]; km: number; ways: number; names: Set<string> }
	>();
	for (const e of readOsm("osm-lines.json")) {
		const volts = kv(e.tags?.voltage ?? "");
		const top = volts.length ? Math.max(...volts) : null;
		if (top === null || !e.geometry?.length) continue;
		const pts = e.geometry.map((g) => [round(g.lat, 5), round(g.lon, 5)] as [number, number]);
		let km = 0;
		for (let i = 1; i < pts.length; i++) {
			const [a1 = 0, o1 = 0] = pts[i - 1] ?? [];
			const [a2 = 0, o2 = 0] = pts[i] ?? [];
			km += distanceKm(a1, o1, a2, o2);
		}
		const g = byVoltage.get(top) ?? { lines: [], km: 0, ways: 0, names: new Set<string>() };
		g.lines.push(simplifyLine(pts, LINE_TOLERANCE_KM).map(([a, o]) => [round(a, 4), round(o, 4)]));
		g.km += km;
		g.ways++;
		byVoltage.set(top, g);
	}
	const out: Omit<InfraRecord, "state" | "municipality" | "parish" | "placement">[] = [];
	for (const [voltage, g] of [...byVoltage].sort((a, b) => b[0] - a[0])) {
		// A representative point: the vertex nearest the grid's mean position.
		const all = g.lines.flat();
		const mLat = all.reduce((s, p) => s + p[0], 0) / all.length;
		const mLon = all.reduce((s, p) => s + p[1], 0) / all.length;
		const rep = all.reduce((best, p) =>
			distanceKm(mLat, mLon, p[0], p[1]) < distanceKm(mLat, mLon, best[0], best[1]) ? p : best,
		);
		out.push({
			id: `infra.red-${voltage}kv`,
			kind: "power-grid",
			name: {
				es: `Red de transmisión de ${voltage} kV (trazado de OSM)`,
				en: `${voltage} kV transmission grid (OSM mapping)`,
			},
			aliases: [`líneas de ${voltage} kV`],
			lat: rep[0],
			lon: rep[1],
			dataset: "osm",
			codes: { voltageKV: String(voltage) },
			attributes: {
				voltageKV: voltage,
				segments: g.ways,
				mappedKm: Math.round(g.km),
				note: "Tramos mapeados en OpenStreetMap; el mapeo de líneas en Venezuela es incompleto y la mayoría no tiene nombre.",
			},
			operator: "inst.corpoelec",
			lines: g.lines,
		});
	}
	return out;
}

/** Named oil-industry sites worth an entity, by the words their name starts with. */
function oilSites(skip: ReadonlySet<string>): Rest[] {
	const out: Rest[] = [];
	for (const e of readOsm("osm-oil.json")) {
		const t = e.tags ?? {};
		const c = centreOf(e);
		if (!c || !t.name || skip.has(osmRef(e))) continue;
		const n = t.name;
		const kind = /^antigua/i.test(n)
			? null
			: /^(refiner[ií]a|centro de refinaci[oó]n)/i.test(n)
				? "refinery"
				: /petroqu[ií]mic/i.test(n)
					? "petrochemical"
					: /^planta de (distribuci[oó]n|llenado)/i.test(n)
						? "fuel-depot"
						: null;
		if (!kind) continue;
		out.push({
			kind,
			name: { es: n, en: t["name:en"] ?? n },
			aliases: [],
			lat: round(c.lat, 5),
			lon: round(c.lon, 5),
			dataset: "osm",
			codes: { osm: osmRef(e) },
			attributes: { operatorTag: t.operator ?? null },
			operator: operatorOf(t.operator) ?? operatorOf(n),
		});
	}
	return out;
}

/** The flare panel's facilities (World Bank GFMR sites and OSM outlines): same ids as `firms-flares`. */
function flareFacilities(): Omit<InfraRecord, "state" | "municipality" | "parish" | "placement">[] {
	const ids: Record<string, string> = {
		amuay: "infra.refineria-amuay",
		cardon: "infra.refineria-cardon",
		"el-palito": "infra.refineria-el-palito",
		"puerto-la-cruz": "infra.refineria-puerto-la-cruz",
		jose: "infra.complejo-jose",
	};
	return FACILITIES.map((f) => {
		const other = /^other-(.+)$/.exec(f.id);
		const stateName = other?.[1] ? stateByIso(other[1])?.name : null;
		const id =
			ids[f.id] ??
			(other ? `infra.campos-otros-${stateName ? slug(stateName) : "costa-afuera"}` : `infra.campo-${f.id}`);
		const osm = f.sources
			.map((s) => /openstreetmap\.org\/(way|relation|node)\/(\d+)/.exec(s.url))
			.find(Boolean);
		const kind = f.kind === "complex" ? "petrochemical" : f.kind;
		return {
			id,
			kind,
			name: { es: f.nameEs, en: f.nameEn },
			aliases: f.fieldsEs ?? [],
			lat: round(f.centroid.lat, 5),
			lon: round(f.centroid.lon, 5),
			dataset: "flare-facilities",
			codes: { facility: f.id, ...(osm ? { osm: `${osm[1]}/${osm[2]}` } : {}) },
			attributes: {
				operatorTag: f.operatorEs || null,
				flareSites: f.sites?.length ?? 0,
				fields: f.fieldsEs ?? [],
				note: f.noteEs ?? null,
			},
			operator: operatorOf(f.operatorEs),
		};
	});
}

/** PortWatch's 18 Venezuelan ports and terminals, named in Spanish and sorted into port or oil terminal by hand. */
const PORTS: Record<string, { id: string; es: string; en: string; kind: "port" | "oil-terminal" }> = {
	port46: { id: "infra.terminal-amuay", es: "Terminal de Amuay", en: "Amuay terminal", kind: "oil-terminal" },
	port98: {
		id: "infra.terminal-bajo-grande",
		es: "Terminal Bajo Grande",
		en: "Bajo Grande terminal",
		kind: "oil-terminal",
	},
	port318: {
		id: "infra.puerto-el-guamache",
		es: "Puerto de El Guamache",
		en: "El Guamache port",
		kind: "port",
	},
	port320: {
		id: "infra.terminal-el-palito",
		es: "Terminal El Palito",
		en: "El Palito terminal",
		kind: "oil-terminal",
	},
	port524: { id: "infra.terminal-jose", es: "Terminal de José", en: "Jose terminal", kind: "oil-terminal" },
	port618: { id: "infra.puerto-la-guaira", es: "Puerto de La Guaira", en: "La Guaira port", kind: "port" },
	port703: { id: "infra.puerto-maracaibo", es: "Puerto de Maracaibo", en: "Maracaibo port", kind: "port" },
	port878: { id: "infra.puerto-palua", es: "Puerto de Palúa", en: "Palúa port", kind: "port" },
	port1029: { id: "infra.puerto-cabello", es: "Puerto Cabello", en: "Puerto Cabello port", kind: "port" },
	port1049: {
		id: "infra.terminal-puerto-la-cruz",
		es: "Terminal de Puerto La Cruz (Guaraguao)",
		en: "Puerto La Cruz terminal (Guaraguao)",
		kind: "oil-terminal",
	},
	port1051: {
		id: "infra.terminal-puerto-miranda",
		es: "Terminal Puerto Miranda",
		en: "Puerto Miranda terminal",
		kind: "oil-terminal",
	},
	port1063: {
		id: "infra.terminal-punta-cardon",
		es: "Terminal Punta Cardón",
		en: "Punta Cardón terminal",
		kind: "oil-terminal",
	},
	port2260: {
		id: "infra.terminal-catia-la-mar",
		es: "Terminal de Catia La Mar",
		en: "Catia La Mar terminal",
		kind: "oil-terminal",
	},
	port2261: {
		id: "infra.terminal-la-salina",
		es: "Terminal La Salina",
		en: "La Salina terminal",
		kind: "oil-terminal",
	},
	port2279: { id: "infra.puerto-cumarebo", es: "Puerto Cumarebo", en: "Cumarebo port", kind: "port" },
	port2280: { id: "infra.puerto-guaranao", es: "Puerto de Guaranao", en: "Guaranao port", kind: "port" },
	port2281: { id: "infra.puerto-guanta", es: "Puerto de Guanta", en: "Guanta port", kind: "port" },
	fso176: {
		id: "infra.terminal-costa-afuera-1",
		es: "Terminal petrolero costa afuera 1",
		en: "Offshore oil terminal 1",
		kind: "oil-terminal",
	},
};

function ports(): Omit<InfraRecord, "state" | "municipality" | "parish" | "placement">[] {
	const doc = JSON.parse(readFileSync(join(RAW, "portwatch-ports-ven.json"), "utf8")) as {
		features: { attributes: Record<string, string | number | null> }[];
	};
	return doc.features.map(({ attributes: a }) => {
		const portid = String(a.portid);
		const p = PORTS[portid];
		if (!p) throw new Error(`PortWatch port ${portid} (${a.portname}) is not in PORTS: add it by hand`);
		return {
			id: p.id,
			kind: p.kind,
			name: { es: p.es, en: p.en },
			aliases: [String(a.portname)],
			lat: round(Number(a.lat), 5),
			lon: round(Number(a.lon), 5),
			dataset: "imf-portwatch-ports",
			codes: { portwatch: portid, ...(a.LOCODE ? { locode: String(a.LOCODE).replace(/\s+/g, "") } : {}) },
			attributes: {
				portwatchName: String(a.portname),
				vesselsTotal: Number(a.vessel_count_total ?? 0),
				vesselsTanker: Number(a.vessel_count_tanker ?? 0),
				topIndustry: a.industry_top1 === null ? null : String(a.industry_top1),
				shareOfImportsPct: Number(a.share_country_maritime_import ?? 0),
				shareOfExportsPct: Number(a.share_country_maritime_export ?? 0),
			},
			operator: null,
		};
	});
}

/** A CSV line with quoted fields (OurAirports quotes every text field). */
function csvLine(line: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quoted) {
			if (ch === '"' && line[i + 1] === '"') {
				cur += '"';
				i++;
			} else if (ch === '"') quoted = false;
			else cur += ch;
		} else if (ch === '"') quoted = true;
		else if (ch === ",") {
			out.push(cur);
			cur = "";
		} else cur += ch;
	}
	out.push(cur);
	return out;
}

/** "Simón Bolívar International Airport" → "Aeropuerto Internacional Simón Bolívar". */
export function airportNameEs(name: string): string {
	const rules: [RegExp, string][] = [
		[/^(.*) International Airport$/, "Aeropuerto Internacional $1"],
		[/^(.*) National Airport$/, "Aeropuerto Nacional $1"],
		[/^(.*) Airbase$/, "Base Aérea $1"],
		[/^(.*) Air Base$/, "Base Aérea $1"],
		[/^(.*) Airport$/, "Aeropuerto $1"],
	];
	for (const [re, to] of rules) if (re.test(name)) return name.replace(re, to);
	return name;
}

function airports(): Omit<InfraRecord, "state" | "municipality" | "parish" | "placement">[] {
	const lines = readFileSync(join(RAW, "ourairports-airports.csv"), "utf8").split(/\r?\n/);
	const header = csvLine(lines[0] ?? "");
	const col = (name: string) => header.indexOf(name);
	const out: Omit<InfraRecord, "state" | "municipality" | "parish" | "placement">[] = [];
	for (const line of lines.slice(1)) {
		if (!line.includes('"VE"')) continue;
		const r = csvLine(line);
		const get = (name: string) => r[col(name)] ?? "";
		if (get("iso_country") !== "VE") continue;
		const type = get("type");
		const iata = get("iata_code");
		const scheduled = get("scheduled_service") === "yes";
		// Large and medium airports, and small ones with an IATA code or scheduled flights.
		if (
			!(
				type === "large_airport" ||
				type === "medium_airport" ||
				(type === "small_airport" && (iata || scheduled))
			)
		)
			continue;
		const icao = get("gps_code") || get("ident");
		const name = get("name");
		out.push({
			id: `infra.aeropuerto-${(iata || icao).toLowerCase()}`,
			kind: "airport",
			name: { es: airportNameEs(name), en: name },
			aliases: [iata, icao, get("municipality")].filter(Boolean),
			lat: round(Number(get("latitude_deg")), 5),
			lon: round(Number(get("longitude_deg")), 5),
			dataset: "ourairports",
			codes: { icao, ...(iata ? { iata } : {}), ourairports: get("id") },
			attributes: {
				airportType: type,
				scheduledService: scheduled,
				elevationFt: get("elevation_ft") ? Number(get("elevation_ft")) : null,
				servedCity: get("municipality") || null,
			},
			operator: null,
		});
	}
	return out;
}

/** Named dams and reservoirs; generic names ("Laguna", tanks, fish farms) are left out. */
function water(): Rest[] {
	const out: Rest[] = [];
	for (const e of readOsm("osm-water.json")) {
		const t = e.tags ?? {};
		const c = centreOf(e);
		if (!c || !t.name) continue;
		const dam = t.waterway === "dam";
		const n = t.name;
		const ok = dam
			? /^(represa|presa|dique|compuertas|embalse|microcentral)/i.test(n) || t.operator === "EDELCA"
			: /^(embalse|presa)/i.test(n);
		if (!ok) continue;
		const kind = dam ? "dam" : "reservoir";
		out.push({
			kind,
			name: { es: n, en: n },
			aliases:
				n === "Represa del Guri" ? ["Embalse de Guri", "Represa de Guri", "Represa Simón Bolívar"] : [],
			lat: round(c.lat, 5),
			lon: round(c.lon, 5),
			dataset: "osm",
			codes: { osm: osmRef(e), ...(n === "Represa del Guri" ? { dahiti: "67" } : {}) },
			attributes: { operatorTag: t.operator ?? null },
			operator: operatorOf(t.operator),
		});
	}
	return out;
}

function hospitals(): Rest[] {
	const out: Rest[] = [];
	for (const e of readOsm("osm-hospitals.json")) {
		const t = e.tags ?? {};
		const c = centreOf(e);
		if (!c || !t.name) continue;
		out.push({
			kind: "hospital",
			name: { es: t.name, en: t["name:en"] ?? t.name },
			aliases: t.short_name ? [t.short_name] : [],
			lat: round(c.lat, 5),
			lon: round(c.lon, 5),
			dataset: "osm",
			codes: { osm: osmRef(e) },
			attributes: {
				operatorType: t["operator:type"] ?? null,
				operatorTag: t.operator ?? null,
				emergency: t.emergency === "yes" ? true : t.emergency === "no" ? false : null,
			},
			operator: null,
		});
	}
	return out;
}

/**
 * Words that alone do not name a facility: a name made only of these ("Planta Eléctrica", "Ambulatorio", "Planta
 * III") gets its municipality in its name and id, so it can be told apart and found.
 */
const GENERIC_WORDS = new Set(
	"planta electrica de del la el los las pdvsa distribucion llenado ambulatorio hospital cdi clinica salud integral subestacion termoelectrica generacion atencion emergencia i ii iii iv v".split(
		" ",
	),
);

export function isGenericName(name: string): boolean {
	return slug(name)
		.split("-")
		.every((w) => GENERIC_WORDS.has(w));
}

/** Coastal facilities and anchorages sit just off the simplified coast: they take a municipality within 5 km. */
const SNAP_KM = 5;

async function buildInfrastructure(): Promise<InfraRecord[]> {
	const { placeAt } = await import("../../src/ontology/geo.ts");
	const { municipalities } = await import("../../src/geo/index.ts");
	const muniName = new Map(municipalities().map((m) => [m.code, m.name]));
	const flare = flareFacilities();
	const flareOsm = new Set(flare.map((f) => f.codes.osm).filter((x): x is string => Boolean(x)));
	const place = (lat: number, lon: number) => {
		const p = placeAt(lat, lon, SNAP_KM);
		return {
			state: p.state,
			municipality: p.municipality,
			parish: p.parish,
			placement: p.how === "inside" && p.parishNearest ? "inside-parish-nearest" : p.how,
		};
	};
	// OurAirports has a few records with wrong coordinates (one "misplaced duplicate" of Maiquetía sits in Chad).
	const airportsInVenezuela = airports().filter((a) => place(a.lat, a.lon).placement !== "outside");
	const withIds = [...flare, ...powerGrid(), ...ports(), ...airportsInVenezuela];
	const rest = [...powerPlants(), ...substations(), ...oilSites(flareOsm), ...water(), ...hospitals()];

	const records: InfraRecord[] = [];
	const used = new Set<string>();
	const take = (id: string) => {
		if (used.has(id)) throw new Error(`duplicate id ${id}`);
		used.add(id);
	};
	for (const r of withIds) {
		take(r.id);
		records.push({ ...r, ...place(r.lat, r.lon) });
	}
	for (const r of rest) if (r.id) take(r.id);
	// Deterministic order, then ids: the plain slug, then with the municipality, then with the OSM id.
	const sorted = [...rest].sort(
		(a, b) =>
			a.kind.localeCompare(b.kind) ||
			a.name.es.localeCompare(b.name.es) ||
			(a.codes.osm ?? "").localeCompare(b.codes.osm ?? ""),
	);
	for (const r of sorted) {
		const where = place(r.lat, r.lon);
		const muniLabel = where.municipality ? shortMunicipalityName(muniName.get(where.municipality) ?? "") : "";
		if (r.id) {
			records.push({ ...r, id: r.id, ...where });
			continue;
		}
		const osmSlug = (r.codes.osm ?? "").replace("/", "-");
		const unnamed = /sin nombre en OSM/.test(r.name.es);
		const generic = !unnamed && isGenericName(r.name.es) && muniLabel !== "";
		const name = generic ? { es: `${r.name.es} (${muniLabel})`, en: `${r.name.en} (${muniLabel})` } : r.name;
		const base = unnamed
			? `${r.kind === "substation" ? "subestacion" : "planta"}-osm-${osmSlug}`
			: slug(name.es);
		const muni = muniLabel ? slug(muniLabel) : "";
		const candidates = [base, muni && !generic ? `${base}-${muni}` : null, `${base}-${osmSlug}`];
		const id = candidates
			.map((c) => (c ? `infra.${c}` : null))
			.find((c): c is string => c !== null && !used.has(c));
		if (!id) throw new Error(`no free id for ${r.name.es}`);
		used.add(id);
		records.push({ ...r, id, name, ...where });
	}
	return records.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The file keeps only what is set: empty lists, nulls and an English name equal to the Spanish one are left out
 * (the registry restores them), which halves the size of 790 hospitals.
 */
function compact(r: InfraRecord): Record<string, unknown> {
	const attributes = Object.fromEntries(
		Object.entries(r.attributes).filter(([, v]) => v !== null && !(Array.isArray(v) && v.length === 0)),
	);
	return {
		id: r.id,
		kind: r.kind,
		es: r.name.es,
		...(r.name.en !== r.name.es ? { en: r.name.en } : {}),
		...(r.aliases.length ? { aliases: r.aliases } : {}),
		lat: r.lat,
		lon: r.lon,
		...(r.state ? { state: r.state } : {}),
		...(r.municipality ? { municipality: r.municipality } : {}),
		...(r.parish ? { parish: r.parish } : {}),
		...(r.placement !== "inside" ? { placement: r.placement } : {}),
		dataset: r.dataset,
		codes: r.codes,
		...(Object.keys(attributes).length ? { attributes } : {}),
		...(r.operator ? { operator: r.operator } : {}),
		...(r.lines ? { lines: r.lines } : {}),
	};
}

// ——— population ———

async function buildPopulation(): Promise<void> {
	const lines = readFileSync(join(RAW, "ven_admpop_adm2_2011_v3.csv"), "utf8")
		.replace(/^\uFEFF/, "")
		.split(/\r?\n/);
	const header = csvLine(lines[0] ?? "");
	const code = header.indexOf("ADM2_PCODE");
	const stateCol = header.indexOf("ADM1_PCODE");
	const nameCol = header.indexOf("ADM2_ES");
	const total = header.indexOf("T_TL");
	const census: Record<string, number> = {};
	const recoded: string[] = [];
	// The census table uses a few P-codes older than the boundaries': a code the boundaries do not have is matched
	// to the municipality of the same state with the same name (2026-09-28: only Vargas, VE2402 → VE2401).
	const { municipalities } = await import("../../src/geo/index.ts");
	const cod = municipalities();
	const known = new Set(cod.map((m) => m.code));
	for (const line of lines.slice(1)) {
		if (!line.trim()) continue;
		const r = csvLine(line);
		let c = r[code] ?? "";
		const n = Number(r[total]);
		if (!c || !Number.isFinite(n)) continue;
		if (!known.has(c)) {
			const match = cod.find((m) => m.stateCode === r[stateCol] && slug(m.name) === slug(r[nameCol] ?? ""));
			if (!match) throw new Error(`census municipality ${c} (${r[nameCol]}) matches no boundary`);
			recoded.push(`${c} → ${match.code} (${match.name})`);
			c = match.code;
		}
		census[c] = n;
	}
	const wp = JSON.parse(readFileSync(WORLDPOP, "utf8")) as {
		meta: Record<string, unknown> & { gridTotal: number };
		municipalities: Record<string, number>;
		parishes: Record<string, number>;
		grid: { originLon: number; originLat: number; cellDeg: number; blocks: [number, number, number][] };
	};
	// The grid as two delta-coded arrays: key = row × 100000 + col, ascending; people per block.
	const blocks = [...wp.grid.blocks].sort((a, b) => a[0] * 100_000 + a[1] - (b[0] * 100_000 + b[1]));
	const keys: number[] = [];
	const people: number[] = [];
	let prev = 0;
	for (const [r, c, v] of blocks) {
		const k = r * 100_000 + c;
		keys.push(k - prev);
		people.push(v);
		prev = k;
	}
	const doc = {
		meta: {
			census2011: {
				title: "Censo de Población y Vivienda 2011 (INE), población total por municipio",
				url: "https://data.humdata.org/dataset/cod-ps-ven",
				file: "ven_admpop_adm2_2011_v3.csv",
				retrieved: fetchedDay("ine-census-2011-adm2"),
				licence: "CC BY-IGO 3.0",
				attribution: "Instituto Nacional de Estadística (INE) Venezuela, censo 2011, vía OCHA COD-PS (HDX)",
				note: "Cifra oficial de 2011. No refleja la emigración posterior: es la última cifra censal por municipio publicada. La tabla no incluye las Dependencias Federales.",
				recoded,
			},
			worldpop2026: {
				...wp.meta,
				retrieved: fetchedDay("worldpop-2026-1km"),
				note: "Estimación modelada por WorldPop para 2026 (redistribución de totales de la ONU con covariables satelitales); no es un censo.",
			},
		},
		census2011: census,
		worldpop2026: { municipalities: wp.municipalities, parishes: wp.parishes },
		grid: {
			originLon: wp.grid.originLon,
			originLat: wp.grid.originLat,
			cellDeg: wp.grid.cellDeg,
			note: "WorldPop 2026 en bloques de 0.025° (~2.8 km). key[i] es la diferencia con la clave anterior; clave = fila × 100000 + columna desde el origen (esquina NO).",
			key: keys,
			people,
		},
	};
	writeFileSync(join(OUT, "population.json"), `${JSON.stringify(doc)}\n`);
	console.log(`population: census ${Object.keys(census).length} municipalities, grid ${keys.length} blocks`);
}

if (import.meta.main) {
	mkdirSync(OUT, { recursive: true });
	if (!existsSync(join(RAW, "manifest.json"))) throw new Error(`no manifest in ${RAW}: run fetch.ts first`);
	await buildParishes();
	await buildPopulation();
	const infra = await buildInfrastructure();
	const osmBase = (
		JSON.parse(readFileSync(join(RAW, "osm-power-plants.json"), "utf8")) as {
			osm3s?: { timestamp_osm_base?: string };
		}
	).osm3s?.timestamp_osm_base;
	const counts: Record<string, number> = {};
	for (const r of infra) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
	writeFileSync(
		join(OUT, "infrastructure.json"),
		`${JSON.stringify({
			meta: {
				osmBase: osmBase ?? null,
				retrieved: {
					osm: fetchedDay("osm-power-plants"),
					ourairports: fetchedDay("ourairports"),
					portwatch: fetchedDay("imf-portwatch-ports"),
				},
				counts,
				rules: {
					powerPlants: "power=plant con nombre o con capacidad declarada.",
					substations: "power=substation con nombre, o de 230 kV o más.",
					grid: `power=line de 230, 400 y 765 kV, agrupadas por tensión, simplificadas a ${LINE_TOLERANCE_KM * 1000} m.`,
					oil: "Refinerías y complejos del panel de quema (GFMR y OSM); otros sitios de OSM cuyo nombre empieza por Refinería, Centro de Refinación, Petroquímico o Planta de Distribución/Llenado.",
					ports:
						"Los 18 puertos y terminales de IMF PortWatch para Venezuela, clasificados a mano en puerto o terminal petrolero.",
					airports:
						"OurAirports: aeropuertos grandes y medianos, y pequeños con código IATA o vuelos regulares.",
					water:
						"Represas y embalses con nombre (Represa, Presa, Dique, Embalse…), sin lagunas genéricas ni tanques.",
					hospitals: "amenity=hospital con nombre.",
					placement: `Estado, municipio y parroquia por punto en polígono (COD-AB); a menos de ${SNAP_KM} km de la costa simplificada, el municipio más cercano.`,
				},
			},
			items: infra.map(compact),
		})}\n`,
	);
	console.log(`infrastructure: ${infra.length}`, counts);
}
