import { z } from "zod";
import type { Adapter, Observation } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { nearestVenezuelaPoint } from "../../geo/distance.ts";
import { bearingEs } from "../../geo/index.ts";
import { placeOf } from "../../geo/place.ts";
import { PUBLIC_DOMAIN_NOAA } from "../../sources/licences.ts";

/**
 * NOAA National Hurricane Center, active Atlantic tropical cyclones (CurrentStorms.json), with the distance from
 * each centre to Venezuelan territory and an explicit "threat" rule.
 *
 * Quirks, measured 2026-09-24: the feed mixes basins (Atlantic `al…`, East Pacific `ep…`, Central Pacific), so only
 * `al` ids are kept; `intensity` is knots as a string, `movementSpeed` is mph (advisory: "near 6 mph (9 km/h)"
 * for movementSpeed 6), `movementDir` degrees toward which the storm moves; `lastUpdate` is ISO UTC. Advisories
 * come every 6 h (every 3 h with watches). No active storms: `activeStorms` is an empty list.
 */

export const NHC_LICENCE = {
	...PUBLIC_DOMAIN_NOAA,
	attribution: "NOAA / Centro Nacional de Huracanes (NHC)",
};
export const NHC_URL = "https://www.nhc.noaa.gov/CurrentStorms.json";

/**
 * Threat rule, stated so anyone can check it:
 * - the centre is within THREAT_KM of Venezuelan territory, or
 * - it is within WATCH_KM and moving toward Venezuela (heading within ±HEADING_DEG of the bearing to the nearest
 *   Venezuelan point).
 * Why: tropical-storm-force winds reach up to ~300 km from the centre of a large Atlantic hurricane, and a storm
 * moving at a typical 15–30 km/h covers 360–720 km a day, so 500 km is under a day from winds on the coast and
 * 1,000 km is one to three days away. This is our rule, not an NHC product; NHC watches and warnings rule.
 */
export const THREAT_RULE = { threatKm: 500, watchKm: 1_000, headingDeg: 45 } as const;

const Storm = z.object({
	id: z.string().regex(/^[a-z]{2}\d{6}$/),
	name: z.string(),
	classification: z.string(),
	intensity: z.string().regex(/^\d+$/),
	pressure: z.string().regex(/^\d+$/).nullable().optional(),
	latitudeNumeric: z.number().min(-90).max(90),
	longitudeNumeric: z.number().min(-180).max(180),
	movementDir: z.number().nullable().optional(),
	movementSpeed: z.number().nullable().optional(),
	lastUpdate: z.string().datetime({ offset: true }),
	publicAdvisory: z.object({ url: z.string().url() }).nullable().optional(),
	forecastGraphics: z.object({ url: z.string().url() }).nullable().optional(),
});

const Envelope = z.object({ activeStorms: z.array(z.unknown()) });

const CLASS_ES: Readonly<Record<string, string>> = {
	TD: "Depresión tropical",
	TS: "Tormenta tropical",
	HU: "Huracán",
	STD: "Depresión subtropical",
	STS: "Tormenta subtropical",
	PTC: "Ciclón potencial",
	PC: "Ciclón postropical",
	TY: "Tifón",
};

/** Saffir-Simpson category from sustained wind in knots (NHC thresholds). Null below hurricane strength. */
export function saffirSimpson(kt: number): number | null {
	if (kt >= 137) return 5;
	if (kt >= 113) return 4;
	if (kt >= 96) return 3;
	if (kt >= 83) return 2;
	if (kt >= 64) return 1;
	return null;
}

/** Initial bearing in degrees from one point to another. */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const r = Math.PI / 180;
	const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
	const x =
		Math.cos(lat1 * r) * Math.sin(lat2 * r) -
		Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
	return (Math.atan2(y, x) / r + 360) % 360;
}

const angleBetween = (a: number, b: number) => {
	const d = Math.abs(a - b) % 360;
	return d > 180 ? 360 - d : d;
};

export type StormThreat = {
	distanceKm: number;
	/** Bearing from the storm centre to the nearest Venezuelan point, degrees. */
	bearingToVenezuelaDeg: number;
	headingTowardVenezuela: boolean | null;
	threat: boolean;
	/** Which clause of THREAT_RULE fired, or why not. */
	reasonEs: string;
};

