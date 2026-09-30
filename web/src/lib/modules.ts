import type { PanelId } from "./layout.ts";

/**
 * The workstation's modules: each is one workspace of the room, reached from the rail, the command palette, its own
 * address (/dinero, /internet…) or its number key. A module is only an arrangement of panels that already exist
 * (every panel keeps its own sources, ages and rules); `columns` is the order on a desk, one list per column.
 * Situación is the map with its layer stack, and is the only module without panel columns.
 */
export type ModuleId =
	| "situacion"
	| "dinero"
	| "mercados"
	| "internet"
	| "energia"
	| "tierra"
	| "noticias"
	| "oficial"
	| "humanitario"
	| "envivo";

export interface ModuleDef {
	id: ModuleId;
	/** Address; the query string (the selected place, the layer…) is carried across modules. */
	path: string;
	/** Number key on a desk (1–9, 0). */
	key: string;
	es: string;
	en: string;
	/** The one-line question the module answers. */
	qEs: string;
	qEn: string;
	columns: readonly (readonly PanelId[])[];
	/** Relative column widths on a desk (equal when absent). */
	widths?: readonly number[];
	/** 20×20 stroke icon (a path, drawn with currentColor). */
	icon: string;
}

export const MODULES: readonly ModuleDef[] = [
	{
		id: "situacion",
		path: "/",
		key: "1",
		es: "Situación",
		en: "Situation",
		qEs: "¿Qué pasa en cada estado ahora?",
		qEn: "What is happening in each state now?",
		columns: [],
		icon: "M10 2.5v3M10 14.5v3M2.5 10h3M14.5 10h3M10 6.2a3.8 3.8 0 1 0 0 7.6a3.8 3.8 0 0 0 0-7.6Z",
	},
	{
		id: "dinero",
		path: "/dinero",
		key: "2",
		es: "Dinero",
		en: "Money",
		qEs: "¿A cuánto está el dólar y cuánto vale el sueldo?",
		qEn: "What is the dollar at, and what is a wage worth?",
		columns: [["dinero"], ["bolsillo"], ["monetario"]],
		icon: "M10 2.5v15M13.6 5.6c-.7-1-2-1.6-3.6-1.6-2.1 0-3.6 1.1-3.6 2.8 0 4 7.4 2.1 7.4 6.3 0 1.8-1.6 2.9-3.8 2.9-1.7 0-3.1-.7-3.9-1.8",
	},
	{
		id: "mercados",
		path: "/mercados",
		key: "3",
		es: "Mercados",
		en: "Markets",
		qEs: "Precios del mundo que mueven la economía, y buques en puerto",
		qEn: "World prices that move the economy, and ships in port",
		columns: [["mercados"], ["petroleo"]],
		icon: "M3 16.5h14M4.5 13l3.5-4 3 2.5 4.5-6M12.5 5.5h3v3",
	},
	{
		id: "internet",
		path: "/internet",
		key: "4",
		es: "Internet",
		en: "Internet",
		qEs: "¿Hay caídas de conexión o bloqueos?",
		qEn: "Are there connection drops or blocks?",
		columns: [["conectividad"], ["censura", "red", "cloudflare"]],
		icon: "M10 17.5a7.5 7.5 0 1 0 0-15a7.5 7.5 0 0 0 0 15ZM2.5 10h15M10 2.5c2 2.1 3 4.6 3 7.5s-1 5.4-3 7.5c-2-2.1-3-4.6-3-7.5s1-5.4 3-7.5Z",
	},
	{
		id: "energia",
		path: "/energia",
		key: "5",
		es: "Energía",
		en: "Energy",
		qEs: "Luz, agua, gas, gasolina y petróleo desde el espacio",
		qEn: "Power, water, gas, fuel, and oil from space",
		columns: [
			["servicios", "reportes", "luces"],
			["energia", "metano", "buques"],
		],
		icon: "M11 2.5 4.5 11.5h5l-1 6 6.5-9h-5l1-6Z",
	},
	{
		id: "tierra",
		path: "/tierra",
		key: "6",
		es: "Tierra y clima",
		en: "Earth and weather",
		qEs: "Sismos, tormentas, incendios y alertas",
		qEn: "Quakes, storms, fires and alerts",
		columns: [
			["sismos", "alertas"],
			["clima", "rayos", "incendios"],
			["satelite", "inundaciones", "bosque"],
		],
		icon: "M2.5 14.5h3l2-6 3 9 2.5-12 2 9h2.5",
	},
	{
		id: "noticias",
		path: "/noticias",
		key: "7",
		es: "Noticias",
		en: "News",
		qEs: "¿Qué están contando los medios?",
		qEn: "What are the outlets reporting?",
		columns: [["noticias"], ["desmentidos"], ["gdelt", "atencion"]],
		icon: "M4 3.5h9.5L16 6v10.5H4Zm3 5h6M7 11.5h6M7 14h4",
	},
	{
		id: "oficial",
		path: "/oficial",
		key: "8",
		es: "Oficial",
		en: "Official",
		qEs: "La Gaceta, las sanciones, quién ocupa cada cargo y lo que apuestan los mercados",
		qEn: "The Gazette, sanctions, who holds each office, and what the markets trade",
		columns: [["gaceta", "espacio-aereo", "vuelos"], ["sanciones"], ["cargos", "apuestas"]],
		icon: "M3 7.5 10 3l7 4.5M4.5 8v7M8.2 8v7M11.8 8v7M15.5 8v7M3 17h14",
	},
	{
		id: "humanitario",
		path: "/humanitario",
		key: "9",
		es: "Humanitario",
		en: "Humanitarian",
		qEs: "Salud, migración y ayuda",
		qEn: "Health, migration and aid",
		columns: [["humanitario"]],
		icon: "M8 3.5h4v4.5h4.5v4H12v4.5H8V12H3.5V8H8Z",
	},
	{
		id: "envivo",
		path: "/en-vivo",
		key: "0",
		es: "En vivo",
		en: "Live",
		qEs: "¿Qué canales, emisoras y cámaras públicas transmiten ahora?",
		qEn: "Which channels, stations and public cameras are on air now?",
		columns: [["tv"], ["camaras", "radio"]],
		widths: [2, 1],
		icon: "M2.5 5.5h15v10h-15ZM7 2.5l3 3 3-3M8.5 8.5v4l3.5-2Z",
	},
];

export const MODULE_BY_ID = new Map(MODULES.map((m) => [m.id, m]));

export function moduleByPath(path: string): ModuleDef | undefined {
	const clean = path.replace(/\/+$/, "") || "/";
	return MODULES.find((m) => m.path === clean);
}

/** The module whose workspace holds a panel (Incidentes lives in Situación's inspector). */
export function moduleOfPanel(id: PanelId): ModuleDef {
	return MODULES.find((m) => m.columns.some((c) => c.includes(id))) ?? (MODULES[0] as ModuleDef);
}

export function moduleName(m: ModuleDef, lang: "es" | "en"): string {
	return lang === "es" ? m.es : m.en;
}
