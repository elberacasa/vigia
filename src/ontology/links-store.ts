/**
 * Stored links: which archived observations touch which entity, so an entity's timeline is an index lookup rather
 * than a scan that re-tags every headline of the window on each request (measured 2026-09-28 on a copy of a
 * four-day archive: re-tagging a week of headlines takes 1.4 s; a timeline read from the table takes a few
 * milliseconds).
 *
 * The table is derived data, like `history_levels`: `sync()` links every observation inserted since the last sync
 * (a watermark on obs.id), a slice at a time, and a change of the rules or of the registry (its `version`) drops the
 * table and relinks the whole archive in the background. Rows point at obs.id, so a pruned observation simply drops
 * out of the join; `pruneSteps()` removes its rows too.
 */
import type { Store } from "../core/store.ts";
import type { Json } from "../core/types.ts";
import {
	linker as defaultLinker,
	type Link,
	type Linker,
	type LinkRule,
	RULES,
	textFingerprint,
} from "./linker.ts";
import { registry } from "./registry.ts";

const WATERMARK_KEY = "entity-links-watermark";
const VERSION_KEY = "entity-links-version";
/** Work done before yielding to requests (review 4 L8's slice for the history archive). */
const SLICE_MS = 25;

/**
 * Sources whose every stored row is its own event, never a revision of an earlier one: each RIPEstat snapshot
 * compares with the one before it. Every other source's series is one event, told by its newest row.
 */
export const SNAPSHOT_SOURCES: readonly string[] = ["ripestat-prefixes"];
/**
 * Sources whose one series holds one event per observed time (a GLM 15-minute window, a BCV intervention): each
 * observed time is its own event, told by its newest revision.
 * The MODIS flood product ("day") and the radar ship counts (one series per area) are observed day after day in
 * one series: each day is its own event (whole-release review, M5: only the newest day kept its links, so a Lara
 * flood of an earlier day vanished from Lara's timeline).
 */
export const WINDOW_SOURCES: readonly string[] = [
	"goes-glm",
	"bcv-intervention",
	"modis-floods",
	"gfw-vessels",
];
/**
 * Directories (TV and radio listings, Wikidata offices, prediction markets): only a series' newest row keeps its
 * links, so a market re-read every hour or a listing re-published every day never piles up rows here.
 */
export const DIRECTORY_SOURCES: readonly string[] = [
	"iptv-ve",
	"radio-browser",
	"wikidata-officials",
	"polymarket",
	"kalshi",
];
const sqlList = (list: readonly string[]) => list.map((s) => `'${s}'`).join(",");
const SNAPSHOT_SQL = sqlList(SNAPSHOT_SOURCES);
const WINDOW_SQL = sqlList(WINDOW_SOURCES);
const DIRECTORY = new Set(DIRECTORY_SOURCES);
/** The newest revision of the row's series (or of its observed time, for window sources), or a snapshot source. */
const NEWEST = `(o.source IN (${SNAPSHOT_SQL})
	OR (o.source IN (${WINDOW_SQL}) AND o.id = (SELECT o2.id FROM obs o2 WHERE o2.source = o.source AND o2.series = o.series AND o2.observed_at = o.observed_at ORDER BY o2.id DESC LIMIT 1))
	OR (o.source NOT IN (${WINDOW_SQL}) AND o.id = (SELECT o2.id FROM obs o2 WHERE o2.source = o.source AND o2.series = o.series ORDER BY o2.observed_at DESC, o2.id DESC LIMIT 1)))`;

/**
 * Rules version plus fingerprints of everything that decides a link: the registry's ids, the curated names matched
 * in text, and the gazetteer's build. A change to any of them relinks the archive.
 */
export function linkVersion(): string {
	const ids = registry()
		.all.map((e) => e.id)
		.join("\n");
	return `${RULES.version}:${Bun.hash(ids).toString(16)}:${textFingerprint()}`;
}

/**
 * Archived observations not linked yet, read from the store without a LinkIndex (for code that only reads the
 * table, such as the anomaly engine's headline counts): the whole archive when the table is missing or was built by
 * another rules version.
 */
export function linkBacklogOf(store: Store): number {
	const max = store.db.query<{ id: number | null }, []>("SELECT MAX(id) AS id FROM obs").get()?.id ?? 0;
	const meta = store.db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?");
	const mark = meta.get(WATERMARK_KEY)?.value;
	if (mark === undefined || meta.get(VERSION_KEY)?.value !== linkVersion()) return max;
	return Math.max(0, max - Number(mark));
}

export type LinkedRow = {
	readonly id: number;
	readonly source: string;
	readonly series: string;
	readonly observedAt: number;
	readonly fetchedAt: number;
	readonly sourceUrl: string;
	readonly licence: string;
	readonly value: Json;
	readonly lat: number | null;
	readonly lon: number | null;
	readonly rule: LinkRule;
	readonly confidence: number;
	readonly km: number | null;
};

