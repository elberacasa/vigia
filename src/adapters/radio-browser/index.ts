import { z } from "zod";
import type { Adapter, FetchContext, Licence, Observation, RawResponse } from "../../core/types.ts";
import { HttpError, SchemaError } from "../../core/types.ts";
import { states as allStates, locate } from "../../geo/index.ts";
import { corsOpen, hlsState } from "../../media/hls.ts";
import { type AudioProbe, pool, probeAudio, probeHls } from "../../media/probe.ts";
import { plainlyPrivateUrl } from "../../media/public-host.ts";
import { tagPlaces } from "../../news/places.ts";
import { normalize } from "../../news/text.ts";
import { radioState } from "../radio-streams/index.ts";

/**
 * Venezuelan radio stations from Radio Browser (radio-browser.info), a community directory of internet radio
 * streams with a free, open API, in two feeds:
 *
 * - `radio-browser` (daily): the directory. The API etiquette is followed: a speaking User-Agent (the project's), a
 *   server picked at random from the list the API publishes (`all.api.radio-browser.info/json/servers`), the next one
 *   on failure. One request: `/json/stations/bycountrycodeexact/VE` (254 KB, 203 stations on 2026-09-28; 178 HTTPS).
 *   Radio Browser asks clients to report each listener's click (`/json/url`); Vigía does not, so no listener's action
 *   is sent to a third party.
 * - `radio-browser-probe` (hourly): does each station's stream send audio now? The first 8 KB (about half a second)
 *   then hang up, as `radio-streams` does, or the HLS check for the few HLS stations. Measured 2026-09-28: 183
 *   distinct streams in 18.6 s at 8 at a time, 1.2 MB; 148 sent audio.
 *
 * The directory keeps **broadcasters**: a station whose name carries an AM/FM frequency ("Fiesta 106.5 FM",
 * "Rumbos 670 AM", or a bare FM-band number: "Magic Radio 92.5 Maracay"), a state broadcaster by name, or a station in
 * the curated list below (a real station whose listing names no frequency: KYS FM, Radio María, Tamá Stereo). Internet-only radios are counted, not stored: many are one
 * person's stream (a DJ, a game room), and Vigía never stores private people's names or handles. A name with
 * a handle ("@…", "Ig:") is dropped before anything is stored. A stream served through a third-party proxy of
 * another stream (worldradio.online, onlineradiobox) is excluded as a relay.
 *
 * Licence: Radio Browser's API and data are "completely free and open source" (api.radio-browser.info); no data
 * licence is stated beyond that, attribution given. The audio belongs to each station and is only ever played from
 * the station's own server in the listener's browser, after a click, never relayed.
 */

export const RADIO_BROWSER_LICENCE: Licence = {
	id: "radio-browser-open",
	name: "Radio Browser (API y datos libres y abiertos); el audio es de cada emisora",
	url: "https://api.radio-browser.info/",
	attribution: "Directorio: Radio Browser (radio-browser.info); cada señal pertenece a su emisora",
	commercial: true,
};

export const RADIO_DIR_PROBE_LICENCE: Licence = {
	id: "vigia-radio-dir-probe-cc0",
	name: "Medición propia de Vigía (CC0); el audio es de cada emisora",
	url: "https://creativecommons.org/publicdomain/zero/1.0/",
	attribution: "Medición: Vigía, desde este equipo; audio de cada emisora",
	commercial: true,
};

const HOUR = 3_600_000;
const SERVERS_URL = "https://all.api.radio-browser.info/json/servers";
const STATIONS_PATH = "/json/stations/bycountrycodeexact/VE?hidebroken=false";
const CATALOG_MAX_AGE_MS = 36 * HOUR;
const PROBE_CONCURRENCY = 8;
export const PROBE_CONTENT_TYPE = "application/vnd.vigia.radio-dir-probe+json";

