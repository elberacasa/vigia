import { computed, signal } from "@preact/signals";

/**
 * Per-panel settings, per device (localStorage key vigia:panel-prefs:v1), each resettable. They only choose what a
 * panel SHOWS; every figure is still computed on the server the same way, and a filtered panel says it is filtered.
 *
 * - news: which kinds of outlet (by their descriptive stance), which reach (national, regional, international,
 *   diaspora) and which states a story must touch to be listed;
 * - money: which blocks of the dollar panel appear (the BCV's official rate always does: it is the reference);
 * - map: the layer and quake points a visit opens with when its link does not say (?capa=, ?sismos=).
 */

export const STANCES = [
	"independent",
	"commercial",
	"state",
	"state-aligned",
	"state-funded",
	"public-broadcaster",
	"ngo",
	"partisan",
	"agency",
	"aggregator",
	"multilateral",
	"trade-body",
] as const;
export type StanceId = (typeof STANCES)[number];

export const REACHES = ["national", "regional", "international", "diaspora"] as const;
export type Reach = (typeof REACHES)[number];

export const MONEY_BLOCKS = ["yadio", "p2p", "chart", "inflation"] as const;
export type MoneyBlock = (typeof MONEY_BLOCKS)[number];

export const MAP_LAYERS = ["connectivity", "nightlights", "satellite", "reports", "fires"] as const;
export type MapLayer = (typeof MAP_LAYERS)[number];

export interface PanelPrefs {
	v: 1;
	news: {
		/** Stances to hide; empty shows every outlet. */
		hiddenStances: StanceId[];
		/** Reaches to hide; empty shows all. */
		hiddenReaches: Reach[];
		/** Only stories that touch one of these states; empty is the whole country. */
		states: string[];
	};
	money: { hidden: MoneyBlock[] };
	map: { layer: MapLayer | null; quakes: boolean | null };
}

const KEY = "vigia:panel-prefs:v1";

export function defaultPanelPrefs(): PanelPrefs {
	return {
		v: 1,
		news: { hiddenStances: [], hiddenReaches: [], states: [] },
		money: { hidden: [] },
		map: { layer: null, quakes: null },
	};
}

const pick = <T extends string>(raw: unknown, allowed: readonly T[]): T[] =>
	Array.isArray(raw)
		? raw.filter((x, i, a): x is T => typeof x === "string" && allowed.includes(x as T) && a.indexOf(x) === i)
		: [];

/** Keeps only known values; anything else falls back to the default. Never throws. */
export function repairPanelPrefs(raw: unknown): PanelPrefs {
	const base = defaultPanelPrefs();
	if (!raw || typeof raw !== "object") return base;
	const r = raw as {
		news?: Record<string, unknown>;
		money?: Record<string, unknown>;
		map?: Record<string, unknown>;
	};
	const states = Array.isArray(r.news?.states)
		? r.news.states.filter(
				(s, i, a): s is string => typeof s === "string" && /^VE-[A-Z]$/.test(s) && a.indexOf(s) === i,
			)
		: [];
	const layer = r.map?.layer;
	const quakes = r.map?.quakes;
	return {
		v: 1,
		news: {
			hiddenStances: pick(r.news?.hiddenStances, STANCES),
			hiddenReaches: pick(r.news?.hiddenReaches, REACHES),
			states,
		},
		money: { hidden: pick(r.money?.hidden, MONEY_BLOCKS) },
		map: {
			layer:
				typeof layer === "string" && (MAP_LAYERS as readonly string[]).includes(layer)
					? (layer as MapLayer)
					: null,
			quakes: typeof quakes === "boolean" ? quakes : null,
		},
	};
}

function load(): PanelPrefs {
	try {
		const raw = localStorage.getItem(KEY);
		return raw ? repairPanelPrefs(JSON.parse(raw)) : defaultPanelPrefs();
	} catch {
		return defaultPanelPrefs();
	}
}

export const panelPrefs = signal<PanelPrefs>(load());

/**
 * The dollar panel's hidden blocks are applied by CSS (styles/custom-base.css reads this attribute), so the panel's
 * own code stays untouched.
 */
function applyMoney(): void {
	if (typeof document === "undefined") return;
	const hidden = panelPrefs.value.money.hidden;
	if (hidden.length) document.documentElement.dataset.moneyHide = hidden.join(" ");
	else delete document.documentElement.dataset.moneyHide;
}
applyMoney();

export function setPanelPrefs(next: PanelPrefs): void {
	panelPrefs.value = repairPanelPrefs(next);
	applyMoney();
	try {
		localStorage.setItem(KEY, JSON.stringify(panelPrefs.value));
	} catch {
		// Storage off: the settings last for this visit.
	}
}

export function resetPanelPrefs(part?: "news" | "money" | "map"): void {
	const fresh = defaultPanelPrefs();
	setPanelPrefs(part ? { ...panelPrefs.value, [part]: fresh[part] } : fresh);
}

/* ---------- Queries the panels use ---------- */

export const newsFiltered = computed(() => {
	const n = panelPrefs.value.news;
	return n.hiddenStances.length > 0 || n.hiddenReaches.length > 0 || n.states.length > 0;
});

export function reachOf(region: string): Reach {
	if (region === "international") return "international";
	if (region === "diaspora") return "diaspora";
	return region.startsWith("VE-") ? "regional" : "national";
}

/**
 * Whether a story passes the news settings: at least one of its outlets is of a kind and reach the reader keeps,
 * and (when states are chosen) it touches one of them. The reader's own feeds ("user") are never hidden by stance.
 */
export function storyAllowed(story: {
	states: readonly string[];
	outlets: readonly { stance: string; region: string }[];
}): boolean {
	const n = panelPrefs.value.news;
	if (n.states.length && !story.states.some((s) => n.states.includes(s))) return false;
	if (!n.hiddenStances.length && !n.hiddenReaches.length) return true;
	return story.outlets.some(
		(o) =>
			(o.stance === "user" || !n.hiddenStances.includes(o.stance as StanceId)) &&
			!n.hiddenReaches.includes(reachOf(o.region)),
	);
}

export function moneyShows(block: MoneyBlock): boolean {
	return !panelPrefs.value.money.hidden.includes(block);
}
