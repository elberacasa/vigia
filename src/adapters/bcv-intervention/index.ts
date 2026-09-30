import { Conditional } from "../../core/conditional.ts";
import type { Adapter, Observation } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { caracasDateToMs, parseVeNumber } from "../../formats/time.ts";
import { type PublishedUnit, unitOn } from "../bcv-history/index.ts";
import { BCV_LICENCE } from "../bcv-official/index.ts";
import { bcvRequest } from "../bcv-official/tls.ts";

/**
 * BCV foreign-exchange intervention ("Intervención cambiaria › Intervenciones"): the days on which the BCV sold
 * foreign currency to the banks' FX desks, each with the intervention's number ("030-26": the 30th of 2026, one per
 * week) and the exchange rate of the operation in bolívares per euro. The BCV publishes no amounts: the page says
 * when it intervened and at what rate, never how much. Vigía says exactly that.
 *
 * Measured 2026-09-28: one Drupal page, 440,974 bytes (48,555 gzipped), every intervention since 13/05/2019 (608 rows, one day listed twice,
 * newest 28-09-2026 N° 030-26 at 976,90 Bs/EUR, published the same day), ETag + Last-Modified sent. The rate of a
 * day equals the BCV's euro reference rate for that Fecha Valor rounded to two decimals (25/09/2026: 972,65 vs
 * 972,648677). Rates before 01/10/2021 are in bolívares soberanos and are converted to today's bolívares with the
 * same legal table as the rate history (bcv-history, 1:1,000,000), each converted value saying so.
 *
 * Parsing anchors on the table's own classes (`views-field-field-fecha-del-indicador`, `…-nro-de-intervencion`,
 * `…-monto-intervencion`: the last one holds the rate despite its name) and on the ISO date in the `content`
 * attribute, never on the visible text.
 */

export const BCV_INTERVENTION_URL = "https://www.bcv.org.ve/politica-cambiaria/intervencion-cambiaria";

export type Intervention = {
	/** Day of the operation, "YYYY-MM-DD" (Caracas). */
	readonly date: string;
	/** The BCV's number, "030-26". */
	readonly number: string;
	/** Bolívares (today's) per euro. */
	readonly vesPerEur: number;
	/** The rate exactly as published, in `publishedUnit`. */
	readonly publishedRate: number;
	readonly publishedUnit: PublishedUnit;
	readonly divisor: number;
	/** Spanish note when the rate was converted from bolívares soberanos; null otherwise. */
	readonly conversion: string | null;
};

const CONVERSION_NOTE =
	"Convertido por Vigía a bolívares actuales: publicado en bolívares soberanos (Bs.S) y dividido entre 1.000.000 " +
	"(reconversión de 2021).";

const ROW = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
const DATE_CELL =
	/views-field-field-fecha-del-indicador"[^>]*>\s*<span[^>]*content="(\d{4}-\d{2}-\d{2})T00:00:00-04:00"/;
const NUMBER_CELL = /views-field-field-nro-de-intervencion"[^>]*>\s*([^<]*?)\s*<\/td>/;
const RATE_CELL = /views-field-field-monto-intervencion"[^>]*>\s*([^<]*?)\s*<\/td>/;

/** The table header must still say what the rate column is, or the page changed meaning. */
const RATE_HEADER = /views-field-field-monto-intervencion"[^>]*>\s*Tipo de Cambio Bs\.\/EUR\s*<\/th>/;

export function parseInterventions(html: string): { date: string; number: string; rate: number }[] {
	const out: { date: string; number: string; rate: number }[] = [];
	for (const m of html.matchAll(ROW)) {
		const row = m[1] ?? "";
		const date = DATE_CELL.exec(row)?.[1];
		const number = NUMBER_CELL.exec(row)?.[1];
		const rateText = RATE_CELL.exec(row)?.[1];
		if (date === undefined || number === undefined || rateText === undefined) continue;
		if (!/^\d{3}-\d{2}$/.test(number)) continue;
		const rate = parseVeNumber(rateText);
		if (rate === null || !(rate > 0)) continue;
		out.push({ date, number, rate });
	}
	return out;
}

const conditional = new Conditional();

export const bcvIntervention: Adapter<Intervention> = {
	id: "bcv-intervention",
	layer: "money",
	name: { es: "Intervención cambiaria (BCV)", en: "FX intervention (BCV)" },
	provider: "Banco Central de Venezuela",
	homepage: BCV_INTERVENTION_URL,
	licence: BCV_LICENCE,
	keys: [],
	// One row per business day, published the same afternoon; every 3 h with If-None-Match (48 KB gzipped).
	intervalMs: 3 * 3_600_000,
	// An event feed in principle (a week without intervention is news, not staleness), but the BCV has intervened
	// every business week of 2026 so far: a newest row older than 14 days is worth a stale badge and a look.
	freshness: { fetchMs: 24 * 3_600_000, dataMs: 14 * 86_400_000 },

	async fetch(ctx) {
		const raw = await bcvRequest(ctx, BCV_INTERVENTION_URL, {
			maxBytes: 4 * 1024 * 1024,
			headers: { accept: "text/html", ...conditional.headers() },
			okStatuses: conditional.okStatuses(),
		});
		conditional.remember(raw, () => bcvIntervention.normalise([raw]));
		return [raw];
	},

	normalise(raws) {
		const raw = raws[0];
		if (!raw) throw new SchemaError("no response");
		if (raw.status === 304) return [];
		if (!RATE_HEADER.test(raw.body)) {
			throw new SchemaError("BCV intervención: la tabla ya no dice «Tipo de Cambio Bs./EUR»");
		}
		const rows = parseInterventions(raw.body);
		if (rows.length === 0) throw new SchemaError("BCV intervención: tabla sin filas legibles");
		const latestAllowed = raw.fetchedAt + 86_400_000;
		// A day listed twice with different rates (2021-07-19, measured 2026-09-28) cannot be told apart: both rows
		// are dropped rather than one picked.
		const perDay = new Map<string, number>();
		for (const row of rows) perDay.set(row.date, (perDay.get(row.date) ?? 0) + 1);
		const out: Observation<Intervention>[] = [];
		for (const row of rows) {
			const observedAt = caracasDateToMs(row.date);
			if (observedAt === null || observedAt > latestAllowed || perDay.get(row.date) !== 1) continue;
			const { unit, divisor } = unitOn(row.date);
			if (unit === "Bs.F") continue; // The table starts in 2019; a bolívar fuerte date means a parsing error.
			out.push({
				source: "bcv-intervention",
				series: "intervention",
				sourceUrl: BCV_INTERVENTION_URL,
				fetchedAt: raw.fetchedAt,
				observedAt,
				licence: BCV_LICENCE.id,
				value: {
					date: row.date,
					number: row.number,
					vesPerEur: row.rate / divisor,
					publishedRate: row.rate,
					publishedUnit: unit,
					divisor,
					conversion: divisor === 1 ? null : CONVERSION_NOTE,
				},
				confidence: 1,
				basis: divisor === 1 ? "official" : "derived",
			});
		}
		return out;
	},
};
