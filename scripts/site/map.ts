/**
 * The landing page's hero map: the app's own state outlines as polygon rings, and a snapshot of three live layers
 * read from a running Vigía's public API. Positions use the app's projection (web/src/map/project.ts).
 */
import { project } from "../../web/src/map/project.ts";

/** Rings of a generated path (absolute M, relative l, z: the only commands scripts/build-map.ts writes). */
export function rings(d: string): number[][] {
	const out: number[][] = [];
	let ring: number[] = [];
	let x = 0;
	let y = 0;
	for (const m of d.matchAll(/([MlLz])([^MlLz]*)/g)) {
		const nums = (m[2] ?? "")
			.trim()
			.split(/[\s,]+/)
			.filter(Boolean)
			.map(Number);
		if (m[1] === "z") {
			if (ring.length >= 6) out.push(ring);
			ring = [];
			continue;
		}
		for (let i = 0; i + 1 < nums.length; i += 2) {
			const a = nums[i] as number;
			const b = nums[i + 1] as number;
			if (m[1] === "l") {
				x += a;
				y += b;
			} else {
				if (ring.length >= 6) out.push(ring);
				ring = [];
				x = a;
				y = b;
			}
			ring.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10);
		}
	}
	if (ring.length >= 6) out.push(ring);
	return out;
}

export type Level = "normal" | "drop" | "severe" | "no-data";

export interface LiveMap {
	/** When this snapshot was read from the running Vigía. */
	capturedAt: number;
	/** Newest observation behind the layers (the map says "datos de" this time). */
	asOf: number;
	connectivity: { asOf: number; states: { iso: string; level: Level }[] };
	/** Earthquakes of the last 7 days inside the map frame, strongest last (drawn on top). */
	quakes: { x: number; y: number; mag: number; at: number; place: string; source: string }[];
	/** The strongest satellite fire detections of the last 24 h (FIRMS). */
	fires: { x: number; y: number; frpMW: number; at: number; place: string }[];
}

const DAY = 86_400_000;

async function panel<T>(base: string, id: string): Promise<T> {
	const res = await fetch(`${base}/api/v1/panels/${id}`, { headers: { accept: "application/json" } });
	if (!res.ok) throw new Error(`/api/v1/panels/${id}: HTTP ${res.status}`);
	return ((await res.json()) as { panel: T }).panel;
}

const LEVELS = new Set<string>(["normal", "drop", "severe", "no-data"]);

export async function liveMap(base: string): Promise<LiveMap> {
	const capturedAt = Date.now();
	const conn = await panel<{ asOf: number; states: { id: string; level: string }[] }>(base, "connectivity");
	const quakes = await panel<{
		items: {
			at: number;
			lat: number;
			lon: number;
			maxMag: number | null;
			placeEs: string;
			primary: string;
		}[];
	}>(base, "quakes");
	const fires = await panel<{
		strongest: { at: number; lat: number; lon: number; frpMW: number; placeEs: string }[];
	}>(base, "fires");
	const inFrame = ([x, y]: [number, number]) => x >= 0 && y >= 0 && x <= 1399 && y <= 1240;
	const q = quakes.items
		.filter((i) => i.maxMag !== null && capturedAt - i.at <= 7 * DAY)
		.map((i) => {
			const [x, y] = project(i.lon, i.lat);
			return {
				x: Math.round(x * 10) / 10,
				y: Math.round(y * 10) / 10,
				mag: i.maxMag ?? 0,
				at: i.at,
				place: i.placeEs,
				source: i.primary.startsWith("usgs") ? "USGS" : "FUNVISIS",
			};
		})
		.filter((i) => inFrame([i.x, i.y]))
		.sort((a, b) => a.mag - b.mag);
	const fr = fires.strongest.map((f) => {
		const [x, y] = project(f.lon, f.lat);
		return {
			x: Math.round(x * 10) / 10,
			y: Math.round(y * 10) / 10,
			frpMW: f.frpMW,
			at: f.at,
			place: f.placeEs,
		};
	});
	const times = [conn.asOf, ...q.map((i) => i.at), ...fr.map((f) => f.at)];
	return {
		capturedAt,
		asOf: Math.max(...times),
		connectivity: {
			asOf: conn.asOf,
			states: conn.states.map((s) => ({
				iso: s.id,
				level: (LEVELS.has(s.level) ? s.level : "no-data") as Level,
			})),
		},
		quakes: q,
		fires: fr,
	};
}
