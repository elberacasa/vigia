/**
 * Words for entity types and subtypes (src/ontology/types.ts), shared by the entity pages, the inspector, the
 * command palette's entity results and the facilities map layer. Outlet stances are the news panel's own words
 * (src/adapters/rss/factory.ts STANCE_LABELS); a test keeps them equal.
 */
import type { Lang } from "./format.ts";

type Words = { readonly es: string; readonly en: string };

export const TYPE_WORD: Readonly<Record<string, Words>> = {
	country: { es: "País", en: "Country" },
	state: { es: "Estado", en: "State" },
	municipality: { es: "Municipio", en: "Municipality" },
	parish: { es: "Parroquia", en: "Parish" },
	infrastructure: { es: "Instalación", en: "Facility" },
	network: { es: "Red", en: "Network" },
	outlet: { es: "Medio", en: "Outlet" },
	institution: { es: "Institución", en: "Institution" },
	camera: { es: "Cámara pública", en: "Public camera" },
};

/** Plural headings for grouped lists ("Municipios", "Instalaciones"). */
export const TYPE_PLURAL: Readonly<Record<string, Words>> = {
	country: { es: "Países", en: "Countries" },
	state: { es: "Estados", en: "States" },
	municipality: { es: "Municipios", en: "Municipalities" },
	parish: { es: "Parroquias", en: "Parishes" },
	infrastructure: { es: "Instalaciones", en: "Facilities" },
	network: { es: "Redes", en: "Networks" },
	outlet: { es: "Medios", en: "Outlets" },
	institution: { es: "Instituciones", en: "Institutions" },
	camera: { es: "Cámaras públicas", en: "Public cameras" },
};

export const INFRA_WORD: Readonly<Record<string, Words>> = {
	"power-plant": { es: "Planta eléctrica", en: "Power plant" },
	substation: { es: "Subestación", en: "Substation" },
	"power-grid": { es: "Red de transmisión", en: "Transmission grid" },
	refinery: { es: "Refinería", en: "Refinery" },
	petrochemical: { es: "Complejo petroquímico", en: "Petrochemical complex" },
	"fuel-depot": { es: "Depósito de combustible", en: "Fuel depot" },
	"oil-field": { es: "Campo petrolero", en: "Oil field" },
	"gas-field": { es: "Campo de gas", en: "Gas field" },
	port: { es: "Puerto", en: "Port" },
	"oil-terminal": { es: "Terminal petrolero", en: "Oil terminal" },
	airport: { es: "Aeropuerto", en: "Airport" },
	dam: { es: "Represa", en: "Dam" },
	reservoir: { es: "Embalse", en: "Reservoir" },
	// OSM's amenity=hospital here also tags ambulatorios and CDIs (LOG, ontology): the word says so.
	hospital: { es: "Centro de salud", en: "Health centre" },
};

export const INFRA_PLURAL: Readonly<Record<string, Words>> = {
	"power-plant": { es: "Plantas eléctricas", en: "Power plants" },
	substation: { es: "Subestaciones", en: "Substations" },
	"power-grid": { es: "Redes de transmisión", en: "Transmission grids" },
	refinery: { es: "Refinerías", en: "Refineries" },
	petrochemical: { es: "Complejos petroquímicos", en: "Petrochemical complexes" },
	"fuel-depot": { es: "Depósitos de combustible", en: "Fuel depots" },
	"oil-field": { es: "Campos petroleros", en: "Oil fields" },
	"gas-field": { es: "Campos de gas", en: "Gas fields" },
	port: { es: "Puertos", en: "Ports" },
	"oil-terminal": { es: "Terminales petroleros", en: "Oil terminals" },
	airport: { es: "Aeropuertos", en: "Airports" },
	dam: { es: "Represas", en: "Dams" },
	reservoir: { es: "Embalses", en: "Reservoirs" },
	hospital: { es: "Centros de salud", en: "Health centres" },
};

export const NETWORK_WORD: Readonly<Record<string, Words>> = {
	isp: { es: "Proveedor de internet", en: "Internet provider" },
	asn: { es: "Sistema autónomo (ASN)", en: "Autonomous system (ASN)" },
};

export const INSTITUTION_WORD: Readonly<Record<string, Words>> = {
	branch: { es: "Poder público", en: "Branch of state" },
	presidency: { es: "Presidencia", en: "Presidency" },
	ministry: { es: "Ministerio", en: "Ministry" },
	agency: { es: "Ente público", en: "Public body" },
	"state-company": { es: "Empresa del Estado", en: "State company" },
	security: { es: "Cuerpo de seguridad", en: "Security body" },
};

/** Outlet stances, as the news panel words them. */
export const STANCE_WORD: Readonly<Record<string, Words>> = {
	independent: { es: "independiente", en: "independent" },
	commercial: { es: "privado", en: "private" },
	state: { es: "estatal", en: "state" },
	"state-aligned": { es: "afín al gobierno", en: "government-aligned" },
	"state-funded": { es: "financiado por un Estado", en: "state-funded" },
	"public-broadcaster": { es: "servicio público", en: "public broadcaster" },
	ngo: { es: "ONG", en: "NGO" },
	partisan: { es: "partidista", en: "partisan" },
	agency: { es: "agencia", en: "agency" },
	aggregator: { es: "agregador", en: "aggregator" },
	multilateral: { es: "organismo multilateral", en: "multilateral body" },
	"trade-body": { es: "gremio", en: "trade or professional body" },
	user: { es: "añadida por ti", en: "added by you" },
};

/** "Planta eléctrica", "Proveedor de internet", "Medio · independiente", "Municipio": what an entity is. */
export function kindWord(type: string, kind: string | null, lang: Lang): string {
	const w =
		type === "infrastructure"
			? INFRA_WORD[kind ?? ""]
			: type === "network"
				? NETWORK_WORD[kind ?? ""]
				: type === "institution"
					? INSTITUTION_WORD[kind ?? ""]
					: undefined;
	if (w) return w[lang];
	const base = TYPE_WORD[type]?.[lang] ?? type;
	if (type === "outlet" && kind) {
		const stance = STANCE_WORD[kind]?.[lang];
		return stance ? `${base} ${stance}` : base;
	}
	return base;
}
