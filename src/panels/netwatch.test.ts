import { expect, test } from "bun:test";
import { join } from "node:path";
import { ISPS } from "../adapters/ioda-asn/index.ts";
import { dayUrl, ooniMethods } from "../adapters/ooni-methods/index.ts";
import { type PortalReading, portalProbe } from "../adapters/portal-probe/index.ts";
import { type AsnRouting, ripestatPrefixes } from "../adapters/ripestat-prefixes/index.ts";
import { torMetrics } from "../adapters/tor-metrics/index.ts";
import { hasFixture, loadFixture } from "../core/fixtures.ts";
import { Store } from "../core/store.ts";
import type { HttpLike, Observation } from "../core/types.ts";
import {
	BRIDGE_MIN_DELTA,
	cellOf,
	flagTor,
	methodsView,
	netwatchPanel,
	portalsView,
	readDomainDays,
	routeEvents,
	routingView,
	strongest,
	torView,
} from "./netwatch.ts";
import {
	CACHE_MS,
	cleanDomain,
	createLookup,
	FAILURE_CACHE_MS,
	LIVE_BURST,
	LIVE_PACE_KEY,
	liveDays,
	storedLookup,
} from "./netwatch-lookup.ts";

const DAY = 86_400_000;
const fixtureDir = (id: string) => join(import.meta.dir, "..", "adapters", id, "fixtures", "2026-09-24");
const fixture = (id: string) => loadFixture(fixtureDir(id));
// RIPEstat's recording is not redistributable, so it is absent from the public repository (see hasFixture).
const ripestatRecorded = hasFixture(fixtureDir("ripestat-prefixes"));
const NOW = Date.UTC(2026, 8, 25, 3);

function storeWith(...batches: Observation[][]): Store {
	const store = new Store(":memory:");
	for (const b of batches) store.insert(b);
	return store;
}

// ——— Tor ———

test("relay days are judged by Tor Metrics' own range; bridge days by the stated rolling rule", () => {
	const d = (i: number) => Date.UTC(2026, 7, 1) + i * DAY;
	const relay = flagTor(
		[
			{ day: d(0), users: 100, lower: 50, upper: 150 },
			{ day: d(1), users: 151, lower: 50, upper: 150 },
			{ day: d(2), users: 49, lower: 50, upper: 150 },
			{ day: d(3), users: 500, lower: null, upper: null },
		],
		"relay",
	);
	expect(relay.map((p) => p.flag)).toEqual([null, "up", "down", null]);
	const flat = Array.from({ length: 20 }, (_, i) => ({ day: d(i), users: 70, lower: null, upper: null }));
	const bridge = flagTor(
		[
			...flat,
			{ day: d(20), users: 105, lower: null, upper: null },
			{ day: d(21), users: 70 + BRIDGE_MIN_DELTA + 15, lower: null, upper: null },
			{ day: d(22), users: 20, lower: null, upper: null },
		],
		"bridge",
	);
	// 105 = 1.5 × 70 and 35 users more: up. 105 again is still up. 20 ≤ 70/1.5 and 50 fewer: down.
	expect(bridge.slice(20).map((p) => p.flag)).toEqual(["up", "up", "down"]);
	// Fewer than 7 earlier days: never flagged.
	expect(flagTor(flat.slice(0, 3), "bridge").every((p) => p.flag === null)).toBe(true);
});

test("torView on the recorded CSVs: 90 days, the June spike flagged, latest day and change", () => {
	const raws = fixture("tor-metrics");
	const store = storeWith(torMetrics.normalise(raws));
	const at = (raws[0]?.fetchedAt ?? 0) + 1_000;
	const v = torView(store, at);
	expect(v.relay.length).toBe(90);
	expect(v.latest).toMatchObject({ day: Date.UTC(2026, 8, 22), relay: 9_705, bridge: 71, relayFrac: 53 });
	const june26 = v.relay.find((p) => p.day === Date.UTC(2026, 5, 26));
	expect(june26?.flag).toBe("up");
	expect(v.relayChangePct).not.toBeNull();
	expect(v.ruleEs).toContain("Tor Metrics");
	// Empty store: nothing invented.
	const empty = torView(new Store(":memory:"), at);
	expect(empty.latest).toBeNull();
	expect(empty.relay).toEqual([]);
});

