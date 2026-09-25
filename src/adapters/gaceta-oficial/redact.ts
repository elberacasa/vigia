/**
 * What of a Gaceta sumario title Vigía may keep. Safety by construction, not by redaction: a title is kept word for
 * word only when it has one of a few act forms that name no one (laws, and decrees, resolutions, notices… "mediante
 * el cual se dicta / crea / modifica / corrige / aprueba…") AND nothing in it points at a person. Every other title is
 * reduced to a category ("designación", "jubilación o pensión"…) that the panel counts: its text is never stored,
 * served or exported.
 *
 * Code review 4 (H1) showed why the earlier approach (find the name, replace it) fails: names come after
 * "Ciudadano", after a rank or a title ("General de Brigada", "Dr."), in quotes, with no cue at all ("se designa a
 * JOSÉ LUIS PÉREZ"), and identity numbers come in a dozen spellings. A wording the redaction does not recognise
 * would have been published. Here a wording the allowlist does not recognise is withheld instead.
 *
 * Identity numbers (cédula, C.I., V-/E-/J-/G- numbers, RIF, pasaporte, Inpreabogado, "N°" with 6 to 9 digits) are
 * stripped from every string the adapter stores (`stripIds`), and a title that had one is never listed.
 */

/** Why a title is not listed; the panel counts acts per category. */
export type ActCategory =
	| "designacion"
	| "delegacion"
	| "traslado"
	| "jubilacion"
	| "ascenso"
	| "condecoracion"
	| "personal"
	| "otro";

export const ACT_CATEGORIES: readonly ActCategory[] = [
	"designacion",
	"delegacion",
	"traslado",
	"jubilacion",
	"ascenso",
	"condecoracion",
	"personal",
	"otro",
];

// ---------------------------------------------------------------------------------------------------------
// Identity numbers

const NUM_LABEL = String.raw`(?:\s*N\.?\s*[º°o]?\.?\s*|\s*No\.?\s*|\s*Nro\.?\s*|\s*n[uú]mero\s*)?:?\s*`;
const ID_PATTERNS: readonly RegExp[] = [
	// "cédula de identidad N° V-12.345.678", "cédula N° 12.345.678", "cédula 12345678"
	new RegExp(
		String.raw`(?:portador[ae]?|titular)?\s*(?:de\s+la\s+)?c[ée]dula(?:\s+de\s+identidad)?${NUM_LABEL}(?:[VEve]\s*-?\s*)?\d[\d.,\s]*\d`,
		"gu",
	),
	// "C.I. V-12345678", "C.I. N° 5.555.555", "CI: 12345678"
	new RegExp(String.raw`\bC\.?\s?I\.?${NUM_LABEL}(?:[VEve]\s*-?\s*)?\d[\d.,]*\d`, "gu"),
	// "RIF J-12345678-9", "R.I.F. G-20000001-5", "Pasaporte N° 123456789", "Inpreabogado N° 123.456"
	new RegExp(
		String.raw`(?:\bR\.?\s?I\.?\s?F\.?|\bpasaporte|\binpreabogado|\bI\.?P\.?S\.?A\.?)${NUM_LABEL}(?:[A-Za-z]\s*-?\s*)?\d[\d.,\-]*\d`,
		"giu",
	),
	// A bare lettered number: "V-12.345.678", "E-84.123.456", "V- 9.876.543", "J-12345678-9", "V12345678"
	/\b[VEJGPvejgp]\s*-?\s*\d{1,3}(?:[.,]?\d{3}){1,2}(?:\s*-\s*\d)?\b/gu,
	// "N° 12.345.678" (a dotted number of 7 to 9 digits) and "N° 123456789" (6 to 9 digits)
	/\bN\.?\s*[º°]\.?\s*(?:\d{1,3}(?:\.\d{3}){2}|\d{6,9})\b/gu,
	// Any dotted number of 7 to 9 digits ("12.345.678"): Gaceta numbers have 4 or 5 digits, decrees 4.
	/\b\d{1,3}\.\d{3}\.\d{3}\b/gu,
];

/** Removes every identity-number pattern; returns the text and whether anything was removed. */
export function stripIds(s: string): { text: string; found: boolean } {
	let out = s;
	for (const re of ID_PATTERNS) out = out.replace(re, " ");
	const found = out !== s;
	if (!found) return { text: s, found };
	return {
		text: out
			.replace(/\(\s*\)/g, "")
			.replace(/\s+([,;.])/g, "$1")
			.replace(/([,;])(?:\s*[,;])+/g, "$1")
			.replace(/\s+/g, " ")
			.trim(),
		found,
	};
}

