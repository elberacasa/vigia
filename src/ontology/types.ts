import type { Json } from "../core/types.ts";

/**
 * The entity model: every place, facility, network, outlet and institution a signal can be about, with a stable,
 * human-readable id (`ve.zulia.maracaibo`, `infra.planta-centro`, `asn.8048`, `outlet.el-pitazo`, `inst.bcv`).
 * Entities are data, not observations: they change only when the registry's inputs are rebuilt, and every entity
 * names the dataset (and so the licence) it comes from.
 */

export type EntityType =
	| "country"
	| "state"
	| "municipality"
	| "parish"
	| "infrastructure"
	| "network"
	| "outlet"
	| "institution"
	| "camera";

export const ENTITY_TYPES: readonly EntityType[] = [
	"country",
	"state",
	"municipality",
	"parish",
	"infrastructure",
	"network",
	"outlet",
	"institution",
	"camera",
];

export type InfraKind =
	| "power-plant"
	| "substation"
	| "power-grid"
	| "refinery"
	| "petrochemical"
	| "fuel-depot"
	| "oil-field"
	| "gas-field"
	| "port"
	| "oil-terminal"
	| "airport"
	| "dam"
	| "reservoir"
	| "hospital";

export type NetworkKind = "isp" | "asn";

export type InstitutionKind = "branch" | "presidency" | "ministry" | "agency" | "state-company" | "security";

export type Bilingual = { readonly es: string; readonly en: string };

/** How one entity relates to another besides containment. */
export type RelationKind =
	/** Runs the facility or network (PDVSA runs a refinery, CANTV runs AS8048). */
	| "operator"
	/** An ISP's autonomous systems. */
	| "network-of"
	/** An institution publishes this source's figures (the BCV publishes the official rate). */
	| "publishes"
	/** A body attached to a ministry or another body ("adscrito"). */
	| "attached-to";

export type Relation = { readonly rel: RelationKind; readonly id: string };

export type DatasetId =
	| "cod-ab-ven"
	| "osm"
	| "ourairports"
	| "imf-portwatch-ports"
	| "flare-facilities"
	| "vigia-isps"
	| "vigia-outlets"
	| "vigia-institutions"
	| "vigia-cameras";

export interface Entity {
	readonly id: string;
	readonly type: EntityType;
	/** Subtype: an InfraKind, a NetworkKind, an InstitutionKind, an outlet's stance; null for places. */
	readonly kind: string | null;
	readonly name: Bilingual;
	/** Short label for tight places ("Alto Orinoco", "BCV"); null when the name is already short. */
	readonly short: string | null;
	/** Other names people search by (accents and prefixes dropped, acronyms, former names). */
	readonly aliases: readonly string[];
	/**
	 * Containment, nearest first: a municipality's state, a parish's municipality, a facility's parish or
	 * municipality. Only the direct parent is listed; ancestors follow from it.
	 */
	readonly parents: readonly string[];
	readonly related: readonly Relation[];
	/** A representative point (label point, facility centre); null for entities without a place. */
	readonly point: { readonly lat: number; readonly lon: number } | null;
	/** Where the entity's geometry lives, e.g. "cod-ab:VE0101", "osm:way/102819548"; null without one. */
	readonly geometry: string | null;
	/** External codes: P-code, ISO 3166-2, ASN, IATA/ICAO, OSM id, PortWatch id, outlet feed ids. */
	readonly codes: Readonly<Record<string, string>>;
	readonly attributes: Readonly<Record<string, Json>>;
	/** The dataset the entity itself comes from (its licence and attribution). */
	readonly dataset: DatasetId;
}

export type Dataset = {
	readonly id: DatasetId;
	readonly name: string;
	readonly url: string;
	readonly licence: { readonly id: string; readonly name: string; readonly url: string };
	readonly attribution: string;
	/** When the inputs were retrieved (ISO date) or the list was last verified. */
	readonly retrieved: string;
	readonly note: string | null;
};