type Row = {
	id: number;
	source: string;
	series: string;
	observed_at: number;
	fetched_at: number;
	source_url: string;
	licence: string;
	value: string;
	lat: number | null;
	lon: number | null;
	state: string | null;
	place: string | null;
};

export class LinkIndex {
	readonly #store: Store;
	readonly #linker: Linker;
	readonly #version: string;

	constructor(store: Store, linker: Linker = defaultLinker(), version: string = linkVersion()) {
		this.#store = store;
		this.#linker = linker;
		this.#version = version;
		const db = store.db;
		// A new rules or registry version starts over: dropping is instant where DELETE would walk every row.
		if (this.#meta(VERSION_KEY) !== this.#version) db.run("DROP TABLE IF EXISTS entity_links");
		db.run(`CREATE TABLE IF NOT EXISTS entity_links (
			entity TEXT NOT NULL,
			observed_at INTEGER NOT NULL,
			obs_id INTEGER NOT NULL,
			rule TEXT NOT NULL,
			confidence REAL NOT NULL,
			km REAL,
			PRIMARY KEY (entity, observed_at, obs_id)
		) WITHOUT ROWID`);
		db.run("CREATE INDEX IF NOT EXISTS entity_links_obs ON entity_links (obs_id)");
		if (this.#meta(VERSION_KEY) !== this.#version) {
			db.transaction(() => {
				this.#setMeta(WATERMARK_KEY, "0");
				this.#setMeta(VERSION_KEY, this.#version);
			})();
		}
	}

	#meta(key: string): string | null {
		return (
			this.#store.db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)
				?.value ?? null
		);
	}