// ——— Routing ———

const routing = (over: Partial<AsnRouting>): AsnRouting => ({
	asn: "8048",
	isp: "cantv",
	v4Prefixes: 467,
	v6Prefixes: 2,
	v4Addresses: 2_572_544,
	prevAt: NOW - 8 * 3_600_000,
	withdrawn: { v4: 0, v6: 0 },
	announced: { v4: 0, v6: 0 },
	v4AddressesLost: 0,
	v4AddressesGained: 0,
	movedIn: [],
	movedOut: [],
	withdrawalAt: null,
	timingSampled: 0,
	timingDated: 0,
	...over,
});

test("routing events: ≥ 1 % of space and ≥ one /24; moves always; first readings never", () => {
	expect(routeEvents(routing({}), NOW)).toEqual([]);
	expect(routeEvents(routing({ prevAt: null, v4AddressesLost: 1_000_000 }), NOW)).toEqual([]);
	// 25 000 of 2.57 M is under 1 %: minor.
	expect(routeEvents(routing({ v4AddressesLost: 25_000, withdrawn: { v4: 12, v6: 0 } }), NOW)).toEqual([]);
	const lost = 312 * 256;
	const [ev] = routeEvents(
		routing({
			v4Addresses: 2_572_544 - lost,
			v4Prefixes: 155,
			v4AddressesLost: lost,
			withdrawn: { v4: 312, v6: 0 },
			withdrawalAt: NOW - 3_600_000,
		}),
		NOW,
	);
	expect(ev).toMatchObject({
		kind: "withdrawal",
		prefixes: 312,
		addresses: lost,
		sharePct: 3.1,
		at: NOW - 3_600_000,
	});
	const moves = routeEvents(routing({ movedOut: [{ asn: "11562", prefixes: 4 }] }), NOW);
	expect(moves).toEqual([
		expect.objectContaining({ kind: "move", prefixes: 4, other: { asn: "11562", isp: "netuno" } }),
	]);
	// A tiny ASN: one /24 of a /22 is 25 %: an event.
	expect(routeEvents(routing({ v4Addresses: 768, v4AddressesLost: 256 }), NOW)[0]?.sharePct).toBe(25);
});

test.skipIf(!ripestatRecorded)(
	"routingView sums Digitel's ASNs, lists events newest first, counts minor churn",
	() => {
		const store = storeWith(ripestatPrefixes.normalise(fixture("ripestat-prefixes")));
		const snap = Date.UTC(2026, 8, 25, 8);
		const mk = (asn: string, v: Partial<AsnRouting>, at: number): Observation<AsnRouting> => ({
			source: "ripestat-prefixes",
			series: `asn:${asn}`,
			sourceUrl: `https://stat.ripe.net/app/launchpad/AS${asn}`,
			fetchedAt: at + 3_600_000,
			observedAt: at,
			licence: "ripestat-no-redistribution",
			value: routing({ asn, prevAt: at - 8 * 3_600_000, ...v }),
			confidence: 1,
			basis: "measurement",
		});
		store.insert([
			mk("8048", { v4AddressesLost: 300_000, withdrawn: { v4: 40, v6: 0 }, v4Addresses: 2_272_544 }, snap),
			mk("21826", { isp: "inter", withdrawn: { v4: 1, v6: 0 }, v4AddressesLost: 256 }, snap),
		]);
		const v = routingView(store, snap + 2 * 3_600_000);
		expect(v.isps.map((i) => i.isp)).toEqual([
			"cantv",
			"movilnet",
			"movistar",
			"digitel",
			"inter",
			"airtek",
			"netuno",
			"thundernet",
			"g-network",
		]);
		const digitel = v.isps.find((i) => i.isp === "digitel");
		expect(digitel?.asns).toEqual(["264731", "27717"]);
		expect(digitel?.v4Prefixes).toBe(64 + 112);
		expect(v.events.length).toBe(1);
		expect(v.events[0]).toMatchObject({ isp: "cantv", kind: "withdrawal", prefixes: 40 });
		expect(v.isps.find((i) => i.isp === "inter")?.minorChanges).toBe(1);
		expect(v.watchingSince).toBe(Date.UTC(2026, 8, 24, 16));
	},
);

