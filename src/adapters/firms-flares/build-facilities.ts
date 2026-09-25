/**
 * Builds `facilities.json`, the fixed list of oil and gas facilities whose flares Vigía watches, from two public
 * sources, downloaded by hand into one input directory (kept outside the repository):
 *
 * 1. World Bank GFMR, "Flare volume estimates by individual flare location 2012-2025" (xlsx, no login):
 *    https://thedocs.worldbank.org/en/doc/b34e0c054bb3fe3695e70154c28eef3f-0400072026/related/Flare-Volume-Estimates-by-individual-Flare-Location-2012-2025.xlsx
 *    Its "Pivot" sheet, Venezuela rows, saved as CSV (`ggfr-ve-Pivot.csv`): 226 upstream flare sites with field
 *    name, operator and yearly volume. Sites are grouped into fields below; fields not named in GROUPS fall into
 *    "other fields in <state>". GFMR covers upstream flaring only, so refineries come from:
 * 2. OpenStreetMap outlines (ODbL), one Overpass query (`osm-refinery-geom.json`, `osm-cardon-outer.json`):
 *    Refinería Amuay (way 102819548), Centro de Refinación Paraguaná / Cardón (relation 3438667), Refinería El
 *    Palito (way 157032682), Refinería Puerto La Cruz (way 218817950), Complejo José Antonio Anzoátegui
 *    (way 265071557).
 *
 *   bun src/adapters/firms-flares/build-facilities.ts <input-dir> > src/adapters/firms-flares/facilities.json
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { placeOf } from "../../geo/place.ts";

const dir = process.argv[2];
if (!dir) {
	console.error(
		"Uso: bun src/adapters/firms-flares/build-facilities.ts <dir con ggfr-ve-Pivot.csv y osm-*.json>",
	);
	process.exit(1);
}

type Group = {
	id: string;
	nameEs: string;
	nameEn: string;
	fields: string[];
	noteEs?: string;
};

/** Named fields, largest flaring first (GFMR 2025). Field names exactly as GFMR spells them. */
const GROUPS: Group[] = [
	{
		id: "carito-mulata",
		nameEs: "Carito–Mulata (Punta de Mata)",
		nameEn: "Carito–Mulata (Punta de Mata)",
		fields: ["Carito-Mulata"],
	},
	{
		id: "santa-barbara",
		nameEs: "Santa Bárbara–Pirital",
		nameEn: "Santa Bárbara–Pirital",
		fields: ["Santa Barbara", "Santa Barbara Sur", "Bush Grande", "Pirital"],
	},
	{
		id: "jusepin-furrial",
		nameEs: "Jusepín–El Furrial",
		nameEn: "Jusepín–El Furrial",
		fields: ["Jusepin Deep", "El Furrial", "Cotoperi", "El Corozo"],
	},
	{
		id: "orocual-quiriquire",
		nameEs: "Orocual–Boquerón–Quiriquire",
		nameEn: "Orocual–Boquerón–Quiriquire",
		fields: ["Orocual", "Boqueron", "Somero/Quiriquire Shallow"],
	},
	{
		id: "anaco-santa-rosa",
		nameEs: "Santa Rosa (gas, Anaco)",
		nameEn: "Santa Rosa (gas, Anaco)",
		fields: ["Santa Rosa"],
	},
	{
		id: "faja-carabobo",
		nameEs: "Faja del Orinoco: Carabobo",
		nameEn: "Orinoco Belt: Carabobo",
		fields: [
			"Petromonagas(Cerro Negro)",
			"Bitor",
			"Carabobo Project 1",
			"Carabobo Project 2",
			"Carabobo Project 3",
			"Morichal",
		],
	},
	{
		id: "faja-junin-ayacucho",
		nameEs: "Faja del Orinoco: Junín y Ayacucho",
		nameEn: "Orinoco Belt: Junín and Ayacucho",
		fields: [
			"Bare",
			"Petropiar (Hamaca)",
			"Petrocedeno (Sincor)",
			"Petro San Felix",
			"Carina",
			"Miga",
			"Oveja",
			"San Cristobal",
			"Yopales Central",
		],
	},
	{
		id: "san-tome",
		nameEs: "Distrito San Tomé (Oficina)",
		nameEn: "San Tomé district (Oficina)",
		fields: [
			"Zapatos",
			"Soto Norte",
			"Dacion",
			"Nipa",
			"Kaki Inemaka",
			"Santa Ana",
			"Zorro",
			"Tacata",
			"Chimire",
			"Oficina",
			"Guico",
			"Cantaura",
			"Inca",
			"La Ceibita",
			"Oscurote Norte",
			"Bucaral",
			"Nardo",
			"Mata 12",
			"El Toco",
			"Aguasay Sur",
			"Aguasay Norte",
			"Acema A",
			"Acema 200",
			"Acema 300",
			"Acema Oeste",
			"Oritupano Sur",
			"Oritupano Norte",
			"La Florida",
		],
	},
	{
		id: "zulia",
		nameEs: "Lago de Maracaibo y Boscán",
		nameEn: "Lake Maracaibo and Boscán",
		fields: ["Ensanada", "Urdaneta Oeste", "Urdaneta (DZO)", "Boscan", "Alpuf"],
		noteEs:
			"El sitio «Ensanada» del Banco Mundial está junto a las plantas Termozulia: una detección ahí puede ser de la planta eléctrica.",
	},
];

