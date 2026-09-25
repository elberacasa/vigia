import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { FetchContext, HttpLike, RawResponse, RequestOptions } from "../../core/types.ts";
import { HttpError } from "../../core/types.ts";
import {
	makePortalProbe,
	PORTALS,
	type PortalReading,
	type Prober,
	portalProbe,
	probe,
	reason,
} from "./index.ts";

// Probed 2026-09-25 02:04 UTC from OUTSIDE Venezuela. CANTV's record was re-labelled "bad-response" after the
// classifier learnt Bun's UnsupportedTransferEncoding error (the recorded run called it "other").
const raws = loadFixture(join(import.meta.dir, "fixtures", "2026-09-24"));

test("the recorded probe gives one reading per portal with an honest state", () => {
	const obs = portalProbe.normalise(raws);
	expect(obs.length).toBe(PORTALS.length);
	const by = new Map(obs.map((o) => [o.value.portal, o.value as PortalReading]));
	expect(by.get("bcv")).toMatchObject({ state: "ok", httpStatus: 200, tlsAuthorized: false });
	expect(by.get("bcv")?.tlsError).toBe("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
	expect(by.get("cne")).toMatchObject({ state: "no-dns", addresses: [], error: "dns", latencyMs: null });
	expect(by.get("seniat")).toMatchObject({ state: "no-answer", error: "tls", tlsError: "reset" });
	expect(by.get("corpoelec")).toMatchObject({ state: "refuses", httpStatus: 403 });
	expect(by.get("cantv")).toMatchObject({ state: "odd-response", error: "bad-response" });
	expect(by.get("ine")).toMatchObject({ state: "ok", redirectHost: "ine.gob.ve" });
	expect(by.get("saime")?.tlsValidTo).toBe(1_791_719_681_000);
	for (const o of obs) {
		expect(o.source).toBe("portal-probe");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(o.series).toBe(`portal:${o.value.portal}`);
		expect(o.basis).toBe("measurement");
	}
});

test("bad records are skipped; all bad throws", () => {
	const good = raws[0] as RawResponse;
	const obs = portalProbe.normalise([
		good,
		{ ...good, body: "{" },
		{ ...good, body: '{"portal":"x"}' },
		{ ...good, body: JSON.stringify({ ...JSON.parse(good.body), portal: "unknown" }) },
	]);
	expect(obs.length).toBe(1);
	expect(() => portalProbe.normalise([{ ...good, body: "{}" }])).toThrow("ningún registro");
	expect(portalProbe.normalise([])).toEqual([]);
});

function fakeProber(over: Partial<Prober> = {}): Prober {
	let clock = 0;
	return {
		resolve: async () => ["10.0.0.2", "10.0.0.1", "10.0.0.1"],
		certificate: async () => ({ validTo: 2_000_000_000_000, authorized: true, error: null }),
		now: () => 1_790_000_000_000,
		elapsed: () => (clock += 100),
		...over,
	};
}
function ctxWith(http: HttpLike): FetchContext {
	return { http, key: () => undefined, now: () => 0, signal: new AbortController().signal };
}
const portal = PORTALS.find((p) => p.id === "saime") ?? PORTALS[0];

test("probe: DNS then TLS then one GET of the home page, every status accepted, no retries", async () => {
	const seen: { url: string; options: RequestOptions | undefined }[] = [];
	const http: HttpLike = {
		request: async (url, options) => {
			seen.push({ url, options });
			return {
				url: "https://www.saime.gob.ve/",
				status: 503,
				contentType: "text/html",
				body: "",
				fetchedAt: 1,
			};
		},
	};
	if (!portal) throw new Error("no portal");
	const r = await probe(portal, ctxWith(http), fakeProber());
	expect(seen.length).toBe(1);
	expect(seen[0]?.url).toBe(portal.url);
	expect(seen[0]?.options?.retries).toBe(0);
	expect(seen[0]?.options?.okStatuses).toContain(503);
	expect(r.dns.addresses).toEqual(["10.0.0.1", "10.0.0.2"]);
	expect(r.http.status).toBe(503);
	expect(r.tls?.validTo).toBe(2_000_000_000_000);
});

test("probe: a DNS failure skips TLS and HTTP; network errors become short reasons", async () => {
	let calls = 0;
	const http: HttpLike = {
		request: async () => {
			calls++;
			throw new HttpError("network: connection reset by peer", 0, "x");
		},
	};
	if (!portal) throw new Error("no portal");
	const noDns = await probe(
		portal,
		ctxWith(http),
		fakeProber({
			resolve: async () => {
				throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
			},
		}),
	);
	expect(noDns).toMatchObject({ dns: { error: "dns" }, http: { error: "dns" }, tls: null });
	expect(calls).toBe(0);
	const reset = await probe(portal, ctxWith(http), fakeProber());
	expect(reset.http.error).toBe("reset");
	expect(reason(new Error("The operation timed out."))).toBe("timeout");
	expect(reason(new Error("unknown certificate verification error"))).toBe("tls");
	expect(reason(new Error("UnsupportedTransferEncoding fetching x"))).toBe("bad-response");
	expect(reason(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe("refused");
	expect(reason("???")).toBe("other");
});

test("fetch probes every portal once, in order, as synthetic probe records", async () => {
	const http: HttpLike = {
		request: async (url) => ({ url, status: 200, contentType: "text/html", body: "", fetchedAt: 1 }),
	};
	const adapter = makePortalProbe(fakeProber());
	const out = await adapter.fetch(ctxWith(http));
	expect(out.map((r) => r.url)).toEqual(PORTALS.map((p) => p.url));
	expect(out.every((r) => r.contentType === "application/vnd.vigia.probe+json")).toBe(true);
	expect(adapter.normalise(out).every((o) => o.value.state === "ok")).toBe(true);
	expect(adapter.optIn?.es).toContain("dirección IP");
});
