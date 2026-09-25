import { computed, effect, signal } from "@preact/signals";
import { panelPrefs } from "../lib/panelprefs.ts";
import { readQuery, route, writeQuery } from "../lib/router.ts";
import { STATES } from "./geometry.gen.ts";
import { history, indexAt, isoCaracas, parseViewTime } from "./history.ts";

/**
 * The map's view state, shared by the map, the state sheet, the panels that link into the map and (later) the
 * command palette and keyboard shortcuts. Everything here round-trips through the URL:
 *   ?capa=internet&estado=VE-K&t=2026-09-24T18:00-04:00&sismos=0&focos=1&quemadores=1
 * A link restores exactly that view. Programmatic entry points (call these, do not poke the signals from outside):
 *   selectState(iso | null), setLayer(id), nextLayer(), toggleQuakes(on?), toggleFires(on?), toggleFlares(on?),
 *   setViewTime(ms | null),
 *   stepViewTime(±1).
 */

/** One layer colours the states at a time (a map with two choropleths is unreadable); points go on top. */
export type Shading = "connectivity" | "nightlights" | "satellite" | "reports" | "fires" | "aiBlackouts";

export const SHADINGS: readonly Shading[] = [
	"connectivity",
	"nightlights",
	"satellite",
	"reports",
	"fires",
	"aiBlackouts",
];

/** URL slugs, Spanish (the links people forward). */
const SLUG: Record<Shading, string> = {
	connectivity: "internet",
	nightlights: "luces",
	satellite: "satelite",
	reports: "titulares",
	fires: "incendios",
	aiBlackouts: "apagones-ia",
};
const BY_SLUG = new Map(Object.entries(SLUG).map(([k, v]) => [v, k as Shading]));
const ISOS = new Set(STATES.map((s) => s.iso));

const q = readQuery();
const initialIso = q.get("estado")?.toUpperCase() ?? null;
// Without ?capa= / ?sismos= in the link, the reader's map settings (lib/panelprefs.ts) choose; a link always wins.
const initialShading = BY_SLUG.get(q.get("capa") ?? "") ?? panelPrefs.value.map.layer ?? "connectivity";
const initialT = parseViewTime(q.get("t"));

export const shading = signal<Shading>(initialShading);
export const showQuakes = signal(
	q.has("sismos") ? q.get("sismos") !== "0" : (panelPrefs.value.map.quakes ?? true),
);
/** Heat-spot points on top of any shading (NASA FIRMS; needs a free key). */
export const showFires = signal(q.get("focos") === "1");
/** Gas flares at refineries and fields (NASA FIRMS night detections per facility; needs the same free key). */
export const showFlares = signal(q.get("quemadores") === "1");
export const selectedState = signal<string | null>(initialIso && ISOS.has(initialIso) ? initialIso : null);
/**
 * Replay time: the start of the history step being viewed (UTC ms), or null for live. Only the Internet layer has
 * history today, so a `?t=` on any other layer (or in the future) is dropped when the link is read, and the page says
 * so (`ignoredTime`) instead of claiming a replay the map is not showing (review 3, H7).
 */
export const viewTime = signal<number | null>(
	initialT !== null && initialShading === "connectivity" && initialT <= Date.now() ? initialT : null,
);

/** A `?t=` the map could not show, and why, for one honest line under Ahora; null once dismissed or when none. */
export const ignoredTime = signal<{ at: number; reason: "layer" | "range" } | null>(
	initialT !== null && viewTime.value === null ? { at: initialT, reason: "layer" } : null,
);
if (ignoredTime.value && initialT !== null && initialT > Date.now())
	ignoredTime.value = { at: initialT, reason: "range" };

/**
 * The step the map is actually replaying (its start, UTC ms), or null when the map is live: only on the Internet
 * layer, and only once the loaded history contains `viewTime`. Everything that says "the map shows …" reads this,
 * never `viewTime` alone.
 */
export const replaying = computed<number | null>(() => {
	const vt = viewTime.value;
	const h = history.value;
	if (vt === null || shading.value !== "connectivity" || !h) return null;
	const i = indexAt(h, vt);
	return i === -1 ? null : (h.times[i] ?? null);
});
/** True when the page was opened from a link that carried a view (never show first-run prompts to these visitors). */
export const openedFromLink = ["capa", "estado", "t"].some((k) => q.has(k));

/** A municipality outlined inside the selected state (from the palette), e.g. "VE2313"; cleared with the state. */
export const highlightedMunicipality = signal<string | null>(null);

export function selectState(iso: string | null): void {
	const next = iso && ISOS.has(iso) ? iso : null;
	if (next !== selectedState.value) highlightedMunicipality.value = null;
	selectedState.value = next;
}

/** Zooms to a municipality's state and outlines the municipality (its geometry loads with the state's). */
export function selectMunicipality(code: string, stateIso: string): void {
	selectState(stateIso);
	highlightedMunicipality.value = /^VE\d{4}$/.test(code) ? code : null;
}

export function setLayer(next: Shading): void {
	if (next !== "connectivity") viewTime.value = null;
	shading.value = next;
}

/** Cycles the shading layers in order (for a keyboard shortcut); `available` filters out locked ones. */
export function nextLayer(available: (s: Shading) => boolean = () => true): Shading {
	const list = SHADINGS.filter(available);
	const i = list.indexOf(shading.value);
	const next = list[(i + 1) % list.length] ?? "connectivity";
	setLayer(next);
	return next;
}

export function toggleQuakes(on?: boolean): void {
	showQuakes.value = on ?? !showQuakes.value;
}

export function toggleFires(on?: boolean): void {
	showFires.value = on ?? !showFires.value;
}

export function toggleFlares(on?: boolean): void {
	showFlares.value = on ?? !showFlares.value;
}

export function setViewTime(t: number | null): void {
	if (t !== null && shading.value !== "connectivity") shading.value = "connectivity";
	viewTime.value = t;
}

/**
 * Steps the replay by `delta` steps of the loaded history (for "[" and "]" shortcuts): from live, −1 goes to the newest
 * past step; stepping past the newest returns to live. Returns false when no history is loaded yet (the strip loads it
 * when the Internet layer is shown).
 */
export function stepViewTime(delta: number): boolean {
	const h = history.value;
	if (!h?.times.length) return false;
	const n = h.times.length;
	const at = viewTime.value === null ? n : indexAt(h, viewTime.value);
	const next = Math.max(0, Math.min(n, (at === -1 ? n : at) + delta));
	setViewTime(next >= n ? null : (h.times[next] ?? null));
	return true;
}

effect(() => {
	if (route.value !== "wall") return;
	writeQuery({
		capa: shading.value === "connectivity" ? null : SLUG[shading.value],
		estado: selectedState.value,
		t: viewTime.value === null ? null : isoCaracas(viewTime.value),
		sismos: showQuakes.value ? null : "0",
		focos: showFires.value ? "1" : null,
		quemadores: showFlares.value ? "1" : null,
	});
});