type Refinery = {
	id: string;
	nameEs: string;
	nameEn: string;
	kind: "refinery" | "complex";
	osm: { type: "way" | "relation"; id: number };
	operatorEs: string;
	noteEs?: string;
};

const REFINERIES: Refinery[] = [
	{
		id: "amuay",
		nameEs: "Refinería Amuay (CRP)",
		nameEn: "Amuay refinery (CRP)",
		kind: "refinery",
		osm: { type: "way", id: 102819548 },
		operatorEs: "PDVSA",
	},
	{
		id: "cardon",
		nameEs: "Refinería Cardón (CRP)",
		nameEn: "Cardón refinery (CRP)",
		kind: "refinery",
		osm: { type: "relation", id: 3438667 },
		operatorEs: "PDVSA",
	},
	{
		id: "el-palito",
		nameEs: "Refinería El Palito",
		nameEn: "El Palito refinery",
		kind: "refinery",
		osm: { type: "way", id: 157032682 },
		operatorEs: "PDVSA",
		noteEs:
			"La planta eléctrica TermoCarabobo, ~2 km al oeste, también aparece caliente de noche: queda fuera del contorno.",
	},
	{
		id: "puerto-la-cruz",
		nameEs: "Refinería Puerto La Cruz",
		nameEn: "Puerto La Cruz refinery",
		kind: "refinery",
		osm: { type: "way", id: 218817950 },
		operatorEs: "PDVSA",
	},
	{
		id: "jose",
		nameEs: "Complejo José Antonio Anzoátegui (mejoradores y petroquímica)",
		nameEn: "José Antonio Anzoátegui complex (upgraders, petrochemicals)",
		kind: "complex",
		osm: { type: "way", id: 265071557 },
		operatorEs: "PDVSA, Pequiven y empresas mixtas",
	},
];

/** A GFMR site's detections are counted within this distance of the site (see facilities.ts). */
const SITE_RADIUS_KM = 1.5;
/** An OSM outline's detections are counted inside it or within this distance of its edge. */
const OUTLINE_BUFFER_KM = 1;
const GGFR_URL = "https://www.worldbank.org/en/programs/gasflaringreduction/global-flaring-data";

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

function parseCsv(text: string): Record<string, string>[] {
	const rows: string[][] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line) continue;
		const cells: string[] = [];
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
				cells.push(cur);
				cur = "";
			} else cur += ch;
		}
		cells.push(cur);
		rows.push(cells);
	}
	const [head, ...body] = rows;
	if (!head) return [];
	return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

