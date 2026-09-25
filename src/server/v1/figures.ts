import type { Adapter, Json } from "../../core/types.ts";

/**
 * Every figure a panel shows, as flat rows a spreadsheet can read: the panel's computed view is walked and each
 * number becomes one row with its path, plus the provenance the view carries around it (the nearest feed, link,
 * observed and fetched times, staleness). Deterministic, and nothing is computed here: the value is exactly what
 * the panel computed and the page shows.
 *
 * Provenance is inherited: a number takes the nearest enclosing object's `feed`, `sourceUrl`/`url`, `observedAt`
 * (or `at`, or a rate's `validFrom`), `fetchedAt` and `stale`. When no enclosing object names its feed, the row
 * names the panel's feeds (`feed` null, `panelSources` listing them): honest about not knowing which one, never a
 * guess.
 *
 * Times, durations and ages are not figures (they become the time columns): keys ending in "At", "Ms", "From",
 * "Until" or "Since" and `now`, `asOf`, `from`, `to`, `time(s)` are skipped. The brief's pre-formatted figures
 * ({label, value, source}) are kept as text.
 */

export interface FigureRow {
	readonly panel: string;
	/** Where the number sits in the panel's view, e.g. "official.usd.current.vesPerUnit" or "byState[VE-A].last24h". */
	readonly path: string;
	/** A human label when the view gives one (the brief's figures), else null. */
	readonly label: string | null;
	readonly value: number | string;
	/** The adapter id the figure comes from, when the view says so. */
	readonly feed: string | null;
	readonly sourceUrl: string | null;
	/** When the source says the figure is true (Unix ms), when known. */
	readonly observedAt: number | null;
	/** When Vigía received it (Unix ms), when known. */
	readonly fetchedAt: number | null;
	/** Whether the view marks the figure (or its group) stale. */
	readonly stale: boolean | null;
	readonly licence: string | null;
	readonly licenceUrl: string | null;
	readonly attribution: string | null;
	/** The panel's feeds (all of them), for rows whose own feed is unknown. */
	readonly panelSources: readonly string[];
}

interface Context {
	feed: string | null;
	sourceUrl: string | null;
	observedAt: number | null;
	fetchedAt: number | null;
	stale: boolean | null;
}

const SKIP_KEY = /(At|Ms|From|Until|Since)$|^(now|asOf|at|from|to|times?)$/;
const ID_KEYS = ["id", "stateIso", "iso", "code", "key", "isp", "series"] as const;
const MAX_ROWS = 20_000;

const isObject = (v: Json): v is { [key: string]: Json } =>
	typeof v === "object" && v !== null && !Array.isArray(v);
const httpUrl = (v: Json | undefined): string | null =>
	typeof v === "string" && /^https?:\/\//.test(v) ? v : null;
const time = (v: Json | undefined): number | null =>
	typeof v === "number" && Number.isFinite(v) && v > 946_684_800_000 ? v : null;

function segment(item: Json, index: number): string {
	if (isObject(item)) {
		for (const k of ID_KEYS) {
			const v = item[k];
			if (typeof v === "string" && /^[\w:.+-]{1,80}$/.test(v)) return `[${v}]`;
		}
	}
	return `[${index}]`;
}

/**
 * Binary floating point leaves noise in computed values (855.6625 − 853.4993 = 2.1632000000000744). Twelve
 * significant digits keep every published figure exactly (rates have at most 8 decimals, counts are far below 1e12)
 * and drop the noise.
 */
export function tidy(v: number): number {
	return Number.isFinite(v) ? Number(v.toPrecision(12)) : v;
}

export function panelFigures(
	panelId: string,
	view: Json | undefined,
	panelSources: readonly string[],
	adapters: ReadonlyMap<string, Adapter>,
): FigureRow[] {
	const rows: FigureRow[] = [];
	const own = panelSources.length === 1 ? (panelSources[0] ?? null) : null;
	const root: Context = { feed: own, sourceUrl: null, observedAt: null, fetchedAt: null, stale: null };

	const push = (path: string, label: string | null, value: number | string, ctx: Context) => {
		if (rows.length >= MAX_ROWS) return;
		const adapter = ctx.feed ? adapters.get(ctx.feed) : undefined;
		rows.push({
			panel: panelId,
			path,
			label,
			value: typeof value === "number" ? tidy(value) : value,
			feed: ctx.feed,
			sourceUrl: ctx.sourceUrl,
			observedAt: ctx.observedAt,
			fetchedAt: ctx.fetchedAt,
			stale: ctx.stale,
			licence: adapter?.licence.id ?? null,
			licenceUrl: adapter?.licence.url ?? null,
			attribution: adapter?.licence.attribution ?? null,
			panelSources,
		});
	};

	const walk = (value: Json, path: string, parent: Context) => {
		if (Array.isArray(value)) {
			value.forEach((item, i) => {
				walk(item, `${path}${segment(item, i)}`, parent);
			});
			return;
		}
		if (!isObject(value)) return;
		const feed = typeof value.feed === "string" && adapters.has(value.feed) ? value.feed : null;
		const ctx: Context = {
			feed: feed ?? parent.feed,
			sourceUrl: httpUrl(value.sourceUrl) ?? httpUrl(value.url) ?? parent.sourceUrl,
			observedAt: time(value.observedAt) ?? time(value.at) ?? time(value.validFrom) ?? parent.observedAt,
			fetchedAt: time(value.fetchedAt) ?? parent.fetchedAt,
			stale: typeof value.stale === "boolean" ? value.stale : parent.stale,
		};
		// The brief's figures: already formatted by code ("853,50 Bs por dólar"), with their own source label.
		if (
			typeof value.label === "string" &&
			typeof value.value === "string" &&
			typeof value.source === "string"
		) {
			push(path, value.label, value.value, ctx);
			return;
		}
		for (const [key, child] of Object.entries(value)) {
			const at = path ? `${path}.${key}` : key;
			if (typeof child === "number") {
				if (!SKIP_KEY.test(key) && Number.isFinite(child)) push(at, null, child, ctx);
			} else if (child !== null && typeof child === "object") walk(child, at, ctx);
		}
	};

	if (view !== undefined) walk(view, "", root);
	return rows;
}
