import { z } from "zod";
import type { Adapter, FetchContext, Licence, Observation, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { corsOpen, type HlsState, hlsState } from "../../media/hls.ts";
import { pool, probeHls } from "../../media/probe.ts";
import {
	buildCatalog,
	type CatalogFiles,
	type IptvCatalog,
	type IptvEntry,
	type IptvReason,
} from "./catalog.ts";

/**
 * TV channels of Venezuela from iptv-org's public list, in two feeds:
 *
 * - `iptv-ve` (daily): the directory. iptv-org's API files (channels, feeds, streams, blocklist) read with
 *   conditional GETs, reduced to the streams that concern Venezuela and classified by the rule in catalog.ts (on,
 *   or excluded with the reason: pay channels, relays of cable head-ends, streams that need a spoofed Referer…).
 *   One observation per stream, dated by the list's Last-Modified, so an unchanged list stores nothing new.
 * - `iptv-ve-probe` (every 30 min): is each "on" stream live now? A player's first second without the video
 *   (src/media/probe.ts): playlist, cheapest variant, first 2 KB of the newest segment. Measured 2026-09-28: 59
 *   HTTPS streams in 55 s sequential and 77 KB; the probe runs 6 at a time with every host paced one request at a
 *   time, so a round of ~60 streams costs ~80 KB (~4 MB a day). Never the video itself; the video is only ever
 *   played by the viewer's browser from the broadcaster's server, after a click.
 *
 * Licence: iptv-org's lists are public domain (Unlicense/CC0). The streams belong to each broadcaster; iptv-org
 * lists "links to publicly available video stream URLs", and Vigía never relays or stores any video.
 */

export const IPTV_LICENCE: Licence = {
	id: "iptv-org-unlicense",
	name: "iptv-org (dominio público, Unlicense); la señal es de cada televisora",
	url: "https://github.com/iptv-org/api/blob/master/LICENSE",
	attribution: "Lista de canales: iptv-org (dominio público); cada señal pertenece a su televisora",
	commercial: true,
};

export const TV_PROBE_LICENCE: Licence = {
	id: "vigia-tv-probe-cc0",
	name: "Medición propia de Vigía (CC0); la señal es de cada televisora",
	url: "https://creativecommons.org/publicdomain/zero/1.0/",
	attribution: "Medición: Vigía, desde este equipo; señal de cada televisora",
	commercial: true,
};

const API = "https://iptv-org.github.io/api/";
const FILES = ["channels", "feeds", "streams", "blocklist"] as const;
type FileName = (typeof FILES)[number];
const HOUR = 3_600_000;
/** The probe uses the directory for up to this long before reading the list again itself. */
const CATALOG_MAX_AGE_MS = 36 * HOUR;
const PROBE_CONCURRENCY = 6;

export const PROBE_CONTENT_TYPE = "application/vnd.vigia.hls-probe+json";
const NOT_MODIFIED_TYPE = "application/vnd.vigia.not-modified";

/** The human page for a channel on iptv-org's site. */
export function channelPage(channel: string): string {
	const dot = channel.lastIndexOf(".");
	const country = channel.slice(dot + 1).toLowerCase();
	return `https://iptv-org.github.io/channels/${country}/${encodeURIComponent(channel.slice(0, dot))}`;
}

/** The directory parsed in this process, shared with the probe (one parse a day, not one per probe round). */
let current: { catalog: IptvCatalog; at: number } | null = null;

function filesOf(raws: readonly RawResponse[]): CatalogFiles | null {
	const by = new Map<string, string>();
	for (const raw of raws) {
		const name = FILES.find((f) => raw.url.endsWith(`/${f}.json`));
		if (name && raw.status === 200) by.set(name, raw.body);
	}
	const get = (n: FileName) => by.get(n);
	const channels = get("channels");
	const feeds = get("feeds");
	const streams = get("streams");
	const blocklist = get("blocklist");
	return channels && feeds && streams && blocklist ? { channels, feeds, streams, blocklist } : null;
}

async function readFiles(
	ctx: FetchContext,
	validators: Map<string, { etag?: string; lastModified?: string }> | null,
) {
	const raws: RawResponse[] = [];
	for (const name of FILES) {
		const url = `${API}${name}.json`;
		const v = validators?.get(url);
		const raw = await ctx.http.request(url, {
			headers: {
				accept: "application/json",
				...(v?.etag ? { "if-none-match": v.etag } : {}),
				...(v?.lastModified ? { "if-modified-since": v.lastModified } : {}),
			},
			maxBytes: 32 * 1024 * 1024,
			timeoutMs: 60_000,
			hostGapMs: 1_000,
			okStatuses: v ? [304] : [],
			signal: ctx.signal,
		});
		raws.push(raw);
	}
	return raws;
}

/**
 * The directory, from this process's copy or read afresh without validators (the probe's and the stills' fallback
 * after a restart).
 */
export async function loadCatalog(ctx: FetchContext): Promise<IptvCatalog> {
	if (current && ctx.now() - current.at < CATALOG_MAX_AGE_MS) return current.catalog;
	const files = filesOf(await readFiles(ctx, null));
	if (!files) throw new SchemaError("iptv-org: faltan archivos de la lista");
	const catalog = buildCatalog(files);
	current = { catalog, at: ctx.now() };
	return catalog;
}

export function listObservations(
	catalog: IptvCatalog,
	observedAt: number,
	fetchedAt: number,
): Observation<IptvEntry>[] {
	return catalog.entries.map((entry) => ({
		source: "iptv-ve",
		series: `iptv:${entry.key}`,
		sourceUrl: channelPage(entry.channel),
		fetchedAt,
		observedAt: Math.min(observedAt, fetchedAt),
		licence: IPTV_LICENCE.id,
		value: entry,
		confidence: 1,
		basis: "report",
	}));
}

const validators = new Map<string, { etag?: string; lastModified?: string }>();

export const iptvVe: Adapter<IptvEntry> = {
	id: "iptv-ve",
	layer: "news",
	name: {
		es: "TV en vivo: directorio de canales venezolanos (iptv-org)",
		en: "Live TV: directory of Venezuelan channels (iptv-org)",
	},
	provider: "iptv-org (lista pública de señales)",
	homepage: "https://github.com/iptv-org/iptv",
	licence: IPTV_LICENCE,
	keys: [],
	// The list is rebuilt once a day (~00:20 UTC measured); read twice a day with validators (a 304 costs nothing).
	intervalMs: 12 * HOUR,
	freshness: { fetchMs: 3 * 24 * HOUR, dataMs: 8 * 24 * HOUR },

	async fetch(ctx) {
		let raws = await readFiles(ctx, validators);
		if (raws.every((r) => r.status === 304)) {
			return [
				{
					url: `${API}streams.json`,
					status: 304,
					contentType: NOT_MODIFIED_TYPE,
					body: "",
					fetchedAt: ctx.now(),
				},
			];
		}
		// Some changed, some did not: the directory needs all four, so read the unchanged ones again in full.
		if (raws.some((r) => r.status === 304)) raws = await readFiles(ctx, null);
		const files = filesOf(raws);
		if (files) {
			current = { catalog: buildCatalog(files), at: ctx.now() };
			validators.clear();
			for (const r of raws) {
				if (r.etag || r.lastModified)
					validators.set(r.url, {
						...(r.etag ? { etag: r.etag } : {}),
						...(r.lastModified ? { lastModified: r.lastModified } : {}),
					});
			}
		}
		return raws;
	},

	normalise(raws) {
		if (raws.length === 1 && raws[0]?.status === 304) return [];
		const files = filesOf(raws);
		if (!files) throw new SchemaError("iptv-org: faltan archivos de la lista");
		const streams = raws.find((r) => r.url.endsWith("/streams.json"));
		const fetchedAt = streams?.fetchedAt ?? 0;
		const modified = streams?.lastModified ? Date.parse(streams.lastModified) : Number.NaN;
		return listObservations(buildCatalog(files), Number.isFinite(modified) ? modified : fetchedAt, fetchedAt);
	},
};

/** The probe's reading of one stream. */
export type TvReading = {
	readonly key: string;
	readonly channel: string;
	readonly state: HlsState;
	/** Why not live: "http-404", "ended", "segment-not-media", "stale-playlist", "timeout"… */
	readonly reason: string | null;
	/** Every response allowed any origin (hls.js can play it inside the page). */
	readonly cors: boolean;
	/** Origins a player fetches from (for the page's Content-Security-Policy). */
	readonly origins: string[];
	readonly https: boolean;
	readonly segmentKind: string | null;
	readonly programDateAgeMs: number | null;
	/** Bytes read by the probe, all steps. */
	readonly bytes: number;
	/** Time for the whole probe from this computer. */
	readonly ms: number;
};

const Step = z.object({
	role: z.enum(["playlist", "variant", "segment"]),
	origin: z.string(),
	httpStatus: z.number().int().nullable(),
	bytes: z.number().int().nonnegative(),
	acao: z.string().nullable(),
});
const ProbeRecord = z.object({
	key: z.string().min(1),
	channel: z.string().min(1),
	website: z.string().nullable(),
	probe: z.object({
		url: z.string().min(8),
		at: z.number(),
		steps: z.array(Step),
		error: z.string().nullable(),
		playlist: z.enum(["master", "media", "invalid"]).nullable(),
		ended: z.boolean(),
		segments: z.number().int().nonnegative(),
		segmentKind: z.enum(["ts", "fmp4", "aac", "mp3", "id3", "unknown"]).nullable(),
		targetDurationS: z.number().nullable(),
		programDateAgeMs: z.number().nullable(),
		origins: z.array(z.string()),
		ms: z.number().nonnegative(),
	}),
});

export const iptvVeProbe: Adapter<TvReading> = {
	id: "iptv-ve-probe",
	layer: "news",
	name: {
		es: "TV en vivo: ¿emite ahora? (directorio iptv-org)",
		en: "Live TV: on air now? (iptv-org directory)",
	},
	provider: "Cada televisora (sus servidores), medido por Vigía",
	homepage: "https://github.com/iptv-org/iptv",
	licence: TV_PROBE_LICENCE,
	keys: [],
	intervalMs: 30 * 60_000,
	freshness: { fetchMs: 90 * 60_000, dataMs: 90 * 60_000 },

	async fetch(ctx) {
		const catalog = await loadCatalog(ctx);
		const on = catalog.entries.filter((e) => e.status === "on");
		const records = await pool(
			on,
			PROBE_CONCURRENCY,
			async (entry) => ({ entry, probe: await probeHls(entry.url, ctx) }),
			ctx.signal,
		);
		return records.map(({ entry, probe }) => ({
			url: entry.url,
			status: 200,
			contentType: PROBE_CONTENT_TYPE,
			body: JSON.stringify({ key: entry.key, channel: entry.channel, website: entry.website, probe }),
			fetchedAt: ctx.now(),
		}));
	},

	normalise(raws) {
		const out: Observation<TvReading>[] = [];
		for (const raw of raws) {
			if (raw.contentType !== PROBE_CONTENT_TYPE) continue;
			let json: unknown;
			try {
				json = JSON.parse(raw.body);
			} catch {
				continue;
			}
			const parsed = ProbeRecord.safeParse(json);
			if (!parsed.success) continue;
			const { key, channel, website, probe } = parsed.data;
			const { state, reason } = hlsState(probe);
			out.push({
				source: "iptv-ve-probe",
				series: `tv:${key}`,
				sourceUrl: website && /^https?:\/\//.test(website) ? website : channelPage(channel),
				fetchedAt: raw.fetchedAt,
				observedAt: Math.min(probe.at, raw.fetchedAt),
				licence: TV_PROBE_LICENCE.id,
				value: {
					key,
					channel,
					state,
					reason,
					cors: corsOpen(probe),
					origins: probe.origins,
					https: probe.url.startsWith("https://"),
					segmentKind: probe.segmentKind,
					programDateAgeMs: probe.programDateAgeMs,
					bytes: probe.steps.reduce((n, s) => n + s.bytes, 0),
					ms: Math.round(probe.ms),
				},
				confidence: 1,
				basis: "measurement",
			});
		}
		if (raws.length > 0 && out.length === 0) throw new SchemaError("TV en vivo: ningún registro válido");
		return out;
	},
};

export type { IptvEntry, IptvReason };