// ——— Methods ———

test("methodsView on four recorded days: DNS blocks per ISP, complete days only, first/last seen", () => {
	const store = storeWith(ooniMethods.normalise(fixture("ooni-methods")));
	const v = methodsView(store, NOW);
	expect(v.days).toEqual([
		Date.UTC(2026, 8, 21),
		Date.UTC(2026, 8, 22),
		Date.UTC(2026, 8, 23),
		Date.UTC(2026, 8, 24),
	]);
	expect(v.skippedDays).toEqual([]);
	const infobae = v.rows.find((r) => r.domain === "infobae.com");
	const cell = (isp: string) => infobae?.cells.find((c) => c.isp === isp);
	expect(cell("cantv")).toMatchObject({ state: "blocked", layers: ["dns"], outcome: "dns.nxdomain" });
	expect(cell("cantv")?.firstSeen).toBe(Date.UTC(2026, 8, 21));
	expect(cell("cantv")?.lastSeen).toBe(Date.UTC(2026, 8, 24));
	expect(cell("inter")?.state).toBe("ok");
	// Movistar shows DNS and TLS interference on infobae; DNS is the stronger.
	expect(cell("movistar")?.layers).toEqual(["dns", "tls"]);
	const dt = v.rows.find((r) => r.domain === "dolartoday.com");
	expect(dt?.cells.find((c) => c.isp === "airtek")?.state).toBe("ok");
	const cantv = v.byIsp.find((b) => b.isp === "cantv");
	expect(cantv?.blocked).toBeGreaterThan(0);
	expect((cantv?.dns ?? 0) + (cantv?.tcp ?? 0) + (cantv?.tls ?? 0)).toBe(cantv?.blocked ?? -1);
	// Sorted: most ISPs first.
	for (let i = 1; i < v.rows.length; i++)
		expect((v.rows[i - 1]?.blockedOn ?? 0) >= (v.rows[i]?.blockedOn ?? 0)).toBe(true);
});

test("a thin OONI day is skipped, and its blocks do not count toward the window", () => {
	const raws = fixture("ooni-methods");
	const store = storeWith(ooniMethods.normalise(raws));
	// A fifth day with 1 % of the usual volume.
	const thin = ooniMethods.normalise([
		{
			...(raws[0] as (typeof raws)[0]),
			url: (raws[0]?.url ?? "").replace(
				"since=2026-09-24&until=2026-09-25",
				"since=2026-09-25&until=2026-09-26",
			),
			fetchedAt: NOW + 2 * DAY,
			body: JSON.stringify({
				results: [
					{
						count: 100,
						domain: "thin.org",
						probe_asn: 8048,
						loni: {
							dns_blocked: 0.9,
							tcp_blocked: 0,
							tls_blocked: 0,
							blocked_max: 0.9,
							blocked_max_outcome: "dns.nxdomain",
						},
					},
				],
			}),
		},
	]);
	store.insert(thin);
	const v = methodsView(store, NOW + 2 * DAY);
	expect(v.skippedDays).toEqual([Date.UTC(2026, 8, 25)]);
	expect(v.rows.some((r) => r.domain === "thin.org")).toBe(false);
});

test("only a blocking signature makes a block; timeouts alone are unclear; the signature's step leads", () => {
	const none = { first: null, last: null };
	const acc = (outcome: string, dns: number, tls: number, n = 20) => ({
		n,
		dns: dns * n,
		tcp: 0,
		tls: tls * n,
		outcomes: new Map([[outcome, n]]),
	});
	expect(cellOf("cantv", acc("dns.nxdomain", 0.9, 0), none)).toMatchObject({
		state: "blocked",
		layers: ["dns"],
	});
	expect(cellOf("cantv", acc("tcp.generic_timeout_error", 0, 0.8), none)).toMatchObject({
		state: "unclear",
		outcome: "tcp.generic_timeout_error",
	});
	expect(cellOf("cantv", acc("dns.dns_no_answer", 0.6, 0.9), none).layers).toEqual(["dns", "tls"]);
	expect(cellOf("cantv", acc("dns.nxdomain", 0.9, 0, 9), none).state).toBe("few");
	expect(cellOf("cantv", acc("dns.nxdomain", 0.2, 0), none)).toMatchObject({ state: "ok", outcome: null });
	expect(cellOf("cantv", undefined, none)).toMatchObject({ state: "few", n: 0 });
});

