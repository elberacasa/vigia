/**
 * The only thing crowd reports write to disk: counts per municipality, service, answer and 15-minute bucket
 * (`crowd_counts`, in the same SQLite file as the archive). No row id, no time finer than the bucket, nothing about
 * who reported: a WITHOUT ROWID table keyed by those four columns, so even the order rows were written in is not
 * kept. "counted" reports make the published figures; "held" ones (beyond a flood ceiling) are shown only as a count
 * of "posible manipulación". "extra" counts the counted reports that came from an address that already had another
 * reporter there (a second phone behind a carrier NAT): reports, but not another connection. Past a day, a municipality's rows are rolled up into hourly totals with no answer
 * (answer "*"), all the flood baseline needs.
 *
 * Nothing about the order reports came in is written either (whole-release review, M8: with one transaction per
 * report, the physical order of cells in the table's pages listed every row in submission order). The counts of a
 * bucket stay in memory while it is open and are written once it closes, all together, in key order, with
 * `secure_delete` on for that write and the WAL truncated after it; arrivals (the flood ceiling's two hours) are
 * never written. The cost, stated: a crash loses the open bucket's reports (at most 15 minutes).
 */

import type { Store } from "../core/store.ts";
import { type Answer, CROWD_RULES, type CrowdMode, type Service } from "./rules.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type Status = "counted" | "held";

export type WindowRow = {
	entity: string;
	service: Service;
	answer: Answer;
	counted: number;
	held: number;
	/** Of the counted, those from an address that already had another reporter for this municipality and service. */
	extra: number;
	/** Earliest and latest bucket start with a counted report of this answer in the window; null without one. */
	firstCounted: number | null;
	lastCounted: number | null;
};

type PendingRow = {
	entity: string;
	service: Service;
	bucket: number;
	answer: Answer;
	counted: number;
	held: number;
	extra: number;
};

/** Rows older than this are rolled up to hourly totals without answers. */
const ROLLUP_AFTER_MS = DAY;

export const bucketOf = (t: number, bucketMs: number = CROWD_RULES.bucketMs): number =>
	Math.floor(t / bucketMs) * bucketMs;

export class CrowdCounts {
	readonly #store: Store;

	constructor(store: Store) {
		this.#store = store;
		store.db.run(`CREATE TABLE IF NOT EXISTS crowd_counts (
			entity TEXT NOT NULL,
			service TEXT NOT NULL,
			bucket INTEGER NOT NULL,
			answer TEXT NOT NULL,
			counted INTEGER NOT NULL DEFAULT 0,
			held INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (entity, service, bucket, answer)
		) WITHOUT ROWID`);
		store.db.run("CREATE INDEX IF NOT EXISTS crowd_counts_bucket ON crowd_counts (bucket)");
		// Databases from before per-device tokens: every counted report was its own connection.
		const cols = store.db
			.query<{ name: string }, []>("SELECT name FROM pragma_table_info('crowd_counts')")
			.all()
			.map((c) => c.name);
		if (!cols.includes("extra"))
			store.db.run("ALTER TABLE crowd_counts ADD COLUMN extra INTEGER NOT NULL DEFAULT 0");
		// Arrivals are kept in memory only now (older versions wrote one row per report).
		store.db.run("DROP TABLE IF EXISTS crowd_arrivals");
	}

	/** Counts not yet written, by `entity|service|bucket|answer`: the open bucket's, and a closed one's until flushed. */
	readonly #pending = new Map<string, PendingRow>();
	/** New reports per `entity|service|answer|bucket`, for the flood ceiling (two hours; never written). */
	readonly #arrivals = new Map<string, number>();

	/** Counts one new report of an answer in its bucket (for the flood ceiling). */
	arrive(entity: string, service: Service, answer: Answer, bucket: number): void {
		const key = `${entity}|${service}|${answer}|${bucket}`;
		this.#arrivals.set(key, (this.#arrivals.get(key) ?? 0) + 1);
	}

