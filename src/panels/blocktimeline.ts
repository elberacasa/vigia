/**
 * When was a site blocked or unblocked, and on which ISP? Computed by comparing consecutive stored versions of each
 * source, so a change is only ever reported between two real observations:
 *
 * - VE sin Filtro: each list update (dated on their page) is one version per site; a change between two updates
 *   happened somewhere in that interval, and the event says so (`after` … `by`).
 * - OONI: each Vigía run stores the domains flagged in OONI's 7-day window; a domain entering or leaving the flagged
 *   set is a change in OONI's reading, which lags reality by up to 7 days (labelled). Only complete runs count, and
 *   a flag ends only after two consecutive complete runs without it (src/panels/ooni-runs.ts).
 *
 * The first version Vigía saw is a baseline, never an event ("already blocked when Vigía started watching").
 */
import type { OoniValue } from "../adapters/ooni-ve/index.ts";
import type { VsfSite } from "../adapters/vesinfiltro-blocks/index.ts";
import type { Store } from "../core/store.ts";
import { END_AFTER, ooniRuns } from "./ooni-runs.ts";

export type BlockChange = {
	source: "vesinfiltro" | "ooni";
	/** "blocked" (VE sin Filtro) or "flagged" (OONI possible block) start, or its end. */
	kind: "blocked" | "unblocked" | "flagged" | "unflagged";
	/** Domain key without "www.". */
	domain: string;
	isp: string;
	/** The change happened after this observation… */
	after: number;
	/** …and was seen by this one. */
	by: number;
	/** Blocking methods when newly blocked (VE sin Filtro). */
	methods: string[];
	url: string;
};

export type BlockTimeline = {
	/** Newest first. */
	changes: BlockChange[];
	/** Since when each source has been watched by this Vigía (null: never). */
	watchingSince: { vesinfiltro: number | null; ooni: number | null };
	versions: { vesinfiltro: number; ooni: number };
	noteEs: string;
	noteEn: string;
};

const VSF_PAGE = "https://vesinfiltro.org/";

function vsfBlockedOn(site: VsfSite): Map<string, string[]> {
	return new Map(site.isps.filter((c) => c.status === "blocked").map((c) => [c.isp, [...c.methods]]));
}

export function vsfChanges(
	store: Store,
	from: number,
	now: number,
): { changes: BlockChange[]; since: number | null; versions: number } {
	const changes: BlockChange[] = [];
	let since: number | null = null;
	const versions = new Set<number>();
	for (const latest of store.latestPerSeries<VsfSite>("vesinfiltro-blocks", 0, 5_000)) {
		const history = store.history<VsfSite>("vesinfiltro-blocks", latest.series, 0, now, 1_000);
		const first = history[0];
		if (first) since = since === null ? first.observedAt : Math.min(since, first.observedAt);
		for (const h of history) versions.add(h.observedAt);
		for (let i = 1; i < history.length; i++) {
			const prev = history[i - 1];
			const cur = history[i];
			if (!prev || !cur || cur.observedAt < from) continue;
			const before = vsfBlockedOn(prev.value);
			const after = vsfBlockedOn(cur.value);
			for (const [isp, methods] of after) {
				if (!before.has(isp)) {
					changes.push({
						source: "vesinfiltro",
						kind: "blocked",
						domain: cur.value.key,
						isp,
						after: prev.observedAt,
						by: cur.observedAt,
						methods,
						url: VSF_PAGE,
					});
				}
			}
			for (const isp of before.keys()) {
				// Only an explicit non-blocked reading counts as unblocked; "no data" is not evidence either way.
				const cell = cur.value.isps.find((c) => c.isp === isp);
				if (!after.has(isp) && cell && (cell.status === "ok" || cell.status === "unblocked")) {
					changes.push({
						source: "vesinfiltro",
						kind: "unblocked",
						domain: cur.value.key,
						isp,
						after: prev.observedAt,
						by: cur.observedAt,
						methods: [],
						url: VSF_PAGE,
					});
				}
			}
		}
	}
	return { changes, since, versions: versions.size };
}

/** Key of one domain on one ISP. */
const cellKey = (domain: string, isp: string) => `${domain}\u0000${isp}`;

/** Runs before the window read to establish each domain's state at its start (two days at the 3-hour cadence). */
const BASELINE_MS = 2 * 86_400_000;

