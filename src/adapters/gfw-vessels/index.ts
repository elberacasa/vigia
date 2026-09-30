import { z } from "zod";
import type { Adapter, Licence, Observation, RawResponse } from "../../core/types.ts";
import { MissingKeyError, SchemaError } from "../../core/types.ts";

/**
 * Ships seen by radar satellite near Venezuela's oil terminals, from Global Fishing Watch's SAR vessel detections
 * (Sentinel-1 radar images, vessels detected by GFW's model and matched, or not, to an AIS position): per terminal
 * area and day, how many vessels the radar saw and how many of them had no matching AIS broadcast. The second number
 * is the "dark" signal (tankers loading with AIS off are a known pattern at José and Amuay), with GFW's caveats:
 * no match can also mean a small vessel without AIS, or a failed match; fixed platforms are excluded by GFW; and
 * the radar only sees an area on the days Sentinel-1 passes (every few days here), so a day with no image is not a
 * day with no ships. Counts only: no vessel is named, tracked or located by Vigía.
 *
 * Access: GFW's API needs a free token (an account for non-commercial use; globalfishingwatch.org/our-apis). Without
 * it the feed is locked. Tested without a token on 2026-09-29: `GET /v3/datasets` and `/v3/4wings/report` answer
 * 401 `{"error":"invalid token"}`. Request and response follow GFW's 4Wings report API as its official Python client
 * documents it (github.com/GlobalFishingWatch/gfw-api-python-client, read 2026-09-29): `POST /v3/4wings/report` with
 * `datasets[0]=public-global-sar-presence:latest`, `temporal-resolution=DAILY`, `spatial-aggregation=true`,
 * `date-range=A,B`, an optional `filters[0]=matched='false'`, and a GeoJSON body; the answer is
 * `{"entries": [{"<dataset>:<version>": [{"date": …, "detections": …}, …]}]}`. Synthetic tests use that shape; a
 * recorded fixture is added on the first run with a token.
 *
 * Areas (fixed, stated): circles of 12–15 km around the terminals of José, Puerto La Cruz (Guaraguao), Paraguaná
 * (Amuay, Punta Cardón, Guaranao) and El Palito–Puerto Cabello, and the box of Lake Maracaibo (9.0–10.97 N,
 * 72.15–70.95 W). Two requests per area (all detections, and those without AIS) a day for the last 30 days: 10
 * requests.
 *
 * Licence: GFW data are CC BY-NC 4.0 ("Global Fishing Watch"), API use non-commercial; Vigía is non-commercial.
 */

export const GFW_VESSELS_LICENCE: Licence = {
	id: "cc-by-nc-4.0-gfw",
	name: "CC BY-NC 4.0 (Global Fishing Watch)",
	url: "https://globalfishingwatch.org/our-apis/documentation#terms-of-use",
	attribution:
		"Detecciones SAR de buques: Global Fishing Watch (CC BY-NC 4.0), imágenes Copernicus Sentinel-1",
	commercial: false,
};

export const GFW_TOKEN_ID = "global-fishing-watch-token";
export const GFW_MAP = "https://globalfishingwatch.org/map";
const API = "https://gateway.api.globalfishingwatch.org/v3/4wings/report";
export const DATASET = "public-global-sar-presence:latest";
const DAY = 86_400_000;
export const DAYS = 30;

export type Area = {
	id: string;
	es: string;
	/** Ontology entities the area is about. */
	entities: readonly string[];
	/** Circle centre and radius, or a box. */
	circle?: { lat: number; lon: number; km: number };
	box?: { south: number; north: number; west: number; east: number };
};