test("strongest layer first; nothing under 0.5 is a layer", () => {
	expect(strongest({ dns: 0.6, tcp: 0.1, tls: 0.8 })).toEqual({ layers: ["tls", "dns"], max: 0.8 });
	expect(strongest({ dns: 0.4, tcp: 0, tls: 0 }).layers).toEqual([]);
});

// ——— Portals ———

test("portalsView: latest state, answered share, certificate days, DNS changes", () => {
	const base = portalProbe.normalise(fixture("portal-probe"));
	const at0 = base[0]?.observedAt ?? 0;
	const later = base.map((o) => {
		if (o.value.portal !== "saime")
			return { ...o, observedAt: o.observedAt + 900_000, fetchedAt: o.fetchedAt + 900_000 };
		const v: PortalReading = { ...o.value, addresses: ["200.11.208.99"] };
		return { ...o, observedAt: o.observedAt + 900_000, fetchedAt: o.fetchedAt + 900_000, value: v };
	});
	const store = storeWith(base, later);
	const v = portalsView(store, at0 + 1_000_000);
	expect(v.hasData).toBe(true);
	const saime = v.rows.find((r) => r.id === "saime");
	expect(saime?.dnsChanges7d).toBe(1);
	expect(saime?.dnsChangedAt).toBe(
		at0 + 900_000 + ((later.find((o) => o.value.portal === "saime")?.observedAt ?? 0) - at0 - 900_000),
	);
	expect(saime?.readings24h).toBe(2);
	expect(saime?.answered24h).toBe(2);
	expect(saime?.certDays).toBe(16);
	const cne = v.rows.find((r) => r.id === "cne");
	expect(cne?.reading?.state).toBe("no-dns");
	expect(cne?.answered24h).toBe(0);
	// CNE had no address both times: no DNS "change".
	expect(cne?.dnsChanges7d).toBe(0);
	expect(v.vantageEs).toContain("desde este equipo");
	expect(portalsView(new Store(":memory:"), NOW).hasData).toBe(false);
});

test("the panel is registered on its four feeds and computes on an empty store", () => {
	expect(netwatchPanel.sources).toEqual(["tor-metrics", "ripestat-prefixes", "ooni-methods", "portal-probe"]);
	const v = netwatchPanel.compute(new Store(":memory:"), NOW);
	expect(v.methods.rows).toEqual([]);
	expect(v.routing.events).toEqual([]);
	expect(v.tor.latest).toBeNull();
});

// ——— Lookup ———

test("cleanDomain accepts what people paste and refuses everything else", () => {
	expect(cleanDomain("https://www.Infobae.com/america/?x=1")).toBe("infobae.com");
	expect(cleanDomain("  elpitazo.net. ")).toBe("elpitazo.net");
	expect(cleanDomain("sub.domain.co.ve:443")).toBe("sub.domain.co.ve");
	for (const bad of ["", "localhost", "1.2.3.4", "a..b", "-x.com", "x_y.com", "x.com\nfoo", "a".repeat(300)])
		expect(cleanDomain(bad)).toBeNull();
});

test("stored lookup: day history, matrix cell, VE sin Filtro and OONI 7-day for one domain", () => {
	const store = storeWith(ooniMethods.normalise(fixture("ooni-methods")));
	const v = storedLookup(store, "infobae.com", NOW);
	expect(v.origin).toBe("stored");
	expect(v.days.map((d) => d.day)).toEqual([
		Date.UTC(2026, 8, 21),
		Date.UTC(2026, 8, 22),
		Date.UTC(2026, 8, 23),
		Date.UTC(2026, 8, 24),
	]);
	expect(v.matrix?.find((c) => c.isp === "cantv")?.state).toBe("blocked");
	const lastDay = v.days.at(-1)?.cells;
	expect(lastDay?.find((c) => c.isp === "cantv")?.state).toBe("blocked");
	expect(lastDay?.find((c) => c.isp === "inter")?.state).toBe("ok");
	expect(v.vsf).toBeNull();
	expect(storedLookup(store, "never-seen.org", NOW).origin).toBe("not-queried");
});

