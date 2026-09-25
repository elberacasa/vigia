import { Database, type Statement } from "bun:sqlite";
import type { Basis, GeoPoint, Json, Observation } from "./types.ts";

/**
 * History from day one: every distinct observation is kept. A re-fetch of an identical value is ignored
 * (same source, series, observed time and content hash); a revision (e.g. USGS updating a magnitude) is a new
 * row, and "latest" means newest observed time, then newest fetch.
 */

export const SCHEMA_VERSION = 2;

export interface StoredObservation<V extends Json = Json> extends Observation<V> {
	readonly id: number;
}

export interface RunRecord {
	readonly source: string;
	readonly startedAt: number;
	readonly finishedAt: number;
	readonly ok: boolean;
	readonly error: string | null;
	readonly bytes: number;
	readonly received: number;
	readonly inserted: number;
}

interface ObsRow {
	id: number;
	source: string;
	series: string;
	observed_at: number;
	fetched_at: number;
	value: string;
	source_url: string;
	licence: string;
	confidence: number;
	basis: string;
	lat: number | null;
	lon: number | null;
	state: string | null;
	place: string | null;
}

interface RunRow {
	source: string;
	started_at: number;
	finished_at: number;
	ok: number;
	error: string | null;
	bytes: number;
	received: number;
	inserted: number;
}

export class Store {
	readonly db: Database;
	readonly #insert: Statement;
	readonly #insertRun: Statement;
	readonly #exists: Statement;

