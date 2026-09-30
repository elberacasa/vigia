import { z } from "zod";
import type { Adapter, Licence, Observation, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import gadmJson from "./gadm.json" with { type: "json" };

/**
 * Vegetation-disturbance alerts in Venezuela from Global Forest Watch's integrated alerts (GLAD-L, GLAD-S2, RADD and,
 * since 2025, DIST-ALERT, which covers every kind of vegetation, not only forest), summed per week by state, by
 * municipality and by protected area, split by GFW's confidence ("nominal", "high", "highest": several systems
 * agree) and by whether the pixel is natural forest (SBTN Natural Forests map). It answers "where is forest being
 * cleared this week" (mining in Bolívar and Amazonas, the Imataca and Caura reserves), with the caveat that an alert
 * is a detected disturbance, not a confirmed clearing.
 *
 * What was measured (2026-09-29): outside natural forest the alerts are dominated by savanna, cropland and dry
 * shrubland (Apure 138,000 ha in September 2025; Falcón 42,800 ha "high" in September 2026, almost all outside
 * GLAD-S2 and RADD, i.e. DIST-ALERT). The panel therefore leads with alerts in natural forest and shows the rest as
 * "otra vegetación". Rows for Venezuela run from 2024-09-30 (two years) to the day before the table's version.
 *
 * Access (no key): GFW's Data API serves "downloadable" datasets through `/dataset/{ds}/{version}/download/json?sql=`
 * without an API key: its own OpenAPI description (data-api.globalforestwatch.org/openapi.json, read 2026-09-29)
 * declares no security on the download endpoints and requires `x-api-key` on `/query`; verified the same day on
 * `gadm__integrated_alerts__adm2_daily_alerts` and `wdpa_protected_areas__integrated_alerts__daily_alerts` (both
 * `is_downloadable: true`), each version `vYYYYMMDD` daily. Vigía asks for the version first (1.4 KB) and downloads
 * the two weekly sums (8 weeks, ≈0.6 + 0.5 MB, ≈1 s each) only when the version is new. If GFW ever closes the
 * downloads to anonymous use, the feed fails loudly and a free GFW API key (sent as `x-api-key`) is the fix.
 *
 * Places: the precomputed tables key Venezuela by GADM 4.1 ids. GADM's states match the official ones at 84–99 % of
 * their area and are mapped one to one; a GADM municipality is linked to an official one only when 80 % of its area
 * lies in it and either the names agree or it also covers 80 % of the official one (142 of 338; El Callao, which
 * lies inside Sifontes, is not), and otherwise keeps its GADM name (`gadm.json`, built by build-gadm.ts).
 * Protected areas are WDPA's (by WDPA id; some overlap, e.g. a national park inside a forest reserve, so they are
 * never summed).
 *
 * Licence: Global Forest Watch data, CC BY 4.0 (the integrated alerts and their inputs); attribution "Global Forest
 * Watch (WRI)" and the systems' authors.
 */

export const GFW_LICENCE: Licence = {
	id: "gfw-cc-by-4.0",
	name: "CC BY 4.0 (Global Forest Watch, WRI)",
	url: "https://www.globalforestwatch.org/terms/",
	attribution:
		"Global Forest Watch (WRI): alertas integradas (GLAD-L, GLAD-S2 de UMD; RADD de Wageningen; DIST-ALERT de UMD/OPERA). Sumas semanales calculadas por Vigía.",
	commercial: true,
};

export const GFW_HOME = "https://www.globalforestwatch.org/dashboards/country/VEN/";
const API = "https://data-api.globalforestwatch.org/dataset";
export const ADM_DATASET = "gadm__integrated_alerts__adm2_daily_alerts";
export const WDPA_DATASET = "wdpa_protected_areas__integrated_alerts__daily_alerts";
const DAY = 86_400_000;
export const WEEKS = 8;
/** Protected areas kept per week: the 50 with most natural-forest alerts, at least 1 ha. */
export const PA_MAX = 50;
export const PA_MIN_HA = 1;
const forestTotal = (s: AlertSplit) => s.forestHa[0] + s.forestHa[1] + s.forestHa[2];

/** Rows that fail validation or name no known GADM unit: more than this share of a download fails the run. */
export const MAX_SKIPPED_SHARE = 0.01;

/** Hectares by confidence: [nominal, high, highest]. */
export type ByConfidence = [number, number, number];
export type AlertSplit = {
	/** Alert area in natural forest, ha, by confidence. */
	forestHa: ByConfidence;
	/** Alert area in other vegetation (or unknown class), ha, by confidence. */
	otherHa: ByConfidence;
	/** Alerts (pixels) in natural forest, all confidences. */
	forestAlerts: number;
};
export type MunicipalityAlerts = AlertSplit & {
	gadmName: string;
	state: string;
	/** Official municipality P-code when GADM's covers ≥ 80 % of it, else null. */
	municipality: string | null;
};
export type ProtectedAreaAlerts = AlertSplit & { name: string; iucn: string | null };

export type AlertsWeek = {
	kind: "week";
	/** Monday (UTC) the week starts. */
	week: string;
	/** GFW table version the municipal and state figures come from, e.g. "v20260929". */
	version: string;
	/** Version of the protected-area table read in the same run (its own daily versions). */
	wdpaVersion: string;
	/**
	 * Whether the week had ended by the version's date. Not final: GFW keeps adding alerts to past weeks and raising
	 * their confidence for weeks after, so an ended week can still grow.
	 */
	ended: boolean;
	venezuela: AlertSplit;
	/** By ISO 3166-2 code. */
	states: Record<string, AlertSplit>;
	/** By GADM id "adm1.adm2", only those with alerts. */
	municipalities: Record<string, MunicipalityAlerts>;
	/** By WDPA id: the PA_MAX with most natural-forest alerts, each with at least PA_MIN_HA. */
	protectedAreas: Record<string, ProtectedAreaAlerts>;
	/** How many protected areas had any alert that week (the list above is the top of them). */
	protectedAreasWithAlerts: number;
};
export type AlertsVersion = { kind: "version"; version: string };
export type GfwAlerts = AlertsWeek | AlertsVersion;

type GadmMap = {
	states: Record<string, { state: string }>;
	municipalities: Record<string, { municipality: string | null; gadmName: string }>;
};
const GADM = gadmJson as unknown as GadmMap;

export function versionUrl(dataset: string): string {
	return `${API}/${dataset}/latest`;
}

/** Monday (UTC) of the week `weeks - 1` weeks before the one containing `now`. */
export function firstWeek(now: number, weeks = WEEKS): string {
	const d = new Date(now);
	const monday =
		Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * DAY;
	return new Date(monday - (weeks - 1) * 7 * DAY).toISOString().slice(0, 10);
}

const NF = "CASE WHEN sbtn_natural_forests__class = 'Natural Forest' THEN 1 ELSE 0 END";
const WEEK = "date_trunc('week', gfw_integrated_alerts__date)";

export function admSql(since: string): string {
	return `SELECT adm1, adm2, ${WEEK} AS w, gfw_integrated_alerts__confidence AS c, ${NF} AS nf, SUM(alert__count) AS n, SUM(alert_area__ha) AS ha FROM data WHERE iso = 'VEN' AND gfw_integrated_alerts__date >= '${since}' GROUP BY 1, 2, 3, 4, 5`;
}
export function wdpaSql(since: string): string {
	return `SELECT wdpa_protected_area__id AS id, wdpa_protected_area__name AS name, wdpa_protected_area__iucn_cat AS cat, ${WEEK} AS w, gfw_integrated_alerts__confidence AS c, ${NF} AS nf, SUM(alert__count) AS n, SUM(alert_area__ha) AS ha FROM data WHERE wdpa_protected_area__iso = 'VEN' AND gfw_integrated_alerts__date >= '${since}' GROUP BY 1, 2, 3, 4, 5, 6`;
}
export function downloadUrl(dataset: string, version: string, sql: string): string {
	return `${API}/${dataset}/${version}/download/json?${new URLSearchParams({ sql })}`;
}

const Version = z.object({
	data: z.object({ dataset: z.string(), version: z.string().regex(/^v\d{8}$/) }),
});
const Ha = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)]).transform(Number);
const Week = z.string().regex(/^\d{4}-\d{2}-\d{2}T00:00:00(\+00:00|Z)$/);
const Conf = z.enum(["nominal", "high", "highest"]);
const AdmRow = z.object({
	adm1: z.number().int().min(1).max(40),
	adm2: z.number().int().min(1).max(99),
	w: Week,
	c: Conf,
	nf: z.union([z.literal(0), z.literal(1)]),
	n: z.number().int().nonnegative(),
	ha: Ha,
});
const WdpaRow = z.object({
	id: z.string().regex(/^\d{1,12}$/),
	name: z.string().min(1).max(200),
	cat: z.string().max(40).nullable(),
	w: Week,
	c: Conf,
	nf: z.union([z.literal(0), z.literal(1)]),
	n: z.number().int().nonnegative(),
	ha: Ha,
});
const CONF_INDEX = { nominal: 0, high: 1, highest: 2 } as const;

