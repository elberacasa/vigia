import { IODA_LICENCE, IODA_SIGNALS, IODA_SITE, type IodaBin } from "../adapters/ioda-states/ioda.ts";
import { IODA_REGIONS } from "../adapters/ioda-states/regions.ts";
import type { Store } from "../core/store.ts";
import { BASELINE_DAYS, type Bins, combine, type Level, readSignal } from "../panels/connectivity.ts";

/**
 * Replays the connectivity layer over stored observations: for each state and each hour, the level the live panel's
 * rules give when evaluated at the end of that hour on the bins stored for it (src/panels/connectivity.ts: same-slot
 * baseline, robust noise, per-signal thresholds, two-signal agreement). Nothing is interpolated or modelled; an hour
 * without usable bins is "no data". Coarser steps (6 h, 1 d) take the worst hourly level inside the step.
 *
 * Deterministic: the same store and the same request give the same answer. A closed hour's level depends only on the
 * bins stored before its end, so it is persisted in the store (table history_levels) and read back instead of
 * recomputed; a stored level is dropped as soon as a bin it could have read is inserted, revised or pruned
 * (LevelArchive.sync), so IODA's revisions of its newest bins, late bins and backfills are never masked. Only the hour
 * in progress is always evaluated.
 *
 * Cost: one state-hour is about 0.4 ms of CPU (three signals, a same-slot baseline and a noise estimate over 8 days of
 * 10-minute bins), so 31 days cold is about 9 s. The service therefore never runs a replay in one piece: the work
 * is a generator that pauses every SLICE_MS, the async driver yields to the event loop at each pause, one replay
 * runs at a time, identical requests share one run, each request has a time budget, and a background warmer fills
 * the archive as data arrives, so requests normally read finished hours.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const HISTORY_STEPS = { "1h": HOUR, "6h": 6 * HOUR, "1d": DAY } as const;
export type HistoryStep = keyof typeof HISTORY_STEPS;
/** Longest window per step: bounded so one request never evaluates more than 31 × 24 hours. */
export const MAX_SPAN_MS: Record<HistoryStep, number> = { "1h": 7 * DAY, "6h": 31 * DAY, "1d": 31 * DAY };
/** How far back any request may reach. */
export const MAX_LOOKBACK_MS = 400 * DAY;

/** One character per step: n normal, d drop, s severe, x no data. Compact on a slow phone. */
export type LevelCode = "n" | "d" | "s" | "x";
const CODE: Record<Level, LevelCode> = { normal: "n", drop: "d", severe: "s", "no-data": "x" };
/** Worst first; "no data" only wins when no hour in the step had data. */
const RANK: Record<LevelCode, number> = { s: 3, d: 2, n: 1, x: 0 };

export interface StepCounts {
	normal: number;
	drop: number;
	severe: number;
	noData: number;
}

export interface ConnectivityHistory {
	layer: "connectivity";
	/** Start of the first step (UTC ms, aligned to the step). */
	from: number;
	/** End of the last step, never later than the time of the request. */
	to: number;
	stepMs: number;
	step: HistoryStep;
	/** Start of each step (UTC ms). */
	times: number[];
	/** State ISO code → one LevelCode per step. */
	states: Record<string, string>;
	/** Per step: how many of the 24 states were at each level. */
	counts: StepCounts[];
	/** Start of the first step where any state could be judged; null when none could. */
	firstJudgedAt: number | null;
	/** When the answer was computed (UTC ms). */
	computedAt: number;
	rule: { es: string; en: string };
	feed: string;
	attribution: string;
	licence: string;
	sourceUrl: string;
}

export interface HistoryRequest {
	from: number;
	to: number;
	step: HistoryStep;
}

type Sorted = { times: number[]; values: number[] };

/** Stored bins of one series as parallel arrays sorted by bin start (last stored revision of a bin wins). */
function loadSorted(store: Store, series: string, from: number, to: number): Sorted {
	const byTime = new Map<number, number>();
	for (const r of store.history<IodaBin>("ioda-states", series, from, to, 50_000))
		byTime.set(r.observedAt, r.value.value);
	const times = [...byTime.keys()].sort((a, b) => a - b);
	return { times, values: times.map((t) => byTime.get(t) as number) };
}

