import { z } from "zod";
import type { Adapter, FetchContext, Licence, Observation, RawResponse } from "../../core/types.ts";
import { HttpError, SchemaError } from "../../core/types.ts";
import { RADIO_STATIONS, type RadioStation } from "./stations.ts";

/**
 * Is each radio station's official online stream sending audio right now? Every 10 minutes Vigía tunes in for
 * a moment, like a listener's player: one GET of the stream, reading only its first 16 KB (about one second of
 * audio), then hangs up. It records the HTTP status, the declared content type, how many bytes came, and whether
 * those bytes carry audio frames (an MP3/AAC frame sync, an ID3 tag or an Ogg page), so an error page served as
 * 200 is not mistaken for a broadcast.
 *
 * "Sends audio" is what is measured: not what is on air, and not whether a program is live rather than a
 * recording or a relay. Measured from this computer; a stream may answer here and not in Venezuela, or the
 * other way round.
 *
 * One synthetic record per station (`application/vnd.vigia.radio-probe+json`): the probe's own reading,
 * replayed by tests like any fixture. Licence: our own measurement (CC0); the audio itself belongs to each
 * station and is only ever played from its own server in the listener's browser, never relayed.
 */

export const RADIO_PROBE_LICENCE: Licence = {
	id: "vigia-radio-probe-cc0",
	name: "Medición propia de Vigía (CC0); el audio es de cada emisora",
	url: "https://creativecommons.org/publicdomain/zero/1.0/",
	attribution: "Medición: Vigía, desde este equipo; audio de cada emisora",
	commercial: true,
};

export const PROBE_CONTENT_TYPE = "application/vnd.vigia.radio-probe+json";
/** About one second of a 128 kb/s stream. */
export const PROBE_BYTES = 16 * 1024;
/** Fewer bytes than this in the first seconds is not a stream that is playing. */
const MIN_AUDIO_BYTES = 4 * 1024;
const TIMEOUT_MS = 12_000;

export type RadioProbe = {
	readonly station: string;
	readonly at: number;
	readonly httpStatus: number | null;
	readonly contentType: string | null;
	readonly bytes: number;
	readonly audioFrames: boolean;
	readonly ms: number;
	readonly error: string | null;
};

/** An MPEG audio frame header or an ADTS (AAC) header at `i`. */
function frameHeaderAt(bytes: Uint8Array, i: number): boolean {
	const b1 = bytes[i + 1] ?? 0;
	const b2 = bytes[i + 2] ?? 0;
	if (bytes[i] !== 0xff || (b1 & 0xe0) !== 0xe0) return false;
	// ADTS: 12 sync bits, then layer 00.
	if ((b1 & 0xf6) === 0xf0) return true;
	// MPEG audio: version not reserved (01), layer not reserved (00), bitrate index not 1111, sample rate not 11.
	return ((b1 >> 3) & 3) !== 1 && ((b1 >> 1) & 3) !== 0 && b2 >> 4 !== 0xf && ((b2 >> 2) & 3) !== 3;
}

/**
 * Pure: whether the first bytes look like compressed audio: an ID3 tag, an Ogg page, or (a stream is usually
 * joined mid-frame) at least three MPEG/ADTS frame headers. Text never has a 0xFF byte, so an HTML error page
 * served as 200 fails.
 */
export function hasAudioFrames(bytes: Uint8Array): boolean {
	if (bytes.length < 4) return false;
	const tag = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
	if (tag.startsWith("ID3") || tag === "OggS") return true;
	let headers = 0;
	for (let i = 0; i + 2 < bytes.length; i++) {
		if (frameHeaderAt(bytes, i) && ++headers >= 3) return true;
	}
	return false;
}

function failure(error: unknown): string {
	if (error instanceof HttpError && error.status > 0) return `http-${error.status}`;
	const text = error instanceof Error ? error.message : String(error);
	if (/timed? ?out|timeout|abort/i.test(text)) return "timeout";
	if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|DNS/i.test(text)) return "dns";
	if (/ECONNREFUSED|refused/i.test(text)) return "refused";
	if (/certificate|TLS|SSL/i.test(text)) return "tls";
	return "network";
}

