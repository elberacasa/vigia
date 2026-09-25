/**
 * "Red": Venezuela's internet as a system, in four measured readings, each with its own source, rule and age:
 *
 * 1. Evasión: Tor users from Venezuela (Tor Metrics), direct and via bridges, 90 days. Direct users are judged by
 *    Tor Metrics' own expected range; bridge users by a stated rolling rule (no published range exists).
 * 2. Rutas: prefixes each main ISP originates (RIPE RIS via RIPEstat), and routing events between snapshots.
 * 3. Métodos: how each ISP blocks each site (OONI analysis), over the last 7 complete days, with first/last seen.
 * 4. Portales: public portals' reachability measured from this computer (opt-in probe).
 *
 * All arithmetic is here and tested; the browser only formats.
 */
import { ISPS } from "../adapters/ioda-asn/index.ts";
import { type DaySummary, type DomainDay, LIKELY, type MethodCell } from "../adapters/ooni-methods/index.ts";
import { PORTALS, type PortalReading, type PortalState } from "../adapters/portal-probe/index.ts";
import type { AsnRouting } from "../adapters/ripestat-prefixes/index.ts";
import type { TorDay } from "../adapters/tor-metrics/index.ts";
import type { Store } from "../core/store.ts";
import type { Panel } from "../server/panels.ts";
import { completeness } from "./ooni-runs.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ——— 1. Tor ———

export const TOR_DAYS = 90;
/** Bridge rule: compare with the median of the previous 28 days. */
export const BRIDGE_BASE_DAYS = 28;
export const BRIDGE_RATIO = 1.5;
export const BRIDGE_MIN_DELTA = 20;

export type TorPoint = {
	day: number;
	users: number;
	lower: number | null;
	upper: number | null;
	flag: "up" | "down" | null;
};

export type TorView = {
	relay: TorPoint[];
	bridge: TorPoint[];
	latest: { day: number; relay: number | null; bridge: number | null; relayFrac: number | null } | null;
	/** Relay users on the latest day vs the median of the 28 days before, %; null without enough days. */
	relayChangePct: number | null;
	/** Anomalous days in the last 30 (either series). */
	recentFlags: { day: number; series: "relay" | "bridge"; flag: "up" | "down"; users: number }[];
	fetchedAt: number | null;
	sourceUrl: string;
	ruleEs: string;
	ruleEn: string;
};