export const AREAS: readonly Area[] = [
	{
		id: "jose",
		es: "Terminal de José (Anzoátegui)",
		entities: ["infra.terminal-jose", "infra.complejo-jose"],
		circle: { lat: 10.0676, lon: -64.868, km: 12 },
	},
	{
		id: "puerto-la-cruz",
		es: "Puerto La Cruz: Guaraguao y Guanta (Anzoátegui)",
		entities: ["infra.terminal-puerto-la-cruz", "infra.refineria-puerto-la-cruz", "infra.puerto-guanta"],
		circle: { lat: 10.2308, lon: -64.6149, km: 12 },
	},
	{
		id: "paraguana",
		es: "Paraguaná: Amuay, Punta Cardón y Guaranao (Falcón)",
		entities: [
			"infra.terminal-amuay",
			"infra.terminal-punta-cardon",
			"infra.puerto-guaranao",
			"infra.refineria-amuay",
			"infra.refineria-cardon",
		],
		circle: { lat: 11.69, lon: -70.215, km: 15 },
	},
	{
		id: "el-palito",
		es: "El Palito y Puerto Cabello (Carabobo)",
		entities: ["infra.terminal-el-palito", "infra.refineria-el-palito", "infra.puerto-cabello"],
		circle: { lat: 10.48, lon: -68.07, km: 15 },
	},
	{
		id: "lago-maracaibo",
		es: "Lago de Maracaibo (rectángulo 9,0–10,97 N, 72,15–70,95 O)",
		entities: [
			"infra.terminal-la-salina",
			"infra.terminal-bajo-grande",
			"infra.terminal-puerto-miranda",
			"infra.puerto-maracaibo",
		],
		box: { south: 9.0, north: 10.97, west: -72.15, east: -70.95 },
	},
];

export type VesselDay = {
	area: string;
	/** UTC day. */
	date: string;
	/** Vessels the radar detected in the area that day. */
	detections: number;
	/** Of those, detections GFW did not match to any AIS position. */
	withoutAis: number;
};

/** A closed GeoJSON polygon for an area (a 32-gon for circles; plate carrée scaled by latitude). */
export function areaPolygon(a: Area): { type: "Polygon"; coordinates: number[][][] } {
	if (a.box) {
		const { south, north, west, east } = a.box;
		return {
			type: "Polygon",
			coordinates: [
				[
					[west, south],
					[east, south],
					[east, north],
					[west, north],
					[west, south],
				],
			],
		};
	}
	const c = a.circle ?? { lat: 0, lon: 0, km: 0 };
	const dLat = c.km / 111.32;
	const dLon = c.km / (111.32 * Math.cos((c.lat * Math.PI) / 180));
	const ring: number[][] = [];
	for (let i = 0; i < 32; i++) {
		const t = (i / 32) * 2 * Math.PI;
		ring.push([
			Math.round((c.lon + dLon * Math.cos(t)) * 1e5) / 1e5,
			Math.round((c.lat + dLat * Math.sin(t)) * 1e5) / 1e5,
		]);
	}
	ring.push(ring[0] as number[]);
	return { type: "Polygon", coordinates: [ring] };
}

export function reportUrl(now: number, area: string, darkOnly: boolean): string {
	const to = new Date(now).toISOString().slice(0, 10);
	const from = new Date(now - DAYS * DAY).toISOString().slice(0, 10);
	const q = new URLSearchParams({
		"datasets[0]": DATASET,
		"temporal-resolution": "DAILY",
		"spatial-resolution": "LOW",
		"spatial-aggregation": "true",
		"date-range": `${from},${to}`,
		format: "JSON",
	});
	if (darkOnly) q.set("filters[0]", "matched='false'");
	// The area rides in the fragment, for normalise to know which area an answer is about; fetch cuts it off before
	// the request, so GFW's query stays exactly its documented parameters.
	return `${API}?${q}#${area}`;
}

const Entry = z.object({
	date: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
	detections: z.number().int().nonnegative(),
});
const Envelope = z.object({ entries: z.array(z.record(z.string(), z.unknown())) });