export function ooniChanges(
	store: Store,
	from: number,
	now: number,
): { changes: BlockChange[]; since: number | null; versions: number } {
	const stats = store.db
		.query<{ first: number | null; n: number }, [number]>(
			"SELECT MIN(fetched_at) AS first, COUNT(DISTINCT fetched_at) AS n FROM obs WHERE source = 'ooni-ve' AND series = 'country:VE:summary' AND fetched_at <= ?",
		)
		.get(now) ?? { first: null, n: 0 };
	// Only complete runs are compared (src/panels/ooni-runs.ts): a thin or empty OONI answer says nothing.
	const runs = ooniRuns(store, from - BASELINE_MS, now).filter((r) => r.complete);
	const flaggedAt = new Map<number, Map<string, { domain: string; isp: string }>>(
		runs.map((r) => [r.at, new Map()]),
	);
	const start = runs[0]?.at ?? now;
	const rows = store.db
		.query<{ fetched_at: number; value: string }, [number, number]>(
			"SELECT fetched_at, value FROM obs WHERE source = 'ooni-ve' AND series LIKE 'domain:%' AND observed_at >= ? AND fetched_at >= ?",
		)
		.all(start, start);
	for (const row of rows) {
		const run = flaggedAt.get(row.fetched_at);
		if (!run) continue;
		const v = JSON.parse(row.value) as OoniValue;
		if (v.kind !== "domain") continue;
		for (const c of v.isps)
			if (c.flagged) run.set(cellKey(v.domain, c.isp), { domain: v.domain, isp: c.isp });
	}

	// Per domain × ISP: flagged or not, and while flagged, the consecutive complete runs it has been absent from.
	type State = {
		domain: string;
		isp: string;
		flagged: boolean;
		lastFlagged: number;
		firstMiss: number;
		misses: number;
	};
	const state = new Map<string, State>();
	const changes: BlockChange[] = [];
	const url = (domain: string) =>
		`https://explorer.ooni.org/domain/${encodeURIComponent(domain)}?probe_cc=VE`;
	runs.forEach((run, i) => {
		const flagged = flaggedAt.get(run.at) ?? new Map();
		const prev = runs[i - 1];
		for (const [key, cell] of flagged) {
			const s = state.get(key);
			// The first complete run is the baseline: already flagged when Vigía started watching is not an event.
			if (prev && !s?.flagged && run.at >= from) {
				changes.push({
					source: "ooni",
					kind: "flagged",
					...cell,
					after: prev.at,
					by: run.at,
					methods: [],
					url: url(cell.domain),
				});
			}
			state.set(key, { ...cell, flagged: true, lastFlagged: run.at, firstMiss: 0, misses: 0 });
		}
		for (const [key, s] of state) {
			if (!s.flagged || flagged.has(key)) continue;
			s.misses++;
			if (s.misses === 1) s.firstMiss = run.at;
			if (s.misses < END_AFTER) continue;
			s.flagged = false;
			// It changed after the last run that flagged it and was first missing in the next complete run; the event
			// is only emitted once the absence repeats.
			if (run.at >= from) {
				changes.push({
					source: "ooni",
					kind: "unflagged",
					domain: s.domain,
					isp: s.isp,
					after: s.lastFlagged,
					by: s.firstMiss,
					methods: [],
					url: url(s.domain),
				});
			}
		}
	});
	return { changes, since: stats.first, versions: stats.n };
}

export function blockTimeline(store: Store, now: number, windowMs = 30 * 86_400_000): BlockTimeline {
	const from = now - windowMs;
	const vsf = vsfChanges(store, from, now);
	const ooni = ooniChanges(store, from, now);
	const changes = [...vsf.changes, ...ooni.changes].sort(
		(a, b) => b.by - a.by || a.domain.localeCompare(b.domain) || a.isp.localeCompare(b.isp),
	);
	return {
		changes: changes.slice(0, 300),
		watchingSince: { vesinfiltro: vsf.since, ooni: ooni.since },
		versions: { vesinfiltro: vsf.versions, ooni: ooni.versions },
		noteEs:
			"Cambios detectados por Vigía comparando versiones sucesivas de cada fuente: ocurrieron entre las dos fechas indicadas. Lo que ya estaba bloqueado cuando Vigía empezó a observar no aparece como evento. OONI resume 7 días, así que sus cambios llegan con retraso.",
		noteEn:
			"Changes Vigía detected by comparing consecutive versions of each source: they happened between the two dates shown. Anything already blocked when Vigía started watching is not an event. OONI summarises 7 days, so its changes arrive late.",
	};
}
