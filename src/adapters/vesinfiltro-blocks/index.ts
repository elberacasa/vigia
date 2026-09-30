import type { Adapter, Licence, Observation } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { domainKey } from "../ooni-ve/categories.ts";

/**
 * VE sin Filtro's hand-checked list of sites blocked in Venezuela, with the blocking method per ISP
 * (https://bloqueos.vesinfiltro.org/).
 *
 * Where the list lives (measured 2026-09-29): the CSV moved from a fixed `static/blocking-data.csv` (now 404) to a
 * dated file, `static/blocking-data-2026-09-29.csv`. The site names it in `data-config.js`, which its own source
 * calls "the one place that says which data file the site uses and when it was updated" and keeps "a single JSON
 * object literal" so tools can parse it: `window.VSF_DATA = {"file": "static/blocking-data-<date>.csv",
 * "updated": "<date>"}`. Vigía reads that pointer, then the file it names. If the pointer ever fails or changes
 * shape, the page's download link (`id="csv-download"`) and its "Actualización: <time datetime>" say the same thing
 * and are read instead. The file has no date inside; `updated` is the observed date of every row.
 *
 * The CSV is served by Cloudflare with an ETag and no Last-Modified, so a run asks with If-None-Match (for the same
 * file name) and stores nothing when it is unchanged. The 2026-09-29 file dropped the G-Network column (7 ISPs);
 * a column that is missing is simply not reported.
 *
 * Series: `site:<host>` (as listed, lower case), observed at the update date (00:00 Venezuela time).
 * Every 6 hours, two small requests (0.3 KB pointer, 16 KB CSV), 5 s apart.
 */

export const VESINFILTRO_LICENCE: Licence = {
	id: "cc-by-nc-sa-4.0-vesinfiltro",
	name: "CC BY-NC-SA 4.0 (VE sin Filtro)",
	url: "https://creativecommons.org/licenses/by-nc-sa/4.0/deed.es",
	attribution: "Datos: VE sin Filtro",
	commercial: false,
};

export const PAGE_URL = "https://bloqueos.vesinfiltro.org/";
/** The site's own pointer to the current CSV and its date (see the header). */
export const CONFIG_URL = "https://bloqueos.vesinfiltro.org/data-config.js";

/** CSV column → our ISP id (src/adapters/ioda-asn ISPS). G-Network was in the CSV until 2026-09-29, never on the page. */
export const ISP_COLUMNS: Readonly<Record<string, string>> = {
	CANTV: "cantv",
	Movistar: "movistar",
	Digitel: "digitel",
	Inter: "inter",
	Netuno: "netuno",
	Airtek: "airtek",
	"G-Network": "g-network",
	Thundernet: "thundernet",
};

export const METHODS = ["DNS", "HTTP/HTTPS", "HTTP", "HTTPS", "TCP IP"] as const;
export type Method = (typeof METHODS)[number];

export type CellStatus = "blocked" | "ok" | "unblocked" | "no-data";

export type VsfCell = {
	readonly isp: string;
	readonly status: CellStatus;
	/** Blocking methods when blocked, e.g. ["DNS", "HTTP/HTTPS"]. */
	readonly methods: Method[];
};

export type VsfSite = {
	readonly site: string;
	/** Host (sometimes host/path, e.g. "bit.ly/venezuela911") exactly as listed, lower case. VE sin Filtro lists
	 * "www.x" and "x" separately when it tested both. */
	readonly domain: string;
	/** Join key with OONI: domain without "www." (src/adapters/ooni-ve/categories.ts). */
	readonly key: string;
	/** false when VE sin Filtro marks the entry "abandoned" (site gone or no longer tracked). */
	readonly active: boolean;
	readonly category: string;
	readonly isps: VsfCell[];
	/** The page's update date, YYYY-MM-DD. */
	readonly updated: string;
};