function json(raw: RawResponse, what: string): unknown {
	try {
		return JSON.parse(raw.body);
	} catch {
		throw new SchemaError(`GFW ${what}: la respuesta no es JSON`);
	}
}

const emptySplit = (): AlertSplit => ({ forestHa: [0, 0, 0], otherHa: [0, 0, 0], forestAlerts: 0 });
function add(s: AlertSplit, row: { c: keyof typeof CONF_INDEX; nf: 0 | 1; n: number; ha: number }): void {
	const i = CONF_INDEX[row.c];
	const target = row.nf === 1 ? s.forestHa : s.otherHa;
	target[i] += row.ha;
	if (row.nf === 1) s.forestAlerts += row.n;
}
const round = (s: AlertSplit): AlertSplit => ({
	forestHa: s.forestHa.map((v) => Math.round(v * 10) / 10) as ByConfidence,
	otherHa: s.otherHa.map((v) => Math.round(v * 10) / 10) as ByConfidence,
	forestAlerts: s.forestAlerts,
});

export const gfwAlerts: Adapter<GfwAlerts> = {
	id: "gfw-alerts",
	layer: "earth",
	name: {
		es: "Alertas de pérdida de vegetación y bosque (Global Forest Watch)",
		en: "Vegetation and forest disturbance alerts (Global Forest Watch)",
	},
	provider: "Global Forest Watch (WRI)",
	homepage: GFW_HOME,
	licence: GFW_LICENCE,
	keys: [],
	// GFW publishes a new table version about once a day; checking every 6 h costs 1.4 KB when nothing changed.
	intervalMs: 6 * 3_600_000,
	// Newest week starts ≤ 7 days ago; three weeks without a newer one (no new version) is stale.
	freshness: { fetchMs: 2 * DAY, dataMs: 21 * DAY },

	async fetch(ctx) {
		const opts = {
			headers: { accept: "application/json" },
			hostGapMs: 3_000,
			timeoutMs: 90_000,
			maxBytes: 16 * 1024 * 1024,
			signal: ctx.signal,
		};
		const version = await ctx.http.request(versionUrl(ADM_DATASET), opts);
		const parsed = Version.safeParse(json(version, "versión"));
		if (!parsed.success) return [version];
		const v = parsed.data.data.version;
		if (ctx.seen?.("version", versionAt(v))) return [version];
		const wdpaVersion = await ctx.http.request(versionUrl(WDPA_DATASET), opts);
		const w = Version.safeParse(json(wdpaVersion, "versión de áreas protegidas"));
		const wv = w.success ? w.data.data.version : "latest";
		const since = firstWeek(ctx.now());
		return [
			version,
			wdpaVersion,
			await ctx.http.request(downloadUrl(ADM_DATASET, v, admSql(since)), opts),
			await ctx.http.request(downloadUrl(WDPA_DATASET, wv, wdpaSql(since)), opts),
		];
	},

	normalise(raws) {
		const versionRaw = raws.find((r) => !r.url.includes("/download/") && r.url.includes(`/${ADM_DATASET}/`));
		if (!versionRaw) throw new SchemaError("GFW: falta la versión");
		const parsed = Version.safeParse(json(versionRaw, "versión"));
		if (!parsed.success) throw new SchemaError("GFW: versión con formato inesperado");
		const version = parsed.data.data.version;
		const download = (dataset: string) =>
			raws.find((r) => r.url.includes(`/${dataset}/`) && r.url.includes("/download/"));
		const admRaw = download(ADM_DATASET);
		const wdpaRaw = download(WDPA_DATASET);
		const base = {
			source: "gfw-alerts",
			sourceUrl: GFW_HOME,
			licence: GFW_LICENCE.id,
			// GFW's own alert classification; the weekly sums are Vigía's.
			confidence: 0.8,
			basis: "derived" as const,
		};
		if (!admRaw || !wdpaRaw) return [];
		// The protected-area table's version: from the URL the download used ("latest" in older recordings).
		const wdpaVersion = /\/(v\d{8}|latest)\/download\//.exec(wdpaRaw.url)?.[1] ?? "latest";
		const admBody = json(admRaw, "municipios");
		const wdpaBody = json(wdpaRaw, "áreas protegidas");
		if (!Array.isArray(admBody) || !Array.isArray(wdpaBody))
			throw new SchemaError("GFW: la descarga no es una lista de filas");

		const weeks = new Map<string, AlertsWeek>();
		const versionDay = versionAt(version);
		const weekOf = (w: string): AlertsWeek => {
			const day = w.slice(0, 10);
			let wk = weeks.get(day);
			if (!wk) {
				wk = {
					kind: "week",
					week: day,
					version,
					wdpaVersion,
					ended: Date.parse(`${day}T00:00:00Z`) + 7 * DAY <= versionDay,
					venezuela: emptySplit(),
					states: {},
					municipalities: {},
					protectedAreas: {},
					protectedAreasWithAlerts: 0,
				};
				weeks.set(day, wk);
			}
			return wk;
		};
		let admValid = 0;
		for (const item of admBody) {
			const r = AdmRow.safeParse(item);
			if (!r.success) continue;
			const row = r.data;
			const state = GADM.states[String(row.adm1)]?.state;
			const key = `${row.adm1}.${row.adm2}`;
			const muni = GADM.municipalities[key];
			if (!state || !muni) continue;
			admValid++;
			const wk = weekOf(row.w);
			add(wk.venezuela, row);
			wk.states[state] ??= emptySplit();
			add(wk.states[state], row);
			wk.municipalities[key] ??= {
				...emptySplit(),
				gadmName: muni.gadmName,
				state,
				municipality: muni.municipality,
			};
			add(wk.municipalities[key], row);
		}
		if (admBody.length > 0 && admValid === 0) throw new SchemaError("GFW: ninguna fila de municipios válida");
		// A few odd rows are skipped; more than that means the table changed shape or GADM ids (totals would be wrong).
		if (admBody.length - admValid > MAX_SKIPPED_SHARE * admBody.length)
			throw new SchemaError(
				`GFW: ${admBody.length - admValid} de ${admBody.length} filas de municipios no válidas o sin municipio GADM conocido`,
			);
		let wdpaValid = 0;
		for (const item of wdpaBody) {
			const r = WdpaRow.safeParse(item);
			if (!r.success) continue;
			wdpaValid++;
			const row = r.data;
			const wk = weekOf(row.w);
			wk.protectedAreas[row.id] ??= { ...emptySplit(), name: row.name, iucn: row.cat };
			add(wk.protectedAreas[row.id] as ProtectedAreaAlerts, row);
		}
		if (wdpaBody.length > 0 && wdpaValid === 0)
			throw new SchemaError("GFW: ninguna fila de áreas protegidas válida");
		if (wdpaBody.length - wdpaValid > MAX_SKIPPED_SHARE * wdpaBody.length)
			throw new SchemaError(`GFW: ${wdpaBody.length - wdpaValid} filas de áreas protegidas no válidas`);

		const fetchedAt = Math.max(admRaw.fetchedAt, wdpaRaw.fetchedAt);
		const out: Observation<GfwAlerts>[] = [];
		for (const wk of [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week))) {
			const observedAt = Date.parse(`${wk.week}T00:00:00Z`);
			if (observedAt > fetchedAt) continue;
			const value: AlertsWeek = {
				...wk,
				venezuela: round(wk.venezuela),
				states: Object.fromEntries(Object.entries(wk.states).map(([k, s]) => [k, round(s)])),
				municipalities: Object.fromEntries(
					Object.entries(wk.municipalities).map(([k, m]) => [k, { ...m, ...round(m) }]),
				),
				protectedAreas: Object.fromEntries(
					Object.entries(wk.protectedAreas)
						.map(([k, p]) => [k, { ...p, ...round(p) }] as const)
						.filter(([, p]) => forestTotal(p) >= PA_MIN_HA)
						.sort((a, b) => forestTotal(b[1]) - forestTotal(a[1]) || a[0].localeCompare(b[0]))
						.slice(0, PA_MAX),
				),
				protectedAreasWithAlerts: Object.keys(wk.protectedAreas).length,
			};
			out.push({ ...base, series: `week:${wk.week}`, fetchedAt, observedAt, value });
		}
		// Marks this version as read, so the next runs skip the downloads until GFW publishes a new one.
		out.push({
			...base,
			series: "version",
			fetchedAt,
			observedAt: Math.min(versionDay, fetchedAt),
			value: { kind: "version", version },
		});
		return out;
	},
};

/** "v20260929" → 2026-09-29T00:00Z. */
export function versionAt(version: string): number {
	return Date.UTC(Number(version.slice(1, 5)), Number(version.slice(5, 7)) - 1, Number(version.slice(7, 9)));
}
