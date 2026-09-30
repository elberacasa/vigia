/**
 * Hand-checked names that tie the state and sanctions feeds to entities, read against the stored rows on
 * 2026-09-28 (OFAC's Venezuela programmes: 104 entity records and the titles of the 88 officials OFAC's list lets
 * Vigía name; OFAC's 43 Venezuela general licences; Wikidata's 43 Venezuelan offices). No model and no fuzzy match:
 * an OFAC record by its own id, a Wikidata office by its QID, and whole-word phrases in titles.
 *
 * - `OFAC_STATE_BODIES`: OFAC entity records that are Venezuelan state bodies (the BCV, PDVSA, Conviasa, the state
 *   banks, CVG's Minerven, INEA, the DGCIM), by OFAC's own uid. Foreign subsidiaries (BANDES Uruguay, Banco Prodem in
 *   Bolivia), joint ventures (Evrofinance Mosnarbank) and private companies are not state bodies and are not linked,
 *   except Globovisión, which is an outlet Vigía reads: its designation links to the outlet as OFAC names it.
 * - `STATE_PHRASES`: names of institutions as they appear in OFAC titles ("Rector of Venezuela's National Electoral
 *   Council"), Wikidata positions ("magistrado del Tribunal Supremo de Justicia de Venezuela"), licence titles
 *   ("… Involving Petróleos de Venezuela, S.A.") and Federal Register titles. "Former" offices link too: the
 *   designation concerns the person in those capacities.
 * - `WIKIDATA_OFFICES`: each Venezuelan office Wikidata lists, to the institution that holds it (a ministry's
 *   lineage goes to today's ministry of the same portfolio: "ministro de Hacienda" → Economía y Finanzas) or to the
 *   state of a governorship. Offices of ministries Vigía has no entity for (Alimentación, Comunicación, Petróleo,
 *   Pueblos Indígenas) and of historical ministries without a successor (Fomento, Obras Públicas, Justicia,
 *   Juventud y Deportes, split in two) are not linked.
 */
import { normalize } from "../news/text.ts";

export const OFAC_STATE_BODIES: Readonly<Record<string, { readonly entity: string; readonly name: string }>> =
	{
		"26727": { entity: "inst.bcv", name: "BANCO CENTRAL DE VENEZUELA" },
		"26367": { entity: "inst.pdvsa", name: "PETROLEOS DE VENEZUELA, S.A." },
		"28230": {
			entity: "inst.conviasa",
			name: "CONSORCIO VENEZOLANO DE INDUSTRIAS AERONAUTICAS Y SERVICIOS AEREOS, S.A.",
		},
		"26590": { entity: "inst.banco-de-venezuela", name: "BANCO DE VENEZUELA SA BANCO UNIVERSAL" },
		"26589": {
			entity: "inst.banco-bicentenario",
			name: "BANCO BICENTENARIO DEL PUEBLO, DE LA CLASE OBRERA, MUJER Y COMUNIAS, BANCO UNIVERSAL C.A.",
		},
		"26587": { entity: "inst.bandes", name: "BANCO DE DESARROLLO ECONOMICO Y SOCIAL DE VENEZUELA" },
		"26523": { entity: "inst.minerven", name: "MINERVEN" },
		"29506": { entity: "inst.inea", name: "INSTITUTO NACIONAL DE LOS ESPACIOS ACUATICOS E INSULARES" },
		"27008": { entity: "inst.dgcim", name: "GENERAL DIRECTORATE OF MILITARY COUNTERINTELLIGENCE" },
		"26218": { entity: "outlet.globovision", name: "GLOBOVISION TELE C.A." },
	};

/**
 * [phrase as written, entity id]; matched whole-word on the normalised text, longest phrase first. An empty id
 * consumes the words without a link (a longer name that contains an institution's name but is another body).
 */