/** Index of the first element ≥ x. */
function lowerBound(a: readonly number[], x: number): number {
	let lo = 0;
	let hi = a.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if ((a[mid] as number) < x) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/**
 * The bins the live panel would have held at `at`: bins that started before `at`, over the window its rules read
 * (the newest bin and the BASELINE_DAYS before it, plus a margin).
 */
function binsAt(s: Sorted, at: number): Bins {
	const lo = lowerBound(s.times, at - (BASELINE_DAYS + 1) * DAY);
	const hi = lowerBound(s.times, at);
	const out = new Map<number, number>();
	for (let i = lo; i < hi; i++) out.set(s.times[i] as number, s.values[i] as number);
	return out;
}

/** Level of one state at instant `at`, by the live panel's rules. */
export function stateLevelAt(signals: readonly Sorted[], at: number): Level {
	const readings = IODA_SIGNALS.map((signal, i) => {
		const bins = binsAt(signals[i] as Sorted, at);
		return readSignal(signal, bins.size ? { bins, fetchedAt: new Map() } : null, at);
	});
	return combine(readings).level;
}

export function parseStep(raw: string | null): HistoryStep | null {
	if (raw === null) return "1h";
	// Own keys only: "__proto__", "toString" or "constructor" are not steps.
	return Object.hasOwn(HISTORY_STEPS, raw) ? (raw as HistoryStep) : null;
}

/** Accepts epoch milliseconds or an ISO date ("2026-09-24T18:00", read as UTC unless it names a zone). */
export function parseInstant(raw: string | null): number | null {
	if (raw === null || raw === "") return null;
	if (/^\d{1,15}$/.test(raw)) return Number(raw);
	if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(raw)) return null;
	const zoned = /T.*(Z|[+-]\d{2}:\d{2})$/.test(raw) || !raw.includes("T");
	const t = Date.parse(zoned ? raw : `${raw}Z`);
	return Number.isFinite(t) ? t : null;
}

/**
 * Caracas midnight is 04:00 UTC. A whole number of hours: steps start on the same UTC hour grid as the archived
 * hourly levels (keyed by hour end), so a Caracas-aligned day or 6 h step reads exactly 24 or 6 archived hours.
 */
export const CARACAS_OFFSET_MS = 4 * HOUR;

/**
 * Validates and normalises a request against `now`: `to` defaults to now, `from` to 48 h before `to`; both are
 * aligned to the step; the span is capped per step. Returns an error message (Spanish) when a value is malformed.
 */

export function normaliseRequest(
	params: { from: string | null; to: string | null; step: string | null },
	now: number,
): HistoryRequest | { error: string } {
	const step = parseStep(params.step);
	if (!step) return { error: "Paso no válido: use 1h, 6h o 1d." };
	const stepMs = HISTORY_STEPS[step];
	const rawTo = parseInstant(params.to);
	const rawFrom = parseInstant(params.from);
	if ((params.to && rawTo === null) || (params.from && rawFrom === null))
		return { error: "Fecha no válida: use milisegundos o AAAA-MM-DDTHH:MM." };
	const to = Math.min(now, rawTo ?? now);
	// Steps start on Caracas boundaries (midnight = 04:00 UTC; Caracas is UTC−4 all year), so a "24 sept" bar is
	// the 24th in Caracas, not 20:00 on the 23rd to 20:00 on the 24th.
	const alignedTo = Math.ceil((to - CARACAS_OFFSET_MS) / stepMs) * stepMs + CARACAS_OFFSET_MS;
	const from = Math.max(now - MAX_LOOKBACK_MS, rawFrom ?? alignedTo - 48 * HOUR);
	if (from >= to) return { error: "El intervalo está vacío." };
	const alignedFrom = Math.max(
		Math.floor((from - CARACAS_OFFSET_MS) / stepMs) * stepMs + CARACAS_OFFSET_MS,
		alignedTo - MAX_SPAN_MS[step],
	);
	return { from: alignedFrom, to: alignedTo, step };
}

/** Levels of one state, hour end (UTC ms) → code. */
type StateLevels = Map<number, LevelCode>;

const LEVEL_OF: Record<string, LevelCode> = { n: "n", d: "d", s: "s", x: "x" };
const WATERMARK_KEY = "history-levels-obs-id";
const FIRST_BIN_KEY = "history-levels-first-bin";
/** How far back a bin can change a level: the newest bin plus the BASELINE_DAYS before it. */
const REACH_MS = (BASELINE_DAYS + 1) * DAY;

