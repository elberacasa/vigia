import { selectedState } from "../map/view.ts";
import type { ConnectivityView } from "../panels/Connectivity.tsx";
import type { NewsView } from "../panels/News.tsx";
import type { QuakesView } from "../panels/Quakes.tsx";
import { panels } from "./data.ts";
import { t } from "./i18n.ts";
import type { PanelId } from "./layout.ts";
import { stateName } from "./states.ts";

/**
 * What a wall panel's frame shows before its body has loaded: the title, the question and the feeds behind its
 * freshness badge. The panels themselves read the same entries, so the frame never changes when the body arrives
 * (each panel's body is its own chunk; see ui/LazyPanel.tsx). `fresh` is the panel's "nuevo" scope: the frame
 * keeps observing arrivals while the body is not loaded (a collapsed row on a phone), so its pill and the tab
 * bar's badge stay true.
 */
export interface PanelMeta {
	title: () => string;
	question: () => string;
	/** The feeds behind the freshness badge (Internet and Incidents name theirs in their view). */
	feeds: () => readonly string[];
	fresh?: { scope: string; ids: () => string[] };
}

const NETWATCH_FEEDS = ["ooni-methods", "tor-metrics", "ripestat-prefixes", "portal-probe"] as const;

export const PANEL_META: Record<PanelId, PanelMeta> = {
	incidentes: {
		title: () => t("Incidentes", "Incidents"),
		question: () => t("¿Qué señales coinciden?", "Which signals agree?"),
		feeds: () => (panels.value.incidents as { feeds?: string[] } | undefined)?.feeds ?? ["ioda-states"],
	},
	dinero: {
		title: () => t("Dólar", "Dollar"),
		question: () => t("¿A cuánto está hoy?", "What is it at today?"),
		feeds: () => ["bcv-official", "bcv-api", "yadio", "bcv-history"],
	},
	bolsillo: {
		title: () => t("Bolsillo", "Pocket"),
		question: () =>
			t("¿Cuánto es en dólares? ¿Cuánto vale el sueldo?", "How much in dollars? What is a wage worth?"),
		feeds: () => ["bcv-official", "bcv-api", "yadio", "bcv-history"],
	},
	servicios: {
		title: () => t("Servicios", "Services"),
		question: () => t("¿Luz, agua, gas y gasolina?", "Power, water, gas and fuel?"),
		// Guri, plus the two fast signals of a power cut the panel links to (night lights, internet by state).
		feeds: () => ["dahiti-guri", "gibs-nightlights", "ioda-states"],
	},
	gaceta: {
		title: () => t("Gaceta Oficial", "Official Gazette"),
		question: () => t("¿Qué salió en la Gaceta?", "What is new in the Gazette?"),
		feeds: () => ["gaceta-oficial"],
	},
	conectividad: {
		title: () => t("Internet", "Internet"),
		question: () => t("¿Hay caídas de conexión por estado?", "Are there connection drops by state?"),
		feeds: () => (panels.value.connectivity as ConnectivityView | undefined)?.feeds ?? ["ioda-states"],
		fresh: {
			scope: "outages",
			ids: () => ((panels.value.connectivity as ConnectivityView | undefined)?.events ?? []).map((e) => e.id),
		},
	},
	noticias: {
		title: () => t("Noticias", "News"),
		question: () => {
			const state = selectedState.value;
			return state
				? t(`¿Qué pasa en ${stateName(state)}?`, `What is happening in ${stateName(state)}?`)
				: t("¿Qué está pasando?", "What is happening?");
		},
		feeds: () => [],
		fresh: {
			scope: "news",
			ids: () => {
				const view = panels.value.news as NewsView | undefined;
				return view ? Object.keys(view.stories) : [];
			},
		},
	},
	sismos: {
		title: () => t("Sismos", "Earthquakes"),
		question: () => t("¿Tembló?", "Was there a quake?"),
		feeds: () => ["usgs-quakes", "funvisis-quakes"],
		fresh: {
			scope: "quakes",
			ids: () => ((panels.value.quakes as QuakesView | undefined)?.items ?? []).map((q) => q.id),
		},
	},
	clima: {
		title: () => t("Clima", "Weather"),
		question: () => t("¿Llueve? ¿Tormentas?", "Rain? Storms?"),
		feeds: () => ["open-meteo-weather"],
	},
	luces: {
		title: () => t("Luces nocturnas", "Night lights"),
		question: () => t("¿Hay menos luz de noche?", "Is there less light at night?"),
		feeds: () => ["gibs-nightlights"],
	},
	incendios: {
		title: () => t("Incendios", "Fires"),
		question: () => t("Focos de calor por satélite", "Satellite heat detections"),
		feeds: () => ["firms-fires"],
	},
	alertas: {
		title: () => t("Alertas", "Alerts"),
		question: () => t("Ciclones y desastres", "Cyclones and disasters"),
		feeds: () => ["nhc-storms", "gdacs-events"],
	},
	satelite: {
		title: () => t("Satélite", "Satellite"),
		question: () => t("Nubes y tormentas, cada 10 min", "Clouds and storms, every 10 min"),
		feeds: () => ["goes-nsa"],
	},
	petroleo: {
		title: () => t("Petróleo", "Oil"),
		question: () => t("Brent y WTI", "Brent and WTI"),
		feeds: () => ["fred-oil"],
	},
	mercados: {
		title: () => t("Mercados y carga", "Markets and cargo"),
		question: () =>
			t(
				"Precios del mundo que mueven la economía venezolana, y buques en sus puertos",
				"World prices that move Venezuela's economy, and ships at its ports",
			),
		feeds: () => [
			"fred-oil",
			"fred-markets",
			"trm-colombia",
			"bcb-ptax",
			"wb-pinksheet",
			"fao-ffpi",
			"imf-portwatch",
		],
	},
	censura: {
		title: () => t("Censura", "Censorship"),
		question: () => t("¿Qué está bloqueado?", "What is blocked?"),
		feeds: () => ["ooni-ve", "vesinfiltro-blocks"],
	},
	red: {
		title: () => t("Red", "Network"),
		question: () => t("Rutas, bloqueos y evasión", "Routes, blocks and circumvention"),
		feeds: () => NETWATCH_FEEDS,
	},
	energia: {
		title: () => t("Petróleo y energía desde el espacio", "Oil and energy from space"),
		question: () =>
			t(
				"Llamas de gas en refinerías y campos, noche a noche",
				"Gas flares at refineries and fields, night by night",
			),
		feeds: () => ["firms-flares", "firms-fires"],
	},
	"espacio-aereo": {
		title: () => t("Espacio aéreo", "Airspace"),
		question: () =>
			t("Avisos oficiales para volar sobre Venezuela", "Official notices on flying over Venezuela"),
		feeds: () => ["easa-czib", "faa-prohibitions"],
	},
	atencion: {
		title: () => t("Atención internacional", "International attention"),
		question: () =>
			t(
				"¿Qué lee el mundo sobre Venezuela? (Wikipedia)",
				"What is the world reading about Venezuela? (Wikipedia)",
			),
		feeds: () => ["wiki-attention"],
	},
	tv: {
		title: () => t("En vivo: TV y radio", "Live: TV and radio"),
		question: () => t("¿Qué canales transmiten ahora?", "Which channels are on air now?"),
		// Radio first: it is on by default, so the age badge speaks for a feed that runs.
		feeds: () => ["radio-streams", "youtube-live"],
	},
	humanitario: {
		title: () => t("Salud, migración y ayuda", "Health, migration and aid"),
		question: () =>
			t(
				"¿Qué enfermedades suben, cuántos se han ido y cuánta ayuda llega?",
				"Which diseases are rising, how many have left, and how much aid arrives?",
			),
		feeds: () => ["mpps-boletin", "who-gho", "r4v-figures", "unhcr-population", "ocha-fts", "reliefweb-ve"],
	},
};