	#setMeta(key: string, value: string): void {
		this.#store.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [key, value]);
	}

	#maxId(): number {
		return this.#store.db.query<{ id: number | null }, []>("SELECT MAX(id) AS id FROM obs").get()?.id ?? 0;
	}

	/** Observations not yet linked (0 when current). */
	backlog(): number {
		return Math.max(0, this.#maxId() - Number(this.#meta(WATERMARK_KEY) ?? 0));
	}

	/** Links everything inserted since the last sync; returns how many links were written. */
	sync(): number {
		let n = 0;
		for (const step of this.syncSteps(20_000, Number.POSITIVE_INFINITY)) n += step;
		return n;
	}

	/**
	 * `sync` in slices: id ranges of `chunk` rows, each in its own transaction that also moves the watermark, yielding
	 * the links written whenever `sliceMs` of work has gone by. Stopped halfway, what was done stays done.
	 */
	*syncSteps(chunk = 5_000, sliceMs = SLICE_MS): Generator<number, void> {
		const db = this.#store.db;
		const top = this.#maxId();
		const rows = db.query<Row, [number, number]>(
			"SELECT id, source, series, observed_at, fetched_at, source_url, licence, value, lat, lon, state, place FROM obs WHERE id > ? AND id <= ?",
		);
		const put = db.query(
			"INSERT OR REPLACE INTO entity_links (entity, observed_at, obs_id, rule, confidence, km) VALUES (?, ?, ?, ?, ?, ?)",
		);
		// Directories: a row newer than this one exists (skip it), or this one supersedes the older rows (drop theirs).
		const newer = db.query<{ one: number }, [string, string, number, number, number]>(
			"SELECT 1 AS one FROM obs WHERE source = ? AND series = ? AND (observed_at > ? OR (observed_at = ? AND id > ?)) LIMIT 1",
		);
		const dropOlder = db.query(
			"DELETE FROM entity_links WHERE obs_id IN (SELECT id FROM obs WHERE source = ? AND series = ? AND id <> ?)",
		);
		let slice = performance.now();
		let written = 0;
		// The watermark is re-read before every chunk: a request's catch-up and the background sync may interleave
		// (each yields between chunks), and neither may redo the other's work or move the watermark back.
		for (;;) {
			const since = Number(this.#meta(WATERMARK_KEY) ?? 0);
			if (since >= top) break;
			const until = Math.min(top, since + chunk);
			db.transaction(() => {
				for (const r of rows.all(since, until)) {
					if (!this.#linker.sources.has(r.source)) continue;
					if (DIRECTORY.has(r.source)) {
						if (newer.get(r.source, r.series, r.observed_at, r.observed_at, r.id)) continue;
						dropOlder.run(r.source, r.series, r.id);
					}
					let value: Json;
					try {
						value = JSON.parse(r.value) as Json;
					} catch {
						continue;
					}
					const location =
						r.lat !== null && r.lon !== null
							? {
									lat: r.lat,
									lon: r.lon,
									...(r.state ? { state: r.state } : {}),
									...(r.place ? { place: r.place } : {}),
								}
							: undefined;
					const links: Link[] = this.#linker.observation({
						source: r.source,
						series: r.series,
						observedAt: r.observed_at,
						value,
						...(location ? { location } : {}),
					});
					for (const l of links) put.run(l.entity, r.observed_at, r.id, l.rule, l.confidence, l.km ?? null);
					written += links.length;
				}
				this.#setMeta(WATERMARK_KEY, String(until));
			})();
			if (performance.now() - slice >= sliceMs) {
				yield written;
				written = 0;
				slice = performance.now();
			}
		}
		if (written > 0) yield written;
	}

	/**
	 * Drops the links of observations that no longer exist (after the archive is pruned), a slice of obs ids at a
	 * time through the obs_id index, yielding between slices. Also pulls the watermark back to the newest remaining
	 * row: obs ids are reused when the highest one is deleted, and a reused id at or below the watermark would never
	 * be linked.
	 */
	*pruneSteps(chunk = 20_000): Generator<void, void> {
		const db = this.#store.db;
		const bounds = db
			.query<{ lo: number | null; hi: number | null }, []>(
				"SELECT MIN(obs_id) AS lo, MAX(obs_id) AS hi FROM entity_links",
			)
			.get();
		const drop = db.query(
			"DELETE FROM entity_links WHERE obs_id BETWEEN ? AND ? AND NOT EXISTS (SELECT 1 FROM obs WHERE obs.id = entity_links.obs_id)",
		);
		for (let lo = bounds?.lo ?? 0; bounds?.hi != null && lo <= bounds.hi; lo += chunk) {
			drop.run(lo, lo + chunk - 1);
			yield;
		}
		const top = this.#maxId();
		if (Number(this.#meta(WATERMARK_KEY) ?? 0) > top) this.#setMeta(WATERMARK_KEY, String(top));
	}

	prune(): void {
		for (const _ of this.pruneSteps());
	}

	#sourceFilter(sources: ReadonlySet<string> | undefined): { sql: string; params: string[] } {
		if (!sources) return { sql: "", params: [] };
		const list = [...sources];
		return { sql: ` AND o.source IN (${list.map(() => "?").join(",")})`, params: list };
	}

	/**
	 * Observations linked to `entity` observed in [from, to], newest first. Each series counts once, by its newest
	 * revision anywhere (a quake revised and relocated to another state is gone from the first state's timeline),
	 * except for sources whose every row is its own event (SNAPSHOT_SOURCES). The source filter and the revision
	 * rule run in SQL before the limit, so neither can starve the result. `truncated` says more existed.
	 */
	linked(
		entity: string,
		from: number,
		to: number,
		limit: number,
		sources?: ReadonlySet<string>,
	): { rows: LinkedRow[]; truncated: boolean } {
		const f = this.#sourceFilter(sources);
		const raw = this.#store.db
			.query<Row & { rule: string; confidence: number; km: number | null }, (string | number)[]>(
				`SELECT o.id, o.source, o.series, o.observed_at, o.fetched_at, o.source_url, o.licence, o.value, o.lat, o.lon,
				        o.state, o.place, l.rule, l.confidence, l.km
				 FROM entity_links l JOIN obs o ON o.id = l.obs_id
				 WHERE l.entity = ? AND l.observed_at BETWEEN ? AND ?${f.sql} AND ${NEWEST}
				 ORDER BY l.observed_at DESC, l.obs_id DESC LIMIT ?`,
			)
			.all(entity, from, to, ...f.params, limit + 1);
		const out: LinkedRow[] = raw.slice(0, limit).map((r) => ({
			id: r.id,
			source: r.source,
			series: r.series,
			observedAt: r.observed_at,
			fetchedAt: r.fetched_at,
			sourceUrl: r.source_url,
			licence: r.licence,
			value: JSON.parse(r.value) as Json,
			lat: r.lat,
			lon: r.lon,
			rule: r.rule as LinkRule,
			confidence: r.confidence,
			km: r.km,
		}));
		return { rows: out, truncated: raw.length > limit };
	}

	/** How many distinct items (series, by the same revision rule as `linked`) touch `entity` in [from, to]. */
	count(entity: string, from: number, to: number, sources?: ReadonlySet<string>): number {
		const f = this.#sourceFilter(sources);
		return (
			this.#store.db
				.query<{ n: number }, (string | number)[]>(
					`SELECT COUNT(DISTINCT o.source || char(0) || o.series || char(0) ||
					        CASE WHEN o.source IN (${SNAPSHOT_SQL}) THEN o.id
					             WHEN o.source IN (${WINDOW_SQL}) THEN o.observed_at ELSE '' END) AS n
					 FROM entity_links l JOIN obs o ON o.id = l.obs_id
					 WHERE l.entity = ? AND l.observed_at BETWEEN ? AND ?${f.sql} AND ${NEWEST}`,
				)
				.get(entity, from, to, ...f.params)?.n ?? 0
		);
	}

	/** The newest linked observation time of `entity` from these sources (for "last seen"). */
	newest(entity: string, sources?: ReadonlySet<string>): number | null {
		return this.linked(entity, 0, Number.MAX_SAFE_INTEGER, 1, sources).rows[0]?.observedAt ?? null;
	}

	/** Rows in the table (for measurements and tests). */
	size(): number {
		return this.#store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM entity_links").get()?.n ?? 0;
	}
}