/** Douglas–Peucker in degrees (tolerance ~30 m): the outlines only need to be right to a VIIRS pixel. */
function simplify(points: [number, number][], tol = 0.0003): [number, number][] {
	if (points.length < 4) return points;
	const [a, b] = [points[0] as [number, number], points[points.length - 1] as [number, number]];
	let worst = 0;
	let at = 0;
	for (let i = 1; i < points.length - 1; i++) {
		const p = points[i] as [number, number];
		const dx = b[1] - a[1];
		const dy = b[0] - a[0];
		const len = Math.hypot(dx, dy) || 1e-12;
		const d = Math.abs(dy * (p[1] - a[1]) - dx * (p[0] - a[0])) / len;
		if (d > worst) {
			worst = d;
			at = i;
		}
	}
	if (worst <= tol) return [a, b];
	return [...simplify(points.slice(0, at + 1), tol).slice(0, -1), ...simplify(points.slice(at), tol)];
}

type OsmWay = {
	type: "way";
	id: number;
	geometry: { lat: number; lon: number }[];
	tags?: Record<string, string>;
};

const osm = JSON.parse(readFileSync(join(dir, "osm-refinery-geom.json"), "utf8")) as { elements: OsmWay[] };
const cardonOuter = JSON.parse(readFileSync(join(dir, "osm-cardon-outer.json"), "utf8")) as {
	elements: OsmWay[];
};

/** Chains a multipolygon's outer ways into one ring. */
function chain(ways: OsmWay[]): [number, number][] {
	const segs = ways.map((w) => w.geometry.map((p) => [p.lat, p.lon] as [number, number]));
	const ring = segs.shift() ?? [];
	while (segs.length) {
		const end = ring[ring.length - 1] as [number, number];
		const i = segs.findIndex((s) => {
			const f = s[0] as [number, number];
			const l = s[s.length - 1] as [number, number];
			return (f[0] === end[0] && f[1] === end[1]) || (l[0] === end[0] && l[1] === end[1]);
		});
		if (i < 0) throw new Error("multipolygon ring does not close");
		const [seg] = segs.splice(i, 1) as [[number, number][]];
		const first = seg[0] as [number, number];
		ring.push(...(first[0] === end[0] && first[1] === end[1] ? seg : seg.reverse()).slice(1));
	}
	return ring;
}

function outlineOf(r: Refinery): [number, number][] {
	if (r.osm.type === "relation") return chain(cardonOuter.elements);
	const way = osm.elements.find((e) => e.type === "way" && e.id === r.osm.id);
	if (!way) throw new Error(`OSM way ${r.osm.id} missing`);
	return way.geometry.map((p) => [p.lat, p.lon]);
}

function centroid(points: readonly [number, number][]): { lat: number; lon: number } {
	const lat = points.reduce((s, p) => s + p[0], 0) / points.length;
	const lon = points.reduce((s, p) => s + p[1], 0) / points.length;
	return { lat: r4(lat), lon: r4(lon) };
}

const facilities: unknown[] = [];

for (const r of REFINERIES) {
	// A closed ring starts and ends on the same point, which Douglas–Peucker collapses: simplify each half.
	const full = outlineOf(r);
	const mid = Math.floor(full.length / 2);
	const ring = [...simplify(full.slice(0, mid + 1)).slice(0, -1), ...simplify(full.slice(mid))].map(
		([a, b]) => [r4(a), r4(b)] as [number, number],
	);
	const c = centroid(ring);
	facilities.push({
		id: r.id,
		nameEs: r.nameEs,
		nameEn: r.nameEn,
		kind: r.kind,
		state: placeOf(c.lat, c.lon).state,
		operatorEs: r.operatorEs,
		...(r.noteEs ? { noteEs: r.noteEs } : {}),
		centroid: c,
		outline: ring,
		bufferKm: OUTLINE_BUFFER_KM,
		sources: [
			{
				label: `OpenStreetMap ${r.osm.type} ${r.osm.id} (ODbL)`,
				url: `https://www.openstreetmap.org/${r.osm.type}/${r.osm.id}`,
			},
		],
	});
}

