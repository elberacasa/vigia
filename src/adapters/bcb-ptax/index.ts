import { z } from "zod";
import type { Adapter, Licence, Observation } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";

/**
 * Brazil's official dollar rate, the PTAX (reais per US dollar), from the Banco Central do Brasil's open-data
 * OData service (Olinda, `CotacaoDolarPeriodo`). Brazil is Venezuela's southern neighbour (Roraima, the Santa Elena
 * de Uairén border). We store the closing PTAX sell rate (`cotacaoVenda`, the reference used to settle contracts)
 * and the buy rate.
 *
 * Verified 2026-09-24: one closing row per business day, `dataHoraCotacao` "2026-09-24 13:03:18.656275" in Brasília
 * time (UTC−3; no daylight saving since 2019), ~1 s, ~25 KB for 400 days. No key.
 *
 * Licence: Open Data Commons ODbL (dadosabertos.bcb.gov.br, dataset "Dólar americano (USD): todos os boletins
 * diários"), attribution to the Banco Central do Brasil.
 */

export const PTAX_LICENCE: Licence = {
	id: "odbl-bcb",
	name: "ODbL (Banco Central do Brasil, dados abertos)",
	url: "https://opendatacommons.org/licenses/odbl/",
	attribution: "Fuente: Banco Central do Brasil, PTAX",
	commercial: true,
};

export const PTAX_PAGE = "https://www.bcb.gov.br/estabilidadefinanceira/historicocotacoes";
const DAY = 86_400_000;
const WINDOW_DAYS = 400;
/** Rows come stamped by the BCB's clock; a few minutes ahead of ours is skew, more is a bad row. */
const MAX_SKEW_MS = 10 * 60_000;

export type PtaxRate = {
	/** Reais per US dollar, PTAX sell rate. */
	readonly brlPerUsd: number;
	/** PTAX buy rate. */
	readonly buy: number;
	/** Brasília calendar day, "YYYY-MM-DD". */
	readonly date: string;
};

/** "MM-DD-YYYY", the service's date format. */
function mdy(ms: number): string {
	const iso = new Date(ms - 3 * 3_600_000).toISOString();
	return `${iso.slice(5, 7)}-${iso.slice(8, 10)}-${iso.slice(0, 4)}`;
}

export function ptaxUrl(now: number): string {
	return (
		"https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/" +
		"CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)" +
		`?@dataInicial='${mdy(now - WINDOW_DAYS * DAY)}'&@dataFinalCotacao='${mdy(now)}'` +
		"&$format=json&$select=cotacaoCompra,cotacaoVenda,dataHoraCotacao"
	);
}

const Row = z.object({
	cotacaoCompra: z.number().positive().finite(),
	cotacaoVenda: z.number().positive().finite(),
	dataHoraCotacao: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/),
});
const Envelope = z.object({ value: z.array(z.unknown()) });

/** "2026-09-24 13:03:18.656275" (Brasília) → epoch ms; null if not a real instant. */
export function brasiliaToMs(text: string): number | null {
	const [day, time] = text.split(" ");
	if (!day || !time) return null;
	const ms = Date.parse(`${day}T${time.slice(0, 12)}-03:00`);
	if (Number.isNaN(ms) || new Date(ms - 3 * 3_600_000).toISOString().slice(0, 10) !== day) return null;
	return ms;
}

export const bcbPtax: Adapter<PtaxRate> = {
	id: "bcb-ptax",
	layer: "money",
	name: { es: "Real brasileño: PTAX oficial", en: "Brazilian real: official PTAX" },
	provider: "Banco Central do Brasil",
	homepage: PTAX_PAGE,
	licence: PTAX_LICENCE,
	keys: [],
	// Closing PTAX is set ~13:00 Brasília each business day.
	intervalMs: 3 * 3_600_000,
	freshness: { fetchMs: 12 * 3_600_000, dataMs: 5 * DAY },

	async fetch(ctx) {
		return [
			await ctx.http.request(ptaxUrl(ctx.now()), {
				headers: { accept: "application/json" },
				hostGapMs: 2_000,
				maxBytes: 1024 * 1024,
				signal: ctx.signal,
			}),
		];
	},

	normalise(raws) {
		const raw = raws[0];
		if (!raw) throw new SchemaError("no response");
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw.body);
		} catch {
			throw new SchemaError("BCB Olinda: la respuesta no es JSON");
		}
		const envelope = Envelope.safeParse(parsed);
		if (!envelope.success) throw new SchemaError("BCB Olinda: falta la lista «value»");
		const out: Observation<PtaxRate>[] = [];
		for (const item of envelope.data.value) {
			const row = Row.safeParse(item);
			if (!row.success) continue;
			const observedAt = brasiliaToMs(row.data.dataHoraCotacao);
			if (observedAt === null || observedAt - raw.fetchedAt > MAX_SKEW_MS) continue;
			out.push({
				source: "bcb-ptax",
				series: "usd-brl",
				sourceUrl: PTAX_PAGE,
				fetchedAt: raw.fetchedAt,
				observedAt,
				licence: PTAX_LICENCE.id,
				value: {
					brlPerUsd: row.data.cotacaoVenda,
					buy: row.data.cotacaoCompra,
					date: row.data.dataHoraCotacao.slice(0, 10),
				},
				confidence: 1,
				basis: "official",
			});
		}
		if (envelope.data.value.length > 0 && out.length === 0) {
			throw new SchemaError("BCB Olinda: ninguna fila válida de la PTAX");
		}
		return out;
	},
};
