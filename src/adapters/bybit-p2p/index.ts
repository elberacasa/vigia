import { z } from "zod";
import type { Adapter, Licence, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { type P2pAd, type P2pSample, sample, TICKET_VES } from "../binance-p2p/median.ts";

/**
 * Bybit P2P, USDT/VES: a second, independent venue (a thinner book than Binance), with the same robust
 * median (binance-p2p/median.ts). Shown as "Bybit P2P, mediana de los 10 mejores anuncios (USDT/VES)".
 *
 * Opt-in: undocumented internal endpoint; Bybit's terms could not be checked without a browser.
 * Privacy: advertiser names, user/account ids and free-text remarks are never parsed or stored.
 *
 * `side` is the *advertiser's* side: "1" = advertisers selling USDT (the taker buys), cheapest first;
 * "0" = advertisers buying (the taker sells), highest first. `amount` filters to ads that accept the ticket.
 */

export const BYBIT_LICENCE: Licence = {
	id: "bybit-p2p-terms",
	name: "Bybit: términos de uso (no verificados; API interna; fuente opcional)",
	url: "https://www.bybit.com/es-ES/help-center/article/Bybit-Terms-of-Service",
	attribution: "Fuente: Bybit P2P (anuncios públicos)",
	commercial: false,
};

export const BYBIT_ONLINE_URL = "https://api2.bybit.com/fiat/otc/item/online";
export const BYBIT_PAGE = "https://www.bybit.com/fiat/trade/otc/buy/USDT/VES";
export const BYBIT_LABEL = "Bybit P2P, mediana de los 10 mejores anuncios (USDT/VES)";

export const BYBIT_IDENTIFYING_KEYS = [
	"id",
	"accountId",
	"userId",
	"nickName",
	"userMaskId",
	"remark",
	"makerContact",
	"lastLogoutTime",
] as const;

export function onlineBody(side: "0" | "1", ticketVes = TICKET_VES): string {
	return JSON.stringify({
		userId: "",
		tokenId: "USDT",
		currencyId: "VES",
		payment: [],
		side,
		size: "20",
		page: "1",
		amount: String(ticketVes),
		authMaker: false,
		canTrade: false,
	});
}

const num = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)]).transform(Number);

const Item = z.object({
	tokenId: z.literal("USDT"),
	currencyId: z.literal("VES"),
	side: z.union([z.literal(0), z.literal(1)]),
	price: num,
	lastQuantity: num,
	minAmount: num,
	maxAmount: num,
	recentOrderNum: z.number(),
	/** Percent, 0-100. */
	recentExecuteRate: z.number(),
});

const Envelope = z.object({
	ret_code: z.number(),
	ret_msg: z.string().nullable().optional(),
	result: z
		.object({
			count: z.number().nullable().optional(),
			items: z.array(z.unknown()).nullable(),
		})
		.nullable(),
});

function side(raw: RawResponse, advertiserSide: 0 | 1): { ads: P2pAd[]; total: number | null } {
	let body: unknown;
	try {
		body = JSON.parse(raw.body);
	} catch {
		throw new SchemaError("Bybit P2P: la respuesta no es JSON (¿bloqueo?)");
	}
	const env = Envelope.safeParse(body);
	if (!env.success) throw new SchemaError(`Bybit P2P: ${env.error.message}`);
	if (env.data.ret_code !== 0 || !env.data.result) {
		throw new SchemaError(
			`Bybit P2P respondió ${env.data.ret_code}: ${(env.data.ret_msg ?? "").slice(0, 200)}`,
		);
	}
	const ads: P2pAd[] = [];
	for (const item of env.data.result.items ?? []) {
		const parsed = Item.safeParse(item);
		if (!parsed.success) continue;
		const a = parsed.data;
		if (a.side !== advertiserSide) {
			throw new SchemaError(`Bybit P2P: se esperaban anuncios del lado ${advertiserSide} y llegó ${a.side}`);
		}
		ads.push({
			priceVes: a.price,
			tradable: true,
			minVes: a.minAmount,
			maxVes: a.maxAmount,
			availableAsset: a.lastQuantity,
			orders30d: a.recentOrderNum,
			completion: a.recentExecuteRate / 100,
		});
	}
	return { ads, total: env.data.result.count ?? null };
}

export const bybitP2p: Adapter<P2pSample> = {
	id: "bybit-p2p",
	layer: "money",
	name: { es: "Bybit P2P (USDT/VES)", en: "Bybit P2P (USDT/VES)" },
	provider: "Bybit",
	homepage: BYBIT_PAGE,
	licence: BYBIT_LICENCE,
	keys: [],
	intervalMs: 10 * 60_000,
	freshness: { fetchMs: 40 * 60_000, dataMs: 40 * 60_000 },
	optIn: {
		es:
			"Esta fuente usa una API interna no documentada de Bybit que puede cambiar o bloquearse sin aviso, y no " +
			"pudimos verificar si sus términos permiten el acceso automatizado. Vigía la consulta con suavidad " +
			"(2 peticiones cada 10 minutos) y nunca guarda nombres ni identificadores de anunciantes. Actívala " +
			"solo si aceptas ese riesgo.",
		en:
			"This source uses an undocumented internal Bybit API that may change or block you without notice, and we " +
			"could not verify whether its terms allow automated access. Vigía polls it gently (2 requests every " +
			"10 minutes) and never stores advertiser names or ids. Turn it on only if you accept that risk.",
	},

	async fetch(ctx) {
		const out: RawResponse[] = [];
		// Taker buys first (advertisers selling, side 1), then taker sells (side 0), as for Binance.
		for (const s of ["1", "0"] as const) {
			out.push(
				await ctx.http.request(BYBIT_ONLINE_URL, {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: onlineBody(s),
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
		if (!buyRaw || !sellRaw) throw new SchemaError("Bybit P2P: faltan respuestas (se esperan 2)");
		const buy = side(buyRaw, 1);
		const sell = side(sellRaw, 0);
		const fetchedAt = Math.max(buyRaw.fetchedAt, sellRaw.fetchedAt);
		return [
			{
				source: "bybit-p2p",
				series: "usdt-ves",
				sourceUrl: BYBIT_PAGE,
				fetchedAt,
				observedAt: fetchedAt,
				licence: BYBIT_LICENCE.id,
				value: sample(buy.ads, sell.ads, { takerBuy: buy.total, takerSell: sell.total }),
				confidence: 0.8,
				basis: "quote",
			},
		];
	},
};
