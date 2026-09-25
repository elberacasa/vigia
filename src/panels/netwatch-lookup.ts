/**
 * "¿Está bloqueado?": one domain's blocking history per ISP, for the /bloqueos page.
 *
 * - From what Vigía stored: OONI analysis days (ooni-methods, up to 90 days), the same 7-day matrix cell the Red
 *   panel shows, VE sin Filtro's hand-checked status and method per ISP, and OONI's 7-day anomaly reading.
 * - For a domain Vigía has never stored: at most one live OONI query per domain (the domain and its www. form,
 *   30 days, ~50 KB), cached for 6 h (a failure for 10 min), shared by concurrent requests for the same domain, and
 *   globally limited so a busy public page can never hammer OONI. It is labelled as a live query, with its time.
 * - The server allows a live query only for requests from Vigía's own page (src/server/app.ts), so another website
 *   cannot make this machine ask OONI about domains it picks or drain the budget.
 * - When OONI was not asked (offline, --no-fetch, the budget spent, a cross-site request, OONI failing), the answer
 *   says so ("not-queried" and why), never "OONI has no measurements".
 *
 * Only a syntactically valid public hostname is ever sent to OONI; nothing about the visitor is.
 */
import { ISPS } from "../adapters/ioda-asn/index.ts";
import { aggregateRows, LIKELY, type MethodCell } from "../adapters/ooni-methods/index.ts";
import { domainKey } from "../adapters/ooni-ve/categories.ts";
import type { OoniValue } from "../adapters/ooni-ve/index.ts";
import type { VsfSite } from "../adapters/vesinfiltro-blocks/index.ts";
import type { Store } from "../core/store.ts";
import type { HttpLike } from "../core/types.ts";
import {
	domainCells,
	type MatrixCell,
	METHOD_DAYS,
	methodDays,
	readDomainDays,
	SIGNATURES,
} from "./netwatch.ts";

const DAY = 86_400_000;
export const LOOKUP_DAYS = 90;
export const LIVE_DAYS = 30;
export const CACHE_MS = 6 * 3_600_000;
/** Global limit on live OONI queries: a token bucket of 20, refilled at one every 30 s. */
export const LIVE_BURST = 20;
export const LIVE_REFILL_MS = 30_000;
/** A failed live query is not retried for this long. */
export const FAILURE_CACHE_MS = 10 * 60_000;
/** Live lookups queue on their own pace, not behind (or ahead of) the ooni-ve and ooni-methods adapters. */
export const LIVE_PACE_KEY = "ooni-live-lookup";

