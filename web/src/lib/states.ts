import { STATES } from "../map/geometry.gen.ts";

const NAMES = new Map(STATES.map((s) => [s.iso, s.name]));

export function stateName(iso: string | null | undefined): string {
	return iso ? (NAMES.get(iso) ?? iso) : "";
}

/** "Nueva Esparta" → "nueva-esparta": the address of a place's page (/lugar/nueva-esparta). */
export function slugify(name: string): string {
	return name
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** Formal prefixes people drop from municipality names ("Bolivariano Guaicaipuro" is Guaicaipuro). */
const MUNICIPAL_PREFIX = /^(Indígena Bolivariano|Autónomo|Bolivariano)\s+/;

/**
 * A municipality's segment in its entity id and page address, as the ontology builds it (src/ontology/slug.ts):
 * "Bolivariano Guaicaipuro" → "guaicaipuro". A test ties the two.
 */
export function municipalitySlug(name: string): string {
	return slugify(name.replace(MUNICIPAL_PREFIX, ""));
}

/** State ISO code → slug, and back. */
export const STATE_SLUG = new Map(STATES.map((s) => [s.iso, slugify(s.name)]));
const BY_SLUG = new Map([...STATE_SLUG].map(([iso, slug]) => [slug, iso]));

export function stateBySlug(slug: string): string | null {
	return BY_SLUG.get(slug) ?? null;
}

/** INE code of a state ("VE23") → ISO ("VE-V"). */
export const ISO_BY_CODE = new Map(STATES.map((s) => [s.code, s.iso]));
