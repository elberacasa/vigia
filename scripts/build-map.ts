/**
 * Precomputes the map as SVG path strings, so the browser ships no GIS library and draws Venezuela instantly.
 *
 * Projection: plain lon/lat with x scaled by cos(7°) (Venezuela spans 0.6–12.2° N, so distortion is small),
 * in a fixed frame shared with every raster overlay (satellite, night lights):
 *   lon −73.6 … −59.5, lat 0.5 … 12.9, K = 100 units per degree of latitude.
 * Borders come from the TopoJSON (shared arcs), simplified per arc (Douglas–Peucker), so neighbouring states
 * never show slivers or gaps.
 *
 * Usage: bun scripts/build-map.ts  → web/src/map/geometry.gen.ts, web/src/map/municipalities.gen.ts
 */
import { join } from "node:path";

export const FRAME = { minLon: -73.6, maxLon: -59.5, minLat: 0.5, maxLat: 12.9 } as const;
const K = 100;
const COS = Math.cos((7 * Math.PI) / 180);
const WIDTH = Math.round((FRAME.maxLon - FRAME.minLon) * COS * K);
const HEIGHT = Math.round((FRAME.maxLat - FRAME.minLat) * K);

const project = (lon: number, lat: number): [number, number] => [
	(lon - FRAME.minLon) * COS * K,
	(FRAME.maxLat - lat) * K,
];

type Pt = [number, number];

function simplify(points: Pt[], tolerance: number): Pt[] {
	if (points.length <= 2) return points;
	const [fx, fy] = points[0] as Pt;
	const [lx, ly] = points[points.length - 1] as Pt;
	if (fx === lx && fy === ly) {
		// Closed ring: every point is "on" the degenerate first–last segment, so split at the farthest point.
		let far = 1;
		let best = -1;
		points.forEach(([x, y], i) => {
			const d = Math.hypot(x - fx, y - fy);
			if (d > best) {
				best = d;
				far = i;
			}
		});
		if (far === 0 || far === points.length - 1) return points;
		const a = simplify(points.slice(0, far + 1), tolerance);
		const b = simplify(points.slice(far), tolerance);
		return [...a, ...b.slice(1)];
	}
	const keep = new Uint8Array(points.length);
	keep[0] = 1;
	keep[points.length - 1] = 1;
	const stack: [number, number][] = [[0, points.length - 1]];
	while (stack.length) {
		const [a, b] = stack.pop() as [number, number];
		const [ax, ay] = points[a] as Pt;
		const [bx, by] = points[b] as Pt;
		const dx = bx - ax;
		const dy = by - ay;
		const len = Math.hypot(dx, dy) || 1;
		let max = 0;
		let index = -1;
		for (let i = a + 1; i < b; i++) {
			const [px, py] = points[i] as Pt;
			const d = Math.abs(dy * px - dx * py + bx * ay - by * ax) / len;
			if (d > max) {
				max = d;
				index = i;
			}
		}
		if (max > tolerance && index > 0) {
			keep[index] = 1;
			stack.push([a, index], [index, b]);
		}
	}
	return points.filter((_, i) => keep[i]);
}

const r1 = (n: number) => Math.round(n * 10) / 10;

function ringPath(points: Pt[]): string {
	let d = "";
	let px = 0;
	let py = 0;
	points.forEach(([x, y], i) => {
		const rx = r1(x);
		const ry = r1(y);
		if (i === 0) d += `M${rx} ${ry}`;
		else {
			// Relative coordinates are shorter.
			const dx = r1(rx - px);
			const dy = r1(ry - py);
			if (dx === 0 && dy === 0) return;
			d += `l${dx} ${dy}`;
		}
		px = rx;
		py = ry;
	});
	return `${d}z`;
}

interface Topo {
	arcs: number[][][];
	transform: { scale: [number, number]; translate: [number, number] };
	objects: Record<
		string,
		{ geometries: { type: string; arcs: number[][] | number[][][]; properties: Record<string, string> }[] }
	>;
}

const root = join(import.meta.dir, "..");
const topo = (await Bun.file(join(root, "src/geo/data/admin.topo.json")).json()) as Topo;
const { scale, translate } = topo.transform;

