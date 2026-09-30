/**
 * Entity id segments: lowercase ASCII words joined by hyphens, from a Spanish name. "Anzoátegui" → "anzoategui",
 * "Peña Larga" → "pena-larga" (ñ becomes n in ids only; names keep it), "23 de Enero" → "23-de-enero".
 */
export function slug(name: string): string {
	return name
		.toLowerCase()
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** Formal prefixes of municipality names that people drop ("Bolivariano Guaicaipuro" is "Guaicaipuro"). */
const MUNICIPAL_PREFIX = /^(Indígena Bolivariano|Autónomo|Bolivariano)\s+/;

/** The name people use for a municipality: formal prefixes dropped. */
export function shortMunicipalityName(name: string): string {
	return name.replace(MUNICIPAL_PREFIX, "");
}

/** Id segment pattern: what `slug` produces (tests check every id against it). */
export const SEGMENT = /^[a-z0-9]+(-[a-z0-9]+)*$/;