const Station = z.object({
	stationuuid: z.string().uuid(),
	name: z.string(),
	url: z.string().default(""),
	url_resolved: z.string().default(""),
	homepage: z.string().default(""),
	countrycode: z.string(),
	iso_3166_2: z.string().nullable().default(null),
	state: z.string().default(""),
	codec: z.string().default(""),
	bitrate: z.number().default(0),
	hls: z.number().default(0),
	votes: z.number().default(0),
	lastchangetime_iso8601: z.string().nullable().default(null),
	geo_lat: z.number().nullable().default(null),
	geo_long: z.number().nullable().default(null),
});

export type RadioOwnership = "state" | "other";
export type RadioReason = "relay" | "no-stream";

/** One broadcaster in the directory. `type` alias so it is JSON-assignable. */
export type RadioEntry = {
	readonly uuid: string;
	readonly name: string;
	/** "106.5 FM", "670 AM", when the name carries it. */
	readonly frequency: string | null;
	readonly url: string;
	readonly https: boolean;
	readonly hls: boolean;
	readonly homepage: string | null;
	readonly codec: string | null;
	readonly bitrateKbps: number | null;
	readonly states: string[];
	/** How the state was found: Radio Browser's ISO code, its coordinates, its state field, or the station's name. */
	readonly statesFrom: "iso" | "geo" | "state-field" | "name" | "curated" | null;
	/** Kept by Vigía's curated list (the listing names no frequency): the reference that places it on the dial. */
	readonly curatedWhy: string | null;
	readonly ownership: RadioOwnership;
	readonly status: "on" | "excluded";
	readonly reason: RadioReason | null;
	readonly reasonDetail: string | null;
};

/** What the day's list held besides the broadcasters: counts only (see the header). */
export type RadioDirectorySummary = {
	readonly listed: number;
	readonly broadcasters: number;
	readonly webOnly: number;
	readonly withHandle: number;
	readonly duplicates: number;
};

const FREQUENCY = /\b(\d{2,3}[.,]\d)\s?(?:F\.?M\.?|FN)\b|\bFM\s?(\d{2,3}[.,]\d)\b|\b(\d{3,4})\s?AM\b/i;
/** State broadcasters by name or site (RNV, YVKE Mundial, Alba Ciudad, La Radio del Sur, Radio Miraflores, teleSUR). */
const STATE_NAME =
	/Radio Nacional de Venezuela|\bRNV\b|YVKE|Radio Mundial|Alba Ciudad|Radio del Sur|Radio Miraflores|tele\s?SUR|\bVTV\b|FANB/i;
const STATE_HOME =
	/\.gob\.ve\b|albaciudad\.org|laradiodelsur\.com\.ve|radiomiraflores\.net\.ve|radiomundial\.com\.ve|telesur/i;
/** Handles and one-person stations: dropped before storing (no private person is ever stored). */
const PERSONAL = /@|\big\s*:|\bdj\b|highrise\.game/i;
/**
 * Real over-the-air stations whose Radio Browser listing carries no frequency, matched by the listing's homepage host,
 * each with the reference that places it on the dial (read 2026-09-28). Probed like the rest.
 */
export const CURATED_BROADCASTERS: readonly {
	readonly host: string;
	readonly frequency: string;
	readonly state: string;
	readonly why: string;
}[] = [
	{
		host: "kysfm.com",
		frequency: "101.5 FM",
		// Chuao, Caracas: Baruta, estado Miranda.
		state: "VE-M",
		why: "Cámara Venezolana de la Industria de la Radiodifusión (cvir.com.ve/kys-101-5-fm): Kys 101.5 FM, Caracas; es.wikipedia «Circuito Digital Kys»",
	},
	{
		host: "radiomaria.com.ve",
		frequency: "1450 AM",
		state: "VE-A",
		why: "Cámara Venezolana de la Industria de la Radiodifusión (cvir.com.ve/radio-maria-1450-am): Radio María 1450 AM, Caracas",
	},
	{
		host: "tamastereo.com",
		frequency: "103.9 FM",
		state: "VE-S",
		why: "Infoguía Venezuela (infoguia.com, ficha «Tamá Stereo 103.9 Fm») y la cuenta de la emisora en X: Tamá Stereo 103.9 FM, San Cristóbal",
	},
];