/** Start of the oldest stored IODA bin, or null when there is none. */
function firstIodaBin(store: Store): number | null {
	return (
		store.db
			.query<{ t: number | null }, []>("SELECT MIN(observed_at) AS t FROM obs WHERE source = 'ioda-states'")
			.get()?.t ?? null
	);
}

/**
 * Closed hourly levels persisted in the store, so a replay is paid for once, not per request or per restart.
 * `sync()` keeps them honest: every IODA row inserted since the last sync drops the stored levels it could have
 * changed (those of its state after its bin), and pruning old bins drops the levels that read them.
 */
export class LevelArchive {
	readonly #store: Store;
	constructor(store: Store) {
		this.#store = store;
		const db = store.db;
		db.run(
			"CREATE TABLE IF NOT EXISTS history_levels (iso TEXT NOT NULL, at INTEGER NOT NULL, code TEXT NOT NULL, PRIMARY KEY (iso, at)) WITHOUT ROWID",
		);
		if (this.#meta(WATERMARK_KEY) === null) {
			// A new archive has nothing to invalidate: start after the newest row.
			db.run("DELETE FROM history_levels");
			this.#setMeta(WATERMARK_KEY, this.#maxId());
			this.#setMeta(FIRST_BIN_KEY, firstIodaBin(this.#store) ?? -1);
		}
	}

	#meta(key: string): number | null {
		const row = this.#store.db
			.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
			.get(key);
		return row ? Number(row.value) : null;
	}

	#setMeta(key: string, value: number): void {
		this.#store.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [key, String(value)]);
	}

	#maxId(): number {
		return this.#store.db.query<{ id: number | null }, []>("SELECT MAX(id) AS id FROM obs").get()?.id ?? 0;
	}

	/** Drops the stored levels that rows inserted or pruned since the last sync could have changed. */
	sync(): void {
		for (const _ of this.syncSteps());
	}

	/**
	 * `sync` in slices (review 4 L8): new rows are read in id ranges of `chunk`, each range in its own transaction
	 * that also advances the watermark, pausing (yielding) whenever SLICE_MS of work has gone by. A watermark far
	 * behind (a restart after a day of fetching) cost 594 ms in one synchronous piece on a 509,000-row archive.
	 * Stopped halfway, what was done stays done and the next sync continues from the watermark.
	 */
	*syncSteps(chunk = 20_000, sliceMs = SLICE_MS): Generator<void, void> {
		const db = this.#store.db;
		let slice = performance.now();
		const top = this.#maxId();
		// `+source` keeps the planner on the rowid range: on `source = ?` it picked the (source, series, …) index and
		// scanned every IODA row for each range (500 ms cold on a 509,000-row archive, instead of about 1 ms).
		const changedIn = db.query<{ series: string; t: number }, [number, number]>(
			"SELECT series, MIN(observed_at) AS t FROM obs WHERE id > ? AND id <= ? AND +source = 'ioda-states' GROUP BY series",
		);
		const drop = db.query("DELETE FROM history_levels WHERE iso = ? AND at > ?");
		for (let since = this.#meta(WATERMARK_KEY) ?? 0; since < top; ) {
			const until = Math.min(top, since + chunk);
			db.transaction(() => {
				for (const c of changedIn.all(since, until)) {
					const iso = c.series.split(":")[1];
					if (iso) drop.run(iso, c.t);
				}
				this.#setMeta(WATERMARK_KEY, until);
			})();
			since = until;
			if (performance.now() - slice >= sliceMs) {
				yield;
				slice = performance.now();
			}
		}
		db.transaction(() => {
			this.#setMeta(WATERMARK_KEY, Math.max(top, this.#meta(WATERMARK_KEY) ?? 0));
			const first = firstIodaBin(this.#store) ?? Number.POSITIVE_INFINITY;
			const before = this.#meta(FIRST_BIN_KEY) ?? -1;
			if (first > before && before !== -1) {
				db.run("DELETE FROM history_levels WHERE at <= ?", [
					Number.isFinite(first) ? first + REACH_MS : Number.MAX_SAFE_INTEGER,
				]);
			}
			this.#setMeta(FIRST_BIN_KEY, Number.isFinite(first) ? first : -1);
		})();
	}

	read(iso: string, from: number, to: number): StateLevels {
		const out: StateLevels = new Map();
		for (const r of this.#store.db
			.query<{ at: number; code: string }, [string, number, number]>(
				"SELECT at, code FROM history_levels WHERE iso = ? AND at BETWEEN ? AND ?",
			)
			.all(iso, from, to)) {
			const code = LEVEL_OF[r.code];
			if (code) out.set(r.at, code);
		}
		return out;
	}

	write(iso: string, rows: readonly (readonly [number, LevelCode])[]): void {
		if (rows.length === 0) return;
		const db = this.#store.db;
		const put = db.query("INSERT OR REPLACE INTO history_levels (iso, at, code) VALUES (?, ?, ?)");
		db.transaction(() => {
			for (const [at, code] of rows) put.run(iso, at, code);
		})();
	}

	count(): number {
		return this.#store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM history_levels").get()?.n ?? 0;
	}
}

