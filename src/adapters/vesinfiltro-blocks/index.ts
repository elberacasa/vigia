import type { Adapter, Licence, Observation } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { domainKey } from "../ooni-ve/categories.ts";

/**
 * VE sin Filtro's hand-checked list of sites blocked in Venezuela, with the blocking method per ISP
 * (https://bloqueos.vesinfiltro.org/). The CSV has no date; the page shows "Actualización: <time
 * datetime=YYYY-MM-DD>", which is the observed date of every row. The CSV is served by Cloudflare with an ETag
 * and no Last-Modified, so a run asks with If-None-Match and stores nothing when it is unchanged.
 *
 * Series: `site:<host>` (as listed, lower case), observed at the page's update date (00:00 Venezuela time).
 * Every 6 hours, two small requests (17 KB page, 16 KB CSV), 5 s apart.
 */

export const VESINFILTRO_LICENCE: Licence = {
	id: "cc-by-nc-sa-4.0-vesinfiltro",
	name: "CC BY-NC-SA 4.0 (VE sin Filtro)",
	url: "https://creativecommons.org/licenses/by-nc-sa/4.0/deed.es",
	attribution: "Datos: VE sin Filtro",
	commercial: false,
};

export const PAGE_URL = "https://bloqueos.vesinfiltro.org/";
export const CSV_URL = "https://bloqueos.vesinfiltro.org/static/blocking-data.csv";

/** CSV column → our ISP id (src/adapters/ioda-asn ISPS). The page's own table omits G-Network; the CSV has it. */
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

/** Minimal RFC 4180 reader (quotes, doubled quotes, CRLF); the file has none today but may. */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quoted) {
			if (ch === '"' && text[i + 1] === '"') {
				field += '"';
				i++;
			} else if (ch === '"') quoted = false;
			else field += ch;
		} else if (ch === '"') quoted = true;
		else if (ch === ",") {
			row.push(field);
			field = "";
		} else if (ch === "\n" || ch === "\r") {
			if (ch === "\r" && text[i + 1] === "\n") i++;
			row.push(field);
			if (row.some((f) => f !== "")) rows.push(row);
			row = [];
			field = "";
		} else field += ch;
	}
	row.push(field);
	if (row.some((f) => f !== "")) rows.push(row);
	return rows;
}

/** The "Actualización" date on the page, as YYYY-MM-DD. */
export function updateDate(html: string): string | null {
	const near = /Actualizaci[oó]n[\s\S]{0,300}?<time[^>]*datetime="(\d{4}-\d{2}-\d{2})"/i.exec(html);
	const any = near ?? /<time[^>]*datetime="(\d{4}-\d{2}-\d{2})"/i.exec(html);
	return any?.[1] ?? null;
}

let lastEtag: string | null = null;

export const vesinfiltroBlocks: Adapter<VsfSite> = {
	id: "vesinfiltro-blocks",
	layer: "internet",
	name: { es: "Sitios bloqueados (VE sin Filtro)", en: "Blocked sites (VE sin Filtro)" },
	provider: "VE sin Filtro",
	homepage: PAGE_URL,
	licence: VESINFILTRO_LICENCE,
	keys: [],
	intervalMs: 6 * 3_600_000,
	// Hand-curated and updated every few days: stale when the page date is 30 days old.
	freshness: { fetchMs: 20 * 3_600_000, dataMs: 30 * 86_400_000 },

	async fetch(ctx) {
		const options = { hostGapMs: 5_000, maxBytes: 2 * 1024 * 1024, signal: ctx.signal };
		const page = await ctx.http.request(PAGE_URL, { ...options, headers: { accept: "text/html" } });
		const csv = await ctx.http.request(CSV_URL, {
			...options,
			headers: { accept: "text/csv", ...(lastEtag ? { "if-none-match": lastEtag } : {}) },
			okStatuses: [304],
		});
		// The ETag is remembered only for a CSV that parses: a broken file must be fetched again in full next
		// time, not answered with 304 forever. normalise ignores the CSV when the server answers 304.
		if (csv.status === 200 && csv.etag) {
			try {
				vesinfiltroBlocks.normalise([page, csv]);
				lastEtag = csv.etag;
			} catch {
				lastEtag = null;
			}
		}
		return [page, csv];
	},

	normalise(raws) {
		const [page, csv] = raws;
		if (!page || !csv) throw new SchemaError("VE sin Filtro: faltan respuestas");
		if (csv.status === 304) return [];
		const updated = updateDate(page.body);
		if (!updated) throw new SchemaError("VE sin Filtro: la página no trae fecha de actualización");
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