	/** New reports of one answer for a municipality and service in buckets starting at or after `fromBucket`. */
	arrivalsSince(entity: string, service: Service, answer: Answer, fromBucket: number): number {
		const prefix = `${entity}|${service}|${answer}|`;
		let n = 0;
		for (const [key, count] of this.#arrivals)
			if (key.startsWith(prefix) && Number(key.slice(prefix.length)) >= fromBucket) n += count;
		return n;
	}

	/**
	 * Writes every pending count of a bucket that has closed by `now` (all of them with `now` = Infinity, at a
	 * graceful stop): one transaction, rows in key order, `secure_delete` on, then the WAL truncated, so neither the
	 * pages nor the log keep the order reports arrived in. Returns how many rows were written.
	 */
	flush(now: number): number {
		const open = Number.isFinite(now) ? bucketOf(now) : Number.POSITIVE_INFINITY;
		const due = [...this.#pending]
			.filter(([, p]) => p.bucket < open)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		if (due.length === 0) return 0;
		const db = this.#store.db;
		db.run("PRAGMA secure_delete = ON");
		try {
			db.transaction(() => {
				for (const [key, p] of due) {
					db.run(
						`INSERT INTO crowd_counts (entity, service, bucket, answer, counted, held, extra) VALUES (?, ?, ?, ?, 0, 0, 0)
						 ON CONFLICT (entity, service, bucket, answer) DO NOTHING`,
						[p.entity, p.service, p.bucket, p.answer],
					);
					db.run(
						`UPDATE crowd_counts SET counted = MAX(0, counted + ?), held = MAX(0, held + ?)
						 WHERE entity = ? AND service = ? AND bucket = ? AND answer = ?`,
						[p.counted, p.held, p.entity, p.service, p.bucket, p.answer],
					);
					db.run(
						"UPDATE crowd_counts SET extra = MIN(counted, MAX(0, extra + ?)) WHERE entity = ? AND service = ? AND bucket = ? AND answer = ?",
						[p.extra, p.entity, p.service, p.bucket, p.answer],
					);
					db.run(
						"DELETE FROM crowd_counts WHERE entity = ? AND service = ? AND bucket = ? AND answer = ? AND counted = 0 AND held = 0",
						[p.entity, p.service, p.bucket, p.answer],
					);
					this.#pending.delete(key);
				}
			})();
		} finally {
			db.run("PRAGMA secure_delete = OFF");
		}
		try {
			db.run("PRAGMA wal_checkpoint(TRUNCATE)");
		} catch {
			// A reader holding the WAL: the next flush truncates it.
		}
		return due.length;
	}

	/**
	 * Adds `delta` (±1) to one count (and to `extra` for a counted report from an address's second or later device),
	 * in memory until its bucket closes and `flush` writes it; a count never goes below zero once written.
	 */
	add(
		entity: string,
		service: Service,
		bucket: number,
		answer: Answer,
		status: Status,
		delta: 1 | -1,
		extra = false,
	): void {
		const key = `${entity}|${service}|${bucket}|${answer}`;
		const p = this.#pending.get(key) ?? { entity, service, bucket, answer, counted: 0, held: 0, extra: 0 };
		if (status === "counted") {
			p.counted += delta;
			if (extra) p.extra += delta;
		} else p.held += delta;
		if (p.counted === 0 && p.held === 0 && p.extra === 0) this.#pending.delete(key);
		else this.#pending.set(key, p);
	}

	/**
	 * The municipality's usual busiest hour for a service: for each of the last `days` UTC days before today, its
	 * busiest clock hour of counted reports (0 for a day without any), and the median of those. Held reports never
	 * raise it, and the median needs more than half the days attacked to move.
	 */
	usualPeak(
		entity: string,
		service: Service,
		now: number,
		days: number = CROWD_RULES.flood.historyDays,
	): number {
		// Past days' buckets are closed: written (together, in key order) before the history is read.
		this.flush(now);
		const today = Math.floor(now / DAY) * DAY;
		const rows = this.#store.db
			.query<{ day: number; peak: number }, [string, string, number, number]>(
				`SELECT day, MAX(n) AS peak FROM (
					SELECT (bucket / ${DAY}) AS day, (bucket / ${HOUR}) AS hour, SUM(counted) AS n
					FROM crowd_counts WHERE entity = ? AND service = ? AND bucket >= ? AND bucket < ?
					GROUP BY hour
				) GROUP BY day`,
			)
			.all(entity, service, today - days * DAY, today);
		const peaks = new Array<number>(days).fill(0);
		for (const r of rows) {
			const i = Math.floor(r.day - (today - days * DAY) / DAY);
			if (i >= 0 && i < days) peaks[i] = r.peak;
		}
		return median(peaks);
	}

	/** Every count in buckets [fromBucket, toBucket), by municipality, service and answer (written and pending). */
	window(fromBucket: number, toBucket: number): WindowRow[] {
		const cells = new Map<string, PendingRow>();
		const put = (r: PendingRow) => {
			const key = `${r.entity}|${r.service}|${r.bucket}|${r.answer}`;
			const c = cells.get(key) ?? { ...r, counted: 0, held: 0, extra: 0 };
			c.counted += r.counted;
			c.held += r.held;
			c.extra += r.extra;
			cells.set(key, c);
		};
		for (const r of this.#store.db
			.query<PendingRow, [number, number]>(
				`SELECT entity, service, bucket, answer, counted, held, extra FROM crowd_counts
				 WHERE bucket >= ? AND bucket < ? AND answer != '*'`,
			)
			.all(fromBucket, toBucket))
			put(r);
		for (const p of this.#pending.values()) if (p.bucket >= fromBucket && p.bucket < toBucket) put(p);
		const rows = new Map<string, WindowRow>();
		for (const c of [...cells.values()].sort((a, b) => a.bucket - b.bucket)) {
			const counted = Math.max(0, c.counted);
			const held = Math.max(0, c.held);
			if (counted === 0 && held === 0) continue;
			const key = `${c.entity}|${c.service}|${c.answer}`;
			const w = rows.get(key) ?? {
				entity: c.entity,
				service: c.service,
				answer: c.answer,
				counted: 0,
				held: 0,
				extra: 0,
				firstCounted: null,
				lastCounted: null,
			};
			w.counted += counted;
			w.held += held;
			w.extra += Math.min(counted, Math.max(0, c.extra));
			if (counted > 0) {
				w.firstCounted ??= c.bucket;
				w.lastCounted = c.bucket;
			}
			rows.set(key, w);
		}
		return [...rows.values()].sort(
			(a, b) =>
				a.entity.localeCompare(b.entity) ||
				a.service.localeCompare(b.service) ||
				a.answer.localeCompare(b.answer),
		);
	}

	/**
	 * Deletes buckets older than `before`, arrivals older than two hours, and rolls rows older than a day up into
	 * hourly totals with no answer (what the flood baseline reads, and nothing more).
	 */
	prune(before: number, now: number): void {
		this.flush(now);
		for (const key of this.#arrivals.keys())
			if (Number(key.slice(key.lastIndexOf("|") + 1)) < now - 2 * HOUR) this.#arrivals.delete(key);
		const db = this.#store.db;
		const cutoff = Math.floor((now - ROLLUP_AFTER_MS) / HOUR) * HOUR;
		db.transaction(() => {
			db.run(
				`INSERT INTO crowd_counts (entity, service, bucket, answer, counted, held)
				 SELECT entity, service, (bucket / ${HOUR}) * ${HOUR} AS hour, '*', SUM(counted), SUM(held)
				 FROM crowd_counts WHERE bucket < ? AND answer != '*' GROUP BY entity, service, hour
				 ON CONFLICT (entity, service, bucket, answer) DO UPDATE SET
				   counted = counted + excluded.counted, held = held + excluded.held`,
				[cutoff],
			);
			db.run("DELETE FROM crowd_counts WHERE bucket < ? AND answer != '*'", [cutoff]);
			db.run("DELETE FROM crowd_counts WHERE bucket < ?", [before]);
		})();
	}
}

export function median(xs: readonly number[]): number {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** The crowd mode this database was last served in (a mirror never shows rows a personal Vigía published). */
export function setInstanceMode(store: Store, mode: CrowdMode): void {
	store.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('crowd-mode', ?)", [mode]);
}

export function instanceMode(store: Store): CrowdMode | null {
	const v = store.db
		.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'crowd-mode'")
		.get()?.value;
	return v === "public" || v === "local" ? v : null;
}

/** Whether a published aggregate may be shown here: a public instance never shows a personal Vigía's rows. */
export function showable(store: Store, rowMode: unknown): boolean {
	return instanceMode(store) !== "public" || rowMode === "public";
}
