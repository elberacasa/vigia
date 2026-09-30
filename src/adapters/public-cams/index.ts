import { createHash } from "node:crypto";
import { z } from "zod";
import { CAMERAS } from "../../cameras/list.ts";
import { CAMERA_RULES } from "../../cameras/rules.ts";
import type { CameraStill } from "../../cameras/state.ts";
import type { CameraSpec } from "../../cameras/types.ts";
import { blobKey } from "../../core/blobs.ts";
import type { Adapter, FetchContext, Licence, Observation, RawResponse } from "../../core/types.ts";
import { HttpError, SchemaError } from "../../core/types.ts";
import { encodeJpeg } from "../../imaging/jpeg.ts";
import { decodeImage, dhash, downscale, lumaStats, type Rgba, sniffImage } from "../../imaging/raster.ts";
import { solarZenithDeg } from "../../imaging/sun.ts";
import { decodeKeyframe, findDecoder } from "../../media/decoder.ts";
import { grabKeyframe, reasonOf as grabReason } from "../../media/grab.ts";
import { pool } from "../../media/probe.ts";
import { publicRequest } from "../../media/public-host.ts";

/**
 * Public cameras: one modest still of every camera in the curated census (src/cameras/list.ts) at the camera's own
 * cadence, stored with history (the time machine replays the room with the stills of that moment), and reduced to
 * a few numbers the camera layer reasons about: a hash of the operator's bytes (a frozen picture), a 64-bit
 * difference hash, the mean brightness of the whole picture and of the camera's city-lights region, and the sun's
 * elevation at the camera. No faces, no people, no counting, no zoom (the project's first hard line: nothing that identifies a private person): nothing else is ever
 * computed from a picture.
 *
 * How a still is taken depends on how the operator publishes the camera:
 * - a snapshot URL (JPEG/PNG): read, decoded, reduced to 480 px and re-encoded by Vigía (never served as sent);
 * - an open HLS stream: the first keyframe of the newest segment (src/media/grab.ts), decoded by the machine's
 *   ffmpeg when it has one ("no-decoder" otherwise);
 * - cameras published only as a YouTube stream, in an operator's page or player, or through Windy take no still:
 *   they are shown with their state and play in the operator's own player after a press. (YouTube's live thumbnails
 *   are not used as stills: measured 2026-09-29, a webcam business's channel returns a promotional picture for them,
 *   and ended streams still answer 200.)
 *
 * Every still is served from Vigía's own origin (/api/blobs/public-cams/<key>): the browser never contacts a camera
 * operator until the viewer presses play. Licence: each picture belongs to its operator; Vigía keeps a reduced
 * reference still where the operator's terms allow it (the census records each one's terms).
 */

export const PUBLIC_CAMS_LICENCE: Licence = {
	id: "public-cam-reference",
	name: "Imagen de cada cámara, de su operador; Vigía guarda una imagen fija reducida como referencia",
	url: "https://vigia.live/fuentes",
	attribution: "Imagen: cada operador de cámara (ver la ficha de la cámara); imagen fija tomada por Vigía",
	commercial: "unclear",
};

const MIN = 60_000;
export const STILL_CONTENT_TYPE = "application/vnd.vigia.camera-still+json";
export const PIPELINE_VERSION = "public-cams/1";

/** When each camera was last tried (process-local: after a restart every camera is due). */
const lastTried = new Map<string, number>();

/** Tests only. */
export function resetCameraMemory(): void {
	lastTried.clear();
}

/** Cameras a still can be taken of: a snapshot or an open stream, with terms that allow keeping a still. */
export function stillCameras(list: readonly CameraSpec[] = CAMERAS): CameraSpec[] {
	return list.filter((c) => c.terms.stills && (c.access.type === "jpeg" || c.access.type === "hls"));
}

export function sunElevationDeg(lat: number, lon: number, at: number): number {
	return Math.round((90 - solarZenithDeg(lat, lon, at)) * 10) / 10;
}