const sites = parseCsv(readFileSync(join(dir, "ggfr-ve-Pivot.csv"), "utf8")).filter(
	(s) => s.Country === "Venezuela",
);
const byGroup = new Map<string, Record<string, string>[]>();
const named = new Map(GROUPS.flatMap((g) => g.fields.map((f) => [f, g.id] as const)));
const STATE_NAME: Record<string, string> = {};
for (const s of sites) {
	const lat = Number(s.lat);
	const lon = Number(s.lon);
	let group = named.get(s["Field name"] ?? "");
	if (!group) {
		const st = placeOf(lat, lon).state ?? "offshore";
		group = `other-${st}`;
		STATE_NAME[group] = placeOf(lat, lon).placeEs;
	}
	byGroup.set(group, [...(byGroup.get(group) ?? []), s]);
}
for (const f of GROUPS.flatMap((g) => g.fields)) {
	if (!sites.some((s) => s["Field name"] === f)) throw new Error(`field ${f} not in GFMR file`);
}

const volume = (list: Record<string, string>[], year: string) =>
	Math.round(list.reduce((sum, s) => sum + Number(s[year] || 0), 0) * 1000 * 10) / 10;

const groupEntries: { g: Group; list: Record<string, string>[] }[] = [
	...GROUPS.map((g) => ({ g, list: byGroup.get(g.id) ?? [] })),
	...[...byGroup]
		.filter(([id]) => id.startsWith("other-"))
		.map(([id, list]) => ({
			g: {
				id,
				nameEs: `Otros campos: ${id === "other-offshore" ? "costa afuera" : (STATE_NAME[id] ?? id)}`,
				nameEn: `Other fields: ${id === "other-offshore" ? "offshore" : (STATE_NAME[id] ?? id)}`,
				fields: [...new Set(list.map((s) => s["Field name"] ?? ""))].sort(),
			},
			list,
		})),
];

for (const { g, list } of groupEntries) {
	const points = list.map((s) => [r4(Number(s.lat)), r4(Number(s.lon))] as [number, number]);
	const c = centroid(points);
	const fields = [...new Set(list.map((s) => s["Field name"] ?? ""))].filter((f) => f && f !== "NA");
	facilities.push({
		id: g.id,
		nameEs: g.nameEs,
		nameEn: g.nameEn,
		kind: list.every((s) => s["Field type"] === "GAS") ? "gas-field" : "oil-field",
		state: placeOf(c.lat, c.lon).state,
		operatorEs: [...new Set(list.map((s) => s.Operator).filter((o) => o && o !== "NA"))].sort().join(", "),
		fieldsEs: fields.sort(),
		...(g.noteEs ? { noteEs: g.noteEs } : {}),
		centroid: c,
		sites: points,
		siteRadiusKm: SITE_RADIUS_KM,
		// GFMR's own estimate, million m³ of gas flared per year (sum of the group's sites).
		ggfrMillionM3: { "2024": volume(list, "2024"), "2025": volume(list, "2025") },
		sources: [{ label: "Banco Mundial GFMR: sitios de quema 2012–2025", url: GGFR_URL }],
	});
}

console.log(
	JSON.stringify(
		{
			builtAt: "2026-09-24",
			rule: `Refinerías y complejos: dentro del contorno de OpenStreetMap o a ≤ ${OUTLINE_BUFFER_KM} km de su borde. Campos: a ≤ ${SITE_RADIUS_KM} km de un sitio de quema del Banco Mundial (GFMR, 2012–2025). Si un punto cae en dos, cuenta para el más cercano.`,
			sources: [
				{
					label: "World Bank GFMR, flare volume estimates by individual flare location 2012-2025",
					url: GGFR_URL,
				},
				{ label: "OpenStreetMap contributors (ODbL)", url: "https://www.openstreetmap.org/copyright" },
			],
			facilities,
		},
		null,
		"\t",
	),
);
