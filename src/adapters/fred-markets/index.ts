import type { Adapter, Licence, Observation, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { utcDateToMs } from "../../formats/time.ts";
import { csvUrl, fredUserAgent, parseCsv } from "../fred-oil/index.ts";

/**
 * Daily market series around Venezuela's economy, from FRED's keyless CSV (the same endpoint and User-Agent rule
 * as `fred-oil`, which carries Brent and WTI):
 *
 * - U.S. Gulf Coast conventional gasoline (regular) and ultra-low-sulfur diesel spot prices (US$ per gallon):
 *   the Gulf Coast is where Venezuelan crude was refined for decades and the reference for the fuels Venezuela
 *   imports. EIA series EER_EPMRU_PF4_RGC_DPG and EER_EPD2DXL0_PF4_RGC_DPG, republished by FRED.
 * - Henry Hub natural gas spot price (US$ per MMBtu), EIA RNGWHHD via FRED.
 * - The Federal Reserve Board's nominal broad U.S. dollar index (goods and services, January 2006 = 100), H.10.
 *
 * Verified 2026-09-24: each CSV ~5 KB for two years, ~0.45 s; newest day 2026-09-22 for EIA series and
 * 2026-09-18 for the dollar index (the Fed publishes H.10 weekly, on Mondays, with daily values).
 * The first request of a session sometimes times out at 20 s; the shared client retries.
 *
 * Licence: EIA data are public domain; Federal Reserve Board statistical releases are public domain with
 * citation requested. FRED is the distributor, not the author.
 */

export const US_PUBLIC_DOMAIN_VIA_FRED: Licence = {
	id: "us-public-domain-via-fred",
	name: "Dominio público (U.S. EIA y Junta de la Reserva Federal), redistribuido por FRED",
	url: "https://fred.stlouisfed.org/legal/",
	attribution:
		"Fuente: U.S. Energy Information Administration y Junta de Gobernadores de la Reserva Federal, vía FRED (Federal Reserve Bank of St. Louis)",
	commercial: true,
};

export const MARKET_SERIES = [
	{
		fredId: "DGASUSGULF",
		series: "gasoline-usgc",
		labelEs: "Gasolina, Golfo de EE.UU.",
		labelEn: "Gasoline, U.S. Gulf Coast",
		unit: "US$/gal",
		author: "EIA",
	},
	{
		fredId: "DDFUELUSGULF",
		series: "diesel-usgc",
		labelEs: "Diésel, Golfo de EE.UU.",
		labelEn: "Diesel, U.S. Gulf Coast",
		unit: "US$/gal",
		author: "EIA",
	},
	{
		fredId: "DHHNGSP",
		series: "henry-hub",
		labelEs: "Gas natural, Henry Hub",
		labelEn: "Natural gas, Henry Hub",
		unit: "US$/MMBtu",
		author: "EIA",
	},
	{
		fredId: "DTWEXBGS",
		series: "usd-broad",
		labelEs: "Dólar frente a sus socios (índice amplio)",
		labelEn: "Dollar vs trading partners (broad index)",
		unit: "ene 2006 = 100",
		author: "Fed",
	},
] as const;

export type MarketSeriesId = (typeof MARKET_SERIES)[number]["series"];

export type MarketPrice = {
	readonly value: number;
	/** Unit of `value`, as shown ("US$/gal", "US$/MMBtu", "ene 2006 = 100"). */
	readonly unit: string;
	/** Trading day, "YYYY-MM-DD". */
	readonly date: string;
};

function seriesOf(raw: RawResponse): (typeof MARKET_SERIES)[number] {
	const id = new URL(raw.url).searchParams.get("id");
	const found = MARKET_SERIES.find((s) => s.fredId === id);
	if (!found) throw new SchemaError(`FRED: serie inesperada ${id ?? "(ninguna)"}`);
	return found;
}

export const fredMarkets: Adapter<MarketPrice> = {
	id: "fred-markets",
	layer: "money",
	name: {
		es: "Combustibles del Golfo, Henry Hub e índice del dólar (vía FRED)",
		en: "Gulf Coast fuels, Henry Hub and dollar index (via FRED)",
	},
	provider: "U.S. EIA y Reserva Federal vía FRED",
	homepage: "https://fred.stlouisfed.org/series/DGASUSGULF",
	licence: US_PUBLIC_DOMAIN_VIA_FRED,
	keys: [],
	// Daily data, published once a day (the dollar index once a week): every 6 h is plenty.
	intervalMs: 6 * 3_600_000,
	// The dollar index arrives weekly with a lag of up to 10 days; stale past 12 days for the feed as a whole.
	// The panel judges each series by its own cadence (see src/panels/markets.ts).
	freshness: { fetchMs: 24 * 3_600_000, dataMs: 12 * 86_400_000 },

	async fetch(ctx) {
		const out: RawResponse[] = [];
		for (const s of MARKET_SERIES) {
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
		const out: Observation<MarketPrice>[] = [];
		for (const raw of raws) {
			const s = seriesOf(raw);
			const rows = parseCsv(raw, s.fredId);
			if (rows.length === 0) throw new SchemaError(`FRED ${s.fredId}: sin datos`);
			for (const row of rows) {
				const observedAt = utcDateToMs(row.date) as number;
				if (observedAt > raw.fetchedAt) continue;
				out.push({
					source: "fred-markets",
					series: s.series,
					sourceUrl: `https://fred.stlouisfed.org/series/${s.fredId}`,
					fetchedAt: raw.fetchedAt,
					observedAt,
					licence: US_PUBLIC_DOMAIN_VIA_FRED.id,
					value: { value: row.value, unit: s.unit, date: row.date },
					confidence: 1,
					basis: "official",
				});
			}
		}
		return out;
	},
};
