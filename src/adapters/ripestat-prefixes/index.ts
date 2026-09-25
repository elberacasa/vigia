import { z } from "zod";
import type { Adapter, FetchContext, Observation, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { ISPS } from "../ioda-asn/index.ts";
import { parseUtc, RIPESTAT_LICENCE } from "../ripestat-routing/index.ts";
import { minusSize, parseV4, size, union } from "./cidr.ts";

/**
 * Routing changes per Venezuelan ISP, from the RIPE RIS route collectors via RIPEstat: which prefixes each main
 * ISP's autonomous system originates, compared between consecutive RIS snapshots, so an ISP that stops announcing
 * part of its network (the BGP side of a shutdown) or whose prefixes move to another Venezuelan network shows up
 * as an event, with the address space involved.
 *
 * - `ris-prefixes` gives the originated prefix list at RIS's 8-hourly snapshots (00, 08, 16 UTC; verified
 *   2026-09-24 by querying either side of each boundary), available ~1–2 h later. Each run reads the newest
 *   snapshot and the one before it, per ASN, skipping ASNs whose newest snapshot is already stored.
 * - When prefixes were withdrawn, up to `TIMING_SAMPLE` of them (largest first) get a `bgp-updates` query over
 *   the 8-hour gap, to date the withdrawal to the minute: per RIS peer, the last update in the gap; when most
 *   peers ended on a withdrawal, the prefix's time is the median of those withdrawals.
 * - Space is counted on merged IPv4 ranges (overlapping announcements are not double counted); a prefix split
 *   into more-specifics is not a loss. IPv6 is counted in prefixes only.
 *
 * TERMS: RIPEstat forbids redistributing its data; the licence id marks these rows, and the UI shows derived
 * counts and times only, never the prefix lists. `sourceapp=vigia` identifies us, as RIPEstat asks.
 * Budget: 10 ASNs × 2 small requests (≤ 20 KB) per new snapshot, plus ≤ 3 timing requests per ASN with a loss.
 */

const HOUR = 3_600_000;
export const SNAPSHOT_MS = 8 * HOUR;
export const TIMING_SAMPLE = 3;
const API = "https://stat.ripe.net/data";

export type Moved = { readonly asn: string; readonly prefixes: number };

export type AsnRouting = {
	readonly asn: string;
	readonly isp: string;
	/** Originated prefixes at this snapshot. */
	readonly v4Prefixes: number;
	readonly v6Prefixes: number;
	/** Addresses covered by the merged IPv4 prefixes. */
	readonly v4Addresses: number;
	/** The snapshot compared against (UTC ms), null for a first reading with nothing to compare. */
	readonly prevAt: number | null;
	readonly withdrawn: { readonly v4: number; readonly v6: number };
	readonly announced: { readonly v4: number; readonly v6: number };
	/** IPv4 addresses no longer covered by any prefix of this ASN / newly covered. */
	readonly v4AddressesLost: number;
	readonly v4AddressesGained: number;
	/** Prefixes now originated here that another watched ASN originated before, and the reverse. */
	readonly movedIn: Moved[];
	readonly movedOut: Moved[];
	/** Median withdrawal time from RIS updates (UTC ms), null when not sampled or not clear. */
	readonly withdrawalAt: number | null;
	/** Withdrawn prefixes whose updates were read / that gave a clear time. */
	readonly timingSampled: number;
	readonly timingDated: number;
};

const Prefixes = z.object({
	status: z.literal("ok"),
	data: z.object({
		resource: z.string(),
		query_time: z.string(),
		prefixes: z.object({
			v4: z.object({ originating: z.array(z.string()) }).partial(),
			v6: z.object({ originating: z.array(z.string()) }).partial(),
		}),
	}),
});
const Update = z.object({
	timestamp: z.string(),
	type: z.enum(["A", "W"]),
	attrs: z.object({ source_id: z.string(), target_prefix: z.string() }).loose(),
});
const Updates = z.object({
	status: z.literal("ok"),
	data: z.object({ resource: z.string(), updates: z.array(z.unknown()) }),
});

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16);
const ASN_ISP = new Map(ISPS.flatMap((isp) => isp.asns.map((asn) => [asn, isp.id] as const)));
const WATCHED = ISPS.flatMap((isp) => isp.asns);

export function prefixesUrl(asn: string, queryTime?: number): string {
	const p = new URLSearchParams({ resource: `AS${asn}`, list_prefixes: "true", types: "o", af: "v4,v6" });
	if (queryTime !== undefined) p.set("query_time", iso(queryTime));
	p.set("sourceapp", "vigia");
	return `${API}/ris-prefixes/data.json?${p}`;
}