/** A hostname a person could type: letters, digits, dots and dashes, a dot inside, no scheme or path. */
export function cleanDomain(input: string): string | null {
	let s = input.trim().toLowerCase();
	s = s
		.replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
		.replace(/[/?#].*$/, "")
		.replace(/:\d+$/, "")
		.replace(/\.$/, "");
	s = domainKey(s);
	if (s.length < 3 || s.length > 253 || !s.includes(".")) return null;
	const labels = s.split(".");
	if (!labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return null;
	if (/^\d+$/.test(labels.at(-1) ?? "")) return null;
	return s;
}

/** One ISP on one day, with its verdict by the panel's rule (a day needs no minimum count; it is one tile). */
export type DayCell = MethodCell & { state: "blocked" | "unclear" | "ok" };
export type LookupDay = { day: number; cells: DayCell[] };

export function dayCell(c: MethodCell): DayCell {
	const likely = Math.max(c.dns, c.tcp, c.tls) >= LIKELY;
	const state = !likely ? "ok" : c.outcome !== null && SIGNATURES.has(c.outcome) ? "blocked" : "unclear";
	return { ...c, state };
}

export type LookupView = {
	domain: string;
	/**
	 * Where the day-by-day history came from: stored, a live OONI query, "none" (OONI was asked, or Vigía stored
	 * the domain's days, and there are no measurements), or "not-queried" (nothing stored and OONI was not asked).
	 */
	origin: "stored" | "live" | "none" | "not-queried";
	/** Why OONI was not asked; null unless origin is "not-queried". */
	notQueried: NotQueried | null;
	/** For a live query: when OONI was asked (UTC ms). */
	liveAt: number | null;
	/** Oldest first. */
	days: LookupDay[];
	/** The 7-day cell per ISP, by the Red panel's rule (stored data only). */
	matrix: MatrixCell[] | null;
	vsf: {
		updated: string;
		site: string;
		isps: { isp: string; status: string; methods: string[] }[];
		url: string;
	} | null;
	ooni7d: {
		fetchedAt: number;
		isps: { isp: string; measurements: number; anomalyRatePct: number; flagged: boolean }[];
		url: string;
	} | null;
	isps: { id: string; name: string }[];
	explorerUrl: string;
	error: string | null;
};

/**
 * offline: Vigía runs without fetching (--no-fetch). busy: the global live budget is spent. cross-site: the request
 * did not come from Vigía's own page. failed: OONI did not answer (retried after FAILURE_CACHE_MS).
 */
export type NotQueried = "offline" | "busy" | "cross-site" | "failed";

export function storedLookup(store: Store, domain: string, now: number): LookupView {
	const byDay = readDomainDays(store, now - LOOKUP_DAYS * DAY, domain).get(domain);
	const days: LookupDay[] = byDay
		? [...byDay].sort(([a], [b]) => a - b).map(([day, cells]) => ({ day, cells: cells.map(dayCell) }))
		: [];
	let matrix: MatrixCell[] | null = null;
	if (byDay) {
		const window = new Set(
			methodDays(store, now)
				.filter((d) => d.complete)
				.slice(-METHOD_DAYS)
				.map((d) => d.day),
		);
		matrix = domainCells(byDay, window);
	}
	// VE sin Filtro lists "x" and "www.x" separately; either matches.
	let vsf: LookupView["vsf"] = null;
	for (const series of [`site:${domain}`, `site:www.${domain}`]) {
		const row = store.latest<VsfSite>("vesinfiltro-blocks", series);
		if (row && row.value.key === domain && (!vsf || row.value.updated > vsf.updated))
			vsf = {
				updated: row.value.updated,
				site: row.value.site,
				isps: row.value.isps.map((c) => ({ isp: c.isp, status: c.status, methods: [...c.methods] })),
				url: row.sourceUrl,
			};
	}
	if (!vsf) {
		// Fallback for any other series naming: scan the newest list for the key.
		const hit = store
			.latestPerSeries<VsfSite>("vesinfiltro-blocks", 0, 5_000)
			.filter((o) => o.value.key === domain)
			.sort((a, b) => b.observedAt - a.observedAt)[0];
		if (hit)
			vsf = {
				updated: hit.value.updated,
				site: hit.value.site,
				isps: hit.value.isps.map((c) => ({ isp: c.isp, status: c.status, methods: [...c.methods] })),
				url: hit.sourceUrl,
			};
	}
	const o = store.latest<OoniValue>("ooni-ve", `domain:${domain}`);
	const ooni7d: LookupView["ooni7d"] =
		o && o.value.kind === "domain" && o.fetchedAt >= now - 3 * DAY
			? {
					fetchedAt: o.fetchedAt,
					isps: o.value.isps.map((c) => ({
						isp: c.isp,
						measurements: c.measurements,
						anomalyRatePct: Math.round(c.anomalyRate * 1_000) / 10,
						flagged: c.flagged,
					})),
					url: o.sourceUrl,
				}
			: null;
	return {
		domain,
		// Nothing stored means OONI has not been asked yet about this domain: createLookup decides what follows.
		origin: days.length ? "stored" : "not-queried",
		notQueried: days.length ? null : "offline",
		liveAt: null,
		days,
		matrix,
		vsf,
		ooni7d,
		isps: ISPS.map((i) => ({ id: i.id, name: i.name })),
		explorerUrl: `https://explorer.ooni.org/domain/${encodeURIComponent(domain)}?probe_cc=VE`,
		error: null,
	};
}

export function liveUrl(domain: string, now: number): string {
	const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
	const p = new URLSearchParams({
		probe_cc: "VE",
		domain,
		since: day(now - LIVE_DAYS * DAY),
		until: day(now + DAY),
		axis_x: "measurement_start_day",
		axis_y: "probe_asn",
		test_name: "web_connectivity",
	});
	return `https://api.ooni.io/api/v1/aggregation/analysis?${p}`;
}

/** Groups live analysis rows by day and aggregates each day with the adapter's own rule. */
export function liveDays(bodies: readonly string[], domain: string): LookupDay[] {
	const byDay = new Map<number, unknown[]>();
	for (const body of bodies) {
		let json: unknown;
		try {
			json = JSON.parse(body);
		} catch {
			continue;
		}
		const results = (json as { results?: unknown })?.results;
		if (!Array.isArray(results)) continue;
		for (const r of results) {
			const d = (r as { measurement_start_day?: unknown })?.measurement_start_day;
			const t = typeof d === "string" ? Date.parse(d) : Number.NaN;
			if (!Number.isFinite(t)) continue;
			const day = Math.floor(t / DAY) * DAY;
			byDay.set(day, [...(byDay.get(day) ?? []), r]);
		}
	}
	return [...byDay]
		.sort(([a], [b]) => a - b)
		.map(([day, rows]) => ({ day, cells: (aggregateRows(rows).perDomain.get(domain) ?? []).map(dayCell) }))
		.filter((d) => d.cells.length > 0);
}

export interface LookupDeps {
	readonly store: Store;
	readonly http: HttpLike;
	readonly now?: () => number;
	/** False when Vigía runs with --no-fetch: stored data only, never a live OONI query. */
	readonly live?: boolean;
}

export interface LookupOptions {
	/** False when the request may not trigger a live query (it did not come from Vigía's own page). */
	readonly live?: boolean;
}

export type Lookup = (input: string, options?: LookupOptions) => Promise<LookupView | { error: string }>;

/** The lookup the server calls: stored first, then (rarely) one cached live OONI query. */
export function createLookup(deps: LookupDeps): Lookup {
	const now = deps.now ?? Date.now;
	const cache = new Map<string, { at: number; days: LookupDay[] } | { at: number; failed: true }>();
	const inflight = new Map<string, Promise<{ at: number; days: LookupDay[] } | null>>();
	let tokens = LIVE_BURST;
	let refilledAt = now();
	const take = (): boolean => {
		const t = now();
		const gained = Math.floor((t - refilledAt) / LIVE_REFILL_MS);
		if (gained > 0) {
			tokens = Math.min(LIVE_BURST, tokens + gained);
			refilledAt += gained * LIVE_REFILL_MS;
		}
		if (tokens <= 0) return false;
		tokens--;
		return true;
	};
	const remember = (
		domain: string,
		entry: { at: number; days: LookupDay[] } | { at: number; failed: true },
	) => {
		cache.delete(domain);
		cache.set(domain, entry);
		if (cache.size > 500) cache.delete(cache.keys().next().value as string);
	};
	/** One live query per domain at a time; concurrent callers share it. Null when OONI did not answer. */
	const ask = (domain: string, t: number) => {
		const running = inflight.get(domain);
		if (running) return running;
		const job = (async () => {
			try {
				const bodies: string[] = [];
				for (const d of [domain, `www.${domain}`]) {
					const res = await deps.http.request(liveUrl(d, t), {
						headers: { accept: "application/json" },
						timeoutMs: 20_000,
						retries: 0,
						hostGapMs: 2_000,
						paceKey: LIVE_PACE_KEY,
						maxBytes: 4 * 1024 * 1024,
					});
					bodies.push(res.body);
				}
				const entry = { at: t, days: liveDays(bodies, domain) };
				remember(domain, entry);
				return entry;
			} catch {
				remember(domain, { at: t, failed: true });
				return null;
			}
		})().finally(() => inflight.delete(domain));
		inflight.set(domain, job);
		return job;
	};
	const live = (view: LookupView, entry: { at: number; days: LookupDay[] }): LookupView => ({
		...view,
		origin: entry.days.length ? "live" : "none",
		notQueried: null,
		liveAt: entry.at,
		days: entry.days,
	});
	const notAsked = (view: LookupView, why: NotQueried): LookupView => ({
		...view,
		origin: "not-queried",
		notQueried: why,
	});
	return async (input, options = {}) => {
		const domain = cleanDomain(input);
		if (!domain) return { error: "Escribe un dominio válido, por ejemplo infobae.com." };
		const t = now();
		const view = storedLookup(deps.store, domain, t);
		if (view.origin === "stored") return view;
		const hit = cache.get(domain);
		if (hit && "days" in hit && t - hit.at < CACHE_MS) return live(view, hit);
		if (hit && "failed" in hit && t - hit.at < FAILURE_CACHE_MS) return notAsked(view, "failed");
		if (deps.live === false) return notAsked(view, "offline");
		// A query already running for this domain is joined whoever asks: it costs nothing more.
		const running = inflight.get(domain);
		if (!running) {
			if (options.live === false) return notAsked(view, "cross-site");
			if (!take()) return notAsked(view, "busy");
		}
		const entry = await (running ?? ask(domain, t));
		return entry ? live(view, entry) : notAsked(view, "failed");
	};
}
