/**
 * "Usar mi ubicación" for a crowd report, entirely on the device: the phone's position is placed in a municipality
 * against the map's own outlines (map/municipalities.gen.ts, in the map's projection) and only the municipality's
 * code is kept; the coordinates are dropped at once and never sent anywhere (not to /api/v1/locate, not in the
 * report). Pure and tested (crowd-geo.test.ts), apart from `locateMunicipality`, which asks the browser.
 */
import { project } from "../map/project.ts";

export interface MuniShape {
	code: string;
	name: string;
	state: string;
	d: string;
}

/** The rings of a generated path (absolute M, relative l, z: the only commands scripts/build-map.ts writes). */
export function rings(d: string): [number, number][][] {
	const out: [number, number][][] = [];
	let ring: [number, number][] = [];
	let x = 0;
	let y = 0;
	for (const m of d.matchAll(/([MlLz])([^MlLz]*)/g)) {
		const cmd = m[1];
		if (cmd === "z") {
			if (ring.length) out.push(ring);
			ring = [];
			continue;
		}
		const nums = (m[2] ?? "")
			.trim()
			.split(/[\s,]+/)
			.filter(Boolean)
			.map(Number);
		for (let i = 0; i + 1 < nums.length; i += 2) {
			const a = nums[i] as number;
			const b = nums[i + 1] as number;
			if (cmd === "l") {
				x += a;
				y += b;
			} else {
				if (cmd === "M" && i === 0 && ring.length) {
					out.push(ring);
					ring = [];
				}
				x = a;
				y = b;
			}
			ring.push([x, y]);
		}
	}
	if (ring.length) out.push(ring);
	return out;
}

/** Even-odd point in polygon over every ring (islands and holes alike). */
export function inside(px: number, py: number, all: readonly (readonly [number, number])[][]): boolean {
	let hit = false;
	for (const ring of all) {
		for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
			const [xi, yi] = ring[i] as [number, number];
			const [xj, yj] = ring[j] as [number, number];
			if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
		}
	}
	return hit;
}

/** The municipality a position falls in (its INE code, "VE2313"), or null outside every outline. */
export function municipalityAt(lon: number, lat: number, munis: readonly MuniShape[]): MuniShape | null {
	const [px, py] = project(lon, lat);
	for (const m of munis) {
		if (inside(px, py, rings(m.d))) return m;
	}
	return null;
}

/** Map units (the map's projection: 1/100 of a degree of latitude) to km. */
const KM_PER_UNIT = 1.1132;
/** How far the simplified outlines can stray from the official boundary (0.6 map units, rounded), km. */
export const OUTLINE_SLACK_KM = 0.7;

/** Distance from a point to the nearest edge of any ring, in map units. */
function edgeDistance(px: number, py: number, all: readonly (readonly [number, number])[][]): number {
	let best = Number.POSITIVE_INFINITY;
	for (const ring of all) {
		for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
			const [ax, ay] = ring[j] as [number, number];
			const [bx, by] = ring[i] as [number, number];
			const dx = bx - ax;
			const dy = by - ay;
			const len = dx * dx + dy * dy;
			const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
			best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
		}
	}
	return best;
}

/**
 * The municipalities a position of this accuracy may fall in: the one containing the point first, then every other
 * whose outline passes within the accuracy plus the outlines' own slack. One means the position is clear; more,
 * the person chooses.
 */
export function candidatesAt(
	lon: number,
	lat: number,
	accuracyM: number,
	munis: readonly MuniShape[],
): MuniShape[] {
	const [px, py] = project(lon, lat);
	const reach = (accuracyM / 1000 + OUTLINE_SLACK_KM) / KM_PER_UNIT;
	const hit: MuniShape[] = [];
	const near: [number, MuniShape][] = [];
	for (const m of munis) {
		const r = rings(m.d);
		if (inside(px, py, r)) hit.push(m);
		else {
			const d = edgeDistance(px, py, r);
			if (d <= reach) near.push([d, m]);
		}
	}
	return [...hit, ...near.sort((a, b) => a[0] - b[0]).map(([, m]) => m)];
}

/** Positions less precise than this are not placed: a neighbouring municipality is too likely. */
export const MAX_ACCURACY_M = 1_500;

export type Located =
	| { ok: true; candidates: MuniShape[]; accuracyM: number }
	| {
			ok: false;
			why: "unsupported" | "insecure" | "denied" | "unavailable" | "timeout" | "outside" | "coarse";
			km?: number;
	  };

/**
 * Asks the browser for the position once (no watching, no high accuracy), places it, and keeps only the
 * municipality or the few it may be in. The coordinates never leave this function.
 */
export function locateMunicipality(): Promise<Located> {
	if (!("geolocation" in navigator)) return Promise.resolve({ ok: false, why: "unsupported" });
	// Browsers give no position to a page served over plain http (a personal Vigía opened by its LAN address).
	if (!window.isSecureContext) return Promise.resolve({ ok: false, why: "insecure" });
	return new Promise((resolve) => {
		navigator.geolocation.getCurrentPosition(
			(pos) => {
				const { longitude, latitude, accuracy } = pos.coords;
				if (accuracy > MAX_ACCURACY_M) {
					resolve({ ok: false, why: "coarse", km: Math.max(1, Math.round(accuracy / 1000)) });
					return;
				}
				void import("../map/municipalities.gen.ts").then(
					({ MUNICIPALITIES }) => {
						const found = candidatesAt(longitude, latitude, accuracy, MUNICIPALITIES);
						resolve(
							found.length
								? { ok: true, candidates: found.slice(0, 4), accuracyM: Math.round(accuracy) }
								: { ok: false, why: "outside" },
						);
					},
					() => resolve({ ok: false, why: "unavailable" }),
				);
			},
			(err) =>
				resolve({
					ok: false,
					why:
						err.code === err.PERMISSION_DENIED
							? "denied"
							: err.code === err.TIMEOUT
								? "timeout"
								: "unavailable",
				}),
			{ enableHighAccuracy: false, maximumAge: 10 * 60_000, timeout: 20_000 },
		);
	});
}