	constructor(path: string) {
		this.db = new Database(path, { create: true, strict: true });
		this.db.run("PRAGMA journal_mode = WAL");
		this.db.run("PRAGMA synchronous = NORMAL");
		this.db.run("PRAGMA busy_timeout = 5000");
		this.#migrate();
		this.#insert = this.db.prepare(
			`INSERT OR IGNORE INTO obs
			 (source, series, observed_at, fetched_at, value, hash, source_url, licence, confidence, basis, lat, lon, state, place)
			 VALUES ($source, $series, $observed_at, $fetched_at, $value, $hash, $source_url, $licence, $confidence, $basis, $lat, $lon, $state, $place)`,
		);
		this.#exists = this.db.prepare("SELECT 1 FROM obs WHERE source = ? AND series = ? LIMIT 1");
		this.#insertRun = this.db.prepare(
			`INSERT INTO runs (source, started_at, finished_at, ok, error, bytes, received, inserted)
			 VALUES ($source, $started_at, $finished_at, $ok, $error, $bytes, $received, $inserted)`,
		);
	}

	#migrate(): void {
		this.db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		const row = this.db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema'").get();
		const version = row ? Number(row.value) : 0;
		if (version > SCHEMA_VERSION) {
			throw new Error(
				`La base de datos es de una versión más nueva de Vigía (esquema ${version}). Actualiza Vigía.`,
			);
		}
		if (version < 1) {
			this.db.transaction(() => {
				this.db.run(`CREATE TABLE obs (
					id INTEGER PRIMARY KEY,
					source TEXT NOT NULL,
					series TEXT NOT NULL,
					observed_at INTEGER NOT NULL,
					fetched_at INTEGER NOT NULL,
					value TEXT NOT NULL,
					hash TEXT NOT NULL,
					source_url TEXT NOT NULL,
					licence TEXT NOT NULL,
					confidence REAL NOT NULL,
					basis TEXT NOT NULL,
					lat REAL, lon REAL, state TEXT, place TEXT,
					UNIQUE (source, series, observed_at, hash)
				)`);
				this.db.run("CREATE INDEX obs_series ON obs (source, series, observed_at DESC, id DESC)");
				this.db.run("CREATE INDEX obs_source_time ON obs (source, observed_at DESC)");
				this.db.run(`CREATE TABLE runs (
					id INTEGER PRIMARY KEY,
					source TEXT NOT NULL,
					started_at INTEGER NOT NULL,
					finished_at INTEGER NOT NULL,
					ok INTEGER NOT NULL,
					error TEXT,
					bytes INTEGER NOT NULL,
					received INTEGER NOT NULL,
					inserted INTEGER NOT NULL
				)`);
				this.db.run("CREATE INDEX runs_source ON runs (source, started_at DESC)");
				this.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', '1')");
			})();
		}
		if (version < 2) {
			// The AI section: a ledger of every paid request, a response cache, and per-item model outputs.
			this.db.transaction(() => {
				this.db.run(`CREATE TABLE ai_ledger (
					id INTEGER PRIMARY KEY,
					at INTEGER NOT NULL,
					provider TEXT NOT NULL,
					model TEXT NOT NULL,
					purpose TEXT NOT NULL,
					input_tokens INTEGER NOT NULL,
					output_tokens INTEGER NOT NULL,
					cost_usd REAL NOT NULL
				)`);
				this.db.run(`CREATE TABLE ai_cache (
					key TEXT PRIMARY KEY,
					model TEXT NOT NULL,
					at INTEGER NOT NULL,
					response TEXT NOT NULL
				)`);
				this.db.run(`CREATE TABLE ai_outputs (
					feature TEXT NOT NULL,
					item TEXT NOT NULL,
					model TEXT NOT NULL,
					at INTEGER NOT NULL,
					output TEXT NOT NULL,
					PRIMARY KEY (feature, item, model)
				)`);
				this.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', '2')");
			})();
		}
	}

	/** Inserts observations; returns how many were new. */
	insert(observations: readonly Observation[]): number {
		let inserted = 0;
		this.db.transaction(() => {
			for (const o of observations) {
				if (o.keepFirst && this.#exists.get(o.source, o.series)) continue;
				const value = canonicalJson(o.value);
				const location = o.location;
				const result = this.#insert.run({
					source: o.source,
					series: o.series,
					observed_at: o.observedAt,
					fetched_at: o.fetchedAt,
					value,
					hash: contentHash(value, location),
					source_url: o.sourceUrl,
					licence: o.licence,
					confidence: o.confidence,
					basis: o.basis,
					lat: location?.lat ?? null,
					lon: location?.lon ?? null,
					state: location?.state ?? null,
					place: location?.place ?? null,
				});
				inserted += result.changes;
			}
		})();
		return inserted;
	}

	recordRun(run: RunRecord): void {
		this.#insertRun.run({
			source: run.source,
			started_at: run.startedAt,
			finished_at: run.finishedAt,
			ok: run.ok ? 1 : 0,
			error: run.error,
			bytes: run.bytes,
			received: run.received,
			inserted: run.inserted,
		});
	}

	/** Newest observation of one series. */
	latest<V extends Json = Json>(source: string, series: string): StoredObservation<V> | null {
		const row = this.db
			.query<ObsRow, [string, string]>(
				"SELECT * FROM obs WHERE source = ? AND series = ? ORDER BY observed_at DESC, id DESC LIMIT 1",
			)
			.get(source, series);
		return row ? fromRow<V>(row) : null;
	}

	/** Newest observation of every series of a source observed since `since`. */
	latestPerSeries<V extends Json = Json>(source: string, since = 0, limit = 500): StoredObservation<V>[] {
		return this.db
			.query<ObsRow, [string, number, number]>(
				`SELECT * FROM (
					SELECT *, ROW_NUMBER() OVER (PARTITION BY series ORDER BY observed_at DESC, id DESC) AS rn
					FROM obs WHERE source = ? AND observed_at >= ?
				) WHERE rn = 1 ORDER BY observed_at DESC LIMIT ?`,
			)
			.all(source, since, limit)
			.map((row) => fromRow<V>(row));
	}

	/** Every stored revision of one series in a time window, oldest first. */
	history<V extends Json = Json>(
		source: string,
		series: string,
		from: number,
		to: number,
		limit = 5_000,
	): StoredObservation<V>[] {
		return this.db
			.query<ObsRow, [string, string, number, number, number]>(
				`SELECT * FROM obs WHERE source = ? AND series = ? AND observed_at BETWEEN ? AND ?
				 ORDER BY observed_at ASC, id ASC LIMIT ?`,
			)
			.all(source, series, from, to, limit)
			.map((row) => fromRow<V>(row));
	}

	/**
	 * Every row one run of a source stored (rows of a run share its fetch time). `lookbackMs` bounds how far before
	 * the fetch the rows' observed times may be, so the (source, observed_at) index does the work.
	 */
	fetchedAt<V extends Json = Json>(
		source: string,
		fetchedAt: number,
		lookbackMs: number,
	): StoredObservation<V>[] {
		return this.db
			.query<ObsRow, [string, number, number, number]>(
				"SELECT * FROM obs WHERE source = ? AND observed_at BETWEEN ? AND ? AND fetched_at = ? ORDER BY series, id",
			)
			.all(source, fetchedAt - lookbackMs, fetchedAt, fetchedAt)
			.map((row) => fromRow<V>(row));
	}

	/** Whether any observation of this series at this observed time is stored. */
	hasObservation(source: string, series: string, observedAt: number): boolean {
		return (
			this.db
				.query<{ one: number }, [string, string, number]>(
					"SELECT 1 AS one FROM obs WHERE source = ? AND series = ? AND observed_at = ? LIMIT 1",
				)
				.get(source, series, observedAt) !== null
		);
	}

	newestObservedAt(source: string): number | null {
		const row = this.db
			.query<{ t: number | null }, [string]>("SELECT MAX(observed_at) AS t FROM obs WHERE source = ?")
			.get(source);
		return row?.t ?? null;
	}

	recentRuns(source: string, limit = 50): RunRecord[] {
		return this.db
			.query<RunRow, [string, number]>("SELECT * FROM runs WHERE source = ? ORDER BY started_at DESC LIMIT ?")
			.all(source, limit)
			.map((r) => ({
				source: r.source,
				startedAt: r.started_at,
				finishedAt: r.finished_at,
				ok: r.ok === 1,
				error: r.error,
				bytes: r.bytes,
				received: r.received,
				inserted: r.inserted,
			}));
	}

	/** The first recorded run of a feed on this machine (runs are pruned after 30 days). */
	firstRunAt(source: string): number | null {
		const row = this.db
			.query<{ t: number | null }, [string]>("SELECT MIN(started_at) AS t FROM runs WHERE source = ?")
			.get(source);
		return row?.t ?? null;
	}

	lastSuccessAt(source: string): number | null {
		const row = this.db
			.query<{ t: number | null }, [string]>(
				"SELECT MAX(finished_at) AS t FROM runs WHERE source = ? AND ok = 1",
			)
			.get(source);
		return row?.t ?? null;
	}

	/** Deletes run logs older than `before`; observations are history and are kept unless the user sets retention. */
	pruneRuns(before: number): void {
		this.db.run("DELETE FROM runs WHERE started_at < ?", [before]);
	}

	/**
	 * Deletes observations older than `before`, except the newest row of every series: a slow series (a monthly
	 * index, a list updated weekly, an undated headline kept by `keepFirst`) must keep its current value, or it
	 * would vanish from the panels and an old item would look new again.
	 */
	pruneObservations(before: number): void {
		this.db.run(
			`DELETE FROM obs WHERE observed_at < ? AND id NOT IN (
				SELECT id FROM (
					SELECT id, ROW_NUMBER() OVER (PARTITION BY source, series ORDER BY observed_at DESC, id DESC) AS rn
					FROM obs
				) WHERE rn = 1
			)`,
			[before],
		);
	}

	close(): void {
		this.db.close();
	}
}