/** Longest stretch of synchronous work between two pauses of a replay. */
export const SLICE_MS = 20;
/** Levels written to the archive per transaction. */
const WRITE_BATCH = 400;

export interface ReplayStats {
	/** State-hours evaluated by the rules (not read back from the archive). */
	evaluated: number;
}

/**
 * The level of each state at each hour end in `ats` (ascending). A generator: it pauses (yields) whenever it has
 * worked SLICE_MS without a break, so a driver can hand the event loop back. Closed hours are read from and written
 * to `archive` when one is given.
 */
function* replayLevels(
	store: Store,
	ats: readonly number[],
	now: number,
	archive: LevelArchive | null,
	stats: ReplayStats,
	regions: readonly { iso: string }[] = IODA_REGIONS,
): Generator<void, Map<string, StateLevels>> {
	const out = new Map<string, StateLevels>();
	const first = ats[0];
	const last = ats.at(-1);
	if (first === undefined || last === undefined) return out;
	const firstBin = firstIodaBin(store);
	let slice = performance.now();
	for (const r of regions) {
		const codes: StateLevels = archive ? archive.read(r.iso, first, last) : new Map();
		const todo: number[] = [];
		for (const at of ats) {
			if (codes.has(at)) continue;
			// No stored bin started before this hour's end: nothing to read.
			if (firstBin === null || at <= firstBin) codes.set(at, "x");
			else todo.push(at);
		}
		const lo = todo[0];
		const hi = todo.at(-1);
		if (lo !== undefined && hi !== undefined) {
			const signals: Sorted[] = [];
			for (const s of IODA_SIGNALS) {
				signals.push(loadSorted(store, `state:${r.iso}:${s}`, lo - REACH_MS, hi));
				if (performance.now() - slice > SLICE_MS) {
					yield;
					slice = performance.now();
				}
			}
			const closed: [number, LevelCode][] = [];
			// finally: a replay abandoned at its deadline (the driver calls return()) still keeps what it finished.
			try {
				for (const at of todo) {
					const code = CODE[stateLevelAt(signals, at)];
					stats.evaluated++;
					codes.set(at, code);
					// Closed hours only: the hour in progress is judged at `now` and changes until it closes.
					if (at < now) closed.push([at, code]);
					// Few, larger transactions: each commit adds WAL pages, and the commit that crosses the checkpoint
					// threshold pays for the checkpoint (measured at 130 ms when written every slice).
					if (closed.length >= WRITE_BATCH) {
						archive?.write(r.iso, closed);
						closed.length = 0;
					}
					if (performance.now() - slice > SLICE_MS) {
						yield;
						slice = performance.now();
					}
				}
			} finally {
				archive?.write(r.iso, closed);
			}
		}
		out.set(r.iso, codes);
	}
	return out;
}

/** The archive's sync, sliced, then the replay: one generator, so the driver's pauses and deadline cover both. */
function* syncThenReplay<T>(archive: LevelArchive, replay: Generator<void, T>): Generator<void, T> {
	yield* archive.syncSteps();
	return yield* replay;
}

