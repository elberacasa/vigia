import type { Store } from "../core/store.ts";
import type { Json } from "../core/types.ts";
import { DROP, redactRows } from "../intel/chain.ts";
import { isCourtNotice, redactNewsText } from "./privacy.ts";

/**
 * A cheap SQL prefilter: only rows whose stored text could hold a court notice or a labelled identity number are
 * read (SQLite's LIKE ignores ASCII case). Everything it lets through is judged by src/news/privacy.ts.
 */
const SUSPECT = [
	"%edicto%",
	"%cartel%",
	"%emplaza%",
	"%herederos%",
	"%dula%",
	"%C.I%",
	"%R.I.F%",
	"%RIF%",
	"%pasaporte%",
	"%inpreabogado%",
	"%V-%",
	"%E-%",
]
	.map((p) => `value LIKE '${p}'`)
	.join(" OR ");

/** A stored news item under today's rule: DROP a court notice, the item with identity numbers removed, or null. */
export function redactStoredItem(value: Json): Json | null | typeof DROP {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const title = typeof value.title === "string" ? value.title : null;
	if (title === null) return null;
	const summary = typeof value.summary === "string" ? value.summary : "";
	if (isCourtNotice(title, summary)) return DROP;
	const t = redactNewsText(title);
	const s = redactNewsText(summary);
	if (t === title && s === summary) return null;
	return { ...value, title: t, summary: s };
}

/**
 * Applies the news privacy rule (src/news/privacy.ts) to items stored by older versions (whole-release review,
 * 29 Sept 2026, B1: 43 court notices with names, identity numbers and a minor's case were stored and linked). Runs
 * at every start, like the Gaceta purge; changes only rows the rule would not keep. A row of a sealed day is removed
 * with its hash kept in `chain_pruned`, so `vigia verify` still accounts for it. Returns how many rows changed.
 */
export function purgeStoredNews(store: Store, now: number): number {
	const sources = store.db
		.query<{ source: string }, []>("SELECT DISTINCT source FROM obs WHERE series LIKE 'item:%'")
		.all()
		.map((r) => r.source);
	if (sources.length === 0) return 0;
	return redactRows(store, sources, redactStoredItem, now, SUSPECT);
}