export function median(xs: readonly number[]): number | null {
	if (xs.length === 0) return null;
	const s = [...xs].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Relay: Tor Metrics' range. Bridge: ≥ 1.5× (or ≤ 1/1.5×) the previous 28-day median and ≥ 20 users apart. */
export function flagTor(
	points: readonly { day: number; users: number; lower: number | null; upper: number | null }[],
	kind: "relay" | "bridge",
): TorPoint[] {
	return points.map((p, i) => {
		let flag: TorPoint["flag"] = null;
		if (kind === "relay") {
			if (p.upper !== null && p.users > p.upper) flag = "up";
			else if (p.lower !== null && p.users < p.lower) flag = "down";
		} else {
			const base = median(points.slice(Math.max(0, i - BRIDGE_BASE_DAYS), i).map((q) => q.users));
			if (base !== null && i >= 7) {
				if (p.users >= base * BRIDGE_RATIO && p.users - base >= BRIDGE_MIN_DELTA) flag = "up";
				else if (p.users <= base / BRIDGE_RATIO && base - p.users >= BRIDGE_MIN_DELTA) flag = "down";
			}
		}
		return { day: p.day, users: p.users, lower: p.lower, upper: p.upper, flag };
	});
}

function torSeries(store: Store, series: string, now: number) {
	// One value per day: the newest revision wins (history is ordered oldest first).
	const byDay = new Map<number, TorDay & { fetchedAt: number }>();
	for (const o of store.history<TorDay>(
		"tor-metrics",
		series,
		now - (TOR_DAYS + BRIDGE_BASE_DAYS + 2) * DAY,
		now,
	))
		byDay.set(o.observedAt, { ...o.value, fetchedAt: o.fetchedAt });
	return [...byDay].sort(([a], [b]) => a - b).map(([day, v]) => ({ day, ...v }));
}

export function torView(store: Store, now: number): TorView {
	const relayRaw = torSeries(store, "country:VE:tor-relay", now);
	const bridgeRaw = torSeries(store, "country:VE:tor-bridge", now);
	const lastRelay = relayRaw.at(-1);
	const lastBridge = bridgeRaw.at(-1);
	const lastDay = Math.max(lastRelay?.day ?? 0, lastBridge?.day ?? 0);
	// The 90 days ending on the newest day Tor Metrics has published (it lags ~2 days).
	const from = lastDay - (TOR_DAYS - 1) * DAY;
	const relay = flagTor(relayRaw, "relay").filter((p) => p.day >= from);
	const bridge = flagTor(bridgeRaw, "bridge").filter((p) => p.day >= from);
	let relayChangePct: number | null = null;
	if (lastRelay) {
		const prior = relayRaw.filter((p) => p.day < lastRelay.day && p.day >= lastRelay.day - 28 * DAY);
		const base = prior.length >= 14 ? median(prior.map((p) => p.users)) : null;
		if (base) relayChangePct = Math.round(((lastRelay.users - base) / base) * 1_000) / 10;
	}
	const recent = (pts: TorPoint[], s: "relay" | "bridge") =>
		pts
			.filter((p) => p.flag !== null && p.day >= lastDay - 30 * DAY)
			.map((p) => ({ day: p.day, series: s, flag: p.flag as "up" | "down", users: p.users }));
	const fetched = [...relayRaw, ...bridgeRaw].map((p) => p.fetchedAt);
	return {
		relay,
		bridge,
		latest: lastDay
			? {
					day: lastDay,
					relay: lastRelay?.day === lastDay ? lastRelay.users : null,
					bridge: lastBridge?.day === lastDay ? lastBridge.users : null,
					relayFrac: lastRelay?.day === lastDay ? lastRelay.frac : null,
				}
			: null,
		relayChangePct,
		recentFlags: [...recent(relay, "relay"), ...recent(bridge, "bridge")].sort((a, b) => b.day - a.day),
		fetchedAt: fetched.length ? Math.max(...fetched) : null,
		sourceUrl:
			"https://metrics.torproject.org/userstats-relay-country.html?graph=userstats-relay-country&country=ve&events=on",
		ruleEs: `Conexiones directas: fuera del rango esperado que publica Tor Metrics (su detector de censura). Puentes: ${BRIDGE_RATIO}× sobre o bajo la mediana de los ${BRIDGE_BASE_DAYS} días previos y al menos ${BRIDGE_MIN_DELTA} usuarios de diferencia. Son estimaciones de Tor, no conteos de personas.`,
		ruleEn: `Direct: outside the expected range Tor Metrics publishes (its censorship detector). Bridges: ${BRIDGE_RATIO}× above or below the median of the previous ${BRIDGE_BASE_DAYS} days and at least ${BRIDGE_MIN_DELTA} users apart. Tor's estimates, not head counts.`,
	};
}

// ——— 2. Routing ———

/** An event: ≥ 1 % of the ISP's IPv4 space and at least one /24 stops (or starts) being announced, or a move. */
export const ROUTE_SHARE = 0.01;
export const ROUTE_MIN_ADDRESSES = 256;
export const ROUTE_WINDOW_MS = 30 * DAY;

export type RouteIsp = {
	isp: string;
	name: string;
	asns: string[];
	/** Newest snapshot read (UTC ms). */
	at: number | null;
	v4Prefixes: number;
	v6Prefixes: number;
	v4Addresses: number;
	/** Events in the window for this ISP. */
	events: number;
	/** Snapshots compared in the window with small changes below the event rule. */
	minorChanges: number;
};

export type RouteEvent = {
	isp: string;
	asn: string;
	kind: "withdrawal" | "announcement" | "move";
	/** Between these two snapshots… */
	after: number;
	by: number;
	/** …and, when RIS updates dated it, at this minute. */
	at: number | null;
	prefixes: number;
	addresses: number;
	/** Share of the ISP's previous IPv4 space, %. */
	sharePct: number;
	/** For moves: the other network. */
	other: { asn: string; isp: string | null } | null;
	url: string;
};

export type RoutingView = {
	isps: RouteIsp[];
	events: RouteEvent[];
	/** First snapshot Vigía compared (null: none yet). */
	watchingSince: number | null;
	newestAt: number | null;
	ruleEs: string;
	ruleEn: string;
};

const ISP_OF_ASN = new Map(ISPS.flatMap((i) => i.asns.map((a) => [a, i.id] as const)));

export function routeEvents(v: AsnRouting, at: number): RouteEvent[] {
	if (v.prevAt === null) return [];
	const prevSpace = v.v4Addresses + v.v4AddressesLost - v.v4AddressesGained;
	const share = (n: number) => (prevSpace > 0 ? Math.round((n / prevSpace) * 1_000) / 10 : 0);
	const url = `https://stat.ripe.net/app/launchpad/AS${v.asn}`;
	const base = { isp: v.isp, asn: v.asn, after: v.prevAt, by: at, url };
	const out: RouteEvent[] = [];
	const big = (n: number) => n >= ROUTE_MIN_ADDRESSES && prevSpace > 0 && n / prevSpace >= ROUTE_SHARE;
	if (big(v.v4AddressesLost))
		out.push({
			...base,
			kind: "withdrawal",
			at: v.withdrawalAt,
			prefixes: v.withdrawn.v4 + v.withdrawn.v6,
			addresses: v.v4AddressesLost,
			sharePct: share(v.v4AddressesLost),
			other: null,
		});
	if (big(v.v4AddressesGained))
		out.push({
			...base,
			kind: "announcement",
			at: null,
			prefixes: v.announced.v4 + v.announced.v6,
			addresses: v.v4AddressesGained,
			sharePct: share(v.v4AddressesGained),
			other: null,
		});
	for (const m of v.movedOut)
		out.push({
			...base,
			kind: "move",
			at: null,
			prefixes: m.prefixes,
			addresses: 0,
			sharePct: 0,
			other: { asn: m.asn, isp: ISP_OF_ASN.get(m.asn) ?? null },
		});
	return out;
}

export function routingView(store: Store, now: number): RoutingView {
	const from = now - ROUTE_WINDOW_MS;
	const events: RouteEvent[] = [];
	const isps: RouteIsp[] = [];
	let watchingSince: number | null = null;
	let newestAt: number | null = null;
	for (const isp of ISPS) {
		const row: RouteIsp = {
			isp: isp.id,
			name: isp.name,
			asns: [...isp.asns],
			at: null,
			v4Prefixes: 0,
			v6Prefixes: 0,
			v4Addresses: 0,
			events: 0,
			minorChanges: 0,
		};
		let seen = 0;
		for (const asn of isp.asns) {
			const latest = store.latest<AsnRouting>("ripestat-prefixes", `asn:${asn}`);
			if (!latest) continue;
			seen++;
			row.at = Math.max(row.at ?? 0, latest.observedAt);
			newestAt = Math.max(newestAt ?? 0, latest.observedAt);
			row.v4Prefixes += latest.value.v4Prefixes;
			row.v6Prefixes += latest.value.v6Prefixes;
			// Digitel's two ASNs could overlap in space; they do not today, and a sum is what RIS shows per ASN.
			row.v4Addresses += latest.value.v4Addresses;
			for (const h of store.history<AsnRouting>("ripestat-prefixes", `asn:${asn}`, 0, now, 2_000)) {
				if (h.value.prevAt === null) continue;
				watchingSince = Math.min(watchingSince ?? h.value.prevAt, h.value.prevAt);
				if (h.observedAt < from) continue;
				const ev = routeEvents(h.value, h.observedAt);
				events.push(...ev);
				row.events += ev.length;
				const changed =
					h.value.withdrawn.v4 + h.value.withdrawn.v6 + h.value.announced.v4 + h.value.announced.v6;
				if (ev.length === 0 && changed > 0) row.minorChanges++;
			}
		}
		if (seen) isps.push(row);
	}
	events.sort((a, b) => b.by - a.by || b.addresses - a.addresses);
	return {
		isps,
		events: events.slice(0, 50),
		watchingSince,
		newestAt,
		ruleEs: `Evento: un proveedor deja de anunciar (o empieza a anunciar) al menos el ${ROUTE_SHARE * 100} % de su espacio IPv4 y al menos una /24, entre dos fotos de los colectores RIS (cada 8 h); o prefijos que pasan de una red venezolana vigilada a otra. La hora exacta sale de las actualizaciones BGP de RIS cuando la mayoría de sus pares vio el retiro.`,
		ruleEn: `Event: an ISP stops (or starts) announcing at least ${ROUTE_SHARE * 100} % of its IPv4 space and at least one /24 between two RIS collector snapshots (every 8 h); or prefixes moving between watched Venezuelan networks. The minute comes from RIS BGP updates when most peers saw the withdrawal.`,
	};
}

// ——— 3. Blocking methods ———

export const METHOD_DAYS = 7;
export const METHOD_MIN_N = 10;
/** A day counts toward first/last seen when it has this many measurements and a likely block. */
export const DAY_MIN_N = 3;
const HISTORY_DAYS = 120;

export type Layer = "dns" | "tcp" | "tls";

export type MatrixCell = {
	isp: string;
	/**
	 * blocked: ≥ 10 measurements, a layer ≥ 0.5 and a blocking signature as OONI's most frequent outcome;
	 * unclear: interference likely but only timeouts or other errors (often a site that is down); ok: ≥ 10
	 * measurements and no layer ≥ 0.5; few: fewer than 10 measurements.
	 */
	state: "blocked" | "unclear" | "ok" | "few";
	/** Layers at or above 0.5, strongest first. */
	layers: Layer[];
	/** Strongest layer's mean likelihood, %. */
	likelihoodPct: number;
	outcome: string | null;
	n: number;
	/** First and last day (UTC ms) with a likely block on this ISP, in what Vigía stored. */
	firstSeen: number | null;
	lastSeen: number | null;
};

export type MatrixRow = { domain: string; cells: MatrixCell[]; blockedOn: number };

export type MethodsView = {
	/** The complete days used (UTC ms), oldest first. */
	days: number[];
	/** Days skipped because OONI's volume was under half the recent median. */
	skippedDays: number[];
	rows: MatrixRow[];
	/** Domains blocked on ≥ 1 ISP in the window (rows is capped). */
	totalBlocked: number;
	/** Per ISP: blocked domains by strongest layer. */
	byIsp: {
		isp: string;
		name: string;
		dns: number;
		tcp: number;
		tls: number;
		blocked: number;
		tested: number;
	}[];
	watchingSince: number | null;
	fetchedAt: number | null;
	ruleEs: string;
	ruleEn: string;
};

type Acc = { n: number; dns: number; tcp: number; tls: number; outcomes: Map<string, number> };

/** Newest revision of every domain-day since `from`, keyed by domain then day. */
export function readDomainDays(
	store: Store,
	from: number,
	domain?: string,
): Map<string, Map<number, MethodCell[]>> {
	const rows = domain
		? store.db
				.query<{ observed_at: number; value: string }, [string, number]>(
					"SELECT observed_at, value FROM obs WHERE source = 'ooni-methods' AND series = ? AND observed_at >= ? ORDER BY id",
				)
				.all(`domain:${domain}`, from)
		: store.db
				.query<{ observed_at: number; value: string }, [number]>(
					"SELECT observed_at, value FROM obs WHERE source = 'ooni-methods' AND series LIKE 'domain:%' AND observed_at >= ? ORDER BY id",
				)
				.all(from);
	// The newest fetch of each day names the domains it flagged; a row an earlier, partial fetch wrote for a domain
	// that the newest one did not flag is stale (review 3 M6: a 12-measurement "blocked" kept after 200 said "no").
	const flagged = new Map<number, Set<string>>();
	for (const o of store.history<DaySummary>("ooni-methods", "day", from, Number.MAX_SAFE_INTEGER, 5_000)) {
		if (o.value.kind !== "day") continue;
		if (Array.isArray(o.value.likely)) flagged.set(o.observedAt, new Set(o.value.likely));
		else flagged.delete(o.observedAt); // an older summary format: trust the rows, as before
	}
	const out = new Map<string, Map<number, MethodCell[]>>();
	for (const r of rows) {
		let v: DomainDay;
		try {
			v = JSON.parse(r.value) as DomainDay;
		} catch {
			continue;
		}
		if (v.kind !== "domain-day" || !Array.isArray(v.cells)) continue;
		const days = out.get(v.domain) ?? new Map<number, MethodCell[]>();
		days.set(r.observed_at, v.cells);
		out.set(v.domain, days);
	}
	for (const [domain, days] of out) {
		for (const day of days.keys()) if (flagged.get(day)?.has(domain) === false) days.delete(day);
		if (days.size === 0) out.delete(domain);
	}
	return out;
}

/** Daily summaries (newest revision per day), oldest first, with completeness by the OONI complete-runs rule. */
export function methodDays(
	store: Store,
	now: number,
): { day: number; measurements: number; complete: boolean; fetchedAt: number }[] {
	const byDay = new Map<number, { m: number; fetchedAt: number }>();
	for (const o of store.history<DaySummary>("ooni-methods", "day", now - HISTORY_DAYS * DAY, now, 1_000))
		byDay.set(o.observedAt, { m: o.value.measurements, fetchedAt: o.fetchedAt });
	const days = [...byDay].sort(([a], [b]) => a - b);
	const complete = completeness(days.map(([, v]) => v.m));
	return days.map(([day, v], i) => ({
		day,
		measurements: v.m,
		complete: complete[i] ?? false,
		fetchedAt: v.fetchedAt,
	}));
}

export function strongest(c: { dns: number; tcp: number; tls: number }): { layers: Layer[]; max: number } {
	const all = (["dns", "tcp", "tls"] as const).map((l) => [l, c[l]] as const).sort((a, b) => b[1] - a[1]);
	return { layers: all.filter(([, v]) => v >= LIKELY).map(([l]) => l), max: all[0]?.[1] ?? 0 };
}

/**
 * OONI outcomes that are a blocking signature. Measured 2026-09-24 against VE sin Filtro (768 domain × ISP cells,
 * 7 days): with these, precision 0.87 and recall 0.92 (0.83 / 0.93 counting every outcome); timeouts alone were
 * wrong 4 times in 5 (tcp.generic_timeout_error: 3 of 16 cells right), so they are "unclear", never "blocked".
 * Where both say blocked, OONI's step matches VE sin Filtro's method in 382 of 391 cells.
 */
export const SIGNATURES: ReadonlySet<string> = new Set([
	"dns.nxdomain",
	"dns.dns_no_answer",
	"dns.got_answer",
	"dns.dns_servfail_error",
	"tls.connection_reset",
]);

export function cellOf(
	isp: string,
	acc: Acc | undefined,
	seen: { first: number | null; last: number | null },
): MatrixCell {
	if (!acc || acc.n === 0)
		return {
			isp,
			state: "few",
			layers: [],
			likelihoodPct: 0,
			outcome: null,
			n: 0,
			firstSeen: seen.first,
			lastSeen: seen.last,
		};
	const mean = { dns: acc.dns / acc.n, tcp: acc.tcp / acc.n, tls: acc.tls / acc.n };
	const { layers, max } = strongest(mean);
	let outcome: string | null = null;
	let best = 0;
	for (const [o, n] of [...acc.outcomes].sort(([a], [b]) => a.localeCompare(b)))
		if (n > best) {
			best = n;
			outcome = o;
		}
	const signed = outcome !== null && SIGNATURES.has(outcome);
	const state = acc.n < METHOD_MIN_N ? "few" : !layers.length ? "ok" : signed ? "blocked" : "unclear";
	// The signature's step leads (a DNS answer that is false is a DNS block even if TLS then fails too).
	const lead = signed ? (outcome?.split(".")[0] as Layer) : null;
	const ordered = lead && layers.includes(lead) ? [lead, ...layers.filter((l) => l !== lead)] : layers;
	return {
		isp,
		state,
		layers: ordered,
		likelihoodPct: Math.round(max * 100),
		outcome: state === "blocked" || state === "unclear" ? outcome : null,
		n: acc.n,
		firstSeen: seen.first,
		lastSeen: seen.last,
	};
}

/** Aggregates one domain's stored days into one cell per main ISP. */
export function domainCells(days: Map<number, MethodCell[]>, window: ReadonlySet<number>): MatrixCell[] {
	const acc = new Map<string, Acc>();
	const seen = new Map<string, { first: number | null; last: number | null }>();
	for (const [day, cells] of [...days].sort(([a], [b]) => a - b)) {
		for (const c of cells) {
			if (
				Math.max(c.dns, c.tcp, c.tls) >= LIKELY &&
				c.n >= DAY_MIN_N &&
				c.outcome &&
				SIGNATURES.has(c.outcome)
			) {
				const s = seen.get(c.isp) ?? { first: null, last: null };
				s.first = s.first ?? day;
				s.last = day;
				seen.set(c.isp, s);
			}
			if (!window.has(day)) continue;
			const a = acc.get(c.isp) ?? { n: 0, dns: 0, tcp: 0, tls: 0, outcomes: new Map<string, number>() };
			a.n += c.n;
			a.dns += c.n * c.dns;
			a.tcp += c.n * c.tcp;
			a.tls += c.n * c.tls;
			if (c.outcome) a.outcomes.set(c.outcome, (a.outcomes.get(c.outcome) ?? 0) + c.n);
			acc.set(c.isp, a);
		}
	}
	return ISPS.map((isp) => cellOf(isp.id, acc.get(isp.id), seen.get(isp.id) ?? { first: null, last: null }));
}

export function methodsView(store: Store, now: number, limit = 40): MethodsView {
	const all = methodDays(store, now);
	const complete = all.filter((d) => d.complete);
	const days = complete.slice(-METHOD_DAYS).map((d) => d.day);
	const firstUsed = days[0] ?? now;
	const skippedDays = all.filter((d) => !d.complete && d.day >= firstUsed).map((d) => d.day);
	const window = new Set(days);
	const stored = readDomainDays(store, now - HISTORY_DAYS * DAY);
	const rows: MatrixRow[] = [];
	for (const [domain, byDay] of stored) {
		const cells = domainCells(byDay, window);
		const blockedOn = cells.filter((c) => c.state === "blocked").length;
		if (blockedOn > 0) rows.push({ domain, cells, blockedOn });
	}
	const volume = (r: MatrixRow) => r.cells.reduce((s, c) => s + c.n, 0);
	rows.sort((a, b) => b.blockedOn - a.blockedOn || volume(b) - volume(a) || a.domain.localeCompare(b.domain));
	const byIsp = ISPS.map((isp, i) => {
		const counts = { dns: 0, tcp: 0, tls: 0, blocked: 0, tested: 0 };
		for (const r of rows) {
			const c = r.cells[i];
			if (!c || c.state === "few") continue;
			counts.tested++;
			if (c.state !== "blocked") continue;
			counts.blocked++;
			const top = c.layers[0];
			if (top) counts[top]++;
		}
		return { isp: isp.id, name: isp.name, ...counts };
	});
	return {
		days,
		skippedDays,
		rows: rows.slice(0, limit),
		totalBlocked: rows.length,
		byIsp,
		watchingSince: all[0]?.day ?? null,
		fetchedAt: all.length ? Math.max(...all.map((d) => d.fetchedAt)) : null,
		ruleEs: `Bloqueado en un proveedor: al menos ${METHOD_MIN_N} mediciones de OONI en los ${METHOD_DAYS} días completos más recientes y una probabilidad media de interferencia de ${Math.round(LIKELY * 100)} % o más en DNS, TCP o TLS, con una firma de bloqueo (DNS falso o vacío, o conexión TLS cortada); solo tiempos agotados se muestran como «dudoso». Medido contra la lista de VE sin Filtro: coincide en el 87 % de los casos marcados y encuentra el 92 % de los suyos. Días con menos de la mitad del volumen habitual de OONI no cuentan.`,
		ruleEn: `Blocked on an ISP: at least ${METHOD_MIN_N} OONI measurements in the ${METHOD_DAYS} most recent complete days and a mean interference likelihood of ${Math.round(LIKELY * 100)} % or more at DNS, TCP or TLS, with a blocking signature (a false or empty DNS answer, or a TLS connection cut); timeouts alone show as “unclear”. Checked against VE sin Filtro's list: 87 % of flagged cells agree and 92 % of theirs are found. Days under half of OONI's usual volume do not count.`,
	};
}

// ——— 4. Portals ———

export type PortalRow = {
	id: string;
	name: string;
	what: string;
	url: string;
	reading: PortalReading | null;
	at: number | null;
	/** Readings in the last 24 h and how many got an HTTP answer (any status). */
	readings24h: number;
	answered24h: number;
	/** Days until the TLS certificate expires (negative: expired). */
	certDays: number | null;
	/** When the DNS answer last changed (7 days), and how many times. */
	dnsChangedAt: number | null;
	dnsChanges7d: number;
};

export type PortalsView = {
	/** Whether any probe reading is stored (the probe is opt-in; the UI reads the feed's on/off state). */
	hasData: boolean;
	rows: PortalRow[];
	newestAt: number | null;
	vantageEs: string;
	vantageEn: string;
};

const ANSWERED: ReadonlySet<PortalState> = new Set(["ok", "odd-response", "refuses", "server-error"]);

export function portalsView(store: Store, now: number): PortalsView {
	let newestAt: number | null = null;
	const rows = PORTALS.map((p): PortalRow => {
		const history = store.history<PortalReading>("portal-probe", `portal:${p.id}`, now - 7 * DAY, now, 2_000);
		const latest = history.at(-1) ?? null;
		if (latest) newestAt = Math.max(newestAt ?? 0, latest.observedAt);
		const day = history.filter((h) => h.observedAt >= now - DAY);
		let dnsChangedAt: number | null = null;
		let dnsChanges7d = 0;
		let prev: string | null = null;
		for (const h of history) {
			if (h.value.state === "no-dns" || h.value.addresses.length === 0) continue;
			const key = [...h.value.addresses].sort().join(",");
			if (prev !== null && key !== prev) {
				dnsChanges7d++;
				dnsChangedAt = h.observedAt;
			}
			prev = key;
		}
		const validTo = latest?.value.tlsValidTo ?? null;
		return {
			id: p.id,
			name: p.name,
			what: p.what,
			url: p.url,
			reading: latest?.value ?? null,
			at: latest?.observedAt ?? null,
			readings24h: day.length,
			answered24h: day.filter((h) => ANSWERED.has(h.value.state)).length,
			certDays: validTo !== null && latest ? Math.floor((validTo - latest.observedAt) / DAY) : null,
			dnsChangedAt,
			dnsChanges7d,
		};
	});
	return {
		hasData: newestAt !== null,
		rows,
		newestAt,
		vantageEs:
			"Medido desde este equipo, no desde Venezuela en general. Muchos sitios .gob.ve bloquean conexiones desde el exterior: «no responde desde aquí» no significa «caído».",
		vantageEn:
			"Measured from this computer, not from Venezuela at large. Many .gob.ve sites block connections from abroad: “no answer from here” does not mean “down”.",
	};
}

// ——— Panel ———

export type NetwatchView = {
	tor: TorView;
	routing: RoutingView;
	methods: MethodsView;
	portals: PortalsView;
	feeds: string[];
};

export function netwatchView(store: Store, now: number): NetwatchView {
	return {
		tor: torView(store, now),
		routing: routingView(store, now),
		methods: methodsView(store, now),
		portals: portalsView(store, now),
		feeds: ["tor-metrics", "ripestat-prefixes", "ooni-methods", "portal-probe"],
	};
}

export const netwatchPanel: Panel<NetwatchView> = {
	id: "netwatch",
	sources: ["tor-metrics", "ripestat-prefixes", "ooni-methods", "portal-probe"],
	compute: (store: Store, now: number) => netwatchView(store, now),
};