/** "ok", "ND", "unblocked" or a "+"-joined set of methods. Null for anything else. */
export function parseCell(raw: string): Omit<VsfCell, "isp"> | null {
	const v = raw.trim();
	if (v === "ok") return { status: "ok", methods: [] };
	if (v === "ND") return { status: "no-data", methods: [] };
	if (v === "unblocked") return { status: "unblocked", methods: [] };
	const parts = v.split("+").map((p) => p.trim());
	if (parts.length === 0 || !parts.every((p): p is Method => (METHODS as readonly string[]).includes(p)))
		return null;
	return { status: "blocked", methods: parts as Method[] };
}

import { parseCsv } from "../../formats/csv.ts";

export { parseCsv };

/** The "Actualización" date on the page, as YYYY-MM-DD. */
export function updateDate(html: string): string | null {
	const near = /Actualizaci[oó]n[\s\S]{0,300}?<time[^>]*datetime="(\d{4}-\d{2}-\d{2})"/i.exec(html);
	const any = near ?? /<time[^>]*datetime="(\d{4}-\d{2}-\d{2})"/i.exec(html);
	return any?.[1] ?? null;
}

/** Where the current CSV is and its date: from `data-config.js`, or from the page's download link and date. */
export type DataPointer = { readonly csvUrl: string; readonly updated: string };

const CSV_PATH = /^static\/[A-Za-z0-9._-]+\.csv$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `window.VSF_DATA = {"file": "static/blocking-data-2026-09-29.csv", "updated": "2026-09-29"};` */
export function pointerFromConfig(js: string): DataPointer | null {
	const m = /window\.VSF_DATA\s*=\s*(\{[^}]*\})/.exec(js);
	if (!m?.[1]) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(m[1]);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const { file, updated } = parsed as Record<string, unknown>;
	if (typeof file !== "string" || !CSV_PATH.test(file)) return null;
	if (typeof updated !== "string" || !DATE.test(updated)) return null;
	return { csvUrl: new URL(file, PAGE_URL).toString(), updated };
}

/** The page's own "Descargar .csv" link and its "Actualización" date. */
export function pointerFromPage(html: string): DataPointer | null {
	const link =
		/<a[^>]*id="csv-download"[^>]*>/i.exec(html)?.[0] ??
		/<a[^>]*href="static\/[^"]*\.csv"[^>]*>/i.exec(html)?.[0];
	const file = link ? /href="([^"]+)"/.exec(link)?.[1] : undefined;
	const updated = updateDate(html);
	if (!file || !CSV_PATH.test(file) || !updated) return null;
	return { csvUrl: new URL(file, PAGE_URL).toString(), updated };
}

/** The pointer in a recorded response: the config file or, as a fallback, the page. */
function pointerOf(raw: { url: string; body: string }): DataPointer | null {
	return raw.url.startsWith(CONFIG_URL) ? pointerFromConfig(raw.body) : pointerFromPage(raw.body);
}

/** The ETag of the last CSV that parsed, for that file name only (each update is a new file). */
let lastCsv: { url: string; etag: string } | null = null;