export const STATE_PHRASES: readonly (readonly [string, string])[] = [
	// public powers
	["President of the Bolivarian Republic of Venezuela", "inst.presidencia"],
	["presidente de Venezuela", "inst.presidencia"],
	["Vice President of Venezuela", "inst.vicepresidencia"],
	["Executive Vice President", "inst.vicepresidencia"],
	["vicepresidente de Venezuela", "inst.vicepresidencia"],
	// The 2017 constituent assembly is another body: consumed without a link, so "Asamblea Nacional" cannot match it.
	["Asamblea Nacional Constituyente", ""],
	["National Assembly", "inst.an"],
	["Asamblea Nacional", "inst.an"],
	["diputado de Venezuela", "inst.an"],
	["Supreme Court of Justice", "inst.tsj"],
	["Tribunal Supremo de Justicia", "inst.tsj"],
	["National Electoral Council", "inst.cne"],
	["Consejo Nacional Electoral", "inst.cne"],
	["Public Ministry", "inst.ministerio-publico"],
	["Prosecutor General", "inst.ministerio-publico"],
	["Fiscal General", "inst.ministerio-publico"],
	["Ombudsman", "inst.defensoria"],
	["Defensor del Pueblo", "inst.defensoria"],
	["Republican Moral Council", "inst.consejo-moral-republicano"],
	// ministries
	["Minister of Defense", "inst.mpp-defensa"],
	["ministro de Defensa", "inst.mpp-defensa"],
	["Minister of Interior", "inst.mpp-relaciones-interiores"],
	["Minister of Education", "inst.mpp-educacion"],
	["Minister of Popular Power for Education", "inst.mpp-educacion"],
	["Minister of Culture", "inst.mpp-cultura"],
	// OFAC's own spelling in one title.
	["Minster of Culture", "inst.mpp-cultura"],
	["Minister of Popular Power for Culture", "inst.mpp-cultura"],
	["Minister of the Office of the Presidency", "inst.mpp-despacho-presidencia"],
	["Minister of Electrical Power", "inst.mpp-energia-electrica"],
	["Energía Eléctrica", "inst.mpp-energia-electrica"],
	["Minister of Popular Power for Water", "inst.mpp-atencion-aguas"],
	["Economy and Finance", "inst.mpp-economia-finanzas"],
	["ministro de Ciencia y Tecnología", "inst.mpp-ciencia-tecnologia"],
	["ministro de Planificación", "inst.mpp-planificacion"],
	["ministro de Transporte", "inst.mpp-transporte"],
	["Comunas y los Movimientos Sociales", "inst.mpp-comunas"],
	["ministros de Vivienda", "inst.mpp-habitat-vivienda"],
	["ministro de Vivienda", "inst.mpp-habitat-vivienda"],
	// security bodies
	["Bolivarian National Intelligence Service", "inst.sebin"],
	["SEBIN", "inst.sebin"],
	["Bolivarian National Police", "inst.pnb"],
	["Bolivarian National Guard", "inst.gnb"],
	["National Armed Forces", "inst.fanb"],
	["FANB", "inst.fanb"],
	["Bolivarian Army", "inst.fanb"],
	["Military Counterintelligence", "inst.dgcim"],
	// agencies and state companies
	["Central Bank of Venezuela", "inst.bcv"],
	["Banco Central de Venezuela", "inst.bcv"],
	["Petróleos de Venezuela", "inst.pdvsa"],
	["PDVSA", "inst.pdvsa"],
	["PDV Holding", "inst.pdv-holding"],
	["CITGO", "inst.citgo"],
	["Conviasa", "inst.conviasa"],
	["Consorcio Venezolano de Industrias Aeronáuticas", "inst.conviasa"],
	["Economic and Social Development Bank", "inst.bandes"],
	["BANDES", "inst.bandes"],
	["Venezuelan Corporation of Guayana", "inst.cvg"],
	["Corporación Venezolana de Guayana", "inst.cvg"],
	["Minerven", "inst.minerven"],
	["Banco de Venezuela", "inst.banco-de-venezuela"],
];

export const WIKIDATA_OFFICES: Readonly<Record<string, string>> = {
	Q11942698: "inst.presidencia", // presidente de Venezuela
	Q3556895: "inst.vicepresidencia", // Vicepresidente de Venezuela
	Q137530422: "inst.bcv", // Presidente del Banco Central de Venezuela
	Q141161530: "inst.defensoria", // Defensor del Pueblo
	Q131748591: "inst.ministerio-publico", // Prosecutor General of Venezuela
	Q6597955: "inst.an", // Presidente de la Asamblea Nacional
	Q21970629: "inst.an", // Primer Vicepresidente de la Asamblea Nacional
	Q28706232: "inst.mpp-agricultura-productiva", // ministro de Agricultura
	Q114606437: "inst.mpp-ciencia-tecnologia", // ministro de Ciencia y Tecnología
	Q114606460: "inst.mpp-ciencia-tecnologia", // Ministro del Poder Popular para la Ciencia y Tecnología
	Q113578049: "inst.mpp-defensa", // ministro de Defensa
	Q28706262: "inst.mpp-economia-finanzas", // ministro de Hacienda
	Q114606316: "inst.mpp-planificacion", // ministro de Planificación
	Q113470515: "inst.mpp-relaciones-exteriores", // Ministro de Relaciones Exteriores
	Q114606382: "inst.mpp-trabajo", // ministro de Trabajo
	Q114606356: "inst.mpp-transporte", // ministro de Transporte
	Q114606400: "inst.mpp-turismo", // ministro de Turismo
	Q113578038: "inst.mpp-ecosocialismo", // ministro del Ambiente (Ambiente → Ecosocialismo)
	Q141552714: "inst.mpp-deporte", // ministro del Deporte
	Q114606325: "inst.mpp-despacho-presidencia", // Oficina de la Presidencia
	Q114605062: "inst.mpp-pesca", // Pesca y Acuicultura
	Q114606511: "inst.mpp-comunas", // Comunas y Movimientos Sociales
	Q114606335: "inst.mpp-habitat-vivienda", // ministros de Vivienda
};

type Phrase = { words: string[]; entity: string };

const PHRASES: readonly Phrase[] = STATE_PHRASES.map(([p, entity]) => ({
	words: normalize(p).split(" "),
	entity,
})).sort((a, b) => b.words.length - a.words.length);

/** Entities named in a text by `STATE_PHRASES` (whole words, longest phrase first, no overlapping matches). */
export function stateNamesIn(text: string): string[] {
	const words = normalize(text).split(" ").filter(Boolean);
	const used = new Set<number>();
	const out = new Set<string>();
	for (const p of PHRASES)
		for (let i = 0; i + p.words.length <= words.length; i++) {
			if (!p.words.every((w, k) => words[i + k] === w)) continue;
			if (p.words.some((_, k) => used.has(i + k))) continue;
			for (let k = 0; k < p.words.length; k++) used.add(i + k);
			if (p.entity) out.add(p.entity);
		}
	return [...out].sort();
}

/** A fingerprint of these lists (part of the stored links' version: a change relinks the archive). */
export function stateNamesFingerprint(): string {
	return Bun.hash(JSON.stringify([OFAC_STATE_BODIES, STATE_PHRASES, WIKIDATA_OFFICES])).toString(16);
}
