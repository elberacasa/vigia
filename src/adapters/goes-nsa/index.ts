import { type BlobSink, blobKey } from "../../core/blobs.ts";
import type { Adapter, FetchContext, Observation, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { type Bounds, VENEZUELA_FRAME } from "../../imaging/frame.ts";
import { jpegSize } from "../../imaging/jpeg.ts";
import { PUBLIC_DOMAIN_NOAA } from "../../sources/licences.ts";
import { type Lighting, lighting, OUTPUT, PIPELINE_VERSION, renderFrame, SOURCE } from "./frame.ts";

/**
 * GOES-19 ABI GeoColor, NOAA/NESDIS STAR's "nsa" (northern South America) sector: a frame every 10 minutes,
 * public domain. Each new frame is downloaded once (1800×1080, ≈1.3 MB), reprojected to the Venezuela
 * lon/lat frame and stored as a ≈40 KB JPEG (`frame.ts`); the last 24 frames (4 h) make the loop.
 *
 * Frame names are the scan start, `YYYYDDDHHMM` UTC, on a 10-minute cadence (ABI mode 6), and appear on the
 * CDN about 15 minutes after the scan starts. Instead of the 1.1 MB directory listing, each run asks for the
 * expected names newest first and stops at what it already has; a 404 on a recent slot means "not uploaded
 * yet", on a slot older than an hour "never coming" (an outage; such gaps are real: 21 slots in the week to
 * 2026-09-24). If nothing new appears for 90 minutes (e.g. a change of scan mode), one listing is read.
 *
 * GeoColor at night is infrared clouds over a static city-lights picture: it does not show blackouts.
 */

const BASE = "https://cdn.star.nesdis.noaa.gov/GOES19/ABI/SECTOR/nsa/GEOCOLOR/";
const SIZE = `${SOURCE.width}x${SOURCE.height}`;
const FRAME_RE = new RegExp(`/(\\d{11})_GOES19-ABI-nsa-GEOCOLOR-${SIZE}\\.jpg$`);
const LISTING_RE = new RegExp(`href="(\\d{11})_GOES19-ABI-nsa-GEOCOLOR-${SIZE}\\.jpg"`, "g");
export const SLOT_MS = 10 * 60_000;
export const LOOP_FRAMES = 24;
const GONE_AFTER_MS = 60 * 60_000;
const LISTING_AFTER_MS = 90 * 60_000;

export type GoesFrame = {
	/** Blob key: GET /api/blobs/goes-nsa/<key>. */
	readonly key: string;
	/** Scan start, YYYYDDDHHMM UTC (NOAA's file name). */
	readonly name: string;
	readonly width: number;
	readonly height: number;
	/** Plate carrée bounds of the image (pixel edges). */
	readonly bounds: Bounds;
	readonly lighting: Lighting;
	/** True whenever any part of the frame is at night: the lights there are a fixed layer, not live. */
	readonly staticCityLights: boolean;
	readonly sourceSize: string;
	readonly pipeline: string;
};

/** YYYYDDDHHMM (UTC) for a time. */
export function frameName(at: number): string {
	const d = new Date(at);
	const day = Math.floor((at - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000) + 1;
	const pad = (n: number, w: number) => String(n).padStart(w, "0");
	return `${d.getUTCFullYear()}${pad(day, 3)}${pad(d.getUTCHours(), 2)}${pad(d.getUTCMinutes(), 2)}`;
}

/** Inverse of frameName; null if it is not a valid scan time. */
export function parseFrameName(name: string): number | null {
	const m = /^(\d{4})(\d{3})(\d{2})(\d{2})$/.exec(name);
	if (!m) return null;
	const [year, day, hour, minute] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
	if (day < 1 || day > 366 || hour > 23 || minute > 59) return null;
	const at = Date.UTC(year, 0, 1) + (day - 1) * 86_400_000 + hour * 3_600_000 + minute * 60_000;
	return new Date(at).getUTCFullYear() === year ? at : null;
}

export function frameUrl(name: string): string {
	return `${BASE}${name}_GOES19-ABI-nsa-GEOCOLOR-${SIZE}.jpg`;
}

/** Blob key of a frame: its name plus a hash of the source bytes and the pipeline version. */
export function frameKey(name: string, sourceBase64: string): string {
	return blobKey(name, sourceBase64, PIPELINE_VERSION);
}

/** Expected scan starts, newest first, covering the loop plus two slots of slack. */
export function candidateSlots(now: number): number[] {
	const newest = Math.floor(now / SLOT_MS) * SLOT_MS - SLOT_MS;
	return Array.from({ length: LOOP_FRAMES + 2 }, (_, i) => newest - i * SLOT_MS);
}

/** Frame names in a directory listing, newest first. */
export function namesFromListing(html: string): string[] {
	const names = new Set<string>();
	for (const m of html.matchAll(LISTING_RE)) if (m[1] && parseFrameName(m[1]) !== null) names.add(m[1]);
	return [...names].sort().reverse();
}

/** Slots known not to exist (outages), so they are not asked for every 10 minutes. Process-local. */
const gone = new Map<string, number>();
let lastListingAt = 0;

export const goesNsa: Adapter<GoesFrame> = {
	id: "goes-nsa",
	layer: "earth",
	name: { es: "Satélite GOES-19 (GeoColor)", en: "GOES-19 satellite (GeoColor)" },
	provider: "NOAA/NESDIS/STAR",
	homepage: "https://www.star.nesdis.noaa.gov/GOES/sector.php?sat=G19&sector=nsa",
	licence: PUBLIC_DOMAIN_NOAA,
	keys: [],
	intervalMs: SLOT_MS,
	// A frame is due every 10 min and lands ≈15 min after its scan: 45 min without one is a real gap.
	freshness: { fetchMs: 40 * 60_000, dataMs: 45 * 60_000 },
	blobs: { maxEntries: 36, maxBytes: 16 * 1024 * 1024, maxAgeMs: 24 * 3_600_000 },

	async fetch(ctx) {
		const now = ctx.now();
		for (const [name, at] of gone) if (now - at > 6 * 3_600_000) gone.delete(name);
		const out: RawResponse[] = [];
		const errors: string[] = [];
		const wanted = candidateSlots(now).map((slot) => ({ name: frameName(slot), slot }));
		await fetchFrames(ctx, wanted, now, out, errors);

		const newest = ctx.blobs?.list()[0]?.observedAt ?? 0;
		if (out.length === 0 && now - newest > LISTING_AFTER_MS && now - lastListingAt > 3_600_000) {
			lastListingAt = now;
			const listing = await ctx.http.request(BASE, {
				signal: ctx.signal,
				hostGapMs: 1_000,
				timeoutMs: 30_000,
			});
			// Frames older than the image retention would be evicted as soon as they were stored.
			const maxAge = goesNsa.blobs?.maxAgeMs ?? 0;
			const names = namesFromListing(listing.body)
				.filter((name) => now - (parseFrameName(name) ?? 0) < maxAge)
				.slice(0, LOOP_FRAMES);
			await fetchFrames(
				ctx,
				names.map((name) => ({ name, slot: parseFrameName(name) ?? 0 })),
				now,
				out,
				errors,
			);
		}
		if (out.length === 0 && errors.length > 0) throw new Error(errors[0]);
		return out;
	},

	normalise(raws) {
		const out: Observation<GoesFrame>[] = [];
		let frames = 0;
		for (const raw of raws) {
			const name = FRAME_RE.exec(raw.url)?.[1];
			if (!name || raw.status !== 200) continue;
			frames++;
			const observedAt = parseFrameName(name);
			const size = jpegSize(Buffer.from(raw.body, "base64"));
			// One bad frame is skipped; the rest of the loop stands.
			if (observedAt === null || size?.width !== SOURCE.width || size.height !== SOURCE.height) continue;
			const light = lighting(observedAt);
			out.push({
				source: "goes-nsa",
				series: "geocolor",
				sourceUrl: frameUrl(name),
				fetchedAt: raw.fetchedAt,
				observedAt,
				licence: PUBLIC_DOMAIN_NOAA.id,
				value: {
					key: frameKey(name, raw.body),
					name,
					width: OUTPUT.width,
					height: OUTPUT.height,
					bounds: { ...VENEZUELA_FRAME },
					lighting: light,
					staticCityLights: light !== "day",
					sourceSize: SIZE,
					pipeline: PIPELINE_VERSION,
				},
				confidence: 1,
				basis: "measurement",
			});
		}
		if (frames > 0 && out.length === 0) throw new SchemaError("GOES: no frame was a valid 1800×1080 JPEG");
		return out;
	},
};

async function fetchFrames(
	ctx: FetchContext,
	wanted: readonly { name: string; slot: number }[],
	now: number,
	out: RawResponse[],
	errors: string[],
): Promise<void> {
	const blobs: BlobSink | undefined = ctx.blobs;
	// Done = image stored AND observation stored: if a run died between the two, the frame is fetched again.
	const stored = new Set(blobs?.list().map((m) => m.name));
	const done = (name: string, slot: number) => stored.has(name) && (ctx.seen?.("geocolor", slot) ?? true);
	for (const { name, slot } of wanted) {
		if (done(name, slot) || gone.has(name)) continue;
		let raw: RawResponse;
		try {
			raw = await ctx.http.request(frameUrl(name), {
				binary: true,
				okStatuses: [404],
				maxBytes: 4 * 1024 * 1024,
				hostGapMs: 1_000,
				timeoutMs: 30_000,
				headers: { accept: "image/jpeg" },
				signal: ctx.signal,
			});
		} catch (error) {
			// One failed download must not throw away the frames this run already stored.
			if (ctx.signal.aborted) throw error;
			errors.push(`GOES frame ${name}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		if (raw.status === 404) {
			if (now - slot > GONE_AFTER_MS) gone.set(name, now);
			continue;
		}
		// Without a store (recording a fixture, `vigia fetch`) one frame is enough.
		if (!blobs) {
			out.push(raw);
			return;
		}
		const at = parseFrameName(name);
		try {
			const image = renderFrame(new Uint8Array(Buffer.from(raw.body, "base64")));
			blobs.put(frameKey(name, raw.body), image, {
				name,
				contentType: "image/jpeg",
				observedAt: at ?? now,
				width: OUTPUT.width,
				height: OUTPUT.height,
			});
			stored.add(name);
			out.push(raw);
		} catch (error) {
			// A corrupt frame is not asked for again; the run fails only if nothing else worked.
			gone.set(name, now);
			errors.push(`GOES frame ${name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