/** Hour ends a request needs, judged at the end of each hour, or now for the hour in progress. */
function hourEnds(req: HistoryRequest, now: number): { times: number[]; ats: number[] } {
	const stepMs = HISTORY_STEPS[req.step];
	const times: number[] = [];
	for (let t = req.from; t < req.to && t <= now; t += stepMs) times.push(t);
	const ats: number[] = [];
	for (const start of times)
		for (let h = start; h < start + stepMs && h < now; h += HOUR) ats.push(Math.min(h + HOUR, now));
	return { times, ats };
}

function assemble(
	req: HistoryRequest,
	now: number,
	times: readonly number[],
	levels: ReadonlyMap<string, StateLevels>,
): ConnectivityHistory {
	const stepMs = HISTORY_STEPS[req.step];
	const states: Record<string, string> = {};
	for (const r of IODA_REGIONS) {
		const codes = levels.get(r.iso);
		let row = "";
		for (const start of times) {
			let worst: LevelCode = "x";
			for (let h = start; h < start + stepMs && h < now; h += HOUR) {
				const code = codes?.get(Math.min(h + HOUR, now)) ?? "x";
				if (RANK[code] > RANK[worst]) worst = code;
			}
			row += worst;
		}
		states[r.iso] = row;
	}
	const counts = times.map((_, i) => {
		const c: StepCounts = { normal: 0, drop: 0, severe: 0, noData: 0 };
		for (const row of Object.values(states)) {
			const code = row[i] as LevelCode;
			if (code === "n") c.normal++;
			else if (code === "d") c.drop++;
			else if (code === "s") c.severe++;
			else c.noData++;
		}
		return c;
	});
	const firstIndex = counts.findIndex((c) => c.noData < IODA_REGIONS.length);
	return {
		layer: "connectivity",
		from: req.from,
		to: Math.min(req.to, now),
		stepMs,
		step: req.step,
		times: [...times],
		states,
		counts,
		firstJudgedAt: firstIndex === -1 ? null : (times[firstIndex] ?? null),
		computedAt: now,
		rule: {
			es:
				req.step === "1h"
					? "Nivel de cada estado al cierre de cada hora, con las mismas reglas del panel de Internet sobre los datos de IODA guardados."
					: "Peor nivel horario de cada estado dentro de cada intervalo, con las mismas reglas del panel de Internet sobre los datos de IODA guardados.",
			en:
				req.step === "1h"
					? "Each state's level at the close of each hour, by the Internet panel's rules over the stored IODA data."
					: "Each state's worst hourly level within each interval, by the Internet panel's rules over the stored IODA data.",
		},
		feed: "ioda-states",
		attribution: IODA_LICENCE.attribution,
		licence: IODA_LICENCE.id,
		sourceUrl: `${IODA_SITE}/country/VE`,
	};
}

/**
 * The replay in one synchronous piece, without the archive: the reference the service must equal (tests, scripts).
 * Never call it from a request handler.
 */
export function connectivityHistory(store: Store, req: HistoryRequest, now: number): ConnectivityHistory {
	const { times, ats } = hourEnds(req, now);
	const run = replayLevels(store, ats, now, null, { evaluated: 0 });
	let step = run.next();
	while (!step.done) step = run.next();
	return assemble(req, now, times, step.value);
}

export interface HistoryResponse {
	status: number;
	body: unknown;
	cacheSeconds: number;
	/** Seconds after which a refused request may retry (503). */
	retryAfter?: number;
}

export interface HistoryService {
	/** GET /api/history/:layer with the request's query string. */
	handle(layer: string, query: URLSearchParams): Promise<HistoryResponse>;
	/**
	 * Fills the archive with every closed hour of the last `days` days, one state at a time between requests.
	 * Returns how many state-hours it evaluated.
	 */
	warm(days?: number): Promise<number>;
	/** Counters, for tests and the performance log. */
	readonly stats: ReplayStats;
}

export interface HistoryServiceOptions {
	/**
	 * Wall time one request may spend replaying before it is answered 503 (its finished hours are kept, so a retry
	 * continues). With maxPending, bounds the wait under the server's 60 s idle timeout.
	 */
	budgetMs?: number;
	/** Distinct replays that may wait for or hold the replay lock; more are answered 503 at once. */
	maxPending?: number;
	/** Pause between slices of the background warmer, so it never takes a whole core. */
	warmPauseMs?: number;
}

