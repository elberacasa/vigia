import { computed, signal } from "@preact/signals";
import { density } from "./prefs.ts";

/**
 * The wall's layout, saved per device (localStorage, key vigia:layout:v1): which panels are hidden, their order,
 * which side column each sits in on a wide screen, and which are collapsed to their one-line summary. Collapse is
 * stored separately for phones and desks because a phone starts with everything collapsed into summary rows.
 * The page works without storage; a corrupt or outdated saved layout is repaired, never trusted.
 */

export const PANEL_IDS = [
	"incidentes",
	"dinero",
	"conectividad",
	"bolsillo",
	"servicios",
	"noticias",
	"gaceta",
	"sismos",
	"clima",
	"luces",
	"incendios",
	"alertas",
	"satelite",
	"petroleo",
	"mercados",
	"censura",
	"red",
	"energia",
	"espacio-aereo",
	"atencion",
	"tv",
	"humanitario",
] as const;
export type PanelId = (typeof PANEL_IDS)[number];
export type Column = "left" | "right";
type Form = "phone" | "desk";

export function isPanelId(id: string): id is PanelId {
	return (PANEL_IDS as readonly string[]).includes(id);
}

const DEFAULT_COLUMN: Record<PanelId, Column> = {
	incidentes: "right",
	dinero: "left",
	bolsillo: "left",
	servicios: "left",
	gaceta: "right",
	conectividad: "right",
	noticias: "right",
	sismos: "right",
	clima: "left",
	luces: "left",
	incendios: "left",
	alertas: "left",
	satelite: "left",
	petroleo: "left",
	mercados: "left",
	censura: "left",
	red: "left",
	energia: "left",
	"espacio-aereo": "right",
	atencion: "right",
	tv: "right",
	humanitario: "left",
};

export interface Layout {
	v: 1;
	order: PanelId[];
	column: Record<PanelId, Column>;
	hidden: PanelId[];
	collapsed: Record<Form, Partial<Record<PanelId, boolean>>>;
}

const KEY = "vigia:layout:v1";
const ONBOARDED = "vigia:onboarded";

function fresh(): Layout {
	return {
		v: 1,
		order: [...PANEL_IDS],
		column: { ...DEFAULT_COLUMN },
		hidden: [],
		collapsed: { phone: {}, desk: {} },
	};
}

/** Keeps only known ids, adds panels that shipped after the layout was saved, drops duplicates. */
export function repair(raw: unknown): Layout {
	const base = fresh();
	if (!raw || typeof raw !== "object") return base;
	const r = raw as Partial<Layout>;
	const seen = new Set<PanelId>();
	const order: PanelId[] = [];
	for (const id of Array.isArray(r.order) ? r.order : []) {
		if (typeof id === "string" && isPanelId(id) && !seen.has(id)) {
			seen.add(id);
			order.push(id);
		}
	}
	// Panels the saved layout does not know (shipped after it was saved) are added at the end, except one that
	// leads the default order (every panel before it is new too): it leads, so a new first panel is not buried.
	let lead = 0;
	PANEL_IDS.forEach((id, i) => {
		if (seen.has(id)) return;
		if (PANEL_IDS.slice(0, i).every((p) => !seen.has(p) || order.indexOf(p) < lead))
			order.splice(lead++, 0, id);
		else order.push(id);
		seen.add(id);
	});
	const column = { ...DEFAULT_COLUMN };
	if (r.column && typeof r.column === "object") {
		for (const id of PANEL_IDS) {
			const c = (r.column as Record<string, unknown>)[id];
			if (c === "left" || c === "right") column[id] = c;
		}
	}
	const hidden = (Array.isArray(r.hidden) ? r.hidden : []).filter(
		(id, i, a): id is PanelId => typeof id === "string" && isPanelId(id) && a.indexOf(id) === i,
	);
	const collapsed: Layout["collapsed"] = { phone: {}, desk: {} };
	for (const form of ["phone", "desk"] as const) {
		const src = r.collapsed?.[form];
		if (!src || typeof src !== "object") continue;
		for (const id of PANEL_IDS) {
			const v = (src as Record<string, unknown>)[id];
			if (typeof v === "boolean") collapsed[form][id] = v;
		}
	}
	return { v: 1, order, column, hidden, collapsed };
}

function load(): Layout {
	try {
		const raw = localStorage.getItem(KEY);
		return raw ? repair(JSON.parse(raw)) : fresh();
	} catch {
		return fresh();
	}
}

export const layout = signal<Layout>(load());

function save(next: Layout): void {
	layout.value = next;
	try {
		localStorage.setItem(KEY, JSON.stringify(next));
	} catch {
		// Storage off: the layout lasts for this visit only.
	}
}

/* ---------- Viewport ---------- */

export type Viewport = "phone" | "narrow" | "mid" | "wide";
const mq = {
	phone: matchMedia("(max-width: 640px)"),
	mid: matchMedia("(min-width: 1000px)"),
	wide: matchMedia("(min-width: 1500px)"),
};
function measure(): Viewport {
	if (mq.wide.matches) return "wide";
	if (mq.mid.matches) return "mid";
	return mq.phone.matches ? "phone" : "narrow";
}
export const viewport = signal<Viewport>(measure());
for (const m of Object.values(mq)) m.addEventListener("change", () => (viewport.value = measure()));

const form = computed<Form>(() => (viewport.value === "phone" ? "phone" : "desk"));

/**
 * Wall mode: every side panel shows its summary row and one panel at a time opens, rotating only among panels
 * whose summary is not normal. Null keeps everything still (all normal).
 */
