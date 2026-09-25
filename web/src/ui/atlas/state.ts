/**
 * The atlas's view state (filters, sort, the open feed), kept in the query string so a filtered view can be linked:
 * /fuentes?cat=internet&estado=failing. replaceState only: filtering never adds history entries.
 */
import { signal } from "@preact/signals";
import { BUCKETS, type Bucket, type Filters, NO_FILTERS, type Sort } from "./model.ts";

const KEYS: Record<Exclude<keyof Filters, "needsKey">, string> = {
	q: "q",
	category: "cat",
	region: "region",
	country: "pais",
	kind: "tipo",
	lang: "idioma",
	licence: "licencia",
	bucket: "estado",
};
const SORTS: readonly Sort[] = ["category", "name", "fresh", "added"];

function read(): { filters: Filters; sort: Sort } {
	const q = new URLSearchParams(location.search);
	const get = (k: string) => q.get(k) || null;
	const bucket = get(KEYS.bucket);
	const sort = get("orden");
	return {
		filters: {
			q: q.get(KEYS.q) ?? "",
			category: get(KEYS.category),
			region: get(KEYS.region),
			country: get(KEYS.country),
			kind: get(KEYS.kind),
			lang: get(KEYS.lang),
			licence: get(KEYS.licence),
			bucket: bucket && (BUCKETS as readonly string[]).includes(bucket) ? (bucket as Bucket) : null,
			needsKey: q.get("clave") === "1",
		},
		sort: sort && (SORTS as readonly string[]).includes(sort) ? (sort as Sort) : "category",
	};
}

const initial = read();
export const filters = signal<Filters>(initial.filters);
export const sort = signal<Sort>(initial.sort);
/** The feed whose detail sheet is open. */
export const openFeed = signal<string | null>(null);

let timer: ReturnType<typeof setTimeout> | null = null;
function write(): void {
	if (timer) clearTimeout(timer);
	timer = setTimeout(() => {
		if (location.pathname.replace(/\/+$/, "") !== "/fuentes") return;
		const q = new URLSearchParams();
		const f = filters.value;
		for (const [k, name] of Object.entries(KEYS) as [keyof typeof KEYS, string][]) {
			const v = f[k];
			if (typeof v === "string" && v.trim()) q.set(name, v);
		}
		if (f.needsKey) q.set("clave", "1");
		if (sort.value !== "category") q.set("orden", sort.value);
		const s = q.toString();
		history.replaceState(history.state, "", s ? `/fuentes?${s}` : "/fuentes");
	}, 300);
}

export function setFilter<K extends keyof Filters>(key: K, value: Filters[K]): void {
	filters.value = { ...filters.value, [key]: value };
	write();
}

/** Clicking the active value again clears it (map states, category tiles, health chips). */
export function toggleFilter<K extends "category" | "region" | "country" | "bucket">(
	key: K,
	value: Filters[K],
): void {
	setFilter(key, filters.value[key] === value ? null : value);
}

export function setSort(next: Sort): void {
	sort.value = next;
	write();
}

export function clearFilters(): void {
	filters.value = NO_FILTERS;
	write();
}
