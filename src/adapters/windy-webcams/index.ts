import { z } from "zod";
import type { Adapter, Licence, Observation, RawResponse } from "../../core/types.ts";
import { MissingKeyError, SchemaError } from "../../core/types.ts";

/**
 * Windy Webcams: the cameras their owners registered on Windy in and around Venezuela, as a LIST (where each one is,
 * which way it looks by its title, whether Windy says it is active and when its picture last changed) and a link to
 * Windy's own player. Locked until the user adds a free Windy key (api.windy.com/keys).
 *
 * No image is ever read, stored or measured: Windy's terms allow images "only with URLs provided by the API", with
 * a link to Windy, and forbid redistributing them or publishing "any graphics displaying the Webcam images"; image
 * URLs expire in 10–15 minutes on the free plan. So a Windy camera is shown as a card with its state and plays in
 * Windy's public player after a press, with Windy's credit line ("Webcams provided by windy.com — add a webcam").
 * Whether a brightness number may be computed from a Windy image without keeping it is left open: the terms are
 * silent, so nothing is computed from Windy images.
 *
 * API v3 (docs read 2026-09-29): GET
 * /webcams/api/v3/webcams with `countries`, `nearby=<lat>,<lon>,<km ≤ 250>`, `limit ≤ 50`, `offset`, and
 * `include=location,player,urls`; the key goes in the `x-windy-api-key` header, never in a URL. Response shape
 * validated loosely (not yet seen with a real key: every field but the id is optional). Three reads an hour at most:
 * far from the "continuous scanning" Windy's terms call misuse.
 */

export const WINDY_KEY_ID = "windy-webcams-key";

export const WINDY_LICENCE: Licence = {
	id: "windy-webcams",
	name: "Windy Webcams API (plan gratuito): lista y enlaces; las imágenes no se guardan ni se redistribuyen",
	url: "https://api.windy.com/webcams/terms",
	attribution: "Webcams provided by windy.com — add a webcam",
	commercial: false,
	raw: false,
};

const API = "https://api.windy.com/webcams/api/v3/webcams";
export const WINDY_ATTRIBUTION = {
	text: "Webcams provided by windy.com — add a webcam",
	url: "https://www.windy.com/webcams/add",
} as const;

/** The three lists read each run: Venezuela, the Cúcuta border area, and the ABC islands off the Falcón coast. */
export const WINDY_QUERIES = [
	{ id: "ve", params: "countries=VE" },
	{ id: "cucuta", params: "nearby=7.89,-72.49,60" },
	{ id: "abc", params: "nearby=12.3,-69.3,150" },
] as const;

export const LIST_CONTENT_TYPE = "application/vnd.vigia.windy-list+json";

const Webcam = z
	.object({
		webcamId: z.union([z.number(), z.string()]).transform(String),
		title: z.string().max(300).optional(),
		status: z.string().max(40).optional(),
		lastUpdatedOn: z.string().optional(),
		location: z
			.object({
				city: z.string().optional(),
				region: z.string().optional(),
				country_code: z.string().optional(),
				latitude: z.number().min(-90).max(90),
				longitude: z.number().min(-180).max(180),
			})
			.optional(),
		player: z.object({ day: z.string().optional() }).optional(),
		urls: z.object({ detail: z.string().optional() }).optional(),
	})
	.loose();
const Envelope = z.object({ webcams: z.array(z.unknown()) }).loose();

export type WindyCam = {
	readonly id: string;
	readonly title: string;
	/** Windy's own status ("active", "inactive"…). */
	readonly status: string;
	/** When Windy says the camera's picture last changed (epoch ms), or null. */
	readonly lastUpdatedAt: number | null;
	readonly lat: number;
	readonly lon: number;
	readonly city: string | null;
	readonly country: string | null;
	/** Windy's public player (embed after a press) and its camera page. */
	readonly player: string;
	readonly page: string;
};

const WINDY_PLAYER = /^https:\/\/webcams\.windy\.com\/webcams\/public\/embed\/player\/\d{1,15}\/day$/;

