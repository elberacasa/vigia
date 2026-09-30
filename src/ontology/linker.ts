/**
 * The linker: pure functions that attach an observation, an incident or a headline to the entities it is about.
 * Every rule is a constant here, tested (linker.test.ts), and stated in words by `linkRulesText` for the UI and the
 * API, so the published rule and the code cannot drift apart. No model: point-in-polygon, codes, a keyword
 * gazetteer and stated distances.
 *
 * What gets linked (only event-like observations: an IODA 10-minute bin or a weather slot is a series, read "now"
 * from its panel, not an event for a timeline):
 *   quakes (USGS, FUNVISIS)   the parish, municipality and state of the epicentre; facilities within
 *                             RULES.quake.km when the magnitude is at least RULES.quake.minMag
 *   fires (NASA FIRMS)        the parish, municipality and state; facilities within their kind's distance
 *   flares (NASA FIRMS)       the facility the adapter assigned; the place of the detection
 *   IODA outage events        the country, the state, or the ISP and the event's ASN
 *   GDACS events              the place of the event's point, when it is in Venezuela
 *   headlines (every outlet)  the outlet; places named with confidence ≥ RULES.textMinConfidence by the news
 *                             panel's keyword tagger; institutions and major facilities by their curated names
 *   Gaceta Oficial issues     the institutions whose organ published an act in it
 *   RIPEstat prefix changes   the ASN, when the netwatch panel's rule counts the change as an event
 *   Vigía incidents           the state
 *   users' reports (Vigía)    the municipality or state the published aggregate is about
 *   GDELT articles            the place GDELT's own geocoding gives (point in polygon, or its state code), at
 *                             confidence 0.5 ("codificación automática"); the outlet whose site published it
 *   GOES-19 GLM windows       the states with flashes; the municipality of each 0.25° cell's centre (confidence
 *                             0.5: a cell is ~28 km wide); facilities of RULES.lightning.kinds inside a cell
 *   TV and radio directories  the states the listing says a channel or station serves; the outlet whose site it is
 *   OFAC SDN changes          a Venezuelan state body designated or removed (by OFAC's own record id); the
 *                             institutions a named official's OFAC title or Wikidata office names
 *   OFAC licences and actions, Federal Register documents   institutions their titles name
 *   Wikidata offices          the institution holding the office, or the state of a governorship
 *   BCV interventions         the BCV; prediction markets: the country
 *   (the hand-checked names are in state-names.ts)
 *   methane plumes            the place of the plume; the facility the adapter assigned (Carbon Mapper)
 *   floods (NASA MODIS)       each state and municipality whose flood seen that day passes RULES.flood
 *   forest alerts (GFW)       each state and official municipality whose week passes RULES.forest
 *   radar ship counts (GFW)   the terminals and ports of the area, on days with detections
 *   Cloudflare Radar          the states an outage note names (else the country), and its networks' ASNs
 *   airline flights (adsb.lol)  the Venezuelan airports of an international flight's plausible published route
 *
 * Every measured event placed in a state (and IODA's country-level outages, and incidents) also links the country,
 * so the country has a timeline of measured events; headlines, GDELT articles and lightning windows do not (that
 * would be every headline, every article, every storm).
 */

import type { Flight } from "../adapters/adsb-flights/index.ts";
import type { MethanePlume } from "../adapters/carbon-mapper/index.ts";
import type { CloudflareRadar } from "../adapters/cloudflare-radar/index.ts";
import type { FrDocument } from "../adapters/federal-register/index.ts";
import type { FirmsValue } from "../adapters/firms-fires/index.ts";
import type { FlareValue } from "../adapters/firms-flares/index.ts";
import type { GacetaIssue } from "../adapters/gaceta-oficial/index.ts";
import type { GdacsEvent } from "../adapters/gdacs-events/index.ts";
import type { GdeltArticle } from "../adapters/gdelt-ve/index.ts";
import type { GfwAlerts } from "../adapters/gfw-alerts/index.ts";
import { AREAS as VESSEL_AREAS, type VesselDay } from "../adapters/gfw-vessels/index.ts";
import type { LightningWindow } from "../adapters/goes-glm/index.ts";
import type { IodaEvent } from "../adapters/ioda-events/index.ts";
import type { IptvEntry } from "../adapters/iptv-ve/index.ts";
import type { FloodDay } from "../adapters/modis-floods/index.ts";
import type { OfacValue } from "../adapters/ofac-sdn/index.ts";
import type { OfacVenezuelaValue } from "../adapters/ofac-venezuela/index.ts";
import type { RadioEntry } from "../adapters/radio-browser/index.ts";
import type { AsnRouting } from "../adapters/ripestat-prefixes/index.ts";
import type { NewsItem } from "../adapters/rss/factory.ts";
import { OUTLETS } from "../adapters/rss/outlets.ts";
import type { OfficeValue } from "../adapters/wikidata-officials/index.ts";
import { num } from "../core/format.ts";
import type { Json, Observation } from "../core/types.ts";
import { CROWD_SOURCE } from "../crowd/rules.ts";
import gazetteerJson from "../geo/data/gazetteer.json" with { type: "json" };
import { distanceKm } from "../geo/index.ts";
import { INCIDENTS_SOURCE } from "../intel/archive.ts";
import type { Incident } from "../intel/incidents.ts";
import { type PlaceMention, tagPlaces } from "../news/places.ts";
import { isCourtNotice } from "../news/privacy.ts";
import { normalize, stripDateline } from "../news/text.ts";
import { routeEvents } from "../panels/netwatch.ts";
import { outageStates } from "../panels/radar.ts";
import { placeAt } from "./geo.ts";
import { INSTITUTIONS } from "./institutions.ts";
import { INFRA_ITEMS, type Registry, registry } from "./registry.ts";
import { OFAC_STATE_BODIES, stateNamesFingerprint, stateNamesIn, WIKIDATA_OFFICES } from "./state-names.ts";

