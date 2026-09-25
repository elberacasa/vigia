/** Names for the atlas ids served by /api/meta (src/sources/atlas.ts). Unknown ids fall back to the id itself. */
import type { Lang } from "../../lib/format.ts";
import { stateName } from "../../lib/states.ts";
import type { Bucket } from "./model.ts";

type L = { readonly es: string; readonly en: string };

const CATEGORY: Readonly<Record<string, L>> = {
	news: { es: "Noticias", en: "News" },
	money: { es: "Dinero", en: "Money" },
	markets: { es: "Mercados", en: "Markets" },
	energy: { es: "Energía", en: "Energy" },
	internet: { es: "Internet", en: "Internet" },
	censorship: { es: "Censura", en: "Censorship" },
	earth: { es: "Tierra y clima", en: "Earth and weather" },
	space: { es: "Espacio", en: "Space" },
	airspace: { es: "Espacio aéreo", en: "Airspace" },
	attention: { es: "Atención", en: "Attention" },
	social: { es: "Redes", en: "Social" },
	society: { es: "Sociedad", en: "Society" },
	oil: { es: "Petróleo", en: "Oil" },
};

const CATEGORY_NOTE: Readonly<Record<string, L>> = {
	news: {
		es: "Medios nacionales, regionales e internacionales",
		en: "National, regional and international outlets",
	},
	money: { es: "Tasas oficial y paralela, inflación", en: "Official and parallel rates, inflation" },
	markets: { es: "Precios de mercado y cotizaciones", en: "Market prices and quotes" },
	energy: { es: "Petróleo, mechurrios, luz", en: "Oil, gas flares, power" },
	internet: { es: "Caídas, rutas, sondas", en: "Outages, routing, probes" },
	censorship: { es: "Bloqueos y métodos de censura", en: "Blocking and censorship methods" },
	earth: { es: "Sismos, incendios, lluvia, tormentas", en: "Quakes, fires, rain, storms" },
	space: { es: "Imágenes y detecciones de satélite", en: "Satellite imagery and detections" },
	airspace: { es: "Avisos y prohibiciones de vuelo", en: "Flight warnings and bans" },
	attention: { es: "Qué busca la gente", en: "What people look up" },
	society: {
		es: "Salud, migración, ayuda humanitaria, seguridad",
		en: "Health, migration, humanitarian aid, security",
	},
};

const KIND: Readonly<Record<string, L>> = {
	api: { es: "API de datos", en: "Data API" },
	web: { es: "Publicación oficial", en: "Official publication" },
	feed: { es: "RSS de un medio", en: "Outlet feed" },
	video: { es: "Canal de video", en: "Video channel" },
	satellite: { es: "Satélite", en: "Satellite" },
	sensor: { es: "Red de sensores", en: "Sensor network" },
	network: { es: "Medición de red", en: "Network measurement" },
};

const PANEL: Readonly<Record<string, L>> = {
	money: { es: "Dinero", en: "Money" },
	oil: { es: "Petróleo", en: "Oil" },
	energy: { es: "Energía", en: "Energy" },
	airspace: { es: "Espacio aéreo", en: "Airspace" },
	attention: { es: "Atención", en: "Attention" },
	connectivity: { es: "Conectividad", en: "Connectivity" },
	nightlights: { es: "Luces nocturnas", en: "Night lights" },
	censorship: { es: "Censura", en: "Censorship" },
	netwatch: { es: "Red", en: "Network" },
	quakes: { es: "Sismos", en: "Earthquakes" },
	weather: { es: "Clima", en: "Weather" },
	fires: { es: "Incendios", en: "Fires" },
	hazards: { es: "Amenazas", en: "Hazards" },
	satellite: { es: "Satélite", en: "Satellite" },
	news: { es: "Noticias", en: "News" },
	brief: { es: "Resumen", en: "Brief" },
	incidents: { es: "Incidentes", en: "Incidents" },
	ai: { es: "Capa IA", en: "AI layer" },
	humanitarian: { es: "Salud, migración y ayuda", en: "Health, migration and aid" },
};

const BUCKET: Readonly<Record<Bucket, L>> = {
	live: { es: "En vivo", en: "Live" },
	stale: { es: "Con retraso", en: "Delayed" },
	failing: { es: "Fallando", en: "Failing" },
	locked: { es: "Necesita clave", en: "Needs a key" },
	off: { es: "Apagada", en: "Off" },
	pending: { es: "Sin consultar", en: "Not fetched yet" },
};

const STANCE: Readonly<Record<string, L>> = {
	independent: { es: "independiente", en: "independent" },
	commercial: { es: "comercial", en: "commercial" },
	state: { es: "estatal", en: "state" },
	"state-aligned": { es: "afín al Estado", en: "state-aligned" },
	"public-broadcaster": { es: "servicio público", en: "public broadcaster" },
	ngo: { es: "ONG", en: "NGO" },
	partisan: { es: "partidista", en: "partisan" },
	agency: { es: "agencia", en: "agency" },
	"state-funded": { es: "financiado por un Estado", en: "state-funded" },
	aggregator: { es: "agregador", en: "aggregator" },
	user: { es: "añadida por ti", en: "added by you" },
};

const pick = (table: Readonly<Record<string, L>>, id: string, l: Lang) => table[id]?.[l] ?? id;

export const categoryLabel = (id: string, l: Lang) => pick(CATEGORY, id, l);
export const categoryNote = (id: string, l: Lang) => CATEGORY_NOTE[id]?.[l] ?? "";
export const kindLabel = (id: string, l: Lang) => pick(KIND, id, l);
export const panelLabel = (id: string, l: Lang) => pick(PANEL, id, l);
export const bucketLabel = (b: Bucket, l: Lang) => BUCKET[b][l];
export const stanceLabel = (id: string, l: Lang) => pick(STANCE, id, l);

const displayNames = new Map<string, Intl.DisplayNames | null>();
function names(type: "region" | "language", l: Lang): Intl.DisplayNames | null {
	const key = `${type}:${l}`;
	if (!displayNames.has(key)) {
		try {
			displayNames.set(key, new Intl.DisplayNames([l === "es" ? "es" : "en"], { type }));
		} catch {
			displayNames.set(key, null);
		}
	}
	return displayNames.get(key) ?? null;
}

export function countryLabel(code: string, l: Lang): string {
	if (code === "INT") return l === "es" ? "Sin país único" : "No single country";
	try {
		return names("region", l)?.of(code) ?? code;
	} catch {
		return code;
	}
}

export function langLabel(code: string | null, l: Lang): string {
	if (!code || code === "none") return l === "es" ? "Sin texto (datos)" : "No text (data)";
	try {
		const n = names("language", l)?.of(code) ?? code;
		return n.charAt(0).toUpperCase() + n.slice(1);
	} catch {
		return code;
	}
}

export function regionLabel(region: string, l: Lang): string {
	if (region === "VE") return l === "es" ? "Nacional" : "National";
	if (region === "state") return "Regional";
	if (region === "diaspora") return l === "es" ? "Diáspora" : "Diaspora";
	if (region === "intl") return l === "es" ? "Internacional" : "International";
	return stateName(region) || region;
}