export function updatesUrl(prefix: string, from: number, to: number): string {
	const p = new URLSearchParams({
		resource: prefix,
		starttime: iso(from),
		endtime: iso(to),
		sourceapp: "vigia",
	});
	return `${API}/bgp-updates/data.json?${p}`;
}

type Snapshot = { asn: string; at: number; v4: Set<string>; v6: Set<string> };

function parseSnapshot(raw: RawResponse): Snapshot {
	let json: unknown;
	try {
		json = JSON.parse(raw.body);
	} catch {
		throw new SchemaError("RIPEstat ris-prefixes: respuesta no es JSON");
	}
	const p = Prefixes.safeParse(json);
	if (!p.success) throw new SchemaError(`RIPEstat ris-prefixes: ${p.error.message}`);
	const at = parseUtc(p.data.data.query_time);
	if (!Number.isFinite(at)) throw new SchemaError("RIPEstat ris-prefixes: query_time inválido");
	const asn = p.data.data.resource.replace(/^AS/i, "");
	const v4 = new Set((p.data.data.prefixes.v4.originating ?? []).filter((x) => parseV4(x) !== null));
	const v6 = new Set(
		(p.data.data.prefixes.v6.originating ?? []).filter((x) => /^[0-9a-f:]+\/\d{1,3}$/i.test(x)),
	);
	return { asn, at, v4, v6 };
}

/** Withdrawn IPv4 prefixes of one ASN, largest first (the ones whose loss matters most), then by address. */
function withdrawnV4(prev: Snapshot, cur: Snapshot): string[] {
	return [...prev.v4]
		.filter((p) => !cur.v4.has(p))
		.sort((a, b) => {
			const ra = parseV4(a) ?? [0, 0];
			const rb = parseV4(b) ?? [0, 0];
			return rb[1] - rb[0] - (ra[1] - ra[0]) || ra[0] - rb[0];
		});
}

/** Pairs each newest snapshot with the one before it, by ASN. */
function pairs(raws: readonly RawResponse[]): Map<string, { cur: Snapshot; prev: Snapshot | null }> {
	const byAsn = new Map<string, Snapshot[]>();
	for (const raw of raws) {
		if (!raw.url.includes("/ris-prefixes/")) continue;
		const s = parseSnapshot(raw);
		byAsn.set(s.asn, [...(byAsn.get(s.asn) ?? []), s]);
	}
	const out = new Map<string, { cur: Snapshot; prev: Snapshot | null }>();
	for (const [asn, snaps] of byAsn) {
		const sorted = snaps.sort((a, b) => b.at - a.at);
		const cur = sorted[0];
		if (!cur) continue;
		const prev = sorted.find((s) => s.at === cur.at - SNAPSHOT_MS) ?? null;
		out.set(asn, { cur, prev });
	}
	return out;
}

/** Withdrawal time of one prefix from its RIS updates, or null when most peers did not end on a withdrawal. */
export function withdrawalTime(raw: RawResponse): { prefix: string; at: number | null } | null {
	let json: unknown;
	try {
		json = JSON.parse(raw.body);
	} catch {
		return null;
	}
	const u = Updates.safeParse(json);
	if (!u.success) return null;
	const last = new Map<string, { t: number; w: boolean }>();
	for (const item of u.data.data.updates) {
		const x = Update.safeParse(item);
		if (!x.success) continue;
		const t = parseUtc(x.data.timestamp);
		if (!Number.isFinite(t)) continue;
		const prev = last.get(x.data.attrs.source_id);
		if (!prev || t >= prev.t) last.set(x.data.attrs.source_id, { t, w: x.data.type === "W" });
	}
	const ws = [...last.values()].filter((v) => v.w).map((v) => v.t);
	if (last.size === 0 || ws.length * 2 <= last.size) return { prefix: u.data.data.resource, at: null };
	return { prefix: u.data.data.resource, at: median(ws) };
}

