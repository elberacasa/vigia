/**
 * The sources atlas, as pure functions over /api/meta and /api/health: rows, filters, counts, growth. No DOM here,
 * so it is tested directly and stays fast with thousands of feeds (one pass per change, precomputed search text).
 * These are counts of catalogue entries, not data figures: they describe Vigía's own sources.
 */
import type { FeedMeta, FeedState } from "../../lib/data.ts";

/** Health collapsed to what a reader acts on. "live" includes a feed retrying after one failed run. */
export type Bucket = "live" | "stale" | "failing" | "locked" | "off" | "pending";
export const BUCKETS: readonly Bucket[] = ["live", "stale", "failing", "locked", "off", "pending"];

export function bucketOf(state: FeedState | undefined): Bucket {
	switch (state) {
		case "ok":
		case "degraded":
			return "live";
		case "stale":
			return "stale";
		case "failing":
			return "failing";
		case "locked":
			return "locked";
		case "off":
			return "off";
		default:
			return "pending";
	}
}

/** Display order of categories; an id the client does not know yet goes last, labelled by its id. */
export const CATEGORY_ORDER = [
	"money",
	"markets",
	"energy",
	"internet",
	"censorship",
	"earth",
	"space",
	"airspace",
	"attention",
	"news",
	"social",
	"society",
] as const;

export interface Row {
	readonly meta: FeedMeta;
	readonly id: string;
	readonly category: readonly string[];
	readonly primary: string;
	readonly kind: string;
	readonly region: string;
	readonly country: string;
	readonly lang: string | null;
	readonly publisher: string;
	/** Epoch ms or null. */
	readonly added: number | null;
	readonly needsKey: boolean;
	/** Lower-case, accent-free text the search matches against. */
	readonly haystack: string;
}