export const wallFocus = signal<PanelId | null>(null);

/* ---------- Queries ---------- */

export const visibleOrder = computed(() =>
	layout.value.order.filter((id) => !layout.value.hidden.includes(id)),
);

export function columnOf(id: PanelId): Column {
	return layout.value.column[id];
}

export function inColumn(column: Column): PanelId[] {
	return visibleOrder.value.filter((id) => layout.value.column[id] === column);
}

export function hiddenPanels(column?: Column): PanelId[] {
	const l = layout.value;
	return l.order.filter((id) => l.hidden.includes(id) && (!column || l.column[id] === column));
}

/** Phones start with every panel collapsed into a summary row; desks start with everything open. */
export function isCollapsed(id: PanelId): boolean {
	if (density.value === "pared" && viewport.value !== "phone") return wallFocus.value !== id;
	const saved = layout.value.collapsed[form.value][id];
	return saved ?? form.value === "phone";
}

/* ---------- Changes ---------- */

/** Screen-reader announcement after a keyboard move or a hide. */
export const announcement = signal("");

export function setCollapsed(id: PanelId, collapsed: boolean): void {
	const l = layout.value;
	save({
		...l,
		collapsed: { ...l.collapsed, [form.value]: { ...l.collapsed[form.value], [id]: collapsed } },
	});
}

/**
 * Moves a panel one place up (-1) or down (+1) among the visible panels it shares a list with: its column on a
 * wide or mid screen, the single list on a phone or narrow screen. Returns false at either end.
 */
export function movePanel(id: PanelId, by: -1 | 1): boolean {
	const l = layout.value;
	const sameList = (other: PanelId) =>
		!l.hidden.includes(other) &&
		(viewport.value === "phone" || viewport.value === "narrow" || l.column[other] === l.column[id]);
	const peers = l.order.filter(sameList);
	const at = peers.indexOf(id);
	const target = peers[at + by];
	if (at < 0 || !target) return false;
	const order = [...l.order];
	const i = order.indexOf(id);
	const j = order.indexOf(target);
	order[i] = target;
	order[j] = id;
	save({ ...l, order });
	return true;
}

export function positionOf(id: PanelId): { at: number; of: number } {
	const l = layout.value;
	const peers = visibleOrder.value.filter(
		(other) => viewport.value === "phone" || viewport.value === "narrow" || l.column[other] === l.column[id],
	);
	return { at: peers.indexOf(id) + 1, of: peers.length };
}

export function moveToColumn(id: PanelId, column: Column): void {
	const l = layout.value;
	save({ ...l, column: { ...l.column, [id]: column } });
}

export function hidePanel(id: PanelId): void {
	const l = layout.value;
	if (!l.hidden.includes(id)) save({ ...l, hidden: [...l.hidden, id] });
}

export function showPanel(id: PanelId): void {
	const l = layout.value;
	save({ ...l, hidden: l.hidden.filter((h) => h !== id) });
}

/** Presets from the first-run sheet: the panels to keep visible (all others hidden, restorable). */
export function applyPreset(visible: readonly PanelId[] | "all"): void {
	const l = layout.value;
	save({ ...l, hidden: visible === "all" ? [] : PANEL_IDS.filter((id) => !visible.includes(id)) });
}

/** Replaces the whole layout (a saved view or a preset), repaired exactly like a stored one. */
export function replaceLayout(raw: unknown): void {
	save(repair(raw));
}

export function resetLayout(): void {
	save(fresh());
}

export const layoutIsDefault = computed(() => JSON.stringify(layout.value) === JSON.stringify(fresh()));

/**
 * Opens a panel for the reader: shows it if hidden, expands it if collapsed, scrolls it into view. Used by the
 * phone tab bar, the "Más" sheet and every in-page link to a panel (#dinero, #sismos…).
 */
export function reveal(id: PanelId, focus = false): void {
	const l = layout.value;
	if (l.hidden.includes(id)) showPanel(id);
	if (isCollapsed(id)) {
		if (density.value === "pared" && viewport.value !== "phone") wallFocus.value = id;
		else setCollapsed(id, false);
	}
	requestAnimationFrame(() => {
		const el = document.getElementById(id);
		if (!el) return;
		const still =
			matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.motion;
		el.scrollIntoView({ block: "start", behavior: still ? "auto" : "smooth" });
		if (focus) document.getElementById(`${id}-toggle`)?.focus({ preventScroll: true });
	});
}

// In-page links to a panel (the Ahora sentence, the vital-sign tiles) also open it when it is collapsed or hidden.
document.addEventListener("click", (e) => {
	if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
	const a = (e.target as Element | null)?.closest?.("a[href^='#']");
	const id = a?.getAttribute("href")?.slice(1) ?? "";
	if (!isPanelId(id)) return;
	e.preventDefault();
	reveal(id);
});

/* ---------- First run ---------- */

/**
 * The preset sheet appears once, on a first visit to the wall. Never for someone arriving by a shared link (any
 * query string or hash), never in automated browsers; ?bienvenida=1 shows it on purpose.
 */
export function shouldOnboard(): boolean {
	try {
		const params = new URLSearchParams(location.search);
		if (params.get("bienvenida") === "1") return true;
		if (location.search || location.hash || navigator.webdriver) return false;
		return localStorage.getItem(ONBOARDED) === null && localStorage.getItem(KEY) === null;
	} catch {
		return false;
	}
}

export function markOnboarded(): void {
	try {
		localStorage.setItem(ONBOARDED, "1");
	} catch {
		// ignore
	}
}