async function probe(station: RadioStation, ctx: FetchContext): Promise<RadioProbe> {
	const at = ctx.now();
	const t0 = performance.now();
	try {
		const res = await ctx.http.request(station.streamUrl, {
			headers: { accept: "audio/*;q=1, */*;q=0.1", "icy-metadata": "0" },
			readBytes: PROBE_BYTES,
			binary: true,
			retries: 0,
			timeoutMs: TIMEOUT_MS,
			hostGapMs: 2_000,
			signal: ctx.signal,
		});
		const bytes = Buffer.from(res.body, "base64");
		return {
			station: station.id,
			at,
			httpStatus: res.status,
			contentType: res.contentType.slice(0, 80) || null,
			bytes: bytes.byteLength,
			audioFrames: hasAudioFrames(bytes),
			ms: Math.round(performance.now() - t0),
			error: null,
		};
	} catch (error) {
		return {
			station: station.id,
			at,
			httpStatus: error instanceof HttpError && error.status > 0 ? error.status : null,
			contentType: null,
			bytes: 0,
			audioFrames: false,
			ms: Math.round(performance.now() - t0),
			error: failure(error),
		};
	}
}

export type RadioState = "audio" | "not-audio" | "no-answer";

export type RadioReading = {
	readonly station: string;
	readonly state: RadioState;
	readonly httpStatus: number | null;
	readonly contentType: string | null;
	readonly bytes: number;
	/** Time to the first 16 KB (or to the failure), from this computer. */
	readonly ms: number;
	readonly error: string | null;
};

/** Pure: the stated rule. Audio = HTTP 2xx, an audio content type, ≥ 4 KB, and audio frames in the bytes. */
export function radioState(p: RadioProbe): RadioState {
	if (p.error !== null || p.httpStatus === null) return "no-answer";
	const type = (p.contentType ?? "").toLowerCase();
	const audioType = type.startsWith("audio/") || type.startsWith("application/ogg");
	if (p.httpStatus >= 200 && p.httpStatus < 300 && audioType && p.bytes >= MIN_AUDIO_BYTES && p.audioFrames)
		return "audio";
	return "not-audio";
}

const Probe = z.object({
	station: z.string(),
	at: z.number(),
	httpStatus: z.number().int().nullable(),
	contentType: z.string().nullable(),
	bytes: z.number().int().nonnegative(),
	audioFrames: z.boolean(),
	ms: z.number().nonnegative(),
	error: z.string().nullable(),
});

export const radioStreams: Adapter<RadioReading> = {
	id: "radio-streams",
	layer: "news",
	name: {
		es: "Radio en vivo: ¿emite ahora? (señales oficiales en internet)",
		en: "Live radio: on air now? (official online streams)",
	},
	provider: "Emisoras (sus propios servidores), medido por Vigía",
	homepage: "https://www.radiofeyalegrianoticias.com/",
	licence: RADIO_PROBE_LICENCE,
	keys: [],
	intervalMs: 10 * 60_000,
	freshness: { fetchMs: 30 * 60_000, dataMs: 30 * 60_000 },

	async fetch(ctx) {
		const out: RawResponse[] = [];
		for (const station of RADIO_STATIONS) {
			if (ctx.signal.aborted) break;
			const record = await probe(station, ctx);
			out.push({
				url: station.streamUrl,
				status: 200,
				contentType: PROBE_CONTENT_TYPE,
				body: JSON.stringify(record),
				fetchedAt: ctx.now(),
			});
		}
		return out;
	},

	normalise(raws) {
		const out: Observation<RadioReading>[] = [];
		for (const raw of raws) {
			if (raw.contentType !== PROBE_CONTENT_TYPE) continue;
			let json: unknown;
			try {
				json = JSON.parse(raw.body);
			} catch {
				continue;
			}
			const parsed = Probe.safeParse(json);
			if (!parsed.success) continue;
			const p = parsed.data;
			const station = RADIO_STATIONS.find((s) => s.id === p.station);
			if (!station) continue;
			out.push({
				source: "radio-streams",
				series: `radio:${station.id}`,
				sourceUrl: station.homepage,
				fetchedAt: raw.fetchedAt,
				observedAt: Math.min(p.at, raw.fetchedAt),
				licence: RADIO_PROBE_LICENCE.id,
				value: {
					station: station.id,
					state: radioState(p),
					httpStatus: p.httpStatus,
					contentType: p.contentType,
					bytes: p.bytes,
					ms: Math.round(p.ms),
					error: p.error,
				},
				confidence: 1,
				basis: "measurement",
			});
		}
		if (raws.length > 0 && out.length === 0) throw new SchemaError("Radio en vivo: ningún registro válido");
		return out;
	},
};