export function assessThreat(lat: number, lon: number, movementDir: number | null): StormThreat {
	const nearest = nearestVenezuelaPoint(lat, lon);
	const inside = placeOf(lat, lon).inVenezuela;
	const distance = inside ? 0 : Math.round(nearest.km);
	const bearing = Math.round(bearingDeg(lat, lon, nearest.lat, nearest.lon));
	const toward = movementDir === null ? null : angleBetween(movementDir, bearing) <= THREAT_RULE.headingDeg;
	let threat = false;
	let reasonEs: string;
	if (distance <= THREAT_RULE.threatKm) {
		threat = true;
		reasonEs = `Centro a ${distance} km de Venezuela (umbral ${THREAT_RULE.threatKm} km).`;
	} else if (distance <= THREAT_RULE.watchKm && toward) {
		threat = true;
		reasonEs = `Centro a ${distance} km y se desplaza hacia Venezuela (umbral ${THREAT_RULE.watchKm} km).`;
	} else if (distance <= THREAT_RULE.watchKm) {
		reasonEs = `Centro a ${distance} km, sin rumbo hacia Venezuela.`;
	} else {
		reasonEs = `Centro a ${distance} km de Venezuela.`;
	}
	return {
		distanceKm: distance,
		bearingToVenezuelaDeg: bearing,
		headingTowardVenezuela: toward,
		threat,
		reasonEs,
	};
}

export type TropicalStorm = StormThreat & {
	id: string;
	name: string;
	classification: string;
	classificationEs: string;
	/** Maximum sustained wind. */
	windKt: number;
	windKmh: number;
	category: number | null;
	pressureMb: number | null;
	movementDirDeg: number | null;
	movementKmh: number | null;
	/** Where the centre is, in Spanish, relative to the nearest Venezuelan town ("En el mar, a 900 km al N de …"). */
	placeEs: string;
	directionFromVenezuelaEs: string;
	advisoryUrl: string | null;
};

export const nhcStorms: Adapter<TropicalStorm> = {
	id: "nhc-storms",
	layer: "earth",
	name: { es: "Ciclones tropicales del Atlántico (NHC)", en: "Atlantic tropical cyclones (NHC)" },
	provider: "NOAA NHC",
	homepage: "https://www.nhc.noaa.gov/",
	licence: NHC_LICENCE,
	keys: [],
	// Advisories every 3–6 h; the file is cached 5 min. 15 min all year costs ~1.8 MB/day at 19 KB.
	intervalMs: 15 * 60_000,
	freshness: { fetchMs: 60 * 60_000, dataMs: null },

	async fetch(ctx) {
		const raw = await ctx.http.request(NHC_URL, {
			headers: { accept: "application/json" },
			hostGapMs: 5_000,
			maxBytes: 2 * 1024 * 1024,
			signal: ctx.signal,
		});
		return [raw];
	},

	normalise(raws) {
		const raw = raws[0];
		if (!raw) throw new SchemaError("no response");
		let json: unknown;
		try {
			json = JSON.parse(raw.body);
		} catch {
			throw new SchemaError("NHC: the response is not JSON");
		}
		const envelope = Envelope.safeParse(json);
		if (!envelope.success) throw new SchemaError(`NHC CurrentStorms: ${envelope.error.message}`);
		const out: Observation<TropicalStorm>[] = [];
		for (const item of envelope.data.activeStorms) {
			const parsed = Storm.safeParse(item);
			if (!parsed.success || !parsed.data.id.startsWith("al")) continue;
			const s = parsed.data;
			const lat = s.latitudeNumeric;
			const lon = s.longitudeNumeric;
			const kt = Number(s.intensity);
			const dir = s.movementDir ?? null;
			const assessed = assessThreat(lat, lon, dir);
			const nearest = nearestVenezuelaPoint(lat, lon);
			const where = placeOf(lat, lon);
			const advisoryUrl = s.publicAdvisory?.url ?? null;
			out.push({
				source: "nhc-storms",
				series: `storm:${s.id}`,
				sourceUrl: s.forecastGraphics?.url ?? advisoryUrl ?? "https://www.nhc.noaa.gov/",
				fetchedAt: raw.fetchedAt,
				observedAt: Math.min(Date.parse(s.lastUpdate), raw.fetchedAt),
				licence: NHC_LICENCE.id,
				value: {
					id: s.id,
					name: s.name,
					classification: s.classification,
					classificationEs: CLASS_ES[s.classification] ?? s.classification,
					windKt: kt,
					windKmh: Math.round(kt * 1.852),
					category: s.classification === "HU" ? saffirSimpson(kt) : null,
					pressureMb: s.pressure ? Number(s.pressure) : null,
					movementDirDeg: dir,
					movementKmh: s.movementSpeed == null ? null : Math.round(s.movementSpeed * 1.609344),
					placeEs: where.placeEs,
					directionFromVenezuelaEs: bearingEs(nearest.lat, nearest.lon, lat, lon),
					advisoryUrl,
					...assessed,
				},
				location: where.state ? { lat, lon, state: where.state } : { lat, lon },
				confidence: 1,
				basis: "official",
			});
		}
		return out;
	},
};
