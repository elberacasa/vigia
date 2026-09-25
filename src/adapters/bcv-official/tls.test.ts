import { expect, test } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import type { FetchContext, HttpLike, RequestOptions } from "../../core/types.ts";
import { HttpError } from "../../core/types.ts";
import { BCV_CHAIN_PEM, BCV_CHAIN_SHA256, BcvTlsError, bcvRequest, isCertificateError } from "./tls.ts";

function certificates(pem: string): Buffer[] {
	return [...pem.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)].map((m) =>
		Buffer.from((m[1] ?? "").replace(/\s+/g, ""), "base64"),
	);
}

const fingerprint = (der: Buffer) =>
	createHash("sha256")
		.update(der)
		.digest("hex")
		.toUpperCase()
		.replace(/(..)(?!$)/g, "$1:");

test("bcv-chain.pem holds exactly the pinned Sectigo DV R36 intermediate and Root R46", () => {
	const certs = certificates(BCV_CHAIN_PEM);
	expect(certs.map(fingerprint)).toEqual([...BCV_CHAIN_SHA256]);
	const [intermediate, root] = certs.map((der) => new X509Certificate(der));
	expect(intermediate?.subject).toContain("CN=Sectigo Public Server Authentication CA DV R36");
	expect(intermediate?.issuer).toContain("CN=Sectigo Public Server Authentication Root R46");
	expect(root?.subject).toBe(root?.issuer ?? "");
	expect(intermediate?.verify(root?.publicKey as NonNullable<typeof root>["publicKey"])).toBe(true);
});

test("the shipped chain is valid for at least another year", () => {
	for (const der of certificates(BCV_CHAIN_PEM)) {
		const cert = new X509Certificate(der);
		expect(Date.parse(cert.validTo)).toBeGreaterThan(Date.now() + 365 * 86_400_000);
	}
});

function fakeContext(results: ((options: RequestOptions) => never | string)[]): {
	ctx: FetchContext;
	calls: RequestOptions[];
} {
	const calls: RequestOptions[] = [];
	const http: HttpLike = {
		async request(url, options = {}) {
			calls.push(options);
			const next = results.shift();
			if (!next) throw new Error("unexpected request");
			const body = next(options);
			return { url, status: 200, contentType: "text/html", body, fetchedAt: 0 };
		},
	};
	return {
		ctx: { http, key: () => undefined, now: () => 0, signal: new AbortController().signal },
		calls,
	};
}

const certFail = (): never => {
	throw new HttpError("network: unable to verify the first certificate", 0, "https://www.bcv.org.ve/");
};

test("uses the shipped chain first", async () => {
	const { ctx, calls } = fakeContext([() => "ok"]);
	expect((await bcvRequest(ctx, "https://www.bcv.org.ve/")).body).toBe("ok");
	expect(calls[0]?.ca).toBe(BCV_CHAIN_PEM);
});

test("falls back to the system store when the shipped chain no longer matches", async () => {
	const { ctx, calls } = fakeContext([certFail, () => "fixed server"]);
	expect((await bcvRequest(ctx, "https://www.bcv.org.ve/")).body).toBe("fixed server");
	expect(calls[1]?.ca).toBeUndefined();
});

test("when both fail on certificates, the error says how to fix it", async () => {
	const { ctx } = fakeContext([certFail, certFail]);
	const error = await bcvRequest(ctx, "https://www.bcv.org.ve/").catch((e: unknown) => e);
	expect(error).toBeInstanceOf(BcvTlsError);
	expect((error as Error).message).toContain("bcv-chain.pem");
	expect((error as Error).message).toContain("2026-11-20");
	expect((error as Error).message).toContain("Nunca desactives la verificación TLS");
});

test("a non-certificate failure is not retried against the system store", async () => {
	const { ctx, calls } = fakeContext([
		() => {
			throw new HttpError("HTTP 503 from www.bcv.org.ve", 503, "https://www.bcv.org.ve/");
		},
	]);
	await expect(bcvRequest(ctx, "https://www.bcv.org.ve/")).rejects.toThrow("503");
	expect(calls.length).toBe(1);
	expect(isCertificateError(new HttpError("network: timed out", 0, "x"))).toBe(false);
	expect(isCertificateError(new HttpError("network: unable to get local issuer certificate", 0, "x"))).toBe(
		true,
	);
});
