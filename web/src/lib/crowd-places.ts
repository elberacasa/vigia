/**
 * The municipalities a crowd report can be about, from the page's own names index (lib/places.gen.ts: INE's 335
 * municipalities and the cities of 30,000+ people, which point to their municipality), for the report's picker.
 * Pure and tested (crowd-places.test.ts). The server takes the P-code (`VE2313`) as well as the entity id.
 */
import { ISO_BY_CODE, municipalitySlug, STATE_SLUG, stateName } from "./states.ts";

export interface MuniChoice {
	/** INE P-code, "VE2313": what the report sends. */
	code: string;
	/** Ontology id, "ve.zulia.maracaibo": for its page and for matching the room's selection. */
	id: string;
	name: string;
	stateIso: string;
	stateName: string;
	/** Cities of 30,000+ in it (GeoNames), so "Barquisimeto" finds Iribarren. */
	cities: string[];
}

export const fold = (s: string) =>
	s
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();

/** Every municipality, with its cities, from the packed index ("M2313Maracaibo|C2313Cabimas…"). */
export function muniChoices(packed: string): MuniChoice[] {
	const byCode = new Map<string, MuniChoice>();
	const cities: [string, string][] = [];
	for (const r of packed.split("|")) {
		const code = `VE${r.slice(1, 5)}`;
		const name = r.slice(5);
		if (r[0] === "C") {
			cities.push([code, name]);
			continue;
		}
		if (r[0] !== "M") continue;
		const iso = ISO_BY_CODE.get(code.slice(0, 4));
		const slug = iso ? STATE_SLUG.get(iso) : undefined;
		if (!iso || !slug) continue;
		byCode.set(code, {
			code,
			id: `ve.${slug}.${municipalitySlug(name)}`,
			name,
			stateIso: iso,
			stateName: stateName(iso),
			cities: [],
		});
	}
	for (const [code, name] of cities) {
		const m = byCode.get(code);
		if (m && fold(m.name) !== fold(name)) m.cities.push(name);
	}
	return [...byCode.values()].sort(
		(a, b) => a.stateName.localeCompare(b.stateName, "es") || a.name.localeCompare(b.name, "es"),
	);
}

/**
 * Municipalities matching what the person typed: by name, city or state, accents and case ignored; a name that
 * starts with the words first. At most `limit`.
 */
export function searchMunis(all: readonly MuniChoice[], query: string, limit = 8): MuniChoice[] {
	const q = fold(query.trim());
	if (q.length < 2) return [];
	const scored: [number, MuniChoice][] = [];
	for (const m of all) {
		const name = fold(m.name);
		const city = m.cities.map(fold);
		const state = fold(m.stateName);
		const score = name.startsWith(q)
			? 0
			: name.split(/\s+/).some((w) => w.startsWith(q))
				? 1
				: city.some((c) => c.startsWith(q))
					? 2
					: name.includes(q) || city.some((c) => c.includes(q))
						? 3
						: state.startsWith(q)
							? 4
							: -1;
		if (score >= 0) scored.push([score, m]);
	}
	return scored
		.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name, "es"))
		.slice(0, limit)
		.map(([, m]) => m);
}