/** Pure: one listed webcam → a WindyCam, or null (no position, an unexpected player URL). */
export function readWebcam(raw: unknown): WindyCam | null {
	const p = Webcam.safeParse(raw);
	if (!p.success || !p.data.location || !/^\d{1,15}$/.test(p.data.webcamId)) return null;
	const d = p.data;
	const id = d.webcamId;
	// Only Windy's own player on Windy's own host is ever framed (the page's CSP allows exactly that host).
	const standard = `https://webcams.windy.com/webcams/public/embed/player/${id}/day`;
	const player = d.player?.day && WINDY_PLAYER.test(d.player.day) ? d.player.day : standard;
	const updated = d.lastUpdatedOn ? Date.parse(d.lastUpdatedOn) : Number.NaN;
	return {
		id,
		// Anyone can register a webcam on Windy, often at home: its own title (a house's or a person's name) is never
		// kept, and its position is rounded to 0.01° (~1 km), enough for a map of places, not of homes.
		title: `Cámara en Windy · ${(d.location?.city ?? d.location?.region ?? d.location?.country_code ?? "sin lugar").slice(0, 60)}`,
		status: d.status ?? "unknown",
		lastUpdatedAt: Number.isFinite(updated) ? updated : null,
		lat: Math.round((d.location?.latitude ?? 0) * 100) / 100,
		lon: Math.round((d.location?.longitude ?? 0) * 100) / 100,
		city: d.location?.city?.slice(0, 80) ?? null,
		country: d.location?.country_code?.slice(0, 2).toUpperCase() ?? null,
		player,
		page: `https://www.windy.com/webcams/${id}`,
	};
}

export const windyWebcams: Adapter<WindyCam> = {
	id: "windy-webcams",
	layer: "society",
	name: {
		es: "Cámaras públicas: lista de Windy Webcams (con tu clave)",
		en: "Public cameras: Windy Webcams list (with your key)",
	},
	provider: "Windy.com (cámaras registradas por sus dueños)",
	homepage: "https://api.windy.com/webcams",
	licence: WINDY_LICENCE,
	keys: [WINDY_KEY_ID],
	// Windy's terms forbid redistributing what the API returns: on in a personal Vigía, off on a public mirror.
	defaultIn: { local: true, public: false },
	note: {
		es: "Con tu clave de Windy, Vigía muestra dónde hay cámaras registradas en Windy (posición redondeada a ~1 km, sin su título) y su reproductor. Los términos de Windy prohíben redistribuir sus datos: por eso viene apagada en un espejo público.",
		en: "With your Windy key, Vigía shows where cameras registered on Windy are (position rounded to ~1 km, without their title) and their player. Windy's terms forbid redistributing its data: so it is off on a public mirror.",
	},
	intervalMs: 60 * 60_000,
	freshness: { fetchMs: 4 * 60 * 60_000, dataMs: null },

	async fetch(ctx) {
		const key = ctx.key(WINDY_KEY_ID);
		if (!key) throw new MissingKeyError(WINDY_KEY_ID);
		const out: RawResponse[] = [];
		for (const q of WINDY_QUERIES) {
			const res = await ctx.http.request(`${API}?${q.params}&limit=50&include=location,player,urls`, {
				headers: { accept: "application/json", "x-windy-api-key": key },
				timeoutMs: 30_000,
				hostGapMs: 2_000,
				retries: 1,
				signal: ctx.signal,
			});
			out.push({ ...res, contentType: LIST_CONTENT_TYPE });
		}
		return out;
	},

	normalise(raws) {
		const byId = new Map<string, Observation<WindyCam>>();
		for (const raw of raws) {
			if (raw.contentType !== LIST_CONTENT_TYPE) continue;
			let json: unknown;
			try {
				json = JSON.parse(raw.body);
			} catch {
				throw new SchemaError("Windy: JSON no válido");
			}
			const env = Envelope.safeParse(json);
			if (!env.success) throw new SchemaError("Windy: respuesta sin lista de cámaras");
			for (const item of env.data.webcams) {
				const cam = readWebcam(item);
				if (!cam || byId.has(cam.id)) continue;
				byId.set(cam.id, {
					source: "windy-webcams",
					series: `windy:${cam.id}`,
					sourceUrl: cam.page,
					fetchedAt: raw.fetchedAt,
					// The list's own time for the camera when Windy gives one (never in the future), else when read.
					observedAt: Math.min(cam.lastUpdatedAt ?? raw.fetchedAt, raw.fetchedAt),
					licence: WINDY_LICENCE.id,
					value: cam,
					location: { lat: cam.lat, lon: cam.lon },
					confidence: 1,
					basis: "report",
				});
			}
		}
		return [...byId.values()];
	},
};