// ---------------------------------------------------------------------------------------------------------
// Classification

/** Lowercase, accents removed, whitespace collapsed: the form every rule below is written against. */
function fold(s: string): string {
	return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Verbs and nouns of acts about a person, by category, first match wins (folded text). */
const PERSONAL: readonly [ActCategory, RegExp][] = [
	["jubilacion", /\b(?:jubila\w*|pension\w*|retiro|sobrevivientes?|incapacidad|invalidez)\b/u],
	["ascenso", /\b(?:asciende|ascienden|ascenso|ascensos|ascendid[oa]s?)\b/u],
	["traslado", /\b(?:traslada|trasladan|traslado|traslados|trasladad[oa]s?)\b/u],
	["delegacion", /\b(?:delega|delegan|delegacion|delegaciones|delegad[oa]s?)\b/u],
	[
		"designacion",
		/\b(?:designa|designan|designase|designacion|designaciones|designad[oa]s?|nombra|nombran|nombramientos?|nombrad[oa]s?|encarga|encargan|juramenta\w*|ratifica\w*|reincorpora\w*|remueve|remueven|remocion|destituye\w*|destitucion|suspende\w* (?:al?|del?) (?:la |los |las )?(?:ciudadan|funcionari)\w*|cese|ceses)\b/u,
	],
	["condecoracion", /\b(?:condecora\w*|orden al merito|reconocimiento|distincion|botones?)\b/u],
	[
		"personal",
		/\b(?:ciudadan\w*|senor(?:a|as|es)?|excelentisim\w*|persona|personas|funcionari\w*|trabajador(?:a|as|es)?|personal docente|beneficio\w*|otorga\w*|concede\w*|acredita\w*|habilita\w*|autoriza\w* (?:al?|a los|a las) |en su (?:caracter|condicion)|en calidad de|a cargo de|en la persona de|fallec\w*|duelo|homenaje|exequatur|cartas credenciales|recibio|carta de naturaleza|nacionalidad|naturaliza\w*|expropia\w*|adjudica\w*|licencia a|permiso a|sancion\w*|multa\w*)\b/u,
	],
];

/** Ranks, honorifics and offices; one followed by a capitalised word that is not part of an office is a name. */
const OFFICE =
	/\b(?:Dr|Dra|Drs|Ing|Lic|Licda|Abg|Abog|Prof|Profa|Arq|Econ|Msc|MSc|Cnel|Gral|Tcnel|Cap|Tte|Sgto|Pbro)\.?\s+\p{Lu}|\b(?:Doctor|Doctora|Ingenier[oa]|Licenciad[oa]|Abogad[oa]|Profesor(?:a)?|Coronel|Teniente(?: Coronel)?|Capit[aá]n|Mayor|Sargento|Almirante|Vicealmirante|Contralmirante|Comandante|General(?: en Jefe| de Brigada| de Divisi[oó]n)?|Presidente|Presidenta|Vicepresidente|Vicepresidenta|Ministro|Ministra|Viceministro|Viceministra|Director|Directora|Gerente|Fiscal|Embajador(?:a)?|C[oó]nsul|Diputad[oa]|Gobernador(?:a)?|Alcalde(?:sa)?|Magistrad[oa]|Juez(?:a)?|Contralor(?:a)?|Rector(?:a)?|Monse[ñn]or|Padre|Hermana?|Don|Doña)\s+(?!(?:de|del|la|las|los|el|y|e|o|u|en|para|con|a|al|General|Generales|Ejecutiv[oa]s?|Nacional(?:es)?|Sectorial(?:es)?|Encargad[oa]s?|Adjunt[oa]s?|Interin[oa]s?|Provisori[oa]s?|Principal(?:es)?|Suplentes?|Estadal(?:es)?|Regional(?:es)?|Municipal(?:es)?|Superior(?:es)?|Auxiliar(?:es)?|Titular(?:es)?|Constitucional|Encargada|Consejer[oa]|Plenipotenciari[oa]|Extraordinari[oa]|Honorari[oa])\b)\p{Lu}/u;

/** Two or more consecutive words in capitals ("JOSÉ PÉREZ", "INVERSIONES PÉREZ C.A."): names and companies. */
const CAPS_RUN = /(?<!\p{L})\p{Lu}[\p{Lu}'’-]+\s+\p{Lu}[\p{Lu}'’-]+(?!\p{L})/u;

/** A quoted run in capitals ("“LUIS DE VICENTE”", `"JUAN PÉREZ"`), often a person's or a place's name. */
const QUOTED_CAPS = /["“«][^"”»]*\p{Lu}{3,}[^"”»]*["”»]/u;

/** The act forms that name no one: instrument, optional number, "mediante el cual se" + a general verb. */
const INSTRUMENT = `(?:decretos?|resolucion(?:es)?(?: conjunta)?|providencias?(?: administrativas?)?|avisos?(?: oficial)?|acuerdos?|reglamentos?|circular(?:es)?|normas?|oficios?|actas?)`;
const NUMBER = String.raw`(?:\s+(?:n|nro|no)?\s*[.º°]*\s*[\w.\-/]+)?`;
const GENERAL_VERB = `(?:dicta|dictan|crea|crean|suprime|suprimen|ordena|ordenan|corrige|corrigen|aclara|modifica|modifican|establece|establecen|fija|fijan|aprueba|aprueban|regula|regulan|reforma|reforman|deroga|derogan|informa|informan|constituye|constituyen|prorroga|prorrogan|declara|declaran|decreta|publica|publican|convoca|convocan|reajusta|reajustan|ajusta|ajustan|exonera|exoneran|reestructura|reestructuran|reorganiza|reorganizan|adscribe|adscriben|transfiere|transfieren|procede|autoriza la (?:distribucion|creacion|publicacion|transferencia|insubsistencia|rectificacion)|acuerda la (?:creacion|supresion)|dan? a conocer|hace saber|determina|determinan|actualiza|actualizan|designa la sede|instruye|instruyen|prohibe|prohiben|restringe|restringen|suspende la|suspenden las?|habilita el|habilita la)`;
const ALLOWED: readonly RegExp[] = [
	/^ley(?:es)?\b/u,
	new RegExp(
		String.raw`^${INSTRUMENT}${NUMBER},?\s+(?:mediante|por|a traves de)\s+(?:el|la|los|las)\s+cual(?:es)?\s+se\s+${GENERAL_VERB}\b`,
		"u",
	),
	new RegExp(String.raw`^${INSTRUMENT}${NUMBER},?\s+(?:que|con el que|con la que)\s+${GENERAL_VERB}\b`, "u"),
	/^acuerdos?\s+(?:en|de)\s+(?:respaldo|rechazo|apoyo|solidaridad|condena)\b/u,
];

export type ActClass =
	| { listed: true; title: string; category: null }
	| { listed: false; title: null; category: ActCategory };

/**
 * Decides whether a sumario title may be kept. `title` is the stored text when listed (identity numbers stripped,
 * whitespace collapsed); an unlisted act keeps only its category.
 */
export function classifyAct(raw: string): ActClass {
	const { text, found } = stripIds(raw.replace(/\s+/g, " ").trim());
	const folded = fold(text);
	for (const [category, re] of PERSONAL) if (re.test(folded)) return { listed: false, title: null, category };
	if (found || text.includes("[") || OFFICE.test(text) || CAPS_RUN.test(text) || QUOTED_CAPS.test(text))
		return { listed: false, title: null, category: "personal" };
	if (!ALLOWED.some((re) => re.test(folded))) return { listed: false, title: null, category: "otro" };
	return { listed: true, title: text, category: null };
}

/** Spanish and English labels per category, singular and plural (the panel's counts). */
export const CATEGORY_LABEL: Record<ActCategory, { es: [string, string]; en: [string, string] }> = {
	designacion: { es: ["designación", "designaciones"], en: ["appointment", "appointments"] },
	delegacion: { es: ["delegación", "delegaciones"], en: ["delegation", "delegations"] },
	traslado: { es: ["traslado", "traslados"], en: ["transfer", "transfers"] },
	jubilacion: {
		es: ["jubilación o pensión", "jubilaciones o pensiones"],
		en: ["retirement or pension", "retirements or pensions"],
	},
	ascenso: { es: ["ascenso", "ascensos"], en: ["promotion", "promotions"] },
	condecoracion: { es: ["condecoración", "condecoraciones"], en: ["decoration", "decorations"] },
	personal: {
		es: ["otro acto sobre personas", "otros actos sobre personas"],
		en: ["other act about people", "other acts about people"],
	},
	otro: { es: ["acto no listado", "actos no listados"], en: ["unlisted act", "unlisted acts"] },
};