function parse(raw: RawResponse): Map<string, number> {
	let body: unknown;
	try {
		body = JSON.parse(raw.body);
	} catch {
		throw new SchemaError("Global Fishing Watch: la respuesta no es JSON");
	}
	const env = Envelope.safeParse(body);
	if (!env.success) throw new SchemaError("Global Fishing Watch: falta «entries»");
	const byDay = new Map<string, number>();
	for (const entry of env.data.entries)
		for (const [dataset, rows] of Object.entries(entry)) {
			if (!dataset.startsWith("public-global-sar-presence") || !Array.isArray(rows)) continue;
			for (const row of rows) {
				const r = Entry.safeParse(row);
				if (!r.success) continue;
				const day = r.data.date.slice(0, 10);
				byDay.set(day, (byDay.get(day) ?? 0) + r.data.detections);
			}
		}
	return byDay;
}

export const gfwVessels: Adapter<VesselDay> = {
	id: "gfw-vessels",
	layer: "oil",
	name: {
		es: "Buques vistos por radar cerca de las terminales petroleras (Global Fishing Watch, Sentinel-1)",
		en: "Ships seen by radar near the oil terminals (Global Fishing Watch, Sentinel-1)",
	},
	provider: "Global Fishing Watch",
	homepage: GFW_MAP,
	licence: GFW_VESSELS_LICENCE,
	keys: [GFW_TOKEN_ID],
	// Sentinel-1 passes every few days and GFW processes with a lag of days: once a day is enough.
	intervalMs: 24 * 3_600_000,
	// An event-like feed (no image, no detections); a fetch older than 3 days is stale.
	freshness: { fetchMs: 3 * DAY, dataMs: null },

	async fetch(ctx) {
		const token = ctx.key(GFW_TOKEN_ID);
		if (!token) throw new MissingKeyError(GFW_TOKEN_ID);
		const out: RawResponse[] = [];
		for (const area of AREAS)
			for (const dark of [false, true]) {
				const url = reportUrl(ctx.now(), area.id, dark);
				const res = await ctx.http.request(url.slice(0, url.indexOf("#")), {
					method: "POST",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
						accept: "application/json",
					},
					body: JSON.stringify({ geojson: areaPolygon(area) }),
					hostGapMs: 2_000,
					timeoutMs: 120_000,
					maxBytes: 4 * 1024 * 1024,
					signal: ctx.signal,
				});
				// Keep which area and which filter the response is for (the fragment never leaves this machine).
				out.push({ ...res, url });
			}
		return out;
	},

	normalise(raws) {
		if (raws.length === 0) throw new SchemaError("no response");
		const byArea = new Map<string, { all?: Map<string, number>; dark?: Map<string, number>; at: number }>();
		for (const raw of raws) {
			const hash = raw.url.indexOf("#");
			const area = hash === -1 ? "" : raw.url.slice(hash + 1);
			if (!AREAS.some((a) => a.id === area))
				throw new SchemaError(`Global Fishing Watch: área desconocida «${area}»`);
			const dark = raw.url.includes("matched%3D%27false%27") || raw.url.includes("matched='false'");
			const rec = byArea.get(area) ?? { at: raw.fetchedAt };
			rec.at = Math.max(rec.at, raw.fetchedAt);
			if (dark) rec.dark = parse(raw);
			else rec.all = parse(raw);
			byArea.set(area, rec);
		}
		const out: Observation<VesselDay>[] = [];
		for (const [area, rec] of byArea) {
			if (!rec.all) throw new SchemaError(`Global Fishing Watch: falta el total de ${area}`);
			const dark = rec.dark ?? new Map<string, number>();
			for (const [date, detections] of [...rec.all].sort((a, b) => a[0].localeCompare(b[0]))) {
				const observedAt = Date.parse(`${date}T00:00:00Z`);
				if (!Number.isFinite(observedAt) || observedAt > rec.at) continue;
				out.push({
					source: "gfw-vessels",
					series: `area:${area}`,
					sourceUrl: GFW_MAP,
					fetchedAt: rec.at,
					observedAt,
					licence: GFW_VESSELS_LICENCE.id,
					value: { area, date, detections, withoutAis: Math.min(detections, dark.get(date) ?? 0) },
					// A radar detection by GFW's model; the AIS match is GFW's too, with the caveats above.
					confidence: 0.8,
					basis: "measurement",
				});
			}
		}
		return out;
	},
};
