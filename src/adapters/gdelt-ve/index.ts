import type { Adapter, FetchContext, GeoPoint, Licence, Observation, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { ZipReader } from "../../formats/zip.ts";
import ambiguousJson from "../../geo/data/ambiguous.json" with { type: "json" };
import { locate } from "../../geo/index.ts";
import { normalize } from "../../news/text.ts";

/**
 * GDELT 2.0 event files, reduced to events GDELT places in Venezuela.
 *
 * GDELT reads world news and machine-codes "who did what to whom, where" (CAMEO), publishing every 15 minutes a
 * zipped table of new events: English-language sources (`lastupdate.txt`) and machine-translated sources in 65
 * languages, Spanish among them (`lastupdate-translation.txt`). The DOC API answered 429 to every request from this
 * machine (2026-09-24); the raw files are static objects on Google Cloud Storage and answer normally.
 *
 * Measured 2026-09-28/29 over 24 hours (96 + 96 batches; 4 translated files were still 404 when asked, some arrive
 * about an hour late):
 * 11.7 MB of zips a day (6.5 MB English, 5.2 MB translated; ~60 KB per 15-min file), 165,219 events worldwide,
 * 1,100 with ActionGeo in Venezuela (242 English, 858 translated), 424 distinct source articles. So: every 15 min,
 * the newest batch of each stream; missed batches of the last 6 hours are backfilled, 8 per stream per run.
 * The mentions and GKG files are not read (GKG is 3.9–5 MB per 15 min).
 *
 * What is kept: for each batch, counts (by state, CAMEO root, QuadClass); for each source article, its events'
 * codes, tone, place and link. Never actor names: GDELT's actors can be private people.
 *
 * Geography (measured on the same day): 389 events are country-level ("Venezuela", no state); for the rest the point
 * is placed with Vigía's own state boundaries (src/geo), which agreed with GDELT's ADM1 code on every in-country
 * point. A point outside the boundaries falls back to the ADM1 code (FIPS 10-4); 17 events coded VE00 with a point in
 * Brazil stay unplaced. **Homonyms:** GDELT placed 131 events in "Valencia, Carabobo", nearly all Spanish outlets
 * writing about Valencia, Spain. An event is dropped (and counted as such) when its place is one of the gazetteer's
 * curated foreign homonyms (Valencia, Mérida, Barcelona, Trujillo…), its source is not a .ve site, and its link does
 * not mention Venezuela: 128 dropped that day, Carabobo went from 131 events to 4. After the rule: 972 events, 406
 * without a state, 367 articles.
 *
 * These are machine-coded news reports, not verified events: counts say how much the world's press wrote about
 * something happening in a place, labelled as GDELT's automatic coding.
 *
 * Licence: GDELT's data is "100% free and open" for "unlimited and unrestricted use for any academic, commercial, or
 * governmental use of any kind", with citation (gdeltproject.org/about.html#termsofuse).
 */

export const GDELT_LICENCE: Licence = {
	id: "gdelt-open",
	name: "GDELT Project (uso libre con cita)",
	url: "https://www.gdeltproject.org/about.html#termsofuse",
	attribution: "The GDELT Project (gdeltproject.org), codificación automática de noticias",
	commercial: true,
};

const BASE = "https://data.gdeltproject.org/gdeltv2/";
const STREAMS = { en: "lastupdate.txt", tr: "lastupdate-translation.txt" } as const;
export type GdeltStream = keyof typeof STREAMS;
const QUARTER = 15 * 60_000;
/** How far back a missed batch is fetched. */
const BACKFILL_MS = 6 * 3_600_000;
const MAX_PER_STREAM = 8;
const MISSING_AFTER_MS = 3 * 3_600_000;
export const ZIP_CONTENT = "application/zip";

/** GDELT 2.0 event table columns used (0-based, of 61). */
const COL = {
	id: 0,
	rootCode: 28,
	quadClass: 29,
	goldstein: 30,
	numArticles: 33,
	avgTone: 34,
	geoType: 51,
	geoName: 52,
	country: 53,
	adm1: 54,
	lat: 56,
	lon: 57,
	dateAdded: 59,
	url: 60,
} as const;

/** FIPS 10-4 first-order divisions of Venezuela (GDELT's ADM1 codes) to ISO 3166-2; checked against point-in-polygon. */
export const FIPS_VE: Readonly<Record<string, string>> = {
	VE01: "VE-Z",
	VE02: "VE-B",
	VE03: "VE-C",
	VE04: "VE-D",
	VE05: "VE-E",
	VE06: "VE-F",
	VE07: "VE-G",
	VE08: "VE-H",
	VE09: "VE-Y",
	VE11: "VE-I",
	VE12: "VE-J",
	VE13: "VE-K",
	VE14: "VE-L",
	VE15: "VE-M",
	VE16: "VE-N",
	VE17: "VE-O",
	VE18: "VE-P",
	VE19: "VE-R",
	VE20: "VE-S",
	VE21: "VE-T",
	VE22: "VE-U",
	VE23: "VE-V",
	VE24: "VE-W",
	VE25: "VE-A",
	VE26: "VE-X",
};

/** The gazetteer's curated places that are also well-known places abroad (src/geo/data/ambiguous.json). */
const FOREIGN_HOMONYMS: ReadonlySet<string> = new Set(
	(ambiguousJson as { terms: { normalized: string; types: string[] }[] }).terms
		.filter((t) => t.types.includes("foreign_homonym"))
		.map((t) => t.normalized),
);

/** Batch time from a GDELT file name: `20260929014500.export.CSV.zip` → epoch ms (UTC). */
export function batchTime(url: string): number | null {
	const m = /\/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(?:translation\.)?export\.CSV\.zip$/i.exec(url);
	if (!m) return null;
	const [, y, mo, d, h, mi, s] = m;
	return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

function stamp(t: number): string {
	return new Date(t).toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

export function exportUrl(stream: GdeltStream, t: number): string {
	return `${BASE}${stamp(t)}.${stream === "tr" ? "translation." : ""}export.CSV.zip`;
}

/** Pure: the export file named in a lastupdate.txt (three lines: size, md5, URL). */
export function parseLastUpdate(body: string): { url: string; at: number } | null {
	for (const line of body.split(/\r?\n/)) {
		const url = line.trim().split(/\s+/)[2];
		if (!url || !/\.export\.CSV\.zip$/i.test(url)) continue;
		const at = batchTime(url);
		if (at !== null) return { url: url.replace(/^http:/, "https:"), at };
	}
	return null;
}

export type GdeltBatch = {
	readonly stream: GdeltStream;
	/** GDELT's file still answered 404 three hours after its time (translated files can arrive an hour late). */
	readonly missing: boolean;
	/** Events in the whole file (worldwide). */
	readonly rows: number;
	/** Events placed in Venezuela and kept. */
	readonly events: number;
	/** Placed in Venezuela by GDELT but dropped as a likely foreign homonym. */
	readonly droppedHomonym: number;
	/** Country-level ("Venezuela") or unplaceable: counted, no state. */
	readonly national: number;
	readonly byState: Record<string, number>;
	readonly byRoot: Record<string, number>;
	readonly byQuad: Record<string, number>;
	readonly articles: number;
};

export type GdeltArticle = {
	readonly url: string;
	readonly domain: string;
	readonly stream: GdeltStream;
	/** Events GDELT coded from this article in this batch. */
	readonly events: number;
	/** CAMEO root codes ("14" = protest), sorted. */
	readonly roots: string[];
	/** 1 verbal cooperation, 2 material cooperation, 3 verbal conflict, 4 material conflict. */
	readonly quads: number[];
	readonly goldsteinMin: number | null;
	readonly tone: number | null;
	/** GDELT's place text ("Caracas, Distrito Federal, Venezuela"). */
	readonly place: string;
	readonly state: string | null;
	readonly placedBy: "point" | "adm1" | "country" | "none";
	/** Articles GDELT counted for the most-covered of these events (NumArticles). */
	readonly numArticles: number;
};

type Placed = { state: string | null; by: GdeltArticle["placedBy"]; point: GeoPoint | null };

function place(row: readonly string[]): Placed {
	const type = row[COL.geoType];
	const lat = Number(row[COL.lat]);
	const lon = Number(row[COL.lon]);
	if (type === "1") return { state: null, by: "country", point: null };
	if (Number.isFinite(lat) && Number.isFinite(lon) && row[COL.lat] !== "") {
		const where = locate(lat, lon);
		if (where.inVenezuela && where.state)
			return { state: where.state.iso, by: "point", point: { lat, lon, state: where.state.iso } };
	}
	const iso = FIPS_VE[row[COL.adm1] ?? ""];
	if (iso) return { state: iso, by: "adm1", point: null };
	return { state: null, by: "none", point: null };
}

function hostOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}

/** Pure: a place GDELT put in Venezuela that is more likely its foreign homonym (see the header). */
export function likelyForeignHomonym(placeText: string, url: string): boolean {
	const name = normalize(placeText.split(",")[0] ?? "");
	if (!FOREIGN_HOMONYMS.has(name)) return false;
	if (/\.ve$/i.test(hostOf(url))) return false;
	let text = url;
	try {
		text = decodeURIComponent(url);
	} catch {
		// keep the raw URL
	}
	return !/venezuel/i.test(normalize(text));
}

const num = (s: string | undefined): number | null => {
	if (s === undefined || s === "") return null;
	const n = Number(s);
	return Number.isFinite(n) ? n : null;
};

function inc(into: Record<string, number>, key: string): void {
	into[key] = (into[key] ?? 0) + 1;
}

/** Pure: one export file's Venezuelan events → the batch counts and one record per source article. */
export function readBatch(
	tsv: string,
	stream: GdeltStream,
): { batch: GdeltBatch; articles: (GdeltArticle & { point: GeoPoint | null })[] } {
	const lines = tsv.split("\n");
	const byState: Record<string, number> = {};
	const byRoot: Record<string, number> = {};
	const byQuad: Record<string, number> = {};
	const articles = new Map<string, GdeltArticle & { point: GeoPoint | null }>();
	let rows = 0;
	let events = 0;
	let dropped = 0;
	let national = 0;
	for (const line of lines) {
		if (line.trim() === "") continue;
		const r = line.split("\t");
		if (r.length < 61) continue;
		rows++;
		if (r[COL.country] !== "VE") continue;
		const url = (r[COL.url] ?? "").trim();
		if (!/^https?:\/\//.test(url)) continue;
		const placeText = r[COL.geoName] ?? "";
		if (likelyForeignHomonym(placeText, url)) {
			dropped++;
			continue;
		}
		events++;
		const where = place(r);
		if (where.state) inc(byState, where.state);
		else national++;
		const root = (r[COL.rootCode] ?? "").padStart(2, "0");
		const quad = num(r[COL.quadClass]);
		if (/^\d{2}$/.test(root)) inc(byRoot, root);
		if (quad !== null) inc(byQuad, String(quad));
		const goldstein = num(r[COL.goldstein]);
		const tone = num(r[COL.avgTone]);
		const prev = articles.get(url);
		if (prev) {
			articles.set(url, {
				...prev,
				events: prev.events + 1,
				roots: [...new Set([...prev.roots, root])].sort(),
				quads: [...new Set([...prev.quads, ...(quad === null ? [] : [quad])])].sort(),
				goldsteinMin:
					goldstein === null ? prev.goldsteinMin : Math.min(prev.goldsteinMin ?? goldstein, goldstein),
				numArticles: Math.max(prev.numArticles, num(r[COL.numArticles]) ?? 0),
			});
		} else {
			articles.set(url, {
				url,
				domain: hostOf(url),
				stream,
				events: 1,
				roots: /^\d{2}$/.test(root) ? [root] : [],
				quads: quad === null ? [] : [quad],
				goldsteinMin: goldstein,
				tone: tone === null ? null : Math.round(tone * 100) / 100,
				place: placeText.slice(0, 120),
				state: where.state,
				placedBy: where.by,
				numArticles: num(r[COL.numArticles]) ?? 0,
				point: where.point,
			});
		}
	}
	return {
		batch: {
			stream,
			missing: false,
			rows,
			events,
			droppedHomonym: dropped,
			national,
			byState,
			byRoot,
			byQuad,
			articles: articles.size,
		},
		articles: [...articles.values()],
	};
}

const lastSeenUpdate = new Map<GdeltStream, string>();
/** Files GDELT listed that answered 404: not asked for again in this process. */
const gone = new Set<string>();

async function streamRaws(ctx: FetchContext, stream: GdeltStream): Promise<RawResponse[]> {
	const listing = await ctx.http.request(`${BASE}${STREAMS[stream]}`, {
		headers: {
			accept: "text/plain",
			...(lastSeenUpdate.get(stream) ? { "if-none-match": lastSeenUpdate.get(stream) as string } : {}),
		},
		okStatuses: [304],
		signal: ctx.signal,
	});
	if (listing.status === 304) return [];
	const newest = parseLastUpdate(listing.body);
	if (!newest) throw new SchemaError(`GDELT ${STREAMS[stream]}: sin archivo de eventos`);
	const wanted: number[] = [];
	for (let t = newest.at; t > newest.at - BACKFILL_MS && wanted.length < MAX_PER_STREAM; t -= QUARTER) {
		const url = exportUrl(stream, t);
		if (gone.has(url) || ctx.seen?.(`gdelt:batch:${stream}`, t)) continue;
		wanted.push(t);
	}
	const out: RawResponse[] = [];
	for (const t of wanted) {
		if (ctx.signal.aborted) break;
		const url = exportUrl(stream, t);
		const raw = await ctx.http.request(url, {
			binary: true,
			maxBytes: 16 * 1024 * 1024,
			hostGapMs: 1_000,
			okStatuses: [404],
			signal: ctx.signal,
		});
		if (raw.status === 404) {
			// Measured 2026-09-29: translated files listed at 01:15 and 01:30 UTC were still 404 forty minutes later and
			// 01:15 arrived about an hour late. So a 404 is retried until the batch is three hours old, then recorded
			// as missing and not asked for again.
			if (ctx.now() - t < MISSING_AFTER_MS) continue;
			gone.add(url);
		}
		out.push(raw);
	}
	if (listing.etag) lastSeenUpdate.set(stream, listing.etag);
	return out;
}

export const gdeltVe: Adapter<GdeltBatch | GdeltArticle> = {
	id: "gdelt-ve",
	layer: "news",
	name: {
		es: "GDELT: noticias del mundo codificadas sobre Venezuela (cada 15 min)",
		en: "GDELT: world news machine-coded about Venezuela (every 15 min)",
	},
	provider: "The GDELT Project",
	homepage: "https://www.gdeltproject.org/",
	licence: GDELT_LICENCE,
	keys: [],
	intervalMs: QUARTER,
	// A batch every 15 min, zero Venezuelan events included: an hour without one is a stalled pipeline.
	freshness: { fetchMs: 60 * 60_000, dataMs: 75 * 60_000 },

	async fetch(ctx) {
		const en = await streamRaws(ctx, "en");
		const tr = await streamRaws(ctx, "tr");
		return [...en, ...tr];
	},

	normalise(raws) {
		const out: Observation<GdeltBatch | GdeltArticle>[] = [];
		for (const raw of raws) {
			const at = batchTime(raw.url);
			if (at === null) continue;
			const stream: GdeltStream = /\.translation\.export/i.test(raw.url) ? "tr" : "en";
			const common = {
				source: "gdelt-ve",
				fetchedAt: raw.fetchedAt,
				observedAt: Math.min(at, raw.fetchedAt),
				licence: GDELT_LICENCE.id,
			};
			if (raw.status === 404) {
				out.push({
					...common,
					series: `gdelt:batch:${stream}`,
					sourceUrl: raw.url,
					value: {
						stream,
						missing: true,
						rows: 0,
						events: 0,
						droppedHomonym: 0,
						national: 0,
						byState: {},
						byRoot: {},
						byQuad: {},
						articles: 0,
					},
					confidence: 1,
					basis: "report",
				});
				continue;
			}
			let tsv: string;
			try {
				const zip = new ZipReader(new Uint8Array(Buffer.from(raw.body, "base64")), 128 * 1024 * 1024);
				const name = zip.names()[0];
				if (!name) throw new SchemaError("zip vacío");
				tsv = zip.readText(name);
			} catch (error) {
				throw new SchemaError(`GDELT ${raw.url}: ${error instanceof Error ? error.message : error}`);
			}
			const { batch, articles } = readBatch(tsv, stream);
			if (batch.rows === 0) throw new SchemaError(`GDELT ${raw.url}: tabla sin filas de 61 columnas`);
			out.push({
				...common,
				series: `gdelt:batch:${stream}`,
				sourceUrl: raw.url,
				value: batch,
				confidence: 1,
				basis: "report",
			});
			for (const { point, ...a } of articles) {
				out.push({
					...common,
					series: `gdelt:article:${Bun.hash(a.url).toString(36)}`,
					sourceUrl: a.url,
					value: a,
					...(point ? { location: point } : {}),
					// Machine-coded from a news report, with automatic geocoding: a lead, not a fact.
					confidence: 0.5,
					basis: "report",
				});
			}
		}
		return out;
	},
};