function liveBody(domain: string): string {
	return JSON.stringify({
		results: [
			{
				count: 12,
				domain,
				probe_asn: 8048,
				measurement_start_day: "2026-09-20T00:00:00Z",
				loni: {
					dns_blocked: 0.9,
					tcp_blocked: 0,
					tls_blocked: 0,
					blocked_max: 0.9,
					blocked_max_outcome: "dns.nxdomain",
				},
			},
			{
				count: 4,
				domain,
				probe_asn: 21826,
				measurement_start_day: "2026-09-21T00:00:00Z",
				loni: { dns_blocked: 0, tcp_blocked: 0, tls_blocked: 0, blocked_max: 0, blocked_max_outcome: "none" },
			},
		],
	});
}

test("live lookup: one cached query per domain, both www forms, global limit, off with --no-fetch", async () => {
	const store = new Store(":memory:");
	let t = NOW;
	const asked: string[] = [];
	const http: HttpLike = {
		request: async (url) => {
			asked.push(url);
			const d = new URL(url).searchParams.get("domain") ?? "";
			return { url, status: 200, contentType: "application/json", body: liveBody(d), fetchedAt: t };
		},
	};
	const lookup = createLookup({ store, http, now: () => t });
	const first = await lookup("nuevo-sitio.com");
	expect("days" in first && first.origin).toBe("live");
	expect("days" in first && first.days.map((d) => d.day)).toEqual([
		Date.UTC(2026, 8, 20),
		Date.UTC(2026, 8, 21),
	]);
	expect(asked.map((u) => new URL(u).searchParams.get("domain"))).toEqual([
		"nuevo-sitio.com",
		"www.nuevo-sitio.com",
	]);
	await lookup("NUEVO-SITIO.com");
	expect(asked.length).toBe(2);
	t += CACHE_MS + 1;
	await lookup("nuevo-sitio.com");
	expect(asked.length).toBe(4);
	for (let i = 0; i < LIVE_BURST + 5; i++) await lookup(`d${i}.org`);
	const limited = await lookup("otro.org");
	// Not "OONI has no measurements": OONI was not asked (review 3 M10).
	expect("origin" in limited && [limited.origin, limited.notQueried]).toEqual(["not-queried", "busy"]);
	expect(await lookup("no es un dominio")).toEqual({
		error: "Escribe un dominio válido, por ejemplo infobae.com.",
	});
	const offline = createLookup({ store, http, now: () => t, live: false });
	const before = asked.length;
	const off = await offline("sin-red.org");
	// Never asked: the page must not say "OONI has no measurements" (review 3, M10).
	expect("origin" in off && [off.origin, off.notQueried]).toEqual(["not-queried", "offline"]);
	expect(asked.length).toBe(before);
	expect(liveDays(["<html>", '{"results":"x"}'], "x.org")).toEqual([]);
});

