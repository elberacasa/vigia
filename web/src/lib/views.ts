import { type Layout, PANEL_IDS, type PanelId, repair } from "./layout.ts";
import { type PanelPrefs, repairPanelPrefs } from "./panelprefs.ts";
import type { Density } from "./prefs.ts";

/**
 * Saved views ("Vistas"): a name for a whole arrangement of the wall (which panels, their order and columns,
 * which are collapsed), the map (layer, quake and heat-spot points, selected state), the density, and the
 * per-panel settings. Kept per device (localStorage, vigia:views:v1), exported and imported as a small JSON file
 * that is validated like any untrusted input. Built-in presets are views written in code.
 *
 * This module is pure (no DOM, no storage): the sheet (ui/custom/Views.tsx) stores and applies.
 */

export const VIEW_LIMIT = 20;
export const VIEWS_FILE_FORMAT = "vigia-vistas";
const MAX_FILE_BYTES = 200_000;

export const MAP_SHADINGS = [
	"connectivity",
	"nightlights",
	"satellite",
	"reports",
	"fires",
	"aiBlackouts",
] as const;
export type ViewShading = (typeof MAP_SHADINGS)[number];
const DENSITIES: readonly Density[] = ["comodo", "compacto", "pared"];

export interface ViewMap {
	layer: ViewShading;
	quakes: boolean;
	fires: boolean;
	/** ISO 3166-2 of the selected state, or null for the whole country. */
	state: string | null;
}

export interface SavedView {
	id: string;
	name: string;
	savedAt: number;
	layout: Layout;
	map: ViewMap;
	density: Density;
	/** Per-panel settings saved with the view; null leaves the reader's current ones untouched. */
	panelPrefs: PanelPrefs | null;
}

export interface Preset {
	id: string;
	name: { es: string; en: string };
	blurb: { es: string; en: string };
	/** Panels shown, in this order; the rest are hidden (one tap brings each back). */
	panels: readonly PanelId[] | "all";
	map: Omit<ViewMap, "state">;
	/** Density the preset switches to; null keeps the reader's. */
	density: Density | null;
}

export const PRESETS: readonly Preset[] = [
	{
		id: "periodista",
		name: { es: "Periodista", en: "Journalist" },
		blurb: {
			es: "Incidentes con su evidencia, noticias, la Gaceta, censura, internet y TV en vivo; el mapa por titulares.",
			en: "Incidents with evidence, news, the Gazette, censorship, internet and live TV; the map by headlines.",
		},
		panels: ["incidentes", "noticias", "gaceta", "censura", "conectividad", "red", "atencion", "tv"],
		map: { layer: "reports", quakes: true, fires: false },
		density: null,
	},
	{
		id: "economia",
		name: { es: "Economía", en: "Economy" },
		blurb: {
			es: "Dólar, bolsillo, servicios, petróleo, mercados, energía, Gaceta y noticias.",
			en: "Dollar, pocket, services, oil, markets, energy, Gazette and news.",
		},
		panels: ["dinero", "bolsillo", "servicios", "petroleo", "mercados", "energia", "gaceta", "noticias"],
		map: { layer: "connectivity", quakes: false, fires: false },
		density: null,
	},
	{
		id: "conectividad",
		name: { es: "Conectividad", en: "Connectivity" },
		blurb: {
			es: "Caídas de internet por estado, censura, la red, luces nocturnas y servicios.",
			en: "Internet drops by state, censorship, the network, night lights and services.",
		},
		panels: ["conectividad", "censura", "red", "incidentes", "luces", "servicios", "energia"],
		map: { layer: "connectivity", quakes: false, fires: false },
		density: null,
	},
	{
		id: "emergencias",
		name: { es: "Emergencias", en: "Emergencies" },
		blurb: {
			es: "Incidentes, sismos, alertas, clima, incendios, servicios, ayuda humanitaria, conexión y noticias.",
			en: "Incidents, earthquakes, alerts, weather, fires, services, aid, connectivity and news.",
		},
		panels: [
			"incidentes",
			"sismos",
			"alertas",
			"clima",
			"incendios",
			"servicios",
			"humanitario",
			"conectividad",
			"noticias",
		],
		map: { layer: "connectivity", quakes: true, fires: true },
		density: null,
	},
	{
		id: "pared",
		name: { es: "Pantalla de pared", en: "Wall screen" },
		blurb: {
			es: "Todo, con letra grande; abre solo los paneles fuera de lo normal, uno a la vez.",
			en: "Everything, in large type; opens only the panels out of the ordinary, one at a time.",
		},
		panels: "all",
		map: { layer: "connectivity", quakes: true, fires: false },
		density: "pared",
	},
	{
		id: "todo",
		name: { es: "Todo", en: "Everything" },
		blurb: {
			es: "Cada panel, en el orden de Vigía.",
			en: "Every panel, in Vigía's order.",
		},
		panels: "all",
		map: { layer: "connectivity", quakes: true, fires: false },
		density: "comodo",
	},
];