function curatedFor(homepage: string) {
	const host = hostOf(homepage).replace(/^www\./, "");
	return CURATED_BROADCASTERS.find((c) => host === c.host) ?? null;
}

/** Third-party proxies re-serving another station's stream. */
const RELAY_HOSTS = /(^|\.)worldradio\.online$|(^|\.)onlineradiobox\.com$/i;

/** A bare number in the FM band with one decimal ("Magic Radio 92.5 Maracay", "Rumba 100.1 Barquisimeto FM"). */
const FM_BAND = /(?<![\d.,])(8[7-9]|9\d|10[0-7])[.,](\d)(?![\d.,])/;

export function frequencyOf(name: string): string | null {
	const m = FREQUENCY.exec(name);
	if (m?.[1] || m?.[2]) return `${(m[1] ?? m[2] ?? "").replace(",", ".")} FM`;
	if (m?.[3]) return `${m[3]} AM`;
	const band = FM_BAND.exec(name);
	return band ? `${band[1]}.${band[2]} FM` : null;
}

const STATE_BY_NAME = new Map(allStates().map((s) => [normalize(s.name), s.iso]));

/** Pure: the station's state, from the most direct evidence available. */
export function stationStates(s: {
	iso_3166_2: string | null;
	geo_lat: number | null;
	geo_long: number | null;
	state: string;
	name: string;
}): { states: string[]; from: RadioEntry["statesFrom"] } {
	const iso = s.iso_3166_2?.trim().toUpperCase() ?? "";
	if (/^VE-[A-Z]$/.test(iso)) return { states: [iso], from: "iso" };
	if (s.geo_lat !== null && s.geo_long !== null) {
		const where = locate(s.geo_lat, s.geo_long);
		if (where.inVenezuela && where.state) return { states: [where.state.iso], from: "geo" };
	}
	const field = normalize(s.state).replace(/^estado /, "");
	const exact = STATE_BY_NAME.get(field);
	if (exact) return { states: [exact], from: "state-field" };
	if (field) {
		const tagged = tagPlaces(s.state, { venezuelanOutlet: true });
		if (tagged.primaryState && tagged.confidence >= 0.75)
			return { states: [tagged.primaryState], from: "state-field" };
	}
	const byName = tagPlaces(s.name, { venezuelanOutlet: true });
	if (byName.primaryState && byName.confidence >= 0.75)
		return { states: [byName.primaryState], from: "name" };
	return { states: [], from: null };
}

function cleanName(name: string): string {
	// UTF-8 read as Latin-1 upstream ("DinÃ¡mica"), control characters (a tab opens one listed name), extra spaces.
	const repaired = /Ã[\u0080-\u00bf]/.test(name) ? Buffer.from(name, "latin1").toString("utf8") : name;
	return repaired
		.replace(/\p{Cc}/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function hostOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return "";
	}
}

export type RadioDirectory = {
	entries: RadioEntry[];
	summary: RadioDirectorySummary;
	version: number | null;
};

