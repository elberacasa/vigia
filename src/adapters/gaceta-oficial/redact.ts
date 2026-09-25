/**
 * What of a Gaceta sumario title Vigía may keep. Public officials acting in office are named as the official gazette
 * names them (the project's decision, 2026-09-25, extended the same day); private persons never.
 *
 * - Acts about public posts and public honours, names included: appointments (designaciones, nombramientos,
 *   encargadurías), transfers to a post, delegations of a post's powers, promotions (ascensos, the armed forces'
 *   included), removals, dismissals, suspensions and reinstatements (ceses), and decorations.
 * - Acts of general scope: a few act forms (laws, and decrees, resolutions, notices… "mediante el cual se dicta /
 *   crea / modifica…"), listed when they name no one or name someone only by a public office ("el Ministro …").
 * - Other acts about named people, listed only when they name them as officials acting in office ("en su carácter
 *   de Presidenta (E)", credentials received by the President, the officials of a commission) and nothing marks a
 *   private party (a company, a lawyer's licence, a passport, a foreigner…).
 *
 * Never listed, only counted per category: pensions, jubilaciones, retiros and every other personal benefit or
 * social-security act (`PRIVATE_MATTER`, checked before anything is listed), private parties' matters, and any
 * wording the rules do not recognise (default deny). The category's text is never stored, served or exported.
 *
 * Code review 4 (H1) showed why the earlier approach (find the name, replace it) fails: names come after
 * "Ciudadano", after a rank or a title ("General de Brigada", "Dr."), in quotes, with no cue at all ("se designa a
 * JOSÉ LUIS PÉREZ"), and identity numbers come in a dozen spellings. A wording the redaction does not recognise
 * would have been published. Here a wording the allowlist does not recognise is withheld instead.
 *
 * Identity numbers (cédula, C.I., V-/E-/J-/G- numbers, RIF, pasaporte, Inpreabogado, "N°" with 6 to 9 digits) are
 * stripped from every string the adapter stores (`stripIds`), and from a listed title about officials also bare
 * 6-to-10-digit runs. An act of general form that carried one is never listed.
 */

/** Why a title is not listed; the panel counts acts per category. */
export type ActCategory =
	| "designacion"
	| "delegacion"
	| "traslado"
	| "jubilacion"
	| "ascenso"
	| "condecoracion"
	| "cese"
	| "personal"
	| "otro";

export const ACT_CATEGORIES: readonly ActCategory[] = [
	"designacion",
	"delegacion",
	"traslado",
	"jubilacion",
	"ascenso",
	"condecoracion",
	"cese",
	"personal",
	"otro",
];

/** Acts about public posts and public honours: listed word for word, names included (identity numbers stripped). */
export const NAMED_CATEGORIES: ReadonlySet<ActCategory> = new Set<ActCategory>([
	"designacion",
	"delegacion",
	"traslado",
	"ascenso",
	"cese",
	"condecoracion",
]);

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
			.replace(/[\s,;]+$/u, "")
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
		/\b(?:designa|designan|designase|designacion|designaciones|designad[oa]s?|nombra|nombran|nombramientos?|nombrad[oa]s?|encarga|encargan|encargad[oa]s?|encargadurias?|juramenta\w*|ratifica\w*)\b/u,
	],
	// Removals, dismissals, suspensions and reinstatements of officials from public posts.
	[
		"cese",
		/\b(?:reincorpora\w*|remueve|remueven|remocion|destituye\w*|destitucion|suspende\w* (?:al?|del?) (?:la |los |las )?(?:ciudadan|funcionari)\w*|cese|ceses)\b/u,
	],
	["condecoracion", /\b(?:condecora\w*|orden al merito|reconocimiento|distincion|botones?)\b/u],
	[
		"personal",
		/\b(?:ciudadan\w*|senor(?:a|as|es)?|excelentisim\w*|persona|personas|funcionari\w*|trabajador(?:a|as|es)?|personal docente|beneficio\w*|otorga\w*|concede\w*|acredita\w*|habilita\w*|autoriza\w* (?:al?|a los|a las) |en su (?:caracter|condicion)|en calidad de|a cargo de|en la persona de|fallec\w*|duelo|homenaje|exequatur|cartas credenciales|recibio|carta de naturaleza|nacionalidad|naturaliza\w*|expropia\w*|adjudica\w*|licencia a|permiso a|sancion\w*|multa\w*)\b/u,
	],
];