function decodeArcs(tolerance: number): Pt[][] {
	return topo.arcs.map((arc) => {
		let x = 0;
		let y = 0;
		const pts = arc.map(([dx = 0, dy = 0]) => {
			x += dx;
			y += dy;
			return project(x * scale[0] + translate[0], y * scale[1] + translate[1]);
		});
		return simplify(pts, tolerance);
	});
}

function geometryPath(geometry: { type: string; arcs: number[][] | number[][][] }, arcs: Pt[][]): string {
	const polygons = (geometry.type === "Polygon" ? [geometry.arcs] : geometry.arcs) as number[][][];
	let d = "";
	for (const polygon of polygons) {
		for (const ring of polygon) {
			const pts: Pt[] = [];
			for (const index of ring) {
				const arc = index >= 0 ? (arcs[index] ?? []) : [...(arcs[~index] ?? [])].reverse();
				pts.push(...(pts.length ? arc.slice(1) : arc));
			}
			if (pts.length >= 3) d += ringPath(pts);
		}
	}
	return d;
}

const meta = (await Bun.file(join(root, "src/geo/data/states-meta.json")).json()) as {
	states: { code: string; iso3166_2: string; name: string; labelPoint: { lat: number; lon: number } }[];
};
const labelByCode = new Map(meta.states.map((s) => [s.code, s]));

const stateArcs = decodeArcs(0.9);
const states = (topo.objects.states?.geometries ?? []).map((g) => {
	const code = g.properties.code ?? "";
	const m = labelByCode.get(code);
	const [lx, ly] = m ? project(m.labelPoint.lon, m.labelPoint.lat) : [0, 0];
	return {
		code,
		iso: g.properties.iso3166_2 ?? "",
		name: m?.name ?? g.properties.name ?? "",
		d: geometryPath(g, stateArcs),
		label: [r1(lx), r1(ly)] as [number, number],
	};
});

const muniArcs = decodeArcs(0.6);
const municipalities = (topo.objects.municipalities?.geometries ?? []).map((g) => ({
	code: g.properties.code ?? "",
	name: g.properties.name ?? "",
	state: g.properties.state_code ?? "",
	d: geometryPath(g, muniArcs),
}));

interface Fc {
	features: { properties: Record<string, string | null>; geometry: { type: string; coordinates: unknown } }[];
}
const context = (await Bun.file(join(root, "src/geo/data/context.geo.json")).json()) as Fc;
const neighbours = context.features.map((f) => {
	const polys = (
		f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates
	) as number[][][][];
	let d = "";
	for (const poly of polys)
		for (const ring of poly) {
			const pts = simplify(
				ring.map(([lon = 0, lat = 0]) => project(lon, lat)),
				1.2,
			);
			if (pts.length >= 3) d += ringPath(pts);
		}
	return { name: f.properties.name ?? "", kind: f.properties.kind ?? "country", d };
});

const header = "// Generated by scripts/build-map.ts from src/geo/data. Do not edit.\n";
await Bun.write(
	join(root, "web/src/map/geometry.gen.ts"),
	`${header}export const FRAME = ${JSON.stringify({ ...FRAME, k: K, cos: COS, width: WIDTH, height: HEIGHT })} as const;
export const STATES: readonly { code: string; iso: string; name: string; d: string; label: readonly [number, number] }[] = ${JSON.stringify(states)};
export const NEIGHBOURS: readonly { name: string; kind: string; d: string }[] = ${JSON.stringify(neighbours)};
`,
);
await Bun.write(
	join(root, "web/src/map/municipalities.gen.ts"),
	`${header}export const MUNICIPALITIES: readonly { code: string; name: string; state: string; d: string }[] = ${JSON.stringify(municipalities)};
`,
);
const size = (s: string) => `${(s.length / 1024).toFixed(0)} KB`;
const gz = (s: string) => `${(Bun.gzipSync(s).length / 1024).toFixed(1)} KB gz`;
const a = JSON.stringify(states) + JSON.stringify(neighbours);
const b = JSON.stringify(municipalities);
console.log(
	`states+context: ${size(a)} (${gz(a)}); municipalities: ${size(b)} (${gz(b)}); frame ${WIDTH}×${HEIGHT}`,
);