/** Pure: Radio Browser's JSON → the broadcasters directory (sorted by name) and the counts of what was left out. */
export function buildDirectory(body: string): RadioDirectory {
	let json: unknown;
	try {
		json = JSON.parse(body);
	} catch {
		throw new SchemaError("Radio Browser: JSON no válido");
	}
	if (!Array.isArray(json) || json.length === 0)
		throw new SchemaError("Radio Browser: se esperaba una lista de emisoras");
	const rows: z.infer<typeof Station>[] = [];
	for (const item of json) {
		const parsed = Station.safeParse(item);
		if (parsed.success && parsed.data.countrycode === "VE") rows.push(parsed.data);
	}
	if (rows.length === 0) throw new SchemaError("Radio Browser: ninguna emisora válida");
	// Most-voted first, so a duplicate stream keeps its best-known listing.
	rows.sort((a, b) => b.votes - a.votes || a.stationuuid.localeCompare(b.stationuuid));
	const seenUrls = new Set<string>();
	const entries: RadioEntry[] = [];
	let webOnly = 0;
	let withHandle = 0;
	let duplicates = 0;
	let version: number | null = null;
	for (const s of rows) {
		const name = cleanName(s.name);
		if (PERSONAL.test(name) || PERSONAL.test(s.homepage)) {
			withHandle++;
			continue;
		}
		const curated = curatedFor(s.homepage);
		const frequency = frequencyOf(name) ?? curated?.frequency ?? null;
		const state = STATE_NAME.test(name) || STATE_HOME.test(s.homepage);
		if (!frequency && !state) {
			webOnly++;
			continue;
		}
		const url = (s.url_resolved || s.url).trim();
		const key = url.toLowerCase();
		if (url && seenUrls.has(key)) {
			duplicates++;
			continue;
		}
		if (url) seenUrls.add(key);
		const changed = s.lastchangetime_iso8601 ? Date.parse(s.lastchangetime_iso8601) : Number.NaN;
		if (Number.isFinite(changed)) version = Math.max(version ?? 0, changed);
		const found = stationStates({ ...s, name });
		const { states, from } =
			found.states.length === 0 && curated ? { states: [curated.state], from: "curated" as const } : found;
		let reason: RadioReason | null = null;
		let detail: string | null = null;
		// Not http(s), or a private or local address (anyone can list a station): never probed (review M7).
		if (!/^https?:\/\//i.test(url) || plainlyPrivateUrl(url)) reason = "no-stream";
		else if (RELAY_HOSTS.test(hostOf(url))) {
			reason = "relay";
			detail = hostOf(url);
		}
		entries.push({
			uuid: s.stationuuid,
			name,
			frequency,
			url,
			https: url.toLowerCase().startsWith("https://"),
			hls: s.hls === 1 || /\.m3u8(\?|$)/i.test(url),
			homepage: /^https?:\/\//i.test(s.homepage) ? s.homepage : null,
			codec: s.codec || null,
			bitrateKbps: s.bitrate > 0 ? s.bitrate : null,
			states,
			statesFrom: from,
			curatedWhy: curated?.why ?? null,
			ownership: state ? "state" : "other",
			status: reason === null ? "on" : "excluded",
			reason,
			reasonDetail: detail,
		});
	}
	entries.sort((a, b) => a.name.localeCompare(b.name, "es") || a.uuid.localeCompare(b.uuid));
	return {
		entries,
		summary: { listed: rows.length, broadcasters: entries.length, webOnly, withHandle, duplicates },
		version,
	};
}

const ServerList = z.array(z.object({ name: z.string().min(3) }));

/** The API's own server list, shuffled (its etiquette: random first choice, the next one on failure). */
async function servers(ctx: FetchContext): Promise<string[]> {
	const raw = await ctx.http.request(SERVERS_URL, {
		headers: { accept: "application/json" },
		signal: ctx.signal,
	});
	let json: unknown = null;
	try {
		json = JSON.parse(raw.body);
	} catch {
		// reported below as an empty list
	}
	const parsed = ServerList.safeParse(json);
	if (!parsed.success || parsed.data.length === 0)
		throw new SchemaError("Radio Browser: lista de servidores vacía");
	const names = [...new Set(parsed.data.map((s) => s.name))];
	for (let i = names.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[names[i], names[j]] = [names[j] as string, names[i] as string];
	}
	return names;
}

async function readStations(ctx: FetchContext): Promise<RawResponse> {
	let last: unknown = null;
	for (const name of await servers(ctx)) {
		try {
			return await ctx.http.request(`https://${name}${STATIONS_PATH}`, {
				headers: { accept: "application/json" },
				maxBytes: 8 * 1024 * 1024,
				signal: ctx.signal,
			});
		} catch (error) {
			last = error;
		}
	}
	throw last instanceof Error
		? last
		: new HttpError("Radio Browser: ningún servidor respondió", 0, SERVERS_URL);
}

let current: { directory: RadioDirectory; at: number } | null = null;

export const radioBrowser: Adapter<RadioEntry | RadioDirectorySummary> = {
	id: "radio-browser",
	layer: "news",
	name: {
		es: "Radio en vivo: directorio de emisoras venezolanas (Radio Browser)",
		en: "Live radio: directory of Venezuelan stations (Radio Browser)",
	},
	provider: "Radio Browser (directorio comunitario de radios)",
	homepage: "https://www.radio-browser.info/",
	licence: RADIO_BROWSER_LICENCE,
	keys: [],
	// Listings change a few times a week; one read a day. No validators are sent by the API.
	intervalMs: 24 * HOUR,
	freshness: { fetchMs: 3 * 24 * HOUR, dataMs: null },

	async fetch(ctx) {
		const raw = await readStations(ctx);
		current = { directory: buildDirectory(raw.body), at: ctx.now() };
		return [raw];
	},

	normalise(raws) {
		const raw = raws[0];
		if (!raw) throw new SchemaError("Radio Browser: sin respuesta");
		const { entries, summary, version } = buildDirectory(raw.body);
		// Dated by the newest listing change, so an unchanged directory stores nothing new.
		const observedAt = Math.min(version ?? raw.fetchedAt, raw.fetchedAt);
		const out: Observation<RadioEntry | RadioDirectorySummary>[] = entries.map((e) => ({
			source: "radio-browser",
			series: `rb:${e.uuid}`,
			sourceUrl: `https://www.radio-browser.info/history/${e.uuid}`,
			fetchedAt: raw.fetchedAt,
			observedAt,
			licence: RADIO_BROWSER_LICENCE.id,
			value: e,
			confidence: 0.9,
			basis: "report",
		}));
		out.push({
			source: "radio-browser",
			series: "rb:summary",
			sourceUrl: "https://www.radio-browser.info/search?page=1&order=clickcount&reverse=true&countrycode=VE",
			fetchedAt: raw.fetchedAt,
			observedAt,
			licence: RADIO_BROWSER_LICENCE.id,
			value: summary,
			confidence: 1,
			basis: "report",
		});
		return out;
	},
};

async function loadDirectory(ctx: FetchContext): Promise<RadioDirectory> {
	if (current && ctx.now() - current.at < CATALOG_MAX_AGE_MS) return current.directory;
	const raw = await readStations(ctx);
	const directory = buildDirectory(raw.body);
	current = { directory, at: ctx.now() };
	return directory;
}

/** The probe's reading of one station. */
export type RadioDirReading = {
	readonly uuid: string;
	readonly kind: "audio" | "hls";
	readonly state: "live" | "not-live" | "no-answer";
	readonly reason: string | null;
	readonly https: boolean;
	/** HLS only: every response allowed any origin. An <audio> element needs no CORS. */
	readonly cors: boolean | null;
	readonly origins: string[];
	readonly contentType: string | null;
	readonly bytes: number;
	readonly ms: number;
};

const AudioRecord = z.object({
	url: z.string(),
	at: z.number(),
	httpStatus: z.number().int().nullable(),
	contentType: z.string().nullable(),
	bytes: z.number().int().nonnegative(),
	audioFrames: z.boolean(),
	origin: z.string(),
	ms: z.number().nonnegative(),
	error: z.string().nullable(),
});
const HlsRecord = z.object({
	url: z.string(),
	at: z.number(),
	steps: z.array(
		z.object({
			role: z.enum(["playlist", "variant", "segment"]),
			origin: z.string(),
			httpStatus: z.number().int().nullable(),
			bytes: z.number().int().nonnegative(),
			acao: z.string().nullable(),
		}),
	),
	error: z.string().nullable(),
	playlist: z.enum(["master", "media", "invalid"]).nullable(),
	ended: z.boolean(),
	segments: z.number().int().nonnegative(),
	segmentKind: z.enum(["ts", "fmp4", "aac", "mp3", "id3", "unknown"]).nullable(),
	targetDurationS: z.number().nullable(),
	programDateAgeMs: z.number().nullable(),
	origins: z.array(z.string()),
	ms: z.number().nonnegative(),
});
const Record_ = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("audio"), uuid: z.string().uuid(), probe: AudioRecord }),
	z.object({ kind: z.literal("hls"), uuid: z.string().uuid(), probe: HlsRecord }),
]);