function sha16(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

type Record_ = CameraStill & { readonly at: number };

/** Pure: the numbers a still is reduced to (whole picture, lights region, sun, night). */
export function measure(
	spec: CameraSpec,
	image: Rgba,
	at: number,
): Pick<CameraStill, "hash" | "lumaMean" | "lumaSd" | "lightsMean" | "lightsBright" | "sunDeg" | "night"> {
	const whole = lumaStats(image);
	const lights = spec.lights ? lumaStats(image, spec.lights.region, CAMERA_RULES.lightsLuma) : null;
	const sunDeg = sunElevationDeg(spec.lat, spec.lon, at);
	return {
		hash: dhash(image),
		lumaMean: whole.mean,
		lumaSd: whole.sd,
		lightsMean: lights?.mean ?? null,
		lightsBright: lights?.bright ?? null,
		sunDeg,
		night: sunDeg <= CAMERA_RULES.nightSunDeg,
	};
}

/** Reduce to at most 480 px wide, keeping the aspect. */
function reduce(image: Rgba): Rgba {
	const w = Math.min(CAMERA_RULES.stillWidth, image.width);
	return downscale(image, w, Math.max(1, Math.round((image.height * w) / image.width)));
}

function store(
	spec: CameraSpec,
	image: Rgba,
	at: number,
	ctx: FetchContext,
): { key: string; width: number; height: number } {
	const jpeg = encodeJpeg(image, CAMERA_RULES.jpegQuality);
	const name = `c${Bun.hash(spec.id).toString(36)}-${Math.floor(at / MIN).toString(36)}`;
	const key = blobKey(name, jpeg, PIPELINE_VERSION);
	ctx.blobs?.put(key, jpeg, {
		name,
		contentType: "image/jpeg",
		observedAt: at,
		width: image.width,
		height: image.height,
	});
	return { key, width: image.width, height: image.height };
}

const failed = (spec: CameraSpec, at: number, reason: string, bytes: number, ms: number): Record_ => ({
	camera: spec.id,
	at,
	blob: null,
	width: null,
	height: null,
	reason,
	sourceSha: null,
	hash: null,
	lumaMean: null,
	lumaSd: null,
	lightsMean: null,
	lightsBright: null,
	sunDeg: sunElevationDeg(spec.lat, spec.lon, at),
	night: sunElevationDeg(spec.lat, spec.lon, at) <= CAMERA_RULES.nightSunDeg,
	sourceTime: null,
	bytes,
	ms,
});

function reasonOf(error: unknown): string {
	if (error instanceof HttpError) return grabReason(error);
	if (error instanceof Error && /image|PNG|JPEG|large|SOI|marker|decode/i.test(error.message))
		return "not-image";
	return grabReason(error);
}

/** One still of one camera, by how its operator publishes it. */
export async function stillOf(spec: CameraSpec, ctx: FetchContext): Promise<Record_> {
	const t0 = performance.now();
	const ms = () => Math.round(performance.now() - t0);
	const at = ctx.now();
	if (!ctx.blobs) return failed(spec, at, "no-store", 0, 0);
	const access = spec.access;
	try {
		if (access.type === "jpeg") {
			const res = await publicRequest(
				ctx.http,
				access.url,
				{
					binary: true,
					maxBytes: 6 * 1024 * 1024,
					timeoutMs: 20_000,
					retries: 0,
					hostGapMs: 2_000,
					headers: { accept: "image/jpeg,image/png;q=0.9" },
					signal: ctx.signal,
				},
				ctx.now,
			);
			const source = new Uint8Array(Buffer.from(res.body, "base64"));
			if (!sniffImage(source)) return failed(spec, at, "not-image", source.byteLength, ms());
			const image = reduce(decodeImage(source));
			const readAt = ctx.now();
			const modified = res.lastModified ? Date.parse(res.lastModified) : Number.NaN;
			const sourceTime =
				Number.isFinite(modified) && modified <= readAt + 2 * MIN ? Math.min(modified, readAt) : null;
			const blob = store(spec, image, readAt, ctx);
			return {
				camera: spec.id,
				at: readAt,
				blob: blob.key,
				width: blob.width,
				height: blob.height,
				reason: null,
				sourceSha: sha16(source),
				...measure(spec, image, readAt),
				sourceTime,
				bytes: source.byteLength,
				ms: ms(),
			};
		}
		if (access.type === "hls") {
			const decoder = findDecoder();
			if (!decoder) return failed(spec, at, "no-decoder", 0, ms());
			const grab = await grabKeyframe(access.url, `cam:${spec.id}`, ctx);
			if (!grab.ok) return failed(spec, at, grab.reason, grab.bytes, ms());
			const decoded = await decodeKeyframe(decoder, grab.annexB, CAMERA_RULES.stillWidth, ctx.signal);
			if (!decoded.ok) return failed(spec, grab.at, decoded.reason, grab.bytes, ms());
			const blob = store(spec, decoded.image, grab.at, ctx);
			return {
				camera: spec.id,
				at: grab.at,
				blob: blob.key,
				width: blob.width,
				height: blob.height,
				reason: null,
				sourceSha: sha16(grab.annexB),
				...measure(spec, decoded.image, grab.at),
				sourceTime: null,
				bytes: grab.bytes,
				ms: ms(),
			};
		}
		return failed(spec, at, "no-stills", 0, 0);
	} catch (error) {
		if (ctx.signal.aborted) throw error;
		return failed(spec, at, reasonOf(error), 0, ms());
	}
}

const Still = z.object({
	camera: z.string().min(1),
	at: z.number(),
	blob: z
		.string()
		.regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)
		.nullable(),
	width: z.number().int().positive().max(CAMERA_RULES.stillWidth).nullable(),
	height: z.number().int().positive().max(2_000).nullable(),
	reason: z.string().max(40).nullable(),
	sourceSha: z
		.string()
		.regex(/^[0-9a-f]{16}$/)
		.nullable(),
	hash: z
		.string()
		.regex(/^[0-9a-f]{16}$/)
		.nullable(),
	lumaMean: z.number().min(0).max(255).nullable(),
	lumaSd: z.number().min(0).nullable(),
	lightsMean: z.number().min(0).max(255).nullable(),
	lightsBright: z.number().min(0).max(1).nullable(),
	sunDeg: z.number().min(-90).max(90),
	night: z.boolean(),
	sourceTime: z.number().nullable(),
	bytes: z.number().int().nonnegative(),
	ms: z.number().nonnegative(),
});

