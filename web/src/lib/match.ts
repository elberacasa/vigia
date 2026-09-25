/**
 * Search for the command palette: accent-free prefix + substring matching with a small Spanish synonym table.
 * No fuzzy library: a stranger types "maracaibo", "luz" or "dolar" and the obvious thing comes first.
 */

/** Lowercase, no accents, single spaces: "Táchira" → "tachira". */
export function fold(text: string): string {
	return text
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9ñ ]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * What people type → what the index calls it. Keys and values are folded. A query that starts with a key also
 * searches for each value, so "luz" finds the Electricity topic, the Lights layer and the blackout sources.
 */
export const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
	luz: ["apagon", "electricidad", "luces", "energia"],
	apagon: ["luz", "electricidad", "luces", "internet"],
	corte: ["apagon", "caida"],
	electricidad: ["luz", "apagon"],
	dolar: ["bcv", "paralelo", "yadio", "tasa", "divisa", "cambio"],
	tasa: ["dolar", "bcv", "yadio"],
	paralelo: ["yadio", "p2p", "dolar"],
	euro: ["bcv", "tasa"],
	inflacion: ["precios", "inpc", "dinero"],
	precio: ["inflacion", "dolar"],
	sismo: ["temblor", "terremoto", "funvisis", "usgs"],
	temblor: ["sismo", "terremoto"],
	terremoto: ["sismo", "temblor"],
	internet: ["conexion", "senal", "caida", "ioda", "conectividad"],
	conexion: ["internet", "conectividad"],
	senal: ["internet", "conectividad"],
	caida: ["internet", "conectividad", "apagon"],
	censura: ["bloqueo", "ooni", "vesinfiltro"],
	bloqueo: ["censura", "bloqueado"],
	fuego: ["incendio", "focos", "firms", "calor"],
	incendio: ["fuego", "focos", "calor"],
	lluvia: ["clima", "tormenta", "tiempo", "inundacion"],
	tormenta: ["clima", "lluvia", "alertas", "ciclon"],
	huracan: ["ciclon", "tormenta", "alertas"],
	clima: ["tiempo", "lluvia", "temperatura"],
	tiempo: ["clima"],
	noticias: ["titulares", "medios", "prensa"],
	prensa: ["noticias", "medios"],
	petroleo: ["crudo", "brent", "wti", "oil"],
	gasolina: ["petroleo"],
	satelite: ["goes", "imagen", "nubes"],
	noche: ["luces", "nocturna"],
	ccs: ["caracas"],
	caracas: ["distrito capital", "libertador"],
	margarita: ["nueva esparta", "porlamar"],
	oscuro: ["tema"],
	claro: ["tema"],
	ingles: ["english", "idioma"],
	english: ["idioma", "ingles"],
	idioma: ["english", "espanol"],
	compartir: ["share", "imagen"],
	fuentes: ["estado", "salud"],
};

export interface Searchable {
	/** Shown and matched first. */
	label: string;
	/** Extra words that also match (folded on index). */
	keywords?: readonly string[];
}

/**
 * Lower is better; null = no match. 0: the label starts with the query; 1: a word of the label does; 2: the label
 * contains it; 3: a keyword starts with it; 4: a keyword contains it; +5 when only a synonym matched. A query of
 * several words that matches no item as a phrase matches when each word does (score: the weakest word's + 1).
 */
export function score(item: { label: string; words: readonly string[] }, query: string): number | null {
	const q = fold(query);
	if (!q) return 0;
	const whole = scoreWord(item, q);
	if (whole !== null || !q.includes(" ")) return whole;
	// Several words that are not one phrase ("capa satelite", "internet zulia"): every word must match somewhere,
	// label or keyword; the item ranks by its weakest word, one step below a phrase match.
	let worst = 0;
	for (const w of q.split(" ")) {
		const s = scoreWord(item, w);
		if (s === null) return null;
		worst = Math.max(worst, s);
	}
	return worst + 1;
}

function scoreWord(item: { label: string; words: readonly string[] }, q: string): number | null {
	const direct = scoreOne(item, q);
	if (direct !== null) return direct;
	let best: number | null = null;
	for (const [key, values] of Object.entries(SYNONYMS)) {
		// "dol" still reaches "dolar"'s synonyms, but only once three letters make the intent clear.
		if (!(key.startsWith(q) && q.length >= 3) && q !== key) continue;
		for (const v of values) {
			const s = scoreOne(item, v);
			if (s !== null && (best === null || s + 5 < best)) best = s + 5;
		}
	}
	return best;
}

function scoreOne(item: { label: string; words: readonly string[] }, q: string): number | null {
	const label = item.label;
	if (label.startsWith(q)) return 0;
	if (label.includes(` ${q}`)) return 1;
	if (q.length >= 2 && label.includes(q)) return 2;
	let best: number | null = null;
	for (const w of item.words) {
		if (w.startsWith(q) || w.includes(` ${q}`)) return 3;
		if (q.length >= 3 && w.includes(q)) best = 4;
	}
	return best;
}

/** Folds an item once, for repeated scoring as the user types. */
export function prepare<T extends Searchable>(item: T): T & { folded: { label: string; words: string[] } } {
	return { ...item, folded: { label: fold(item.label), words: (item.keywords ?? []).map(fold) } };
}

/** The best `limit` items for a query, stable within equal scores (index order is the tie-break). */
export function rank<T extends { folded: { label: string; words: readonly string[] } }>(
	items: readonly T[],
	query: string,
	limit: number,
): T[] {
	const hits: { item: T; s: number; i: number }[] = [];
	items.forEach((item, i) => {
		const s = score(item.folded, query);
		if (s !== null) hits.push({ item, s, i });
	});
	hits.sort((a, b) => a.s - b.s || a.i - b.i);
	return hits.slice(0, limit).map((h) => h.item);
}