const BUSY = "El historial se está calculando; vuelve a intentarlo en unos segundos.";

/**
 * The replay behind the API: archived closed hours, a 60 s response cache, one replay at a time (single flight for
 * identical requests, a bounded queue for different ones), a time budget per request, and slices that yield to the
 * event loop.
 */
export function createHistoryService(
	store: Store,
	now: () => number,
	options: HistoryServiceOptions = {},
): HistoryService {
	const CACHE_MS = 60_000;
	const MAX_CACHED = 32;
	const budgetMs = options.budgetMs ?? 20_000;
	const maxPending = options.maxPending ?? 2;
	const warmPauseMs = options.warmPauseMs ?? 5;
	const cache = new Map<string, { at: number; body: ConnectivityHistory }>();
	const inflight = new Map<string, Promise<HistoryResponse>>();
	const stats: ReplayStats = { evaluated: 0 };
	let archive: LevelArchive | null = null;
	const levels = () => {
		archive ??= new LevelArchive(store);
		return archive;
	};

	// One replay at a time: a promise chain used as a lock.
	let tail: Promise<void> = Promise.resolve();
	const exclusive = async <T>(fn: () => Promise<T>): Promise<T> => {
		const previous = tail;
		let release = () => {};
		tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await fn();
		} finally {
			release();
		}
	};

	const pause = (ms: number) =>
		new Promise<void>((resolve) => (ms > 0 ? setTimeout(resolve, ms) : setImmediate(resolve)));

	/** Drives a replay generator, yielding to the event loop at each pause; null when the deadline passed. */
	const drive = async <T>(run: Generator<void, T>, deadline: number, gapMs: number): Promise<T | null> => {
		let step = run.next();
		while (!step.done) {
			if (performance.now() > deadline) {
				run.return(undefined as never);
				return null;
			}
			await pause(gapMs);
			step = run.next();
		}
		return step.value;
	};

	const compute = (key: string, req: HistoryRequest): Promise<HistoryResponse> =>
		exclusive(async () => {
			const t = now();
			const deadline = performance.now() + budgetMs;
			const archive = levels();
			const { times, ats } = hourEnds(req, t);
			const result = await drive(
				syncThenReplay(archive, replayLevels(store, ats, t, archive, stats)),
				deadline,
				0,
			);
			if (!result) return { status: 503, body: { error: BUSY }, cacheSeconds: 0, retryAfter: 5 };
			const body = assemble(req, t, times, result);
			cache.delete(key);
			cache.set(key, { at: t, body });
			while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
			return { status: 200, body, cacheSeconds: 60 };
		});

	return {
		stats,
		async handle(layer, query) {
			if (layer !== "connectivity")
				return { status: 404, body: { error: "Capa sin historial todavía." }, cacheSeconds: 0 };
			const t = now();
			const req = normaliseRequest(
				{ from: query.get("from"), to: query.get("to"), step: query.get("step") },
				t,
			);
			if ("error" in req) return { status: 400, body: { error: req.error }, cacheSeconds: 0 };
			const key = `${req.from}|${req.to}|${req.step}`;
			const hit = cache.get(key);
			if (hit && t - hit.at < CACHE_MS) return { status: 200, body: hit.body, cacheSeconds: 60 };
			const running = inflight.get(key);
			if (running) return running;
			if (inflight.size >= maxPending)
				return { status: 503, body: { error: BUSY }, cacheSeconds: 0, retryAfter: 5 };
			const job = compute(key, req).finally(() => inflight.delete(key));
			inflight.set(key, job);
			return job;
		},
		async warm(days = 31) {
			const before = stats.evaluated;
			const t = now();
			const end = Math.floor(t / HOUR) * HOUR;
			const ats: number[] = [];
			for (let at = Math.max(end - days * DAY, t - MAX_LOOKBACK_MS); at <= end && at < t; at += HOUR)
				ats.push(at);
			for (const region of IODA_REGIONS) {
				// One state per turn of the lock, so a request waits for at most one state's replay.
				await exclusive(async () => {
					const archive = levels();
					await drive(
						syncThenReplay(archive, replayLevels(store, ats, t, archive, stats, [region])),
						Number.POSITIVE_INFINITY,
						warmPauseMs,
					);
				});
			}
			return stats.evaluated - before;
		},
	};
}