export type LinkRule =
	/** The observation's point lies in the entity (point in polygon). */
	| "located"
	/** The source names the state itself (an ISO code in its data). */
	| "state-code"
	/** Within a stated distance of a facility. */
	| "near"
	/** The adapter assigned the detection to this facility (flares). */
	| "facility"
	/** The source's data names the network (ASN, ISP id). */
	| "network"
	/** The feed belongs to this outlet. */
	| "outlet"
	/** The keyword tagger found the place in the text. */
	| "text-place"
	/** A curated name or acronym of the entity appears in the text. */
	| "text-name"
	/** The Gaceta Oficial lists an act of this organ. */
	| "organ"
	/** A Vigía incident about this state. */
	| "incident"
	/** Users of this instance reported for this municipality (or its state's sum). */
	| "reported"
	/** The source's own automatic geocoding puts it here (GDELT): a lead, confidence 0.5. */
	| "coded-place"
	/** In a 0.25° grid cell with lightning (GOES-19 GLM): a facility inside the cell, or the cell centre's municipality. */
	| "grid-cell"
	/** A TV channel or radio station the directory says serves this state. */
	| "broadcast-area"
	/** OFAC's own record of this body was designated, updated or removed. */
	| "sanctioned"
	/** An office of this institution (a Wikidata office, or a named official's OFAC title or Wikidata position). */
	| "office"
	/** The institution publishes this record (a BCV intervention). */
	| "publisher"
	/** A prediction market about the country. */
	| "market"
	/** Vigía's per-place figure from the source (flood area, alert hectares) passes a stated threshold. */
	| "threshold"
	/** A fixed area the adapter watches around this facility (ship counts near a terminal). */
	| "area"
	/** The flight's published route names this airport. */
	| "route";

export type Link = {
	readonly entity: string;
	readonly rule: LinkRule;
	/** 0..1: 1 for codes and polygons; the tagger's own confidence for text. */
	readonly confidence: number;
	/** Distance for "near" links, km (one decimal). */
	readonly km?: number;
};

const QUAKE_SOURCES = new Set(["usgs-quakes", "funvisis-quakes"]);
const INTERNATIONAL_CLASSES: ReadonlySet<string> = new Set(["arrival", "departure", "international"]);
const COUNTRY = "ve";

export const RULES = {
	/** Bump when a rule changes: the stored links are rebuilt from the archive (links-store.ts). */
	version: 7,
	/** Place mentions must reach the news panel's own threshold for a state ("states" of a story). */
	textMinConfidence: 0.7,
	/**
	 * Institutions and facilities by name: in a headline's title only, never its summary (hand-checked 2026-09-29 on
	 * 11,720 headlines: 72 of 74 title matches were about the entity, 32 of 55 summary-only ones).
	 */
	nameConfidence: 0.9,
	/**
	 * A VIIRS fire pixel is 375 m at nadir and up to ~800 m at the swath edge, plus geolocation error: "at" a
	 * facility means within about 1–2 km. Lines use 1 km: the right-of-way plus one pixel.
	 */
	fire: {
		km: {
			"power-plant": 2,
			substation: 1,
			"power-grid": 1,
			refinery: 2,
			petrochemical: 2,
			"fuel-depot": 1,
			"oil-terminal": 2,
			port: 1,
			airport: 2,
			dam: 2,
		} as Readonly<Record<string, number>>,
	},
	/**
	 * Quakes of at least `minMag` link to facilities within `km` of the epicentre. A fixed radius, stated as such: it
	 * says what is near, never that anything was damaged or felt.
	 */
	quake: {
		minMag: 4,
		km: 30,
		kinds: [
			"power-plant",
			"substation",
			"refinery",
			"petrochemical",
			"oil-terminal",
			"port",
			"airport",
			"dam",
			"hospital",
		] as readonly string[],
	},
	/**
	 * GOES-19 GLM counts flashes on a 0.25° grid (~28 km): a facility is linked to a window when it lies inside a cell
	 * with at least one flash, a municipality when a cell's centre lies in it. GLM's own location error is a few km.
	 * The transmission grid is left out: its lines cross dozens of cells and would be linked to most storms.
	 */
	lightning: {
		cellDeg: 0.25,
		municipalityConfidence: 0.5,
		kinds: [
			"power-plant",
			"substation",
			"refinery",
			"petrochemical",
			"fuel-depot",
			"oil-terminal",
			"port",
			"airport",
			"dam",
		] as readonly string[],
	},
	/** GDELT's automatic geocoding of machine-coded news: a lead, not a location Vigía measured. */
	gdeltConfidence: 0.5,
	/** A licence, Federal Register or OFAC title naming an institution by a hand-checked phrase. */
	titleConfidence: 0.9,
	/** A day's "flood" seen by NASA MODIS links a place from this area (km²); recurring flood does not. */
	flood: { stateKm2: 10, municipalityKm2: 5 },
	/** A week's GFW alerts in natural forest, high or highest confidence, link a place from this area (ha). */
	forest: { stateHa: 100, municipalityHa: 50 },
} as const;