/** Pure: the radio-streams rule on an 8 KB read (2xx, audio type, ≥ 4 KB, audio frames). */
export function audioReading(p: AudioProbe): { state: RadioDirReading["state"]; reason: string | null } {
	// The server answered with an error status: it is up but not sending this stream.
	if (p.httpStatus !== null && (p.httpStatus < 200 || p.httpStatus >= 300))
		return { state: "not-live", reason: `http-${p.httpStatus}` };
	const s = radioState({ ...p, station: "" });
	if (s === "audio") return { state: "live", reason: null };
	if (s === "no-answer") return { state: "no-answer", reason: p.error ?? "network" };
	return { state: "not-live", reason: p.audioFrames ? "not-audio-type" : "no-audio-frames" };
}

export const radioBrowserProbe: Adapter<RadioDirReading> = {
	id: "radio-browser-probe",
	layer: "news",
	name: {
		es: "Radio en vivo: ¿emite ahora? (directorio Radio Browser)",
		en: "Live radio: on air now? (Radio Browser directory)",
	},
	provider: "Cada emisora (sus servidores), medido por Vigía",
	homepage: "https://www.radio-browser.info/",
	licence: RADIO_DIR_PROBE_LICENCE,
	keys: [],
	// ~150 streams × 8 KB ≈ 1.2 MB a round: hourly keeps it near 30 MB a day.
	intervalMs: HOUR,
	freshness: { fetchMs: 3 * HOUR, dataMs: 3 * HOUR },

	async fetch(ctx) {
		const directory = await loadDirectory(ctx);
		const on = directory.entries.filter((e) => e.status === "on");
		const records = await pool(
			on,
			PROBE_CONCURRENCY,
			async (e) =>
				e.hls
					? { kind: "hls" as const, uuid: e.uuid, probe: await probeHls(e.url, ctx) }
					: { kind: "audio" as const, uuid: e.uuid, probe: await probeAudio(e.url, ctx) },
			ctx.signal,
		);
		return records.map((r) => ({
			url: r.probe.url,
			status: 200,
			contentType: PROBE_CONTENT_TYPE,
			body: JSON.stringify(r),
			fetchedAt: ctx.now(),
		}));
	},

	normalise(raws) {
		const out: Observation<RadioDirReading>[] = [];
		for (const raw of raws) {
			if (raw.contentType !== PROBE_CONTENT_TYPE) continue;
			let json: unknown;
			try {
				json = JSON.parse(raw.body);
			} catch {
				continue;
			}
			const parsed = Record_.safeParse(json);
			if (!parsed.success) continue;
			const r = parsed.data;
			const value: RadioDirReading =
				r.kind === "audio"
					? {
							uuid: r.uuid,
							kind: "audio",
							...audioReading(r.probe),
							https: r.probe.url.startsWith("https://"),
							cors: null,
							origins: [r.probe.origin],
							contentType: r.probe.contentType,
							bytes: r.probe.bytes,
							ms: Math.round(r.probe.ms),
						}
					: {
							uuid: r.uuid,
							kind: "hls",
							...hlsState(r.probe),
							https: r.probe.url.startsWith("https://"),
							cors: corsOpen(r.probe),
							origins: r.probe.origins,
							contentType: null,
							bytes: r.probe.steps.reduce((n, s) => n + s.bytes, 0),
							ms: Math.round(r.probe.ms),
						};
			out.push({
				source: "radio-browser-probe",
				series: `rbp:${r.uuid}`,
				sourceUrl: `https://www.radio-browser.info/history/${r.uuid}`,
				fetchedAt: raw.fetchedAt,
				observedAt: Math.min(r.probe.at, raw.fetchedAt),
				licence: RADIO_DIR_PROBE_LICENCE.id,
				value,
				confidence: 1,
				basis: "measurement",
			});
		}
		if (raws.length > 0 && out.length === 0) throw new SchemaError("Radio en vivo: ningún registro válido");
		return out;
	},
};