function median(xs: readonly number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? (s[mid] ?? 0) : Math.round(((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2);
}

async function fetchAll(ctx: FetchContext): Promise<RawResponse[]> {
	const options = {
		headers: { accept: "application/json" },
		hostGapMs: 1_500,
		timeoutMs: 60_000,
		maxBytes: 4 * 1024 * 1024,
		signal: ctx.signal,
	};
	const out: RawResponse[] = [];
	const snaps: { cur: Snapshot; prev: Snapshot }[] = [];
	for (const asn of WATCHED) {
		const latest = await ctx.http.request(prefixesUrl(asn), options);
		const cur = parseSnapshot(latest);
		if (ctx.seen?.(`asn:${asn}`, cur.at)) continue;
		const before = await ctx.http.request(prefixesUrl(asn, cur.at - SNAPSHOT_MS), options);
		out.push(latest, before);
		snaps.push({ cur, prev: parseSnapshot(before) });
	}
	for (const { cur, prev } of snaps) {
		for (const prefix of withdrawnV4(prev, cur).slice(0, TIMING_SAMPLE)) {
			// Optional refinement: a failure only loses the minute, never the event.
			const raw = await ctx.http
				.request(updatesUrl(prefix, prev.at, cur.at), { ...options, retries: 1 })
				.catch(() => null);
			if (raw) out.push(raw);
		}
	}
	return out;
}

export const ripestatPrefixes: Adapter<AsnRouting> = {
	id: "ripestat-prefixes",
	layer: "internet",
	name: { es: "Cambios de rutas por proveedor (RIPE RIS)", en: "Routing changes per ISP (RIPE RIS)" },
	provider: "RIPE NCC (RIPEstat, RIS)",
	homepage: "https://stat.ripe.net/app/launchpad/AS8048",
	licence: RIPESTAT_LICENCE,
	keys: [],
	intervalMs: HOUR,
	// Snapshots every 8 h, published 1–2 h later: stale when no fetch for 6 h or the newest snapshot is 12 h old.
	freshness: { fetchMs: 6 * HOUR, dataMs: 12 * HOUR },

	fetch: fetchAll,

	normalise(raws) {
		const byAsn = pairs(raws);
		const timing = new Map<string, number | null>();
		for (const raw of raws) {
			if (!raw.url.includes("/bgp-updates/")) continue;
			const w = withdrawalTime(raw);
			if (w) timing.set(w.prefix, w.at);
		}
		// Who originated what before, across the watched ASNs, for moves between them.
		const prevOwner = new Map<string, string>();
		for (const [asn, { prev }] of byAsn)
			for (const p of [...(prev?.v4 ?? []), ...(prev?.v6 ?? [])]) prevOwner.set(p, asn);
		const curOwner = new Map<string, string>();
		for (const [asn, { cur }] of byAsn) for (const p of [...cur.v4, ...cur.v6]) curOwner.set(p, asn);

		const out: Observation<AsnRouting>[] = [];
		for (const asn of WATCHED) {
			const pair = byAsn.get(asn);
			if (!pair) continue;
			const { cur, prev } = pair;
			const curRanges = union(cur.v4);
			const prevRanges = prev ? union(prev.v4) : curRanges;
			const gone = prev ? withdrawnV4(prev, cur) : [];
			const goneV6 = prev ? [...prev.v6].filter((p) => !cur.v6.has(p)) : [];
			const tally = (list: string[], owner: Map<string, string>) => {
				const counts = new Map<string, number>();
				for (const p of list) {
					const other = owner.get(p);
					if (other && other !== asn) counts.set(other, (counts.get(other) ?? 0) + 1);
				}
				return [...counts].map(([a, n]) => ({ asn: a, prefixes: n })).sort((x, y) => y.prefixes - x.prefixes);
			};
			const newOnes = prev ? [...cur.v4, ...cur.v6].filter((p) => !prev.v4.has(p) && !prev.v6.has(p)) : [];
			const times = gone.map((p) => timing.get(p)).filter((t) => t !== undefined);
			const dated = times.filter((t): t is number => t !== null && t >= (prev?.at ?? 0) && t <= cur.at);
			const fetchedAt =
				raws.find((r) => r.url === prefixesUrl(asn))?.fetchedAt ?? Math.max(...raws.map((r) => r.fetchedAt));
			out.push({
				source: "ripestat-prefixes",
				series: `asn:${asn}`,
				sourceUrl: `https://stat.ripe.net/app/launchpad/AS${asn}`,
				fetchedAt,
				observedAt: cur.at,
				licence: RIPESTAT_LICENCE.id,
				value: {
					asn,
					isp: ASN_ISP.get(asn) ?? "",
					v4Prefixes: cur.v4.size,
					v6Prefixes: cur.v6.size,
					v4Addresses: size(curRanges),
					prevAt: prev ? prev.at : null,
					withdrawn: { v4: gone.length, v6: goneV6.length },
					announced: {
						v4: prev ? [...cur.v4].filter((p) => !prev.v4.has(p)).length : 0,
						v6: prev ? [...cur.v6].filter((p) => !prev.v6.has(p)).length : 0,
					},
					v4AddressesLost: minusSize(prevRanges, curRanges),
					v4AddressesGained: minusSize(curRanges, prevRanges),
					movedIn: tally(newOnes, prevOwner),
					movedOut: tally([...gone, ...goneV6], curOwner),
					withdrawalAt: dated.length ? median(dated) : null,
					timingSampled: times.length,
					timingDated: dated.length,
				},
				confidence: 1,
				basis: "measurement",
			});
		}
		if (out.length === 0 && raws.some((r) => r.url.includes("/ris-prefixes/")))
			throw new SchemaError("RIPEstat ris-prefixes: ningún ASN vigilado en la respuesta");
		return out;
	},
};
