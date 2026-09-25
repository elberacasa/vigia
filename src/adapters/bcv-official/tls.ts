import type { FetchContext, RawResponse, RequestOptions } from "../../core/types.ts";
import { HttpError } from "../../core/types.ts";
import BCV_CHAIN from "./bcv-chain.pem" with { type: "text" };

/**
 * Every request to bcv.org.ve goes through here. The BCV serves the wrong intermediate certificate, so we
 * verify against the chain shipped in `bcv-chain.pem` (the right Sectigo intermediate + its root). TLS is
 * always verified: never `rejectUnauthorized: false`.
 *
 * If the chain stops working (the leaf expires 2026-11-20; a renewal may come from another intermediate), we
 * retry once against the system trust store, which works if the BCV has fixed its server. If both fail on a
 * certificate error, the run fails with `BCV_TLS_HELP`, which tells the user exactly what to do.
 */

export const BCV_CHAIN_PEM: string = BCV_CHAIN;

/** SHA-256 of each certificate in bcv-chain.pem (DER), in file order. Pinned by tls.test.ts. */
export const BCV_CHAIN_SHA256 = [
	"8C:54:C3:34:B6:6B:A4:E4:26:77:2A:F4:A3:F9:13:6C:19:A1:AE:C7:29:FD:B2:8C:53:5C:07:A5:A4:EF:22:E0",
	"7B:B6:47:A6:2A:EE:AC:88:BF:25:7A:A5:22:D0:1F:FE:A3:95:E0:AB:45:C7:3F:93:F6:56:54:EC:38:F2:5A:06",
] as const;

export const BCV_TLS_HELP =
	"El certificado TLS de bcv.org.ve no se pudo verificar ni con la cadena incluida " +
	"(src/adapters/bcv-official/bcv-chain.pem) ni con el almacén del sistema. Lo más probable: el BCV renovó su " +
	"certificado (el anterior vencía el 2026-11-20) con otro intermediario. Solución: actualiza Vigía; o bien " +
	"descarga el intermediario de la URL «CA Issuers» (AIA) del nuevo certificado " +
	"(openssl s_client -connect www.bcv.org.ve:443 -showcerts | openssl x509 -noout -ext authorityInfoAccess), " +
	"conviértelo a PEM y reemplaza bcv-chain.pem. Nunca desactives la verificación TLS. / " +
	"BCV TLS certificate failed with the shipped chain and the system store; the BCV probably renewed its " +
	"certificate with another intermediate: update Vigía or replace bcv-chain.pem with the new leaf's AIA issuer.";

export class BcvTlsError extends Error {
	override readonly name = "BcvTlsError";
	constructor(readonly causes: readonly string[]) {
		super(`${BCV_TLS_HELP} (${causes.join(" | ")})`);
	}
}

const CERT_ERROR =
	/certificate|self[- ]signed|issuer|CERT_|UNABLE_TO_|unable to verify|unable to get local|verify the first/i;

/** A name mismatch is not a missing-intermediate problem: it must not trigger the chain help. */
const NAME_MISMATCH = /altname|hostname|does not match|ERR_TLS_CERT_ALTNAME/i;

export function isCertificateError(error: unknown): boolean {
	return (
		error instanceof HttpError &&
		error.status === 0 &&
		CERT_ERROR.test(error.message) &&
		!NAME_MISMATCH.test(error.message)
	);
}

/** The BCV asks for no rate limit; we keep at least 5 s between requests to its host. */
export const BCV_HOST_GAP_MS = 5_000;

export async function bcvRequest(
	ctx: FetchContext,
	url: string,
	options: RequestOptions = {},
): Promise<RawResponse> {
	const base: RequestOptions = { hostGapMs: BCV_HOST_GAP_MS, signal: ctx.signal, ...options };
	try {
		return await ctx.http.request(url, { ...base, ca: BCV_CHAIN_PEM });
	} catch (first) {
		if (!isCertificateError(first)) throw first;
		try {
			// No `ca`: the system trust store. Works if the BCV now sends a correct chain.
			return await ctx.http.request(url, { ...base, retries: 0 });
		} catch (second) {
			if (!isCertificateError(second)) throw second;
			throw new BcvTlsError([String((first as Error).message), String((second as Error).message)]);
		}
	}
}
