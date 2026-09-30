import { z } from "zod";
import type { Adapter, Licence, Observation, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { placeAt } from "../../ontology/geo.ts";
import { FACILITIES, type Facility, facilityFor } from "../firms-flares/facilities.ts";

/**
 * Methane plumes over Venezuela from Carbon Mapper's public catalogue: point-source plumes imaged by imaging
 * spectrometers (the Tanager-1 satellite, "tan"; NASA/JPL's AVIRIS-NG, "ang"; NASA's EMIT on the ISS, "emi"), with
 * Carbon Mapper's own emission-rate estimate and its uncertainty. It answers "is methane leaking or being vented at
 * Venezuelan oil and gas fields, and where". A plume is one observation of one source at one moment: absence of a
 * plume means nothing was seen on that pass, not that nothing is emitted (most days nobody looks).
 *
 * Access: `GET https://api.carbonmapper.org/api/v1/catalog/plumes/annotated` with a bounding box, no key (verified
 * 2026-09-29). Measured that day, box −73.5…−59.7 E, 0.6…12.3 N: 424 plumes since 2023 (383 Tanager, 28 AVIRIS-NG,
 * 13 EMIT; all CH4; sector 1B2 oil and gas 365, 6A waste 40, 1B1a coal 16); 377 lie in Venezuela (the rest in
 * Colombia, Trinidad and the sea). A 400-day window is 276 plumes, 1.18 MB in 1.2 s (each item carries five signed
 * image links, which Vigía never stores: they expire). Newest scene 2026-08-27, published 2026-09-26: plumes appear
 * about a month after the pass, and are sometimes revised (a new row is stored when the values change).
 * No ETag or Last-Modified; the API is rate-limited without published numbers, so one request a day.
 *
 * Location: only plumes inside Venezuela (state polygons, or Lake Maracaibo) are kept. A plume within 3 km of the
 * outline of a refinery or complex, or of a World Bank GFMR flare site of a field group, is assigned to that
 * facility (the flare feed's list, `firms-flares/facilities.ts`, with a wider radius than for a VIIRS pixel because
 * a plume's origin is marked by hand or by algorithm at a well pad, tank or compressor, not at the flare). Others
 * keep only their place.
 *
 * Licence: Carbon Mapper Terms of Use (version of 2026-01-13): reuse, derivatives and redistribution allowed on a
 * non-commercial basis, for awareness and mitigation purposes (the "Purpose"), with attribution ("Source: Carbon
 * Mapper (data.carbonmapper.org)"), share-alike on redistribution. Vigía is free and non-commercial.
 */

export const CARBON_MAPPER_LICENCE: Licence = {
	id: "carbon-mapper-terms",
	name: "Términos de Carbon Mapper (no comercial, con atribución, compartir igual)",
	url: "https://carbonmapper.org/terms",
	attribution: "Fuente: Carbon Mapper (data.carbonmapper.org)",
	commercial: false,
};

export const CARBON_MAPPER_HOME = "https://data.carbonmapper.org/";
const API = "https://api.carbonmapper.org/api/v1/catalog/plumes/annotated";
/** West, south, east, north: Venezuela's box with a margin (plumes outside the country are dropped in normalise). */
export const BBOX = [-73.5, 0.6, -59.7, 12.3] as const;
const DAY = 86_400_000;
export const WINDOW_DAYS = 400;
export const PAGE = 1000;
/** A plume this close to a facility's outline or flare site belongs to it (km). */
export const PLUME_FACILITY_KM = 3;

/** IPCC sector codes Carbon Mapper uses, in words. */
export const SECTORS: Readonly<Record<string, { es: string; en: string }>> = {
	"1B2": { es: "petróleo y gas", en: "oil and gas" },
	"1B1a": { es: "minería de carbón", en: "coal mining" },
	"6A": { es: "desechos sólidos (vertederos)", en: "solid waste (landfills)" },
	"6B": { es: "aguas residuales", en: "wastewater" },
	"4B": { es: "ganadería (estiércol)", en: "livestock (manure)" },
	"1A1": { es: "generación de energía", en: "energy generation" },
	"1A2": { es: "industria", en: "manufacturing" },
	other: { es: "otro", en: "other" },
};

export const INSTRUMENTS: Readonly<Record<string, string>> = {
	tan: "Tanager-1 (satélite, Planet/Carbon Mapper)",
	ang: "AVIRIS-NG (avión, NASA/JPL)",
	av3: "AVIRIS-3 (avión, NASA/JPL)",
	emi: "EMIT (Estación Espacial, NASA)",
	GAO: "GAO (avión, ASU)",
	ssc: "SSC",
};

export type MethanePlume = {
	/** Carbon Mapper's plume name, e.g. "tan20260827t160224c37s4001-A". */
	plumeId: string;
	gas: "CH4" | "CO2";
	/** Scene time (UTC ISO). */
	sceneAt: string;
	instrument: string;
	platform: string | null;
	/** Carbon Mapper's automatic emission-rate estimate, kg/h; null when they hide it or give none. */
	emissionKgH: number | null;
	/** Its 1-sigma uncertainty, kg/h. */
	uncertaintyKgH: number | null;
	/** Average wind used for the estimate, m/s. */
	windMs: number | null;
	/** IPCC sector code, or null. */
	sector: string | null;
	offshore: boolean;
	/** When Carbon Mapper published it (UTC ISO), or null. */
	publishedAt: string | null;
	/** `firms-flares` facility id within PLUME_FACILITY_KM, or null. */
	facilityId: string | null;
	facilityKm: number | null;
	/** Municipality P-code, when the point falls in one. */
	municipality: string | null;
};

const Num = z.number().finite();
const Item = z.object({
	plume_id: z.string().min(3).max(80),
	gas: z.enum(["CH4", "CO2"]),
	geometry_json: z.object({ type: z.literal("Point"), coordinates: z.tuple([Num, Num]) }),
	scene_timestamp: z.string().datetime({ offset: true }),
	instrument: z.string().min(1).max(20),
	platform: z.string().max(60).nullable().optional(),
	emission_auto: Num.nonnegative().nullable().optional(),
	emission_uncertainty_auto: Num.nonnegative().nullable().optional(),
	wind_speed_avg_auto: Num.nonnegative().nullable().optional(),
	sector: z.string().max(20).nullable().optional(),
	is_offshore: z.boolean().nullable().optional(),
	status: z.string().max(40).nullable().optional(),
	hide_emission: z.boolean().nullable().optional(),
	published_at: z.string().datetime({ offset: true }).nullable().optional(),
});
const Envelope = z.object({
	bbox_count: z.number().int().nonnegative(),
	limit: z.number().int().positive(),
	offset: z.number().int().nonnegative(),
	items: z.array(z.unknown()),
});

export function plumesUrl(now: number, offset = 0): string {
	const q = new URLSearchParams();
	for (const b of BBOX) q.append("bbox", String(b));
	const from = new Date(now - WINDOW_DAYS * DAY).toISOString().slice(0, 19);
	const to = new Date(now + DAY).toISOString().slice(0, 19);
	q.set("datetime", `${from}Z/${to}Z`);
	q.set("limit", String(PAGE));
	q.set("offset", String(offset));
	q.set("sort", "desc");
	return `${API}?${q}`;
}

/** A page a person can open to check one plume (the public API's JSON for it, no key). */
export function plumeUrl(plumeId: string): string {
	return `${API}?${new URLSearchParams({ plume_names: plumeId })}`;
}

const WIDE: readonly Facility[] = FACILITIES.map((f) => ({
	...f,
	...(f.outline ? { bufferKm: PLUME_FACILITY_KM } : {}),
	...(f.sites ? { siteRadiusKm: PLUME_FACILITY_KM } : {}),
}));

function envelope(raw: RawResponse): z.infer<typeof Envelope> {
	let body: unknown;
	try {
		body = JSON.parse(raw.body);
	} catch {
		throw new SchemaError("Carbon Mapper: la respuesta no es JSON");
	}
	const env = Envelope.safeParse(body);
	if (!env.success) throw new SchemaError("Carbon Mapper: falta la lista «items»");
	return env.data;
}

export const carbonMapper: Adapter<MethanePlume> = {
	id: "carbon-mapper",
	layer: "earth",
	name: {
		es: "Plumas de metano sobre Venezuela (Carbon Mapper)",
		en: "Methane plumes over Venezuela (Carbon Mapper)",
	},
	provider: "Carbon Mapper",
	homepage: CARBON_MAPPER_HOME,
	licence: CARBON_MAPPER_LICENCE,
	keys: [],
	// Plumes are published about a month after the pass: once a day is plenty (~1.2 MB a run).
	intervalMs: 24 * 3_600_000,
	// An event feed (no plume for weeks is normal); a fetch older than 3 days is stale.
	freshness: { fetchMs: 3 * DAY, dataMs: null },

	async fetch(ctx) {
		const opts = {
			headers: { accept: "application/json" },
			hostGapMs: 5_000,
			maxBytes: 16 * 1024 * 1024,
			timeoutMs: 60_000,
			signal: ctx.signal,
		};
		const first = await ctx.http.request(plumesUrl(ctx.now()), opts);
		const out = [first];
		// A second page only if the window ever holds more than PAGE plumes (276 on 2026-09-29).
		try {
			const env = envelope(first);
			if (env.bbox_count > PAGE && env.items.length === PAGE)
				out.push(await ctx.http.request(plumesUrl(ctx.now(), PAGE), opts));
		} catch {
			// normalise reports the bad envelope
		}
		return out;
	},

	normalise(raws) {
		if (raws.length === 0) throw new SchemaError("no response");
		const out: Observation<MethanePlume>[] = [];
		const seen = new Set<string>();
		for (const raw of raws) {
			const env = envelope(raw);
			let valid = 0;
			for (const item of env.items) {
				const parsed = Item.safeParse(item);
				if (!parsed.success) continue;
				valid++;
				const p = parsed.data;
				if (p.status && p.status !== "published") continue;
				const [lon, lat] = p.geometry_json.coordinates;
				const observedAt = Date.parse(p.scene_timestamp);
				if (!Number.isFinite(observedAt) || observedAt > raw.fetchedAt) continue;
				const where = placeAt(lat, lon);
				if (!where.state) continue;
				if (seen.has(p.plume_id)) continue;
				seen.add(p.plume_id);
				const facility = facilityFor(lat, lon, WIDE);
				const hidden = p.hide_emission === true;
				out.push({
					source: "carbon-mapper",
					series: `plume:${p.plume_id}`,
					sourceUrl: plumeUrl(p.plume_id),
					fetchedAt: raw.fetchedAt,
					observedAt,
					licence: CARBON_MAPPER_LICENCE.id,
					value: {
						plumeId: p.plume_id,
						gas: p.gas,
						sceneAt: new Date(observedAt).toISOString(),
						instrument: p.instrument,
						platform: p.platform ?? null,
						emissionKgH: hidden ? null : round1(p.emission_auto),
						uncertaintyKgH: hidden ? null : round1(p.emission_uncertainty_auto),
						windMs: round1(p.wind_speed_avg_auto),
						sector: p.sector ?? null,
						offshore: p.is_offshore === true,
						publishedAt: p.published_at ? new Date(Date.parse(p.published_at)).toISOString() : null,
						facilityId: facility?.facility.id ?? null,
						facilityKm: facility ? Math.round(facility.km * 10) / 10 : null,
						municipality: where.municipality,
					},
					location: { lat, lon, state: where.state },
					// The plume is imaged (a measurement); the rate is Carbon Mapper's model estimate with its uncertainty.
					confidence: 0.8,
					basis: "measurement",
				});
			}
			if (env.items.length > 0 && valid === 0) throw new SchemaError("Carbon Mapper: ningún elemento válido");
		}
		return out;
	},
};

function round1(v: number | null | undefined): number | null {
	return typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
}