/** Titles a private person carries too (academic, professional, religious, courtesy). */
const HONORIFIC_ABBR = "Dr|Dra|Drs|Ing|Lic|Licda|Abg|Abog|Prof|Profa|Arq|Econ|Msc|MSc|Pbro";
const HONORIFIC_WORD =
	"Doctor|Doctora|Ingenier[oa]|Licenciad[oa]|Abogad[oa]|Profesor(?:a)?|Monse[ñn]or|Padre|Hermana?|Don|Doña";
/** Public offices and military ranks: whoever carries one in a Gaceta title is named as a public official. */
const PUBLIC_ABBR = "Cnel|Gral|Tcnel|Cap|Tte|Sgto";
const PUBLIC_WORD =
	"Coronel|Teniente(?: Coronel)?|Capit[aá]n|Mayor|Sargento|Almirante|Vicealmirante|Contralmirante|Comandante|General(?: en Jefe| de Brigada| de Divisi[oó]n)?|Presidente|Presidenta|Vicepresidente|Vicepresidenta|Ministro|Ministra|Viceministro|Viceministra|Director|Directora|Gerente|Fiscal|Embajador(?:a)?|C[oó]nsul|Diputad[oa]|Gobernador(?:a)?|Alcalde(?:sa)?|Magistrad[oa]|Juez(?:a)?|Contralor(?:a)?|Rector(?:a)?";
/** Words after a title that continue the office ("Director General", "Ministro de…"), so no name follows yet. */
const NOT_A_NAME =
	"de|del|la|las|los|el|y|e|o|u|en|para|con|a|al|General|Generales|Ejecutiv[oa]s?|Nacional(?:es)?|Sectorial(?:es)?|Encargad[oa]s?|Adjunt[oa]s?|Interin[oa]s?|Provisori[oa]s?|Principal(?:es)?|Suplentes?|Estadal(?:es)?|Regional(?:es)?|Municipal(?:es)?|Superior(?:es)?|Auxiliar(?:es)?|Titular(?:es)?|Constitucional|Encargada|Consejer[oa]|Plenipotenciari[oa]|Extraordinari[oa]|Honorari[oa]";
const titled = (abbr: string, word: string) =>
	new RegExp(String.raw`\b(?:${abbr})\.?\s+\p{Lu}|\b(?:${word})\s+(?!(?:${NOT_A_NAME})\b)\p{Lu}`, "u");
/** A name after an honorific: could be anyone, so an act of general form that has one is withheld. */
const HONORIFIC_NAME = titled(HONORIFIC_ABBR, HONORIFIC_WORD);
/** A name after a public office or rank: an official named in office. */
const OFFICE_NAME = titled(PUBLIC_ABBR, PUBLIC_WORD);

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

/**
 * An act about named people that names them as officials acting in office (folded text): a capacity phrase, the
 * credentials the President receives, a consul's exequatur, or the public servants of a body.
 */
const OFFICIAL_CUE =
	/\b(?:en su (?:caracter|condicion) de|en calidad de|cartas credenciales|exequatur|funcionari[oa]s?|servidor(?:a|es|as)? public[oa]s?)\b/u;
/** A public office or rank somewhere in the title (folded text), required with the cue. */
const PUBLIC_OFFICE =
	/\b(?:president[ae]|vicepresident[ae]|ministr[oa]|viceministr[oa]|director(?:a)?|gerente|fiscal|embajador(?:a)?|consul|diputad[oa]|gobernador(?:a)?|alcalde(?:sa)?|magistrad[oa]|juez(?:a)?|contralor(?:a)?|rector(?:a)?|jef[ae]|coordinador(?:a)?|auditor(?:a)?|comandante|general|almirante|coronel|defensor(?:a)?|procurador(?:a)?|superintendente|intendente|registrador(?:a)?|notari[oa]|funcionari[oa]s?|servidor(?:a|es|as)? public[oa]s?)\b/u;
/** People referred to only as "those listed in it": the title itself names no one (folded text). */
const NAMES_NO_ONE = /\bque en (?:ella|ellas|el|ellos) se (?:mencionan|indican|especifican|senalan)\b/u;
/** A private party (folded raw title, before identity numbers are stripped): its matters are never listed. */
const PRIVATE_PARTY =
	/\b(?:empresas? (?!nacional|del estado|estatal|publica)|sociedad(?:es)? mercantil\w*|c\. ?a\.|s\. ?a\.|compania anonima|firma personal|inpreabogado|abogad[oa]s? (?!general)|pasaporte|extranjer[oa]s?|apoderad[oa]s?|representante legal|particular(?:es)?|trabajador(?:a|as|es)?|personal docente|beneficio\w*|licencia|permiso|homenaje|fallec\w*|duelo|multa\w*)/u;

