import infrastructureJson from "./data/infrastructure.json" with { type: "json" };
import type { Dataset, DatasetId } from "./types.ts";

/**
 * Where the entities themselves come from: every entity names one of these, so its licence and attribution travel
 * with it through the API. (The observations attached to an entity keep their own sources and licences.)
 */

const retrieved = (infrastructureJson as unknown as { meta: { retrieved: Record<string, string> } }).meta
	.retrieved;

const VIGIA_LICENCE = {
	id: "polyform-nc-1.0.0",
	name: "PolyForm Noncommercial 1.0.0 (lista de Vigía)",
	url: "https://polyformproject.org/licenses/noncommercial/1.0.0/",
} as const;

export const DATASETS: Readonly<Record<DatasetId, Dataset>> = {
	"cod-ab-ven": {
		id: "cod-ab-ven",
		name: "Límites administrativos de Venezuela (OCHA COD-AB v01): estados, municipios y parroquias",
		url: "https://data.humdata.org/dataset/cod-ab-ven",
		licence: {
			id: "cc-by-igo-3.0",
			name: "CC BY-IGO 3.0",
			url: "https://creativecommons.org/licenses/by/3.0/igo/legalcode",
		},
		attribution:
			"Límites administrativos: Instituto Nacional de Estadística (INE) Venezuela, vía OCHA Venezuela / OCHA FIS, HDX (CC BY-IGO 3.0)",
		retrieved: "2026-09-24",
		note: "Códigos P estables (VE15, VE1501, VE150101). Dependencias Federales no tiene municipios ni parroquias reales.",
	},
	osm: {
		id: "osm",
		name: "OpenStreetMap (vía Overpass API): plantas, subestaciones, red de transmisión, refinerías, represas, embalses y hospitales",
		url: "https://www.openstreetmap.org/copyright",
		licence: { id: "odbl-1.0", name: "ODbL 1.0", url: "https://opendatacommons.org/licenses/odbl/1-0/" },
		attribution: "© Colaboradores de OpenStreetMap (ODbL 1.0)",
		retrieved: retrieved.osm ?? "unknown",
		note: "Base de datos derivada bajo la misma licencia (ODbL, compartir igual): los archivos de src/ontology/data que vienen de OSM se pueden reutilizar bajo ODbL. El mapeo de Venezuela en OSM es incompleto.",
	},
	ourairports: {
		id: "ourairports",
		name: "OurAirports: aeropuertos de Venezuela",
		url: "https://ourairports.com/data/",
		licence: { id: "public-domain", name: "Dominio público", url: "https://ourairports.com/data/" },
		attribution: "OurAirports (dominio público)",
		retrieved: retrieved.ourairports ?? "unknown",
		note: 'Aeropuertos grandes y medianos, y pequeños con código IATA o vuelos regulares. Nombres en español por regla ("X International Airport" → "Aeropuerto Internacional X").',
	},
	"imf-portwatch-ports": {
		id: "imf-portwatch-ports",
		name: "IMF PortWatch: puertos y terminales de Venezuela",
		url: "https://portwatch.imf.org/",
		licence: {
			id: "imf-portwatch-terms",
			name: "Términos del FMI (reutilización con atribución)",
			url: "https://www.imf.org/en/about/copyright-and-terms",
		},
		attribution:
			"Fuente: Fondo Monetario Internacional, PortWatch (nombres en español y tipo puerto/terminal por Vigía)",
		retrieved: retrieved.portwatch ?? "unknown",
		note: "Los mismos 18 puertos y terminales del feed imf-portwatch.",
	},
	"flare-facilities": {
		id: "flare-facilities",
		name: "Instalaciones de petróleo y gas del panel de quema (Vigía, de GFMR y OSM)",
		url: "https://www.worldbank.org/en/programs/gasflaringreduction/global-flaring-data",
		licence: {
			id: "cc-by-4.0+odbl-1.0",
			name: "CC BY 4.0 (sitios de quema del Banco Mundial GFMR) y ODbL 1.0 (contornos de OSM)",
			url: "https://opendatacommons.org/licenses/odbl/1-0/",
		},
		attribution:
			"Banco Mundial, Global Flaring and Methane Reduction Partnership (CC BY 4.0); © colaboradores de OpenStreetMap (ODbL)",
		retrieved: "2026-09-24",
		note: "Construida por src/adapters/firms-flares/build-facilities.ts: campos agrupados por Vigía.",
	},
	"vigia-isps": {
		id: "vigia-isps",
		name: "Proveedores de internet y sus sistemas autónomos (tabla de Vigía)",
		url: "https://ioda.inetintel.cc.gatech.edu/country/VE",
		licence: VIGIA_LICENCE,
		attribution: "Tabla de Vigía; titulares de cada ASN según IODA y RIPE (verificado 2026-09-24)",
		retrieved: "2026-09-24",
		note: null,
	},
	"vigia-outlets": {
		id: "vigia-outlets",
		name: "Medios y canales que Vigía lee (lista de Vigía)",
		url: "https://github.com/elberacasa/vigia/blob/main/src/adapters/rss/outlets.ts",
		licence: VIGIA_LICENCE,
		attribution: "Lista de medios de Vigía (feeds verificados 2026-09-24/25)",
		retrieved: "2026-09-25",
		note: "La postura de cada medio es una palabra descriptiva de Vigía, mostrada para que el lector la sopese.",
	},
	"vigia-institutions": {
		id: "vigia-institutions",
		name: "Instituciones públicas (lista de Vigía; nombres de órganos según el índice de la Gaceta Oficial)",
		url: "http://www.gacetaoficial.gob.ve",
		licence: VIGIA_LICENCE,
		attribution:
			"Lista de Vigía; nombres de órganos tal como los imprime el índice de la Gaceta Oficial (2026-09-28)",
		retrieved: "2026-09-28",
		note: null,
	},
	"vigia-cameras": {
		id: "vigia-cameras",
		name: "Cámaras públicas publicadas por su operador (censo de Vigía, verificado en vivo)",
		url: "https://github.com/elberacasa",
		licence: VIGIA_LICENCE,
		attribution: "Censo de cámaras de Vigía; cada imagen es de su operador",
		retrieved: "2026-09-29",
		note: "Solo cámaras que su operador publica para el público. Posición y dirección según el operador o los puntos de referencia visibles; cada ficha dice cómo.",
	},
};