export const publicCams: Adapter<CameraStill> = {
	id: "public-cams",
	layer: "society",
	name: { es: "Cámaras públicas: imagen fija de cada cámara", en: "Public cameras: a still of each camera" },
	provider: "Cada operador de cámara (su publicación abierta), imagen fija tomada por Vigía",
	homepage: "https://vigia.live/fuentes",
	licence: PUBLIC_CAMS_LICENCE,
	keys: [],
	note: {
		es:
			"Vigía toma una imagen fija de cada cámara pública del censo a su ritmo (cada 10 a 60 min), la reduce a 480 px " +
			"y la guarda 3 días. Los operadores (el aeropuerto de Charallave, Breathe-IT en Bonaire) la publican sin " +
			"términos de uso escritos. Medido: unos 118 MB al día. Apágala si prefieres ahorrar datos.",
		en:
			"Vigía takes a still of each public camera in the census at its own pace (every 10 to 60 min), shrinks it to " +
			"480 px and keeps it 3 days. The operators (Charallave airport, Breathe-IT in Bonaire) publish them with no " +
			"written terms of use. Measured: about 118 MB a day. Turn it off to save data.",
	},
	// The shortest camera cadence; each camera is taken at its own (stillEveryMs).
	intervalMs: 10 * MIN,
	freshness: { fetchMs: 45 * MIN, dataMs: 45 * MIN },
	// Three days of stills for the time machine; the numbers (brightness baselines) are kept with the observations.
	blobs: { maxEntries: 12_000, maxBytes: 320 * 1024 * 1024, maxAgeMs: 3 * 24 * 3_600_000 },

	async fetch(ctx) {
		const now = ctx.now();
		const due = stillCameras().filter((c) => now - (lastTried.get(c.id) ?? 0) >= c.stillEveryMs - MIN);
		const records = await pool(
			due,
			3,
			async (spec) => {
				lastTried.set(spec.id, ctx.now());
				return stillOf(spec, ctx);
			},
			ctx.signal,
		);
		return records.map(
			(r): RawResponse => ({
				url: `public-cams:${r.camera}`,
				status: 200,
				contentType: STILL_CONTENT_TYPE,
				body: JSON.stringify(r),
				fetchedAt: ctx.now(),
			}),
		);
	},

	normalise(raws) {
		const out: Observation<CameraStill>[] = [];
		let records = 0;
		for (const raw of raws) {
			if (raw.contentType !== STILL_CONTENT_TYPE) continue;
			records++;
			let json: unknown;
			try {
				json = JSON.parse(raw.body);
			} catch {
				continue;
			}
			const p = Still.safeParse(json);
			if (!p.success) continue;
			const { at, ...value } = p.data;
			const spec = CAMERAS.find((c) => c.id === value.camera);
			if (!spec) continue;
			out.push({
				source: "public-cams",
				series: `cam:${spec.id}`,
				sourceUrl: spec.page,
				fetchedAt: raw.fetchedAt,
				observedAt: Math.min(at, raw.fetchedAt),
				licence: PUBLIC_CAMS_LICENCE.id,
				value,
				location: { lat: spec.lat, lon: spec.lon },
				confidence: 1,
				basis: "measurement",
			});
		}
		if (records > 0 && out.length === 0) throw new SchemaError("Cámaras: ningún registro válido");
		return out;
	},
};
