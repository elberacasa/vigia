import { z } from "zod";
import type { Adapter, Licence, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { type P2pAd, type P2pSample, sample, TICKET_VES } from "./median.ts";

/**
 * Binance P2P, USDT/VES: the raw market most Venezuelan "dólar paralelo" figures are built on. Two requests
 * per sample (taker buys USDT, taker sells USDT), 20 ads each, filtered to a retail ticket; the robust median
 * is computed in median.ts. Shown as "Binance P2P, mediana de los 10 mejores anuncios (USDT/VES)".
 *
 * Opt-in: Binance's terms forbid automated access and this is an undocumented internal endpoint.
 * Privacy: only prices, limits, stock and completion stats are read. Advertiser names, user numbers and ad
 * numbers are never parsed, stored or shown (and are redacted from the recorded fixtures).
 *
 * `tradeType` in the request is the *taker's* side: "BUY" returns ads of advertisers who sell USDT, cheapest
 * first; "SELL" returns advertisers who buy, highest first. `rows` above 20 is rejected ("illegal parameter").
 */

export const BINANCE_LICENCE: Licence = {
	id: "binance-p2p-terms",
	name: "Binance: términos de uso (prohíben el acceso automatizado; fuente opcional)",
	url: "https://www.binance.com/es/terms",
	attribution: "Fuente: Binance P2P (anuncios públicos)",
	commercial: false,
};

export const BINANCE_SEARCH_URL = "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search";
export const BINANCE_PAGE = "https://p2p.binance.com/es/trade/all-payments/USDT?fiat=VES";
export const BINANCE_LABEL = "Binance P2P, mediana de los 10 mejores anuncios (USDT/VES)";

export const BINANCE_IDENTIFYING_KEYS = [
	"nickName",
	"realName",
	"userNo",
	"advNo",
	"email",
	"mobile",
	"userIdentity",
	"tagIconUrls",
	"payAccount",
	"payId",
	"remarks",
	"autoReplyMsg",
] as const;

export function searchBody(tradeType: "BUY" | "SELL", ticketVes = TICKET_VES): string {
	return JSON.stringify({
		fiat: "VES",
		asset: "USDT",
		tradeType,
		page: 1,
		rows: 20,
		payTypes: [],
		publisherType: null,
		transAmount: String(ticketVes),
		countries: [],
	});
}

const num = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)]).transform(Number);

const Ad = z.object({
	adv: z.object({
		tradeType: z.enum(["BUY", "SELL"]),
		asset: z.literal("USDT"),
		fiatUnit: z.literal("VES"),
		price: num,
		tradableQuantity: num,
		minSingleTransAmount: num,
		maxSingleTransAmount: num,
		dynamicMaxSingleTransAmount: num.nullable().optional(),
		isTradable: z.boolean().nullable().optional(),
	}),
	advertiser: z.object({
		monthOrderCount: z.number().nullable(),
		monthFinishRate: z.number().nullable(),
	}),
});

const Envelope = z.object({
	code: z.string(),
	message: z.string().nullable().optional(),
	success: z.boolean(),
	data: z.array(z.unknown()).nullable(),
	total: z.number().nullable().optional(),
});

function side(raw: RawResponse, takerSide: "BUY" | "SELL"): { ads: P2pAd[]; total: number | null } {
	let body: unknown;
	try {
		body = JSON.parse(raw.body);
	} catch {
		throw new SchemaError("Binance P2P: la respuesta no es JSON (¿bloqueo o desafío anti-bot?)");
	}
	const env = Envelope.safeParse(body);
	if (!env.success) throw new SchemaError(`Binance P2P: ${env.error.message}`);
	if (env.data.code !== "000000" || !env.data.success) {
		throw new SchemaError(
			`Binance P2P respondió ${env.data.code}: ${(env.data.message ?? "").slice(0, 200)}`,
		);
	}
	// The advertiser's side is the opposite of the taker's.
	const advertiserSide = takerSide === "BUY" ? "SELL" : "BUY";
	const ads: P2pAd[] = [];
	for (const item of env.data.data ?? []) {
		const parsed = Ad.safeParse(item);
		if (!parsed.success) continue;
		const { adv, advertiser } = parsed.data;
		if (adv.tradeType !== advertiserSide) {
			throw new SchemaError(`Binance P2P: se esperaban anuncios ${advertiserSide} y llegó ${adv.tradeType}`);
		}
		ads.push({
			priceVes: adv.price,
			tradable: adv.isTradable !== false,
			minVes: adv.minSingleTransAmount,
			maxVes: Math.min(adv.maxSingleTransAmount, adv.dynamicMaxSingleTransAmount ?? Number.POSITIVE_INFINITY),
			availableAsset: adv.tradableQuantity,
			orders30d: advertiser.monthOrderCount ?? 0,
			completion: advertiser.monthFinishRate ?? 0,
		});
	}
	return { ads, total: env.data.total ?? null };
}

export const binanceP2p: Adapter<P2pSample> = {
	id: "binance-p2p",
	layer: "money",
	name: { es: "Binance P2P (USDT/VES)", en: "Binance P2P (USDT/VES)" },
	provider: "Binance",
	homepage: BINANCE_PAGE,
	licence: BINANCE_LICENCE,
	keys: [],
	// Gentle: one pair of requests every 10 minutes, 5 s apart.
	intervalMs: 10 * 60_000,
	freshness: { fetchMs: 40 * 60_000, dataMs: 40 * 60_000 },
	optIn: {
		es:
			"Los términos de Binance prohíben el acceso automatizado, y esta fuente usa una API interna no " +
			"documentada que puede cambiar o bloquearse sin aviso. Vigía la consulta con suavidad (2 peticiones " +
			"cada 10 minutos) y nunca guarda nombres ni identificadores de anunciantes. Actívala solo si aceptas " +
			"ese riesgo; sin ella, Yadio sigue mostrando la tasa del mercado P2P.",
		en:
			"Binance's terms forbid automated access, and this source uses an undocumented internal API that may " +
			"change or block you without notice. Vigía polls it gently (2 requests every 10 minutes) and never " +
			"stores advertiser names or ids. Turn it on only if you accept that risk; without it, Yadio still " +
			"shows the P2P market rate.",
	},

	async fetch(ctx) {
		const out: RawResponse[] = [];
		for (const tradeType of ["BUY", "SELL"] as const) {
			out.push(
				await ctx.http.request(BINANCE_SEARCH_URL, {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: searchBody(tradeType),
					hostGapMs: 5_000,
					retries: 1,
					maxBytes: 1024 * 1024,
					signal: ctx.signal,
				}),
			);
		}
		return out;
	},

	normalise(raws) {
		const [buyRaw, sellRaw] = raws;
		if (!buyRaw || !sellRaw) throw new SchemaError("Binance P2P: faltan respuestas (se esperan 2)");
		const buy = side(buyRaw, "BUY");
		const sell = side(sellRaw, "SELL");
		const fetchedAt = Math.max(buyRaw.fetchedAt, sellRaw.fetchedAt);
		return [
			{
				source: "binance-p2p",
				series: "usdt-ves",
				sourceUrl: BINANCE_PAGE,
				fetchedAt,
				// The book is live: the sample is true when we read it.
				observedAt: fetchedAt,
				licence: BINANCE_LICENCE.id,
				value: sample(buy.ads, sell.ads, { takerBuy: buy.total, takerSell: sell.total }),
				confidence: 0.8,
				basis: "quote",
			},
		];
	},
};