test("live lookup (review 3 M1, M10): concurrent lookups share one query; asked-and-empty differs from not asked; failures are cached; a cross-site request never asks", async () => {
	const store = new Store(":memory:");
	let t = NOW;
	const asked: string[] = [];
	const paces: (string | undefined)[] = [];
	let fail = false;
	let gate: () => void = () => {};
	let wait = new Promise<void>((resolve) => {
		gate = resolve;
	});
	const http: HttpLike = {
		request: async (url, options) => {
			asked.push(url);
			paces.push(options?.paceKey);
			await wait;
			if (fail) throw new Error("timeout");
			const d = new URL(url).searchParams.get("domain") ?? "";
			const body = d.includes("vacio") ? '{"results":[]}' : liveBody(d);
			return { url, status: 200, contentType: "application/json", body, fetchedAt: t };
		},
	};
	const lookup = createLookup({ store, http, now: () => t });
	// Ten identical lookups at once: one OONI query (two URLs), one token, one answer for all.
	const many = Promise.all(Array.from({ length: 10 }, () => lookup("mismo.com")));
	gate();
	const answers = await many;
	expect(asked.length).toBe(2);
	for (const a of answers) expect("origin" in a && a.origin).toBe("live");
	// Live queries queue on their own pace key, not behind the OONI adapters.
	expect(paces).toEqual([LIVE_PACE_KEY, LIVE_PACE_KEY]);

	// OONI asked and nothing there: "none", which the page may call "no measurements".
	const empty = await lookup("vacio.org");
	expect("origin" in empty && [empty.origin, empty.notQueried]).toEqual(["none", null]);

	// A cross-site request (another website's <img>) is answered from stored data only, and asks nothing.
	const before = asked.length;
	const cross = await lookup("elegido-por-otro.com", { live: false });
	expect("origin" in cross && [cross.origin, cross.notQueried]).toEqual(["not-queried", "cross-site"]);
	expect(asked.length).toBe(before);
	// …but it may read what an earlier same-origin lookup already cached.
	const cached = await lookup("mismo.com", { live: false });
	expect("origin" in cached && cached.origin).toBe("live");

	// A failure is remembered for 10 minutes instead of re-asking OONI on every request.
	fail = true;
	wait = Promise.resolve();
	const failed = await lookup("caido.com");
	expect("origin" in failed && [failed.origin, failed.notQueried]).toEqual(["not-queried", "failed"]);
	const n = asked.length;
	await lookup("caido.com");
	expect(asked.length).toBe(n);
	t += FAILURE_CACHE_MS + 1;
	fail = false;
	const retried = await lookup("caido.com");
	expect(asked.length).toBe(n + 2);
	expect("origin" in retried && retried.origin).toBe("live");
});

test("a fuller OONI revision of a day that no longer flags a domain clears the earlier partial 'blocked' (review 3 M6)", () => {
	const store = new Store(":memory:");
	const asn = Number(ISPS[0]?.asns[0]);
	const row = (domain: string, count: number, dns: number) => ({
		count,
		domain,
		probe_asn: asn,
		loni: {
			dns_blocked: dns,
			tcp_blocked: 0,
			tls_blocked: 0,
			blocked_max: dns,
			blocked_max_outcome: dns >= 0.5 ? "dns.nxdomain" : "none",
		},
	});
	const fetchDay = (day: string, fetchedAt: number, results: unknown[]) =>
		store.insert(
			ooniMethods.normalise([
				{
					url: dayUrl(day),
					status: 200,
					contentType: "application/json",
					fetchedAt,
					body: JSON.stringify({ results }),
				},
			]) as Observation[],
		);
	// Eight complete days (volume from filler.com); on the last, a partial fetch: 12 measurements, DNS 0.9.
	const days = Array.from({ length: 8 }, (_, i) =>
		new Date(Date.UTC(2026, 8, 14 + i)).toISOString().slice(0, 10),
	);
	let t = Date.UTC(2026, 8, 15, 6);
	for (const d of days) {
		fetchDay(d, t, [row("filler.com", 500, 0), ...(d === days.at(-1) ? [row("example.org", 12, 0.9)] : [])]);
		t += DAY;
	}
	const last = days.at(-1) as string;
	const cellOfExample = (at: number) =>
		methodsView(store, at).rows.find((r) => r.domain === "example.org")?.cells[0]?.state ?? "not listed";
	expect(cellOfExample(t)).toBe("blocked");
	// The final fetch of that day: 200 measurements, DNS 0.1. It stores no row for example.org (not likely), so the
	// partial one used to stay the newest and keep the domain "Bloqueado".
	fetchDay(last, t + 2 * DAY, [row("filler.com", 600, 0), row("example.org", 200, 0.1)]);
	expect(cellOfExample(t + 2 * DAY)).toBe("not listed");
	expect(readDomainDays(store, 0, "example.org").size).toBe(0);
	const lookup = storedLookup(store, "example.org", t + 2 * DAY);
	expect(lookup.days).toEqual([]);
	expect(lookup.matrix).toBeNull();
	// A revision that still flags the domain keeps it, with the newer figures.
	fetchDay(last, t + 3 * DAY, [row("filler.com", 700, 0), row("example.org", 220, 0.8)]);
	expect(cellOfExample(t + 3 * DAY)).toBe("blocked");
	expect(storedLookup(store, "example.org", t + 3 * DAY).days.at(-1)?.cells[0]?.n).toBe(220);
});