/** The layout a preset asks for, keeping the reader's collapsed rows and columns. */
export function presetLayout(preset: Preset, current: Layout): Layout {
	const shown = preset.panels === "all" ? [...PANEL_IDS] : [...preset.panels];
	const rest = PANEL_IDS.filter((id) => !shown.includes(id));
	return repair({
		...current,
		order: preset.panels === "all" ? [...PANEL_IDS] : [...shown, ...rest],
		hidden: rest,
		column: preset.panels === "all" ? undefined : current.column,
	});
}

/* ---------- Validation ---------- */

const ISO = /^VE-[A-Z]$/;

function cleanName(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const name = raw
		.split("")
		.map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c))
		.join("")
		.trim()
		.slice(0, 60);
	return name || null;
}

function cleanMap(raw: unknown): ViewMap {
	const m = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const layer = (MAP_SHADINGS as readonly unknown[]).includes(m.layer)
		? (m.layer as ViewShading)
		: "connectivity";
	return {
		layer,
		quakes: typeof m.quakes === "boolean" ? m.quakes : true,
		fires: typeof m.fires === "boolean" ? m.fires : false,
		state: typeof m.state === "string" && ISO.test(m.state) ? m.state : null,
	};
}

/** One view from untrusted JSON (storage or an imported file), repaired; null when it has no usable name. */
export function repairView(raw: unknown, now: number): SavedView | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const name = cleanName(r.name);
	if (!name) return null;
	const id = typeof r.id === "string" && /^v-[0-9a-z]{4,24}$/.test(r.id) ? r.id : newViewId();
	const savedAt =
		typeof r.savedAt === "number" && Number.isFinite(r.savedAt) && r.savedAt > 0 ? r.savedAt : now;
	return {
		id,
		name,
		savedAt: Math.min(savedAt, now),
		layout: repair(r.layout),
		map: cleanMap(r.map),
		density: DENSITIES.includes(r.density as Density) ? (r.density as Density) : "comodo",
		panelPrefs: r.panelPrefs && typeof r.panelPrefs === "object" ? repairPanelPrefs(r.panelPrefs) : null,
	};
}

export function repairViews(raw: unknown, now: number): SavedView[] {
	if (!Array.isArray(raw)) return [];
	const out: SavedView[] = [];
	const ids = new Set<string>();
	for (const item of raw) {
		const v = repairView(item, now);
		if (!v) continue;
		if (ids.has(v.id)) v.id = newViewId();
		ids.add(v.id);
		out.push(v);
		if (out.length >= VIEW_LIMIT) break;
	}
	return out;
}

export function newViewId(): string {
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	return `v-${[...bytes]
		.map((b) => b.toString(36).padStart(2, "0"))
		.join("")
		.slice(0, 12)}`;
}

/* ---------- File ---------- */

export function exportViewsFile(views: readonly SavedView[], now: number): string {
	return `${JSON.stringify(
		{ format: VIEWS_FILE_FORMAT, v: 1, exportedAt: new Date(now).toISOString(), views },
		null,
		2,
	)}\n`;
}

export type ImportResult =
	| { ok: true; views: SavedView[]; skipped: number }
	| { ok: false; reason: { es: string; en: string } };

/** Reads an exported file. Accepts the full file or a bare array of views; never trusts a field. */
export function parseViewsFile(text: string, now: number): ImportResult {
	if (text.length > MAX_FILE_BYTES)
		return { ok: false, reason: { es: "El archivo es demasiado grande.", en: "The file is too large." } };
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return { ok: false, reason: { es: "No es un archivo JSON válido.", en: "Not a valid JSON file." } };
	}
	const list = Array.isArray(data)
		? data
		: data && typeof data === "object" && (data as { format?: unknown }).format === VIEWS_FILE_FORMAT
			? (data as { views?: unknown }).views
			: null;
	if (!Array.isArray(list))
		return {
			ok: false,
			reason: { es: "No es un archivo de vistas de Vigía.", en: "Not a Vigía views file." },
		};
	const views = repairViews(list, now);
	if (!views.length)
		return {
			ok: false,
			reason: { es: "El archivo no trae ninguna vista válida.", en: "The file has no valid view." },
		};
	return { ok: true, views, skipped: Math.max(0, list.length - views.length) };
}

/** Merges imported views into the saved ones: same name replaces, new names are added, up to the limit. */
export function mergeViews(saved: readonly SavedView[], incoming: readonly SavedView[]): SavedView[] {
	const out = [...saved];
	for (const v of incoming) {
		const at = out.findIndex((s) => s.name.toLowerCase() === v.name.toLowerCase());
		const copy = {
			...v,
			id: at >= 0 ? (out[at] as SavedView).id : out.some((s) => s.id === v.id) ? newViewId() : v.id,
		};
		if (at >= 0) out[at] = copy;
		else if (out.length < VIEW_LIMIT) out.push(copy);
	}
	return out;
}
