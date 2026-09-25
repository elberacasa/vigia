import type { Adapter, Licence, Observation } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { caracasDay, parseVeNumber } from "../../formats/time.ts";
import { bcvRequest } from "./tls.ts";

/**
 * Banco Central de Venezuela, "Tipo de Cambio de Referencia" on the home page: the official rate used for
 * prices, taxes and customs, published for USD, EUR, CNY, TRY and RUB. The figure shown is the ask (venta),
 * the weighted average of the day's bank FX-desk operations.
 *
 * Quirks:
 * - The BCV publishes the next business day's rate in the afternoon, so the page's "Fecha Valor" is often
 *   in the future (Thursday evening shows Friday's rate; Friday shows Monday's). `observedAt` is the Fecha
 *   Valor at 00:00 Caracas; the panel shows the latest one that is already in force as "vigente" and a
 *   future one as "próxima".
 * - A stale 2019 block ("Fecha de Publicación: 15/05/2019", Compra/Venta in old bolívares) is still in the
 *   HTML. We anchor only on `id="dolar"` (etc.) and `strong.strong-tb`, and the Fecha Valor inside
 *   `.pull-right.dinpro` right after the currency blocks.
 * - Broken TLS chain: see tls.ts.
 */

export const BCV_LICENCE: Licence = {
	id: "bcv-attribution-nc",
	name: "BCV: reproducción sin fines de lucro citando la fuente",
	url: "https://www.bcv.org.ve/terminos-condiciones",
	attribution: "Fuente: Banco Central de Venezuela (bcv.org.ve)",
	commercial: false,
};

export const BCV_HOME = "https://www.bcv.org.ve/";

export type BcvCurrency = "USD" | "EUR" | "CNY" | "TRY" | "RUB";

export type BcvRate = {
	readonly currency: BcvCurrency;
	/** Bolívares per one unit of the currency (ask/venta), as published. */
	readonly vesPerUnit: number;
	/** The BCV's "Fecha Valor" (Caracas calendar day the rate is in force from), "YYYY-MM-DD". */
	readonly valueDate: string;
};

const BLOCKS: readonly { readonly id: string; readonly currency: BcvCurrency; readonly required: boolean }[] =
	[
		{ id: "dolar", currency: "USD", required: true },
		{ id: "euro", currency: "EUR", required: false },
		{ id: "yuan", currency: "CNY", required: false },
		{ id: "lira", currency: "TRY", required: false },
		{ id: "rublo", currency: "RUB", required: false },
	];

const DAY = 86_400_000;
/** The BCV publishes up to one business day ahead; Holy Week or Carnaval can push that to ~6 calendar days. */
const MAX_FUTURE_MS = 7 * DAY;
/** An older Fecha Valor means the page layout changed (or the BCV stopped publishing): fail loudly. */
const MAX_PAST_MS = 60 * DAY;

/**
 * Whether a Fecha Valor (00:00 Caracas of its day) is plausible for a read at `fetchedAt`: at most 7 days ahead
 * (the next business day, stretched by Holy Week or Carnaval) and at most 60 days behind. Shared by every route to
 * the official rate, so they all accept and reject the same dates.
 */
export function valueDateInRange(observedAt: number, fetchedAt: number): boolean {
	const delta = observedAt - fetchedAt;
	return delta <= MAX_FUTURE_MS && -delta <= MAX_PAST_MS;
}

export function seriesFor(currency: BcvCurrency): string {
	return `${currency.toLowerCase()}-ves`;
}

/** The HTML of one currency block: from its `id` to the next `<div id=` or the Fecha Valor footer. */
function block(html: string, id: string): string | null {
	const start = html.indexOf(`id="${id}"`);
	if (start < 0) return null;
	const rest = html.slice(start + id.length + 5);
	const ends = [rest.search(/<div\s+id="/), rest.search(/class="pull-right dinpro/)].filter((i) => i >= 0);
	return rest.slice(0, ends.length > 0 ? Math.min(...ends) : 2_000);
}

export function parseRate(html: string, id: string, currency: BcvCurrency): number | null {
	const b = block(html, id);
	if (b === null) return null;
	const code = /<span>\s*([A-Z]{3})\s*<\/span>/.exec(b)?.[1];
	if (code !== currency) return null;
	const text = /<strong class="strong-tb">\s*([\d.,]+)\s*<\/strong>/.exec(b)?.[1];
	if (text === undefined) return null;
	const n = parseVeNumber(text);
	return n !== null && n > 0 ? n : null;
}

/** The Fecha Valor of the rate blocks: the `.pull-right.dinpro` footer after `id="dolar"`. */
export function parseValueDate(html: string): { valueDate: string; observedAt: number } | null {
	const anchor = html.indexOf('id="dolar"');
	if (anchor < 0) return null;
	const footer = html.slice(anchor).match(/class="pull-right dinpro[^"]*"[\s\S]{0,600}?<\/div>/)?.[0];
	if (!footer || !/Fecha Valor/.test(footer)) return null;
	const content = /content="(\d{4}-\d{2}-\d{2})T00:00:00(-04:00|-0400)"/.exec(footer);
	if (!content?.[1]) return null;
	const observedAt = Date.parse(`${content[1]}T00:00:00-04:00`);
	if (Number.isNaN(observedAt) || caracasDay(observedAt) !== content[1]) return null;
	return { valueDate: content[1], observedAt };
}

export const bcvOfficial: Adapter<BcvRate> = {
	id: "bcv-official",
	layer: "money",
	name: { es: "Tipo de cambio oficial (BCV)", en: "Official exchange rate (BCV)" },
	provider: "Banco Central de Venezuela",
	homepage: BCV_HOME,
	licence: BCV_LICENCE,
	keys: [],
	// The rate changes once per business day (published ~15:30-16:00 Caracas); every 30 min catches it
	// within half an hour at ~150 KB per request.
	intervalMs: 30 * 60_000,
	// Newest Fecha Valor older than 4 days (a long weekend plus a holiday) means the BCV has not published.
	freshness: { fetchMs: 6 * 3_600_000, dataMs: 4 * DAY },

	async fetch(ctx) {
		return [await bcvRequest(ctx, BCV_HOME, { headers: { accept: "text/html" }, maxBytes: 2 * 1024 * 1024 })];
	},

	normalise(raws) {
		const raw = raws[0];
		if (!raw) throw new SchemaError("no response");
		const html = raw.body;
		const date = parseValueDate(html);
		if (!date) throw new SchemaError('BCV: no se encontró la «Fecha Valor» junto al bloque id="dolar"');
		if (!valueDateInRange(date.observedAt, raw.fetchedAt)) {
			throw new SchemaError(
				`BCV: Fecha Valor ${date.valueDate} fuera de rango respecto a la hora de consulta`,
			);
		}
		const out: Observation<BcvRate>[] = [];
		for (const { id, currency, required } of BLOCKS) {
			const rate = parseRate(html, id, currency);
			if (rate === null) {
				if (required) throw new SchemaError(`BCV: no se pudo leer la tasa ${currency} (bloque id="${id}")`);
				continue;
			}
			out.push({
				source: "bcv-official",
				series: seriesFor(currency),
				sourceUrl: BCV_HOME,
				fetchedAt: raw.fetchedAt,
				observedAt: date.observedAt,
				licence: BCV_LICENCE.id,
				value: { currency, vesPerUnit: rate, valueDate: date.valueDate },
				confidence: 1,
				basis: "official",
			});
		}
		return out;
	},
};