function fromRow<V extends Json>(row: ObsRow): StoredObservation<V> {
	const base = {
		id: row.id,
		source: row.source,
		series: row.series,
		sourceUrl: row.source_url,
		fetchedAt: row.fetched_at,
		observedAt: row.observed_at,
		licence: row.licence,
		value: JSON.parse(row.value) as V,
		confidence: row.confidence,
		basis: row.basis as Basis,
	};
	if (row.lat === null || row.lon === null) return base;
	const location: { -readonly [K in keyof GeoPoint]: GeoPoint[K] } = { lat: row.lat, lon: row.lon };
	if (row.state !== null) location.state = row.state;
	if (row.place !== null) location.place = row.place;
	return { ...base, location };
}

/** JSON with sorted keys, so equal values hash equally regardless of key order. */
export function canonicalJson(value: Json): string {
	return JSON.stringify(value, (_key, v: unknown) => {
		if (v && typeof v === "object" && !Array.isArray(v)) {
			const sorted: Record<string, unknown> = {};
			for (const k of Object.keys(v).sort()) sorted[k] = (v as Record<string, unknown>)[k];
			return sorted;
		}
		return v;
	});
}

function contentHash(value: string, location: GeoPoint | undefined): string {
	const loc = location
		? `${location.lat},${location.lon},${location.state ?? ""},${location.place ?? ""}`
		: "";
	return Bun.hash(`${value}|${loc}`).toString(16);
}