/** The rules in words (what the API and the UI show next to linked items). */
export function linkRulesText(): { es: string[]; en: string[] } {
	const f = RULES.fire.km;
	return {
		es: [
			"Los vínculos los hace el código, sin modelos: punto en polígono con los límites oficiales (COD-AB), códigos de la fuente (estado, ASN, proveedor), el medio de cada titular, y palabras clave.",
			`Titulares: lugares que el etiquetador por palabra clave del panel de noticias encuentra con confianza de al menos ${num(RULES.textMinConfidence)} («ubicación por palabra clave»), en el título o, si el título no nombra ningún lugar, en el resumen; una fecha («el 23 de septiembre») no es un lugar. Una parroquia cuyo nombre comparten otros lugares del país (Catedral, La Pastora, San Agustín) cuenta solo si el mismo texto nombra su municipio o su estado. Instituciones e instalaciones: por sus nombres y siglas en una lista revisada a mano, solo en el título (confianza ${num(RULES.nameConfidence)}); «Asamblea Nacional de 2015» no es la Asamblea Nacional de hoy.`,
			`Incendios (NASA FIRMS): la parroquia, el municipio y el estado del píxel, y las instalaciones a menos de ${f["power-plant"]} km (plantas, refinerías, terminales, aeropuertos, represas), ${f.substation} km (subestaciones, depósitos de combustible, puertos) o ${f["power-grid"]} km de una línea de transmisión.`,
			`Sismos: el lugar del epicentro; si la magnitud es de al menos ${RULES.quake.minMag}, las instalaciones a menos de ${RULES.quake.km} km. Es una distancia fija: no dice que haya daños ni que se sintiera.`,
			"Quemas de gas: la instalación a la que el adaptador asignó la detección (su propia regla de distancia).",
			"Cortes de IODA: el país, el estado, o el proveedor y el ASN del evento. Gaceta Oficial: el órgano que publicó cada acto. Los bloqueos de VE sin Filtro se muestran en el ahora de cada proveedor, no en su cronología: la lista se republica entera y no fecha cada bloqueo. Todo hecho medido en un estado, y cada incidente, también entra en la cronología del país; los titulares no.",
			"Reportes de usuarios: cada conteo publicado (uno por hora por municipio o estado y servicio) se vincula al municipio para el que se reportó, o al estado por su suma; nunca al país; nada por debajo del mínimo de conexiones distintas se publica.",
			`GDELT: el lugar que da su propia geocodificación automática (confianza ${num(RULES.gdeltConfidence)}, «codificación automática de GDELT») y el medio dueño del sitio del artículo.`,
			`Rayos (GOES-19 GLM): cada ventana de 15 minutos se vincula a los estados con destellos, al municipio del centro de cada celda de ${num(RULES.lightning.cellDeg)}° con destellos (confianza ${num(RULES.lightning.municipalityConfidence)}: una celda mide unos 28 km) y a las plantas, subestaciones, refinerías, terminales, puertos, aeropuertos y represas dentro de esas celdas. La red de transmisión no: sus líneas cruzan decenas de celdas.`,
			"Canales de TV y radios: los estados que el directorio dice que atienden, y el medio cuando el sitio del canal es el suyo.",
			`OFAC: las designaciones y exclusiones de un órgano del Estado venezolano (por el número de registro de OFAC, en una lista revisada a mano) y las instituciones que nombra el cargo de un funcionario público identificado (su título en OFAC o su cargo en Wikidata, confianza ${num(RULES.titleConfidence)}). Licencias generales, avisos de OFAC y documentos del Federal Register: las instituciones que nombra su título. Cargos de Wikidata: la institución que ocupa el cargo, o el estado de una gobernación. Intervenciones cambiarias: el BCV. Mercados de predicción: el país.`,
			"Por omisión la cronología trae hechos; los artículos de GDELT, los rayos, los canales y radios, los cargos y los mercados se piden con kinds (gdelt, lightning, broadcast, office, market).",
			"Plumas de metano (Carbon Mapper): el lugar de la pluma y la instalación que le asignó el adaptador (a menos de 3 km de su contorno o de un mechurrio).",
			`Inundaciones (NASA MODIS): cada estado con al menos ${RULES.flood.stateKm2} km² y cada municipio con al menos ${RULES.flood.municipalityKm2} km² clasificados como «inundación» ese día (la «inundación recurrente» no cuenta).`,
			`Alertas de bosque (Global Forest Watch): cada estado con al menos ${RULES.forest.stateHa} ha y cada municipio oficial con al menos ${RULES.forest.municipalityHa} ha de alertas en bosque natural de confianza alta o máxima en la semana; los municipios de GADM que no coinciden con uno oficial no se vinculan.`,
			"Buques por radar (Global Fishing Watch): las terminales y puertos de la zona fija vigilada, los días con detecciones. Cloudflare Radar: los estados que nombra cada nota de corte (o el país) y los ASN de sus redes.",
			"Vuelos (adsb.lol): cada vuelo internacional de aerolínea visto, a los aeropuertos venezolanos de su ruta publicada, si la ruta pasa cerca de donde se vio el avión (los domésticos y los que sobrevuelan solo se cuentan en el panel).",
		],
		en: [
			"Links are made by code, with no model: point in polygon on the official boundaries (COD-AB), codes in the source (state, ASN, ISP), each headline's outlet, and keywords.",
			`Headlines: places the news panel's keyword tagger finds with confidence of at least ${num(RULES.textMinConfidence, "en")} ("location by keyword"), in the title or, when the title names no place, in the summary; a date ("el 23 de septiembre") is not a place. A parish whose name other places in the country share (Catedral, La Pastora, San Agustín) counts only when the same text names its municipality or state. Institutions and facilities: by their names and acronyms from a hand-checked list, in the title only (confidence ${num(RULES.nameConfidence, "en")}); "Asamblea Nacional de 2015" is not today's National Assembly.`,
			`Fires (NASA FIRMS): the pixel's parish, municipality and state, and facilities within ${f["power-plant"]} km (plants, refineries, terminals, airports, dams), ${f.substation} km (substations, fuel depots, ports) or ${f["power-grid"]} km of a transmission line.`,
			`Quakes: the epicentre's place; at magnitude ${RULES.quake.minMag} or more, facilities within ${RULES.quake.km} km. A fixed distance: it does not say anything was damaged or felt.`,
			"Gas flares: the facility the adapter assigned the detection to (its own distance rule).",
			"IODA outages: the country, the state, or the ISP and the event's ASN. Official Gazette: the organ that published each act. VE sin Filtro's blocks show in each ISP's now block, not in its timeline: the list is republished whole and does not date each block. Every event measured in a state, and every incident, is also in the country's timeline; headlines are not.",
			"User reports: each published count (one per hour per municipality or state and service) links the municipality it was reported for, or the state for its sum; never the country; nothing below the minimum of distinct connections is ever published.",
			`GDELT: the place its own automatic geocoding gives (confidence ${num(RULES.gdeltConfidence, "en")}, "GDELT's automatic coding") and the outlet whose site published the article.`,
			`Lightning (GOES-19 GLM): each 15-minute window links to the states with flashes, the municipality of the centre of each ${num(RULES.lightning.cellDeg, "en")}° cell with flashes (confidence ${num(RULES.lightning.municipalityConfidence, "en")}: a cell is ~28 km wide) and the plants, substations, refineries, terminals, ports, airports and dams inside those cells. Not the transmission grid: its lines cross dozens of cells.`,
			"TV channels and radio stations: the states the directory says they serve, and the outlet when the channel's site is its own.",
			`OFAC: designations and removals of a Venezuelan state body (by OFAC's record number, from a hand-checked list) and the institutions a named public official's office names (the OFAC title or Wikidata position, confidence ${num(RULES.titleConfidence, "en")}). General licences, OFAC notices and Federal Register documents: the institutions their titles name. Wikidata offices: the institution holding the office, or the state of a governorship. Exchange interventions: the BCV. Prediction markets: the country.`,
			"By default the timeline holds events; GDELT articles, lightning, channels and stations, offices and markets are asked for with kinds (gdelt, lightning, broadcast, office, market).",
			"Methane plumes (Carbon Mapper): the plume's place and the facility the adapter assigned (within 3 km of its outline or of a flare site).",
			`Floods (NASA MODIS): each state with at least ${RULES.flood.stateKm2} km² and each municipality with at least ${RULES.flood.municipalityKm2} km² classed as "flood" that day (recurring flood does not count).`,
			`Forest alerts (Global Forest Watch): each state with at least ${RULES.forest.stateHa} ha and each official municipality with at least ${RULES.forest.municipalityHa} ha of high or highest confidence alerts in natural forest that week; GADM municipalities that match no official one are not linked.`,
			"Ships by radar (Global Fishing Watch): the terminals and ports of the fixed area watched, on days with detections. Cloudflare Radar: the states each outage note names (or the country) and its networks' ASNs.",
			"Flights (adsb.lol): each international airline flight seen, to the Venezuelan airports of its published route, when the route passes near where the aircraft was seen (domestic flights and overflights are only counted in the panel).",
		],
	};
}

