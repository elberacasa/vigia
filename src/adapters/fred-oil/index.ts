import pkg from "../../../package.json" with { type: "json" };
import type { Adapter, Licence, Observation, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { utcDateToMs } from "../../formats/time.ts";

/**
 * Brent and WTI daily spot prices from FRED's keyless CSV. FRED republishes the U.S. Energy Information
 * Administration's series (DCOILBRENTEU = EIA RBRTE, DCOILWTICO = EIA RWTC; identical values checked on
 * 2026-09-22), so the attribution is "U.S. EIA vía FRED". Values are US$ per barrel; the newest day usually
 * lags by one or two business days.
 *
 * Quirks:
 * - FRED's firewall resets connections for User-Agents that do not start with a known client token, so this
 *   adapter sends `Bun/<version> Vigia/<version> (...)`: the runtime's real name first, then the project. Honest.
 * - Holidays appear as rows with an empty value (or "."); they are skipped, not zeros.
 * - `observedAt` is the trading day at 00:00 UTC (the CSV gives dates only).
 */

export const EIA_VIA_FRED: Licence = {
	id: "eia-public-domain-via-fred",
	name: "Dominio público (U.S. EIA), redistribuido por FRED",
	url: "https://www.eia.gov/about/copyrights_reuse.php",
	attribution: "Fuente: U.S. Energy Information Administration, vía FRED (Federal Reserve Bank of St. Louis)",
	commercial: true,
};

export const FRED_SERIES = [
	{ fredId: "DCOILBRENTEU", series: "brent", label: "Brent (Europa)" },
	{ fredId: "DCOILWTICO", series: "wti", label: "WTI (Cushing, Oklahoma)" },
] as const;

export type OilPrice = {
	/** US$ per barrel. */
	readonly usdPerBarrel: number;
	/** Trading day, "YYYY-MM-DD". */
	readonly date: string;
};

/** Two years back is enough for the panel and keeps each request near 9 KB (full history is ~170 KB). */
const WINDOW_DAYS = 730;

export function csvUrl(fredId: string, now: number): string {
	const start = new Date(now - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
	return `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${fredId}&cosd=${start}`;
}

export function fredUserAgent(bunVersion: string): string {
	return `Bun/${bunVersion} Vigia/${pkg.version} (open-source situation room for Venezuela)`;
}

function seriesOf(raw: RawResponse): (typeof FRED_SERIES)[number] {
	const id = new URL(raw.url).searchParams.get("id");
	const found = FRED_SERIES.find((s) => s.fredId === id);
	if (!found) throw new SchemaError(`FRED: serie inesperada ${id ?? "(ninguna)"}`);
	return found;
}

export function parseCsv(raw: RawResponse, fredId: string): { date: string; value: number }[] {
	const lines = raw.body.replace(/^﻿/, "").split(/\r?\n/);
	const header = (lines[0] ?? "").trim();
	if (header !== `observation_date,${fredId}` && header !== `DATE,${fredId}`) {
		throw new SchemaError(`FRED ${fredId}: cabecera inesperada «${header.slice(0, 80)}»`);
	}
	const out: { date: string; value: number }[] = [];
	for (const line of lines.slice(1)) {
		const [date, text] = line.trim().split(",");
		if (!date || text === undefined || text === "" || text === ".") continue;
		const value = Number(text);
		if (utcDateToMs(date) === null || !Number.isFinite(value) || value <= 0) continue;
		out.push({ date, value });
	}
	return out;
}

export const fredOil: Adapter<OilPrice> = {
	id: "fred-oil",
	layer: "oil",
	name: { es: "Petróleo: Brent y WTI (EIA vía FRED)", en: "Oil: Brent and WTI (EIA via FRED)" },
	provider: "U.S. EIA vía FRED",
	homepage: "https://fred.stlouisfed.org/series/DCOILBRENTEU",
	licence: EIA_VIA_FRED,
	keys: [],
	// Daily data published once a day; every 6 h is plenty.
	intervalMs: 6 * 3_600_000,
	// Stale when the newest trading day is more than 6 calendar days old (≈ 4 business days).
	freshness: { fetchMs: 24 * 3_600_000, dataMs: 6 * 86_400_000 },

	async fetch(ctx) {
		const out: RawResponse[] = [];
		for (const s of FRED_SERIES) {
			out.push(
				await ctx.http.request(csvUrl(s.fredId, ctx.now()), {
					headers: { "user-agent": fredUserAgent(Bun.version), accept: "text/csv" },
					hostGapMs: 3_000,
					maxBytes: 1024 * 1024,
					signal: ctx.signal,
				}),
			);
		}
		return out;
	},

	normalise(raws) {
		if (raws.length === 0) throw new SchemaError("no response");
		const out: Observation<OilPrice>[] = [];
		for (const raw of raws) {
			const s = seriesOf(raw);
			const rows = parseCsv(raw, s.fredId);
			if (rows.length === 0) throw new SchemaError(`FRED ${s.fredId}: sin datos`);
			for (const row of rows) {
				const observedAt = utcDateToMs(row.date) as number;
				if (observedAt > raw.fetchedAt) continue;
				out.push({
					source: "fred-oil",
					series: s.series,
					sourceUrl: `https://fred.stlouisfed.org/series/${s.fredId}`,
					fetchedAt: raw.fetchedAt,
					observedAt,
					licence: EIA_VIA_FRED.id,
					value: { usdPerBarrel: row.value, date: row.date },
					confidence: 1,
					basis: "official",
				});
			}
		}
		return out;
	},
};
