import { expect, test } from "bun:test";
import type { RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { type AsnRouting, prefixesUrl, ripestatPrefixes, updatesUrl } from "./index.ts";

/**
 * Synthetic RIPEstat `ris-prefixes` / `bgp-updates` payloads using documentation address space (RFC 5737,
 * RFC 3849). The recorded responses stay out of the public repository (RIPEstat's terms forbid redistribution);
 * these run everywhere.
 */

const CUR = Date.UTC(2026, 0, 15, 8);
const PREV = Date.UTC(2026, 0, 15, 0);
const FETCHED = CUR + 2 * 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19);

function snapshot(asn: string, at: number, v4: string[], v6: string[] = []): RawResponse {
	return {
		url: at === CUR ? prefixesUrl(asn) : prefixesUrl(asn, at),
		status: 200,
		contentType: "application/json; charset=utf-8",
		body: JSON.stringify({
			status: "ok",
			data: {
				resource: `AS${asn}`,
				query_time: iso(at),
				prefixes: { v4: { originating: v4 }, v6: { originating: v6 } },
			},
		}),
		fetchedAt: FETCHED,
	};
}
function updates(prefix: string, list: unknown[]): RawResponse {
	return {
		url: updatesUrl(prefix, PREV, CUR),
		status: 200,
		contentType: "application/json",
		body: JSON.stringify({ status: "ok", data: { resource: prefix, updates: list } }),
		fetchedAt: FETCHED,
	};
}
const update = (peer: string, at: string, type: "A" | "W", prefix: string) => ({
	timestamp: at,
	type,
	attrs: { source_id: peer, target_prefix: prefix },
});
const value = (obs: { series: string; value: AsnRouting }[], asn: string) =>
	obs.find((o) => o.series === `asn:${asn}`)?.value;

// CANTV's AS8048 drops two /24s; one of them reappears at NetUno's AS11562.
const pair = [
	snapshot("8048", PREV, ["192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24"], ["2001:db8::/32"]),
	snapshot("8048", CUR, ["192.0.2.0/24"], ["2001:db8::/32"]),
	snapshot("11562", PREV, ["192.0.2.0/25"]),
	snapshot("11562", CUR, ["192.0.2.0/25", "198.51.100.0/24", "not-a-prefix"]),
];

test("a withdrawal counts prefixes and uncovered space; a move between watched ASNs is named", () => {
	const obs = ripestatPrefixes.normalise(pair);
	expect(obs.map((o) => o.series)).toEqual(["asn:8048", "asn:11562"]);
	expect(obs[0]).toMatchObject({
		source: "ripestat-prefixes",
		sourceUrl: "https://stat.ripe.net/app/launchpad/AS8048",
		fetchedAt: FETCHED,
		observedAt: CUR,
		licence: "ripestat-no-redistribution",
		basis: "measurement",
		confidence: 1,
	});
	expect(value(obs, "8048")).toMatchObject({
		isp: "cantv",
		v4Prefixes: 1,
		v6Prefixes: 1,
		v4Addresses: 256,
		prevAt: PREV,
		withdrawn: { v4: 2, v6: 0 },
		announced: { v4: 0, v6: 0 },
		v4AddressesLost: 512,
		v4AddressesGained: 0,
		movedOut: [{ asn: "11562", prefixes: 1 }],
		withdrawalAt: null,
		timingSampled: 0,
	});
	// An invalid prefix string is dropped; the /25 inside CANTV's /24 is counted on its own ranges.
	expect(value(obs, "11562")).toMatchObject({
		isp: "netuno",
		v4Prefixes: 2,
		v4Addresses: 384,
		announced: { v4: 1, v6: 0 },
		movedIn: [{ asn: "8048", prefixes: 1 }],
		v4AddressesGained: 256,
	});
});

test("a withdrawal is dated from RIS updates when most peers ended on a withdrawal", () => {
	const gone = "203.0.113.0/24";
	const timing = updates(gone, [
		update("p1", "2026-01-15T03:00:00", "A", gone),
		update("p1", "2026-01-15T03:10:00", "W", gone),
		update("p2", "2026-01-15T03:10:30", "W", gone),
		update("p3", "2026-01-15T03:11:00", "W", gone),
		update("p4", "2026-01-15T04:00:00", "A", gone),
		{ timestamp: "bad" },
	]);
	const c = value(ripestatPrefixes.normalise([...pair, timing]), "8048");
	expect(c?.timingSampled).toBe(1);
	expect(c?.timingDated).toBe(1);
	expect(c?.withdrawalAt).toBe(Date.UTC(2026, 0, 15, 3, 10, 30));
});

test("a first reading has nothing to compare; no watched ASN or a bad envelope throws", () => {
	const first = ripestatPrefixes.normalise([snapshot("8048", CUR, ["192.0.2.0/24"])]);
	expect(value(first, "8048")).toMatchObject({ prevAt: null, withdrawn: { v4: 0, v6: 0 }, movedOut: [] });
	expect(() => ripestatPrefixes.normalise([snapshot("64496", CUR, ["192.0.2.0/24"])])).toThrow(SchemaError);
	expect(() =>
		ripestatPrefixes.normalise([{ ...snapshot("8048", CUR, []), body: '{"status":"error"}' }]),
	).toThrow(SchemaError);
	expect(ripestatPrefixes.normalise([])).toEqual([]);
});