/**
 * A personal benefit, social-security act or other private matter: never listed, even inside an appointment or a
 * decoration (folded text). A pension or retirement keeps its own category.
 */
const PRIVATE_MATTER =
	/\b(?:jubila\w*|pension\w*|retiro|sobrevivientes?|incapacidad|invalidez|beneficiari\w*|beneficio\w*|seguridad social|prestacion(?:es)? social\w*|becas?|becari\w*|ayudas? economica\w*|carta de naturaleza|nacionalidad|naturaliza\w*|expropia\w*|adjudica\w*|indemniza\w*|multa\w*|fallec\w*|duelo|licencia a|permiso a)\b/u;

/** Unlabelled digit runs of 6 to 10 (an identity number written bare); Gaceta and decree numbers are shorter. */
const BARE_NUMBER = /(?<![\d.,])\d{6,10}(?![\d.,])/gu;

export type ActClass =
	/** `named`: an act about a public post or honour, listed with the names it carries (NAMED_CATEGORIES). */
	| { listed: true; title: string; category: null; named: boolean }
	| { listed: false; title: null; category: ActCategory };

/**
 * Decides whether a sumario title may be kept. `title` is the stored text when listed (identity numbers stripped,
 * whitespace collapsed); an unlisted act keeps only its category.
 */
export function classifyAct(raw: string): ActClass {
	const { text, found } = stripIds(raw.replace(/\s+/g, " ").trim());
	const folded = fold(text);
	const category = PERSONAL.find(([, re]) => re.test(folded))?.[0];
	if (category !== undefined) {
		// Pensions and every other personal benefit first: never listed, whatever else the act does.
		if (PRIVATE_MATTER.test(folded))
			return {
				listed: false,
				title: null,
				category: PERSONAL[0]?.[1].test(folded) ? "jubilacion" : "personal",
			};
		if (NAMED_CATEGORIES.has(category))
			return { listed: true, title: stripBare(text), category: null, named: true };
		// "personal": listed only when it names officials acting in office and nothing marks a private party.
		const inOffice = OFFICIAL_CUE.test(folded) && PUBLIC_OFFICE.test(folded);
		const privateParty = PRIVATE_PARTY.test(fold(raw));
		if (category === "personal" && inOffice && !privateParty)
			return { listed: true, title: stripBare(text), category: null, named: true };
		// "…integrada por las ciudadanas y ciudadanos que en ella se mencionan": a body's members, named in the PDF only.
		const unnamed =
			NAMES_NO_ONE.test(folded) &&
			!found &&
			!HONORIFIC_NAME.test(text) &&
			!CAPS_RUN.test(text) &&
			!QUOTED_CAPS.test(text);
		if (category === "personal" && unnamed && !privateParty)
			return { listed: true, title: text, category: null, named: false };
		return { listed: false, title: null, category };
	}
	if (
		found ||
		text.includes("[") ||
		HONORIFIC_NAME.test(text) ||
		CAPS_RUN.test(text) ||
		QUOTED_CAPS.test(text)
	)
		return { listed: false, title: null, category: "personal" };
	if (!ALLOWED.some((re) => re.test(folded))) return { listed: false, title: null, category: "otro" };
	// A general act that names someone only by a public office ("presidida por el Ministro …") names an official.
	return { listed: true, title: text, category: null, named: OFFICE_NAME.test(text) };
}

/** A named title's last pass: bare 6-to-10-digit runs removed, spacing tidied as `stripIds` does. */
function stripBare(text: string): string {
	const out = text.replace(BARE_NUMBER, " ");
	if (out === text) return text;
	return out
		.replace(/\(\s*\)/g, "")
		.replace(/\s+([,;.])/g, "$1")
		.replace(/([,;])(?:\s*[,;])+/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
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
	cese: {
		es: ["cese o remoción", "ceses o remociones"],
		en: ["removal or dismissal", "removals or dismissals"],
	},
	personal: {
		es: ["otro asunto de particulares", "otros asuntos de particulares"],
		en: ["other private matter", "other private matters"],
	},
	otro: { es: ["acto no listado", "actos no listados"], en: ["unlisted act", "unlisted acts"] },
};