// ——— spatial index for "near" ———

type Point = { id: string; kind: string; lat: number; lon: number };
type Segment = { id: string; kind: string; a: readonly [number, number]; b: readonly [number, number] };

const CELL = 0.1;
const cellKey = (lat: number, lon: number) => `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;

export class NearIndex {
	readonly #points = new Map<string, Point[]>();
	readonly #segments = new Map<string, Segment[]>();

	constructor(
		items: readonly {
			id: string;
			kind: string;
			lat: number;
			lon: number;
			lines?: readonly (readonly (readonly [number, number])[])[];
		}[],
	) {
		for (const it of items) {
			if (it.lines) {
				for (const line of it.lines)
					for (let i = 1; i < line.length; i++) {
						const a = line[i - 1] as readonly [number, number];
						const b = line[i] as readonly [number, number];
						const seg = { id: it.id, kind: it.kind, a, b };
						// A segment is filed under every cell its bounding box touches.
						for (
							let y = Math.floor(Math.min(a[0], b[0]) / CELL);
							y <= Math.floor(Math.max(a[0], b[0]) / CELL);
							y++
						)
							for (
								let x = Math.floor(Math.min(a[1], b[1]) / CELL);
								x <= Math.floor(Math.max(a[1], b[1]) / CELL);
								x++
							) {
								const k = `${y}:${x}`;
								this.#segments.set(k, [...(this.#segments.get(k) ?? []), seg]);
							}
					}
				continue;
			}
			const k = cellKey(it.lat, it.lon);
			this.#points.set(k, [
				...(this.#points.get(k) ?? []),
				{ id: it.id, kind: it.kind, lat: it.lat, lon: it.lon },
			]);
		}
	}

	/** Facilities within their kind's distance of the point (`km` per kind), nearest first, one entry per facility. */
	near(
		lat: number,
		lon: number,
		km: Readonly<Record<string, number>>,
	): { id: string; kind: string; km: number }[] {
		const reach = Math.max(0, ...Object.values(km));
		const pad = Math.ceil(reach / (111 * CELL * Math.max(0.2, Math.cos((lat * Math.PI) / 180)))) + 1;
		const cy = Math.floor(lat / CELL);
		const cx = Math.floor(lon / CELL);
		const best = new Map<string, { id: string; kind: string; km: number }>();
		const keep = (id: string, kind: string, d: number) => {
			const limit = km[kind];
			if (limit === undefined || d > limit) return;
			const prev = best.get(id);
			if (!prev || d < prev.km) best.set(id, { id, kind, km: Math.round(d * 10) / 10 });
		};
		for (let y = cy - pad; y <= cy + pad; y++)
			for (let x = cx - pad; x <= cx + pad; x++) {
				for (const p of this.#points.get(`${y}:${x}`) ?? [])
					keep(p.id, p.kind, distanceKm(lat, lon, p.lat, p.lon));
				for (const s of this.#segments.get(`${y}:${x}`) ?? [])
					keep(s.id, s.kind, segmentKm(lat, lon, s.a, s.b));
			}
		return [...best.values()].sort((a, b) => a.km - b.km || a.id.localeCompare(b.id));
	}
}

/** Distance from a point to a [lat, lon] segment, km, on a plane tangent at the point (exact enough under 50 km). */
export function segmentKm(
	lat: number,
	lon: number,
	a: readonly [number, number],
	b: readonly [number, number],
): number {
	const k = Math.cos((lat * Math.PI) / 180) * 111.32;
	const ax = (a[1] - lon) * k;
	const ay = (a[0] - lat) * 111.32;
	const bx = (b[1] - lon) * k;
	const by = (b[0] - lat) * 111.32;
	const dx = bx - ax;
	const dy = by - ay;
	const len2 = dx * dx + dy * dy;
	const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
	return Math.hypot(ax + t * dx, ay + t * dy);
}

// ——— the linker ———

export interface Linker {
	/** Parish, municipality and state of a point (state from `stateHint` when the polygons miss it, e.g. the lake). */
	place(lat: number, lon: number, stateHint?: string | null): Link[];
	/** Places, institutions and facilities named in a text. */
	text(text: string, options?: { venezuelanOutlet?: boolean; homeState?: string }): Link[];
	near(lat: number, lon: number, km: Readonly<Record<string, number>>): Link[];
	/** Every link of one stored observation (empty for sources that are not linked). */
	observation(
		o: Pick<Observation, "source" | "series" | "value" | "location"> & { observedAt?: number },
	): Link[];
	/** The sources `observation` links; others give no links. */
	readonly sources: ReadonlySet<string>;
}

/** Curated names in headlines → entity: institutions' `text` phrases and the facilities people name in the news. */
export const FACILITY_NAMES: Readonly<Record<string, string>> = {
	guri: "infra.guri",
	"represa del guri": "infra.represa-del-guri",
	"embalse de guri": "infra.represa-del-guri",
	"embalse del guri": "infra.represa-del-guri",
	tocoma: "infra.tocoma",
	caruachi: "infra.caruachi",
	"planta centro": "infra.planta-centro",
	tacoa: "infra.central-electrica-josefa-joaquina-sanchez-bastidas",
	termozulia: "infra.planta-termozulia-rafael-urdaneta",
	"refineria amuay": "infra.refineria-amuay",
	"refineria de amuay": "infra.refineria-amuay",
	amuay: "infra.refineria-amuay",
	"refineria cardon": "infra.refineria-cardon",
	"refineria de cardon": "infra.refineria-cardon",
	"centro de refinacion paraguana": "infra.refineria-cardon",
	"el palito": "infra.refineria-el-palito",
	"refineria puerto la cruz": "infra.refineria-puerto-la-cruz",
	"refineria de puerto la cruz": "infra.refineria-puerto-la-cruz",
	"complejo jose antonio anzoategui": "infra.complejo-jose",
	"complejo petroquimico jose antonio anzoategui": "infra.complejo-jose",
	"el tablazo": "infra.complejo-petroquimico-el-tablazo",
	"aeropuerto de maiquetia": "infra.aeropuerto-ccs",
	"aeropuerto internacional de maiquetia": "infra.aeropuerto-ccs",
	"aeropuerto simon bolivar": "infra.aeropuerto-ccs",
	"puerto de la guaira": "infra.puerto-la-guaira",
	"puerto de puerto cabello": "infra.puerto-cabello",
};

function nameIndex(reg: Registry): { phrase: string; words: string[]; id: string }[] {
	const out: { phrase: string; words: string[]; id: string }[] = [];
	for (const i of INSTITUTIONS)
		for (const t of i.text ?? []) out.push({ phrase: normalize(t), words: [], id: i.id });
	for (const [t, id] of Object.entries(FACILITY_NAMES))
		if (reg.get(id)) out.push({ phrase: normalize(t), words: [], id });
	for (const o of out) o.words = o.phrase.split(" ");
	return out.sort((a, b) => b.words.length - a.words.length);
}

/**
 * Words after a curated name that make it something else: "Asamblea Nacional de 2015" (also "electa en 2015",
 * "(AN) 2015") is the delegation of the legislature elected in 2015, not today's National Assembly (12 of 80
 * sampled institution links on 2026-09-29).
 */
export const NOT_FOLLOWED_BY: Readonly<Record<string, RegExp>> = {
	"inst.an": /^(?:an )?(?:(?:de|del|electa|elegida|en|el) )*2015\b/,
};

/**
 * Parishes whose name another parish, a municipality or a state also has (not counting its own municipality or
 * state): "Catedral" is a parish of Caracas, Barquisimeto and Angostura del Orinoco.
 */
export function repeatedParishesOf(reg: Registry): ReadonlySet<string> {
	const byName = new Map<string, string[]>();
	for (const e of reg.all)
		if (e.type === "parish" || e.type === "municipality" || e.type === "state") {
			const k = normalize(e.name.es);
			byName.set(k, [...(byName.get(k) ?? []), e.id]);
		}
	const out = new Set<string>();
	for (const e of reg.all) {
		if (e.type !== "parish") continue;
		const own = new Set([e.id, ...reg.ancestors(e.id).map((a) => a.id)]);
		if ((byName.get(normalize(e.name.es)) ?? []).some((id) => !own.has(id))) out.add(e.id);
	}
	return out;
}

const OUTLET_BY_FEED = new Map(OUTLETS.map((o) => [o.id, o]));

/** The host of a site URL, lower case, without "www."; null when it is not a URL. */
export function siteHost(url: string): string | null {
	try {
		const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
		return host || null;
	} catch {
		return null;
	}
}

/** A fingerprint of the curated names and the gazetteer build (part of the stored links' version). */
export function textFingerprint(): string {
	const gaz = (gazetteerJson as unknown as { meta: { generatedAt?: string } }).meta.generatedAt ?? "";
	const names = JSON.stringify([
		INSTITUTIONS.map((i) => [i.id, i.text ?? [], i.organs ?? []]),
		FACILITY_NAMES,
		gaz,
		stateNamesFingerprint(),
	]);
	return Bun.hash(names).toString(16);
}

function linkerFor(reg: Registry): Linker {
	const index = new NearIndex(
		INFRA_ITEMS.map((r) => ({
			id: r.id,
			kind: r.kind,
			lat: r.lat,
			lon: r.lon,
			...(r.lines ? { lines: r.lines } : {}),
		})),
	);
	const nameList = nameIndex(reg);
	const repeatedParishes = repeatedParishesOf(reg);
	const byCode = (key: string) => reg.byCode(key)?.id ?? null;

	// GLM: the facilities inside each 0.25° cell (RULES.lightning.kinds; lines left out).
	const cellDeg = RULES.lightning.cellDeg;
	const cellKeyOf = (lat: number, lon: number) => `${Math.floor(lat / cellDeg)}:${Math.floor(lon / cellDeg)}`;
	const facilitiesByCell = new Map<string, { id: string; lat: number; lon: number }[]>();
	for (const r of INFRA_ITEMS) {
		if (r.lines || !RULES.lightning.kinds.includes(r.kind)) continue;
		const k = cellKeyOf(r.lat, r.lon);
		facilitiesByCell.set(k, [...(facilitiesByCell.get(k) ?? []), { id: r.id, lat: r.lat, lon: r.lon }]);
	}

	// Outlets by the host of their site: a host two outlets share (YouTube, Telegram) names neither.
	const outletByHost = new Map<string, string | null>();
	for (const o of OUTLETS) {
		const host = siteHost(o.homepage);
		const e = byCode(`feed:${o.id}`);
		if (!host || !e) continue;
		const prev = outletByHost.get(host);
		outletByHost.set(host, prev === undefined || prev === e ? e : null);
	}
	/** The outlet whose site this URL is on (the host or a parent domain of it), when exactly one outlet has it. */
	const outletOfUrl = (url: string | null): string | null => {
		let host = url ? siteHost(url) : null;
		while (host?.includes(".")) {
			const e = outletByHost.get(host);
			if (e !== undefined) return e;
			host = host.slice(host.indexOf(".") + 1);
		}
		return null;
	};

	const place = (lat: number, lon: number, stateHint?: string | null): Link[] => {
		const p = placeAt(lat, lon);
		const out: Link[] = [];
		const parish = p.parish ? byCode(`pcode:${p.parish}`) : null;
		const muni = p.municipality ? byCode(`pcode:${p.municipality}`) : null;
		const state = p.state ?? stateHint ?? null;
		const stateEntity = state ? byCode(`iso:${state}`) : null;
		// A parish found only as the nearest of its municipality's is a weaker claim than one containing the point.
		if (parish) out.push({ entity: parish, rule: "located", confidence: p.parishNearest ? 0.8 : 1 });
		if (muni) out.push({ entity: muni, rule: "located", confidence: 1 });
		if (stateEntity) {
			out.push({ entity: stateEntity, rule: p.state ? "located" : "state-code", confidence: 1 });
			// Measured events in Venezuela also make the country's timeline (headlines do not: that would be all).
			out.push({ entity: COUNTRY, rule: p.state ? "located" : "state-code", confidence: 1 });
		}
		return out;
	};

	const near = (lat: number, lon: number, km: Readonly<Record<string, number>>): Link[] =>
		index.near(lat, lon, km).map((n) => ({ entity: n.id, rule: "near" as const, confidence: 1, km: n.km }));

	/**
	 * Places the news panel's keyword tagger finds (RULES.textMinConfidence). A parish whose name is also another
	 * parish's, a municipality's or a state's (REPEATED_PARISHES: "Catedral", "La Pastora", "San Agustín") counts only
	 * when another place in the same text lies in its municipality or state ("parroquia Catedral de Caracas"); else
	 * the whole mention is dropped: the tagger knows Caracas' parishes only, so "parroquia Catedral del municipio
	 * Angostura del Orinoco" would otherwise land in Caracas.
	 */
	const places = (t: string, options: { venezuelanOutlet?: boolean; homeState?: string } = {}): Link[] => {
		const out = new Map<string, Link>();
		const put = (l: Link) => {
			const prev = out.get(l.entity);
			if (!prev || l.confidence > prev.confidence) out.set(l.entity, l);
		};
		const parishOf = (m: PlaceMention) =>
			m.entry.startsWith("parish:") ? byCode(`pcode:${m.entry.slice("parish:".length)}`) : null;
		// "parroquia Bolívar", "parroquia Concepción": the tagger knows Caracas' parishes only, so a name right after
		// "parroquia" that it resolved to a state, municipality or town is the wrong place (whole-release review, M6:
		// "parroquia Bolívar" became the state of Bolívar; "parroquia Concepción, municipio Iribarren" also Zulia).
		const folded = normalize(t);
		const afterParroquia = (m: PlaceMention) =>
			!m.entry.startsWith("parish:") && new RegExp(`\\bparroquias? ${m.term}\\b`).test(folded);
		const mentions = tagPlaces(t, options).mentions.filter(
			(m) => m.confidence >= RULES.textMinConfidence && !afterParroquia(m),
		);
		const repeated = (m: PlaceMention) => {
			const p = parishOf(m);
			return p !== null && repeatedParishes.has(p);
		};
		// Other places that can vouch for a repeated parish name: any mention but another repeated parish.
		const anchors = mentions.filter((m) => !repeated(m));
		for (const m of mentions) {
			const parish = parishOf(m);
			if (
				repeated(m) &&
				!anchors.some((o) => (o.municipality ?? null) === m.municipality || o.state === m.state)
			)
				continue;
			const state = byCode(`iso:${m.state}`);
			if (state) put({ entity: state, rule: "text-place", confidence: m.confidence });
			// Towns and sectors name their municipality; only a parish entry names a parish.
			if (m.kind !== "state" && m.municipality) {
				const muni = byCode(`pcode:${m.municipality}`);
				if (muni) put({ entity: muni, rule: "text-place", confidence: m.confidence });
			}
			if (parish) put({ entity: parish, rule: "text-place", confidence: m.confidence });
		}
		return [...out.values()];
	};

	/** Institutions and facilities by their hand-checked names (FACILITY_NAMES, institutions' `text`). */
	const names = (t: string): Link[] => {
		const out = new Map<string, Link>();
		const words = normalize(t).split(" ").filter(Boolean);
		const used = new Set<number>();
		for (const n of nameList) {
			for (let i = 0; i + n.words.length <= words.length; i++) {
				if (!n.words.every((w, k) => words[i + k] === w)) continue;
				if (n.words.some((_, k) => used.has(i + k))) continue;
				const next = words.slice(i + n.words.length, i + n.words.length + 6).join(" ");
				if (NOT_FOLLOWED_BY[n.id]?.test(next)) continue;
				for (let k = 0; k < n.words.length; k++) used.add(i + k);
				out.set(n.id, { entity: n.id, rule: "text-name", confidence: RULES.nameConfidence });
			}
		}
		return [...out.values()];
	};

	const text = (t: string, options: { venezuelanOutlet?: boolean; homeState?: string } = {}): Link[] => {
		const found = places(t, options);
		for (const l of names(t)) if (!found.some((x) => x.entity === l.entity)) found.push(l);
		return found;
	};

	const headline = (feed: string, item: NewsItem): Link[] => {
		// A court notice names private persons: never linked (an older archive may still hold one until the purge).
		if (isCourtNotice(item.title, item.summary)) return [];
		const outlet = OUTLET_BY_FEED.get(feed);
		const own = byCode(`feed:${feed}`);
		const options = {
			venezuelanOutlet: outlet ? outlet.region !== "international" : true,
			...(outlet?.region.startsWith("VE-") ? { homeState: outlet.region } : {}),
		};
		// Places: the news panel's rule, the headline first and the summary only when the headline names no state.
		const fromTitle = places(item.title, options);
		const where = fromTitle.length
			? fromTitle
			: places(`${item.title}. ${stripDateline(item.summary)}`, options);
		// Names: the title only (RULES.nameConfidence): a page lists a story by its title, and a name found only in
		// the summary was an aside in 23 of 55 stories checked.
		const named = names(item.title).filter((l) => !where.some((x) => x.entity === l.entity));
		// An international outlet's "CNE" or "Asamblea Nacional" may be another country's: its institution names
		// count only when the text also names Venezuela or a Venezuelan place.
		const foreignDesk = outlet?.region === "international" || outlet?.region === "diaspora";
		const aboutVenezuela =
			where.length > 0 || /\bvenezol|\bvenezuela\b/.test(normalize(`${item.title} ${item.summary}`));
		const kept = foreignDesk && !aboutVenezuela ? named.filter((l) => !l.entity.startsWith("inst.")) : named;
		return [...(own ? [{ entity: own, rule: "outlet" as const, confidence: 1 }] : []), ...where, ...kept];
	};

	const dedupe = (links: readonly Link[]): Link[] => {
		const out = new Map<string, Link>();
		for (const l of links) {
			const prev = out.get(l.entity);
			if (!prev || l.confidence > prev.confidence) out.set(l.entity, l);
		}
		return [...out.values()];
	};

	const sources = new Set<string>([
		...QUAKE_SOURCES,
		"firms-fires",
		"firms-flares",
		"ioda-events",
		"gdacs-events",
		"gaceta-oficial",
		"ripestat-prefixes",
		INCIDENTS_SOURCE,
		CROWD_SOURCE,
		"carbon-mapper",
		"modis-floods",
		"gfw-alerts",
		"gfw-vessels",
		"cloudflare-radar",
		"adsb-flights",
		...OUTLETS.map((o) => o.id),
		"gdelt-ve",
		"goes-glm",
		"iptv-ve",
		"radio-browser",
		"ofac-sdn",
		"ofac-venezuela",
		"federal-register",
		"wikidata-officials",
		"bcv-intervention",
		"polymarket",
		"kalshi",
	]);

	const observation = (
		o: Pick<Observation, "source" | "series" | "value" | "location"> & { observedAt?: number },
	): Link[] => {
		const v = o.value as Json;
		if (typeof v !== "object" || v === null || Array.isArray(v)) return [];
		const loc = o.location;
		if (QUAKE_SOURCES.has(o.source)) {
			if (!loc) return [];
			const mag = typeof v.mag === "number" ? v.mag : 0;
			const links = place(loc.lat, loc.lon, loc.state ?? null);
			if (mag >= RULES.quake.minMag)
				links.push(
					...near(loc.lat, loc.lon, Object.fromEntries(RULES.quake.kinds.map((k) => [k, RULES.quake.km]))),
				);
			return dedupe(links);
		}
		if (o.source === "firms-fires") {
			const f = v as unknown as FirmsValue;
			if (f.kind !== "detection" || !loc) return [];
			return dedupe([
				...place(loc.lat, loc.lon, loc.state ?? null),
				...near(loc.lat, loc.lon, RULES.fire.km),
			]);
		}
		if (o.source === "firms-flares") {
			const f = v as unknown as FlareValue;
			if (f.kind !== "detection") return [];
			const facility = byCode(`facility:${f.facilityId}`);
			return dedupe([
				...(facility ? [{ entity: facility, rule: "facility" as const, confidence: 1 }] : []),
				...(loc ? place(loc.lat, loc.lon, loc.state ?? null) : []),
			]);
		}
		if (o.source === "ioda-events") {
			const e = v as unknown as IodaEvent;
			if (e.entityType === "country") return [{ entity: COUNTRY, rule: "state-code", confidence: 1 }];
			if (e.entityType === "region") {
				const s = byCode(`iso:${e.key}`);
				return s ? [{ entity: s, rule: "state-code", confidence: 1 }] : [];
			}
			if (e.entityType === "asn") {
				// The event is about one ASN (entityCode); its ISP is linked too, not the ISP's other ASNs.
				const net = byCode(`isp:${e.key}`);
				const asn = byCode(`asn:${e.entityCode}`);
				return [
					...(net ? [{ entity: net, rule: "network" as const, confidence: 1 }] : []),
					...(asn ? [{ entity: asn, rule: "network" as const, confidence: 1 }] : []),
				];
			}
			return [];
		}
		if (o.source === "gdacs-events") {
			const g = v as unknown as GdacsEvent;
			if (!g.inVenezuela || !loc) return [];
			return place(loc.lat, loc.lon, loc.state ?? null);
		}
		if (o.source === "gaceta-oficial") {
			const issue = v as unknown as GacetaIssue;
			const out: Link[] = [];
			for (const act of issue.acts ?? []) {
				const inst = byCode(`organ:${act.organ}`);
				if (inst) out.push({ entity: inst, rule: "organ", confidence: 1 });
			}
			return dedupe(out);
		}
		if (o.source === "ripestat-prefixes") {
			// The netwatch panel's own event rule (a withdrawal, announcement or move big enough to count).
			const r = v as unknown as AsnRouting;
			const e = routeEvents(r, o.observedAt ?? 0).length > 0 ? byCode(`asn:${r.asn}`) : null;
			return e ? [{ entity: e, rule: "network", confidence: 1 }] : [];
		}
		if (o.source === INCIDENTS_SOURCE) {
			const inc = v as unknown as Incident;
			const s = inc.state ? byCode(`iso:${inc.state}`) : null;
			return s
				? [
						{ entity: s, rule: "incident", confidence: 1 },
						{ entity: COUNTRY, rule: "incident", confidence: 1 },
					]
				: [];
		}
		if (o.source === CROWD_SOURCE) {
			// A published aggregate names its own entity; tombstones ("nothing to show now") are not events.
			if (v.shown !== true || typeof v.entity !== "string") return [];
			const e = reg.get(v.entity);
			return e && (e.type === "municipality" || e.type === "state")
				? [{ entity: e.id, rule: "reported", confidence: 1 }]
				: [];
		}
		if (o.source === "gdelt-ve") {
			// Batches are counts per state (a series, read by the anomaly engine and the panel); articles are events.
			if (!o.series.startsWith("gdelt:article:")) return [];
			const a = v as unknown as GdeltArticle;
			const coded = (l: Link): Link => ({
				entity: l.entity,
				rule: "coded-place",
				confidence: Math.min(l.confidence, RULES.gdeltConfidence),
			});
			const where = loc
				? place(loc.lat, loc.lon, loc.state ?? null).filter((l) => l.entity !== COUNTRY)
				: a.state
					? [byCode(`iso:${a.state}`)]
							.filter((x): x is string => x !== null)
							.map((entity) => ({ entity, rule: "state-code" as const, confidence: 1 }))
					: [];
			const outlet = outletOfUrl(typeof a.url === "string" ? a.url : null);
			return dedupe([
				...where.map(coded),
				...(outlet ? [{ entity: outlet, rule: "outlet" as const, confidence: 1 }] : []),
			]);
		}
		if (o.source === "goes-glm") {
			const w = v as unknown as LightningWindow;
			const out: Link[] = [];
			for (const [iso, n] of Object.entries(w.byState ?? {})) {
				const s = n > 0 ? byCode(`iso:${iso}`) : null;
				if (s) out.push({ entity: s, rule: "located", confidence: 1 });
			}
			for (const cell of w.cells ?? []) {
				const [lat, lon, n] = cell;
				if (!(n > 0)) continue;
				const p = placeAt(lat, lon);
				const muni = p.municipality ? byCode(`pcode:${p.municipality}`) : null;
				if (muni)
					out.push({
						entity: muni,
						rule: "grid-cell",
						confidence: RULES.lightning.municipalityConfidence,
					});
				for (const f of facilitiesByCell.get(cellKeyOf(lat, lon)) ?? [])
					out.push({
						entity: f.id,
						rule: "grid-cell",
						confidence: 1,
						km: Math.round(distanceKm(lat, lon, f.lat, f.lon) * 10) / 10,
					});
			}
			return dedupe(out);
		}
		if (o.source === "iptv-ve" || o.source === "radio-browser") {
			// Directory entries only (not Radio Browser's summary row); excluded listings are not linked.
			const e = v as unknown as Partial<IptvEntry & RadioEntry>;
			if (e.status !== "on" || !Array.isArray(e.states)) return [];
			const out: Link[] = e.states.flatMap((iso) => {
				const s = byCode(`iso:${iso}`);
				return s ? [{ entity: s, rule: "broadcast-area" as const, confidence: 1 }] : [];
			});
			const outlet = outletOfUrl(o.source === "iptv-ve" ? (e.website ?? null) : (e.homepage ?? null));
			if (outlet) out.push({ entity: outlet, rule: "outlet", confidence: 1 });
			return dedupe(out);
		}
		if (o.source === "ofac-sdn") {
			const c = v as unknown as OfacValue;
			if (c.kind !== "change") return [];
			const s = c.subject;
			if (s.type === "entity") {
				const body = OFAC_STATE_BODIES[s.uid];
				return body && reg.get(body.entity)
					? [{ entity: body.entity, rule: "sanctioned", confidence: 1 }]
					: [];
			}
			if (s.type === "individual" && s.named) {
				const ids = new Set([...stateNamesIn(s.title ?? ""), ...stateNamesIn(s.wikidata?.position ?? "")]);
				return [...ids]
					.filter((id) => reg.get(id))
					.map((entity) => ({ entity, rule: "office" as const, confidence: RULES.titleConfidence }));
			}
			return [];
		}
		if (o.source === "ofac-venezuela" || o.source === "federal-register") {
			const d = v as unknown as Partial<OfacVenezuelaValue & FrDocument>;
			if (o.source === "ofac-venezuela" && d.kind !== "licence" && d.kind !== "action") return [];
			const ids = new Set([...stateNamesIn(d.title ?? ""), ...stateNamesIn(d.abstract ?? "")]);
			return [...ids]
				.filter((id) => reg.get(id))
				.map((entity) => ({ entity, rule: "text-name" as const, confidence: RULES.titleConfidence }));
		}
		if (o.source === "wikidata-officials") {
			const off = v as unknown as OfficeValue;
			const inst = off.office?.qid ? WIKIDATA_OFFICES[off.office.qid] : undefined;
			const state = off.state ? byCode(`iso:${off.state}`) : null;
			return [inst && reg.get(inst) ? inst : null, state]
				.filter((x): x is string => x !== null && x !== undefined)
				.map((entity) => ({ entity, rule: "office" as const, confidence: 1 }));
		}
		if (o.source === "bcv-intervention") return [{ entity: "inst.bcv", rule: "publisher", confidence: 1 }];
		if (o.source === "polymarket" || o.source === "kalshi")
			return [{ entity: COUNTRY, rule: "market", confidence: 1 }];
		if (o.source === "carbon-mapper") {
			const p = v as unknown as MethanePlume;
			const facility = p.facilityId ? byCode(`facility:${p.facilityId}`) : null;
			return dedupe([
				...(facility ? [{ entity: facility, rule: "facility" as const, confidence: 1 }] : []),
				...(loc ? place(loc.lat, loc.lon, loc.state ?? null) : []),
			]);
		}
		if (o.source === "modis-floods") {
			const d = v as unknown as FloodDay;
			const out: Link[] = [];
			for (const [iso, st] of Object.entries(d.states ?? {}))
				if (st.floodKm2 >= RULES.flood.stateKm2) {
					const e = byCode(`iso:${iso}`);
					if (e) out.push({ entity: e, rule: "threshold", confidence: 1 });
				}
			for (const [code, m] of Object.entries(d.municipalities ?? {}))
				if (m.floodKm2 >= RULES.flood.municipalityKm2) {
					const e = byCode(`pcode:${code}`);
					if (e) out.push({ entity: e, rule: "threshold", confidence: 1 });
				}
			if (out.length > 0) out.push({ entity: COUNTRY, rule: "threshold", confidence: 1 });
			return dedupe(out);
		}
		if (o.source === "gfw-alerts") {
			const w = v as unknown as GfwAlerts;
			if (w.kind !== "week") return [];
			const strong = (s: { forestHa: readonly number[] }) => (s.forestHa[1] ?? 0) + (s.forestHa[2] ?? 0);
			const out: Link[] = [];
			for (const [iso, st] of Object.entries(w.states))
				if (strong(st) >= RULES.forest.stateHa) {
					const e = byCode(`iso:${iso}`);
					if (e) out.push({ entity: e, rule: "threshold", confidence: 1 });
				}
			for (const m of Object.values(w.municipalities))
				if (m.municipality && strong(m) >= RULES.forest.municipalityHa) {
					const e = byCode(`pcode:${m.municipality}`);
					if (e) out.push({ entity: e, rule: "threshold", confidence: 1 });
				}
			if (out.length > 0) out.push({ entity: COUNTRY, rule: "threshold", confidence: 1 });
			return dedupe(out);
		}
		if (o.source === "gfw-vessels") {
			const d = v as unknown as VesselDay;
			if (!(d.detections > 0)) return [];
			const area = VESSEL_AREAS.find((a) => a.id === d.area);
			return (area?.entities ?? [])
				.filter((id) => reg.get(id))
				.map((id) => ({ entity: id, rule: "area" as const, confidence: 1 }));
		}
		if (o.source === "cloudflare-radar") {
			const r = v as unknown as CloudflareRadar;
			if (r.kind === "traffic") return [];
			const out: Link[] = [];
			const asnLink = (asn: number) => {
				const e = byCode(`asn:${asn}`);
				if (e) out.push({ entity: e, rule: "network", confidence: 1 });
			};
			if (r.kind === "outage") {
				for (const a of r.asns) asnLink(a.asn);
				const named = outageStates(r);
				if (Array.isArray(named))
					for (const iso of named) {
						const e = byCode(`iso:${iso}`);
						if (e) out.push({ entity: e, rule: "text-place", confidence: 0.9 });
					}
				if (r.locations.includes("VE")) out.push({ entity: COUNTRY, rule: "state-code", confidence: 1 });
			} else {
				if (r.asn !== null) asnLink(r.asn);
				if (r.location === "VE") out.push({ entity: COUNTRY, rule: "state-code", confidence: 1 });
			}
			return dedupe(out);
		}
		if (o.source === "adsb-flights") {
			const f = v as unknown as Flight;
			// International flights only (the "is it being cut off" signal): a domestic shuttle or an overflight would
			// fill an airport's timeline with dozens of rows a day.
			if (f.kind !== "flight" || f.routePlausible === false || !INTERNATIONAL_CLASSES.has(f.class)) return [];
			return f.veAirports
				.map((icao) => byCode(`icao:${icao}`))
				.filter((id): id is string => id !== null)
				.map((entity) => ({ entity, rule: "route" as const, confidence: 0.8 }));
		}
		if (OUTLET_BY_FEED.has(o.source)) {
			const item = v as unknown as NewsItem;
			if (typeof item.title !== "string") return [];
			return dedupe(headline(o.source, item));
		}
		return [];
	};

	return { place, text, near, observation, sources };
}

let cached: Linker | null = null;

/** The linker over the built-in registry. */
export function linker(): Linker {
	cached ??= linkerFor(registry());
	return cached;
}