export const vesinfiltroBlocks: Adapter<VsfSite> = {
	id: "vesinfiltro-blocks",
	layer: "internet",
	name: { es: "Sitios bloqueados (VE sin Filtro)", en: "Blocked sites (VE sin Filtro)" },
	provider: "VE sin Filtro",
	homepage: PAGE_URL,
	licence: VESINFILTRO_LICENCE,
	keys: [],
	intervalMs: 6 * 3_600_000,
	// Hand-curated and updated every few days: stale when the list's date is 30 days old.
	freshness: { fetchMs: 20 * 3_600_000, dataMs: 30 * 86_400_000 },

	async fetch(ctx) {
		const options = { hostGapMs: 5_000, maxBytes: 2 * 1024 * 1024, signal: ctx.signal };
		let meta = await ctx.http
			.request(CONFIG_URL, {
				...options,
				headers: { accept: "application/javascript, text/javascript, */*" },
			})
			.catch(() => null);
		if (!meta || !pointerOf(meta)) {
			meta = await ctx.http.request(PAGE_URL, { ...options, headers: { accept: "text/html" } });
		}
		const pointer = pointerOf(meta);
		if (!pointer)
			throw new SchemaError("VE sin Filtro: ni data-config.js ni la página dicen dónde está el CSV");
		const etag = lastCsv?.url === pointer.csvUrl ? lastCsv.etag : null;
		const csv = await ctx.http.request(pointer.csvUrl, {
			...options,
			headers: { accept: "text/csv", ...(etag ? { "if-none-match": etag } : {}) },
			okStatuses: [304],
		});
		// The ETag is remembered only for a CSV that parses: a broken file must be fetched again in full next
		// time, not answered with 304 forever. normalise ignores the CSV when the server answers 304.
		if (csv.status === 200) {
			lastCsv = null;
			if (csv.etag) {
				try {
					vesinfiltroBlocks.normalise([meta, csv]);
					lastCsv = { url: pointer.csvUrl, etag: csv.etag };
				} catch {
					// normalise reports the error on the run; nothing is remembered.
				}
			}
		}
		return [meta, csv];
	},

	normalise(raws) {
		const [meta, csv] = raws;
		if (!meta || !csv) throw new SchemaError("VE sin Filtro: faltan respuestas");
		if (csv.status === 304) return [];
		const updated = pointerOf(meta)?.updated;
		if (!updated) throw new SchemaError("VE sin Filtro: sin fecha de actualización");
		// The date is Venezuelan (UTC−4, no DST): midnight there is 04:00 UTC.
		const observedAt = Date.parse(`${updated}T04:00:00Z`);
		if (!Number.isFinite(observedAt) || observedAt > csv.fetchedAt + 86_400_000) {
			throw new SchemaError(`VE sin Filtro: fecha inválida ${updated}`);
		}
		const rows = parseCsv(csv.body.replace(/^﻿/, ""));
		const header = rows[0]?.map((h) => h.trim()) ?? [];
		const col = (name: string) => header.indexOf(name);
		for (const required of ["site", "domain", "abandoned", "category"]) {
			if (col(required) < 0) throw new SchemaError(`VE sin Filtro: falta la columna ${required}`);
		}
		const ispCols = Object.entries(ISP_COLUMNS)
			.map(([name, isp]) => ({ isp, index: col(name) }))
			.filter((c) => c.index >= 0);
		if (ispCols.length < 4) throw new SchemaError("VE sin Filtro: faltan columnas de proveedores");

		const out: Observation<VsfSite>[] = [];
		const seen = new Set<string>();
		for (const r of rows.slice(1)) {
			const domain = (r[col("domain")] ?? "").trim().toLowerCase();
			const site = (r[col("site")] ?? "").trim();
			const state = (r[col("abandoned")] ?? "").trim();
			const category = (r[col("category")] ?? "").trim();
			if (!/^[a-z0-9.-]+\.[a-z]{2,}(\/[^\s]*)?$/.test(domain) || !site || !category) continue;
			if (state !== "active" && state !== "abandoned") continue;
			if (seen.has(domain)) continue; // an exact repeat: first row wins
			const cells: VsfCell[] = [];
			for (const c of ispCols) {
				const parsed = parseCell(r[c.index] ?? "");
				if (parsed) cells.push({ isp: c.isp, ...parsed });
			}
			seen.add(domain);
			out.push({
				source: "vesinfiltro-blocks",
				series: `site:${domain}`,
				sourceUrl: PAGE_URL,
				fetchedAt: csv.fetchedAt,
				observedAt: Math.min(observedAt, csv.fetchedAt),
				licence: VESINFILTRO_LICENCE.id,
				value: {
					site,
					domain,
					key: domainKey(domain),
					active: state === "active",
					category,
					isps: cells,
					updated,
				},
				confidence: 1,
				basis: "report",
			});
		}
		if (out.length === 0) throw new SchemaError("VE sin Filtro: la lista vino vacía");
		return out;
	},
};
