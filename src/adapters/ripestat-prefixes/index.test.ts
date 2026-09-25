import { expect, test } from "bun:test";
import { join } from "node:path";
import { hasFixture, loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { minusSize, parseV4, size, union } from "./cidr.ts";
import { type AsnRouting, prefixesUrl, ripestatPrefixes, updatesUrl, withdrawalTime } from "./index.ts";

// Recorded 2026-09-25 02:02 UTC: the 00:00 UTC snapshot and the 16:00 one before it, for the 10 watched ASNs.
// Nothing changed between them (routing in Venezuela is stable most days), so changes are tested by editing it.
// RIPEstat's terms forbid redistributing its data, so the recording is absent from the public repository.
const FIXTURE = join(import.meta.dir, "fixtures", "2026-09-24");
const recorded = hasFixture(FIXTURE);
const raws = recorded ? loadFixture(FIXTURE) : [];
const T = Date.UTC(2026, 8, 25, 0);
const PREV = Date.UTC(2026, 8, 24, 16);

function snapshotOf(asn: string, latest: boolean): RawResponse {
	const hit = raws.find(
		(r) => r.url.includes(`resource=AS${asn}&`) && r.url.includes("query_time") !== latest,
	);
	if (!hit) throw new Error(`no fixture for AS${asn}`);
	return hit;
}
type Body = { data: { prefixes: { v4: { originating: string[] }; v6: { originating: string[] } } } };
function edit(raw: RawResponse, change: (b: Body) => void): RawResponse {
	const body = JSON.parse(raw.body) as Body;
	change(body);
	return { ...raw, body: JSON.stringify(body) };
}
const value = (obs: { series: string; value: AsnRouting }[], asn: string) =>
	obs.find((o) => o.series === `asn:${asn}`)?.value as AsnRouting;

test.skipIf(!recorded)(
	"the recorded pair gives one reading per ASN, no changes, and merged address space",
	() => {
		const obs = ripestatPrefixes.normalise(raws);
		expect(obs.length).toBe(10);
		const cantv = value(obs, "8048");
		expect(cantv).toMatchObject({
			isp: "cantv",
			v4Prefixes: 467,
			v6Prefixes: 2,
			v4Addresses: 2_572_544,
			prevAt: PREV,
			withdrawn: { v4: 0, v6: 0 },
			v4AddressesLost: 0,
			withdrawalAt: null,
		});
		expect(value(obs, "27717").isp).toBe("digitel");
		expect(value(obs, "264731").isp).toBe("digitel");
		for (const o of obs) {
			expect(o.observedAt).toBe(T);
			expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
			expect(o.licence).toBe("ripestat-no-redistribution");
			expect(o.sourceUrl).toStartWith("https://stat.ripe.net/app/launchpad/AS");
		}
	},
);

test.skipIf(!recorded)(
	"a withdrawal counts prefixes and uncovered space; a move between watched ASNs is named",
	() => {
		const inter = snapshotOf("21826", true);
		const netuno = snapshotOf("11562", true);
		let removed: string[] = [];
		const edited = raws.map((r) => {
			if (r === inter)
				return edit(r, (b) => {
					// Drop the first three /24s Inter announces; hand one of them to NetUno.
					const v4 = b.data.prefixes.v4.originating;
					removed = v4.filter((p) => p.endsWith("/24")).slice(0, 3);
					b.data.prefixes.v4.originating = v4.filter((p) => !removed.includes(p));
				});
			return r;
		});
		const final = edited.map((r) =>
			r === netuno ? edit(r, (b) => b.data.prefixes.v4.originating.push(removed[0] as string)) : r,
		);
		const obs = ripestatPrefixes.normalise(final);
		const i = value(obs, "21826");
		expect(i.withdrawn).toEqual({ v4: 3, v6: 0 });
		expect(i.movedOut).toEqual([{ asn: "11562", prefixes: 1 }]);
		// Lost space depends on whether a covering prefix remains; never more than the three /24s.
		expect(i.v4AddressesLost).toBeLessThanOrEqual(768);
		expect(i.v4AddressesLost % 256).toBe(0);
		const n = value(obs, "11562");
		expect(n.announced.v4).toBe(1);
		expect(n.movedIn).toEqual([{ asn: "21826", prefixes: 1 }]);
	},
);

test.skipIf(!recorded)("a withdrawal is dated from RIS updates when most peers ended on a withdrawal", () => {
	const cantv = snapshotOf("8048", true);
	let gone = "";
	const edited = raws.map((r) =>
		r === cantv
			? edit(r, (b) => {
					gone = b.data.prefixes.v4.originating[0] as string;
					b.data.prefixes.v4.originating = b.data.prefixes.v4.originating.slice(1);
				})
			: r,
	);
	const update = (peer: string, ts: string, type: "A" | "W") => ({
		timestamp: ts,
		type,
		attrs: { source_id: peer, target_prefix: gone },
	});
	const updates: RawResponse = {
		url: updatesUrl(gone, PREV, T),
		status: 200,
		contentType: "application/json",
		fetchedAt: T + 7_000_000,
		body: JSON.stringify({
			status: "ok",
			data: {
				resource: gone,
				updates: [
					update("p1", "2026-09-24T18:00:00", "A"),
					update("p1", "2026-09-24T18:40:10", "W"),
					update("p2", "2026-09-24T18:40:20", "W"),
					update("p3", "2026-09-24T18:41:00", "W"),
					update("p4", "2026-09-24T19:00:00", "A"),
					{ timestamp: "bad" },
				],
			},
		}),
	};
	const obs = ripestatPrefixes.normalise([...edited, updates]);
	const c = value(obs, "8048");
	expect(c.withdrawn.v4).toBe(1);
	expect(c.timingSampled).toBe(1);
	expect(c.timingDated).toBe(1);
	expect(c.withdrawalAt).toBe(Date.UTC(2026, 8, 24, 18, 40, 20));
});

test("withdrawal time is null when most peers still announce it; garbage is ignored", () => {
	const body = (updates: unknown[]) =>
		JSON.stringify({ status: "ok", data: { resource: "1.2.3.0/24", updates } });
	const raw = { url: "x", status: 200, contentType: "", fetchedAt: 0 };
	expect(
		withdrawalTime({
			...raw,
			body: body([
				{ timestamp: "2026-09-24T18:00:00", type: "W", attrs: { source_id: "a", target_prefix: "x" } },
				{ timestamp: "2026-09-24T18:00:00", type: "A", attrs: { source_id: "b", target_prefix: "x" } },
			]),
		}),
	).toEqual({ prefix: "1.2.3.0/24", at: null });
	expect(withdrawalTime({ ...raw, body: "<html>" })).toBeNull();
});

test.skipIf(!recorded)(
	"a first reading with no earlier snapshot has nothing to compare; bad envelopes throw",
	() => {
		const latestOnly = raws.filter((r) => !r.url.includes("query_time"));
		const obs = ripestatPrefixes.normalise(latestOnly);
		expect(value(obs, "8048").prevAt).toBeNull();
		expect(value(obs, "8048").withdrawn).toEqual({ v4: 0, v6: 0 });
		const bad = { ...(raws[0] as RawResponse), body: '{"status":"error"}' };
		expect(() => ripestatPrefixes.normalise([bad])).toThrow("RIPEstat");
		expect(ripestatPrefixes.normalise([])).toEqual([]);
	},
);

test("URLs name the app, only originated prefixes, and the snapshot asked", () => {
	const u = new URL(prefixesUrl("8048", PREV));
	expect(u.searchParams.get("resource")).toBe("AS8048");
	expect(u.searchParams.get("types")).toBe("o");
	expect(u.searchParams.get("query_time")).toBe("2026-09-24T16:00");
	expect(u.searchParams.get("sourceapp")).toBe("vigia");
	expect(new URL(prefixesUrl("8048")).searchParams.has("query_time")).toBe(false);
});

test("CIDR arithmetic merges overlaps and subtracts ranges", () => {
	expect(parseV4("190.6.10.0/24")).toEqual([3_188_066_816, 3_188_067_072]);
	expect(parseV4("300.1.1.1/24")).toBeNull();
	expect(parseV4("1.2.3.4/33")).toBeNull();
	const a = union(["10.0.0.0/16", "10.0.1.0/24", "10.1.0.0/24"]);
	expect(size(a)).toBe(65_536 + 256);
	const b = union(["10.0.0.0/17"]);
	expect(minusSize(a, b)).toBe(32_768 + 256);
	expect(minusSize(b, a)).toBe(0);
	expect(minusSize(a, [])).toBe(size(a));
	expect(minusSize(union(["10.0.0.0/24", "10.0.2.0/24"]), union(["10.0.0.128/25", "10.0.1.0/24"]))).toBe(
		128 + 256,
	);
});