export function fold(s: string): string {
	return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function parseAdded(s: string | null | undefined): number | null {
	if (!s) return null;
	const t = Date.parse(s);
	return Number.isFinite(t) ? t : null;
}

/** One row per feed. `extra` adds searchable words (translated category and region names). */
export function toRows(meta: readonly FeedMeta[], extra: (m: FeedMeta) => string = () => ""): Row[] {
	return meta.map((m) => {
		const category = m.category && m.category.length > 0 ? m.category : [m.layer];
		return {
			meta: m,
			id: m.id,
			category,
			primary: category[0] ?? m.layer,
			kind: m.kind ?? "api",
			region: m.region ?? "intl",
			country: m.country ?? "INT",
			lang: m.lang ?? null,
			publisher: m.publisher ?? fold(m.provider),
			added: parseAdded(m.added),
			needsKey: m.keys.length > 0,
			haystack: fold(
				[m.name.es, m.name.en, m.provider, m.id, m.homepage, m.licence.name, extra(m)].join(" "),
			),
		};
	});
}

export interface Filters {
	q: string;
	category: string | null;
	/** A region code ("VE", "VE-V", "diaspora", "intl") or "state" for any Venezuelan state. */
	region: string | null;
	country: string | null;
	kind: string | null;
	lang: string | null;
	licence: string | null;
	bucket: Bucket | null;
	needsKey: boolean;
}

export const NO_FILTERS: Filters = {
	q: "",
	category: null,
	region: null,
	country: null,
	kind: null,
	lang: null,
	licence: null,
	bucket: null,
	needsKey: false,
};

export function activeCount(f: Filters): number {
	return (
		(f.q.trim() ? 1 : 0) +
		[f.category, f.region, f.country, f.kind, f.lang, f.licence, f.bucket].filter((v) => v !== null).length +
		(f.needsKey ? 1 : 0)
	);
}

export type Sort = "name" | "category" | "fresh" | "added";

/** Filter then sort. Every word of the query must match (in any field), accents ignored. */
export function applyFilters(
	rows: readonly Row[],
	f: Filters,
	bucketById: ReadonlyMap<string, Bucket>,
	sort: Sort = "category",
	dataAge: (id: string) => number | null = () => null,
	lang: "es" | "en" = "es",
): Row[] {
	const words = fold(f.q).split(/\s+/).filter(Boolean);
	const out = rows.filter((r) => {
		if (f.category && !r.category.includes(f.category)) return false;
		if (f.region) {
			if (f.region === "state" ? !r.region.startsWith("VE-") : r.region !== f.region) return false;
		}
		if (f.country && r.country !== f.country) return false;
		if (f.kind && r.kind !== f.kind) return false;
		if (f.lang && (r.lang ?? "none") !== f.lang) return false;
		if (f.licence && r.meta.licence.id !== f.licence) return false;
		if (f.bucket && (bucketById.get(r.id) ?? "pending") !== f.bucket) return false;
		if (f.needsKey && !r.needsKey) return false;
		for (const w of words) if (!r.haystack.includes(w)) return false;
		return true;
	});
	const name = (r: Row) => r.meta.name[lang];
	const rank = (c: string) => {
		const i = (CATEGORY_ORDER as readonly string[]).indexOf(c);
		return i === -1 ? CATEGORY_ORDER.length : i;
	};
	const byName = (a: Row, b: Row) => name(a).localeCompare(name(b), lang);
	switch (sort) {
		case "name":
			return out.sort(byName);
		case "category":
			return out.sort((a, b) => rank(a.primary) - rank(b.primary) || byName(a, b));
		case "fresh":
			return out.sort((a, b) => {
				const x = dataAge(a.id);
				const y = dataAge(b.id);
				if (x === null && y === null) return byName(a, b);
				if (x === null) return 1;
				if (y === null) return -1;
				return x - y;
			});
		case "added":
			return out.sort((a, b) => (b.added ?? -1) - (a.added ?? -1) || byName(a, b));
	}
}

export type BucketCounts = Record<Bucket, number>;

export function emptyCounts(): BucketCounts {
	return { live: 0, stale: 0, failing: 0, locked: 0, off: 0, pending: 0 };
}

export interface Group {
	readonly key: string;
	readonly feeds: number;
	readonly publishers: number;
	readonly buckets: BucketCounts;
}

export interface Summary {
	readonly feeds: number;
	readonly publishers: number;
	readonly buckets: BucketCounts;
	/** By primary category (each feed once), largest first. */
	readonly categories: readonly Group[];
	/** Venezuelan states with at least one regional feed. */
	readonly states: readonly Group[];
	/** Feeds by region class: VE (national), state, diaspora, intl. */
	readonly regions: Readonly<Record<"VE" | "state" | "diaspora" | "intl", number>>;
	/** Publishers based outside Venezuela (intl and diaspora feeds not based in VE), by country, largest first. */
	readonly countries: readonly Group[];
	readonly needsKey: number;
	readonly undated: number;
}

function group(
	rows: readonly Row[],
	key: (r: Row) => string,
	bucketById: ReadonlyMap<string, Bucket>,
): Group[] {
	const map = new Map<string, { feeds: number; pubs: Set<string>; buckets: BucketCounts }>();
	for (const r of rows) {
		const k = key(r);
		let g = map.get(k);
		if (!g) {
			g = { feeds: 0, pubs: new Set(), buckets: emptyCounts() };
			map.set(k, g);
		}
		g.feeds++;
		g.pubs.add(r.publisher);
		g.buckets[bucketById.get(r.id) ?? "pending"]++;
	}
	return [...map.entries()]
		.map(([k, g]) => ({ key: k, feeds: g.feeds, publishers: g.pubs.size, buckets: g.buckets }))
		.sort((a, b) => b.feeds - a.feeds || a.key.localeCompare(b.key));
}

export function summarize(rows: readonly Row[], bucketById: ReadonlyMap<string, Bucket>): Summary {
	const buckets = emptyCounts();
	const regions = { VE: 0, state: 0, diaspora: 0, intl: 0 };
	let needsKey = 0;
	let undated = 0;
	for (const r of rows) {
		buckets[bucketById.get(r.id) ?? "pending"]++;
		if (r.region.startsWith("VE-")) regions.state++;
		else if (r.region === "VE" || r.region === "diaspora" || r.region === "intl") regions[r.region]++;
		else regions.intl++;
		if (r.needsKey) needsKey++;
		if (r.added === null) undated++;
	}
	// teleSUR is an international channel based in Caracas: not "outside Venezuela".
	const abroad = rows.filter((r) => (r.region === "intl" || r.region === "diaspora") && r.country !== "VE");
	return {
		feeds: rows.length,
		publishers: new Set(rows.map((r) => r.publisher)).size,
		buckets,
		categories: group(rows, (r) => r.primary, bucketById),
		states: group(
			rows.filter((r) => r.region.startsWith("VE-")),
			(r) => r.region,
			bucketById,
		),
		regions,
		countries: group(abroad, (r) => r.country, bucketById),
		needsKey,
		undated,
	};
}

/** Cumulative feed count over time: one step per distinct `added` instant, then a final point at `now`. */
export function growth(rows: readonly Row[], now: number): { t: number; n: number }[] {
	const times = rows
		.map((r) => r.added)
		.filter((t): t is number => t !== null)
		.sort((a, b) => a - b);
	const out: { t: number; n: number }[] = [];
	for (let i = 0; i < times.length; i++) {
		const t = times[i] as number;
		const last = out.at(-1);
		if (last && last.t === t) last.n = i + 1;
		else out.push({ t, n: i + 1 });
	}
	const last = out.at(-1);
	if (last && now > last.t) out.push({ t: now, n: last.n });
	return out;
}

/** Distinct values of a field with their counts, largest first (for the filter menus). */
export function facet(rows: readonly Row[], key: (r: Row) => string): { value: string; n: number }[] {
	const m = new Map<string, number>();
	for (const r of rows) {
		const k = key(r);
		m.set(k, (m.get(k) ?? 0) + 1);
	}
	return [...m.entries()]
		.map(([value, n]) => ({ value, n }))
		.sort((a, b) => b.n - a.n || a.value.localeCompare(b.value));
}

/** Points of a sunflower (phyllotaxis) around a centre: dense, even, no overlaps for any count. */
export function sunflower(n: number, spacing: number): [number, number][] {
	const golden = Math.PI * (3 - Math.sqrt(5));
	return Array.from({ length: n }, (_, i) => {
		const r = spacing * Math.sqrt(i + (i === 0 ? 0 : 0.5));
		return [r * Math.cos(i * golden), r * Math.sin(i * golden)];
	});
}
