import { project } from "./project.ts";
import type { FacilityGroup } from "./view.ts";

/**
 * The ontology's facilities for the map (scripts/build-facilities.ts writes the data): parsed once, on demand, from
 * two chunks (health centres apart, 790 of them). Positions are the entity's representative point, as the server's
 * `/api/v1/entities/{id}` gives it, rounded to ~100 m.
 */

export interface Facility {
	/** Ontology id: "infra.planta-centro". */
	id: string;
	kind: string;
	group: FacilityGroup;
	lat: number;
	lon: number;
	/** ISO 3166-2 of its state ("VE-G"); null when outside every state (offshore). */
	iso: string | null;
	name: string;
	/** Its position in the map's units, projected once when parsed. */
	x: number;
	y: number;
}

const KIND: Record<string, { kind: string; group: FacilityGroup }> = {
	P: { kind: "power-plant", group: "energia" },
	S: { kind: "substation", group: "energia" },
	R: { kind: "refinery", group: "petroleo" },
	Q: { kind: "petrochemical", group: "petroleo" },
	F: { kind: "fuel-depot", group: "petroleo" },
	O: { kind: "oil-field", group: "petroleo" },
	N: { kind: "gas-field", group: "petroleo" },
	L: { kind: "oil-terminal", group: "petroleo" },
	T: { kind: "port", group: "transporte" },
	A: { kind: "airport", group: "transporte" },
	D: { kind: "dam", group: "agua" },
	E: { kind: "reservoir", group: "agua" },
	H: { kind: "hospital", group: "salud" },
};

export const GROUP_KINDS: Record<FacilityGroup, readonly string[]> = {
	energia: ["power-plant", "substation", "power-grid"],
	petroleo: ["refinery", "petrochemical", "fuel-depot", "oil-field", "gas-field", "oil-terminal"],
	transporte: ["port", "airport"],
	agua: ["dam", "reservoir"],
	salud: ["hospital"],
};

export function groupOfKind(kind: string): FacilityGroup | null {
	for (const [g, kinds] of Object.entries(GROUP_KINDS)) if (kinds.includes(kind)) return g as FacilityGroup;
	return null;
}

/** Exported for tests: one "kind|slug|lat|lon|state|name" record per line. */
export function parseFacilities(text: string): Facility[] {
	const out: Facility[] = [];
	for (const line of text.split("\n")) {
		const [code, slug, lat, lon, state, ...name] = line.split("|");
		const k = KIND[code ?? ""];
		if (!k || !slug) continue;
		const [x, y] = project(Number(lon), Number(lat));
		out.push({
			id: `infra.${slug}`,
			x,
			y,
			kind: k.kind,
			group: k.group,
			lat: Number(lat),
			lon: Number(lon),
			iso: state ? `VE-${state}` : null,
			name: name.join("|"),
		});
	}
	return out;
}

export interface GridLine {
	id: string;
	kv: number;
	d: string;
}

let core: Promise<{ facilities: Facility[]; grid: readonly GridLine[] }> | null = null;
let health: Promise<Facility[]> | null = null;

/** Everything but health centres, and the transmission grid (≈ 21 KB gzip). */
export function loadCore(): Promise<{ facilities: Facility[]; grid: readonly GridLine[] }> {
	core ??= import("./facilities.gen.ts")
		.then((m) => ({ facilities: parseFacilities(m.FACILITIES), grid: m.GRID }))
		.catch((err) => {
			core = null;
			throw err;
		});
	return core;
}

/** Health centres (≈ 19 KB gzip), only when that group is shown or a page lists them. */
export function loadHealth(): Promise<Facility[]> {
	health ??= import("./health.gen.ts")
		.then((m) => parseFacilities(m.HEALTH))
		.catch((err) => {
			health = null;
			throw err;
		});
	return health;
}
