/**
 * Keyword place tagger: finds Venezuelan places in a headline and resolves them to a state, honestly.
 *
 * Rules (from the measured ambiguity list, src/geo/data/ambiguous.json):
 * - A term that names places in one state only, and is not also a person, a common word, a foreign place or
 *   something else (currency, river), is accepted directly.
 * - A term naming places in several states is resolved only by (a) an explicit cue before it ("estado Sucre",
 *   "municipio Sucre", "Edo. Sucre") or (b) another accepted place in the same text that sits in one of its states.
 * - A term that is also a person/common word/other meaning needs a cue, even if it maps to one state.
 * - A foreign homonym (Mérida, Valencia, Barcelona) is accepted from Venezuelan outlets with lower confidence and
 *   needs a cue from international ones.
 * - Short tokens (≤ 4 letters) are only matched from the curated abbreviation list (Ccs, Mcbo, Bqto…).
 * Every result carries a confidence; the UI labels it "ubicación por palabra clave".
 */
import ambiguousJson from "../geo/data/ambiguous.json" with { type: "json" };
import gazetteerJson from "../geo/data/gazetteer.json" with { type: "json" };
import { stateByCode } from "../geo/index.ts";
import { normalize } from "./text.ts";

type AmbiguityType =
	| "homonym_multi_state"
	| "homonym_same_state"
	| "same_state_multi_level"
	| "small_places_elsewhere"
	| "short_token"
	| "person_name"
	| "common_word"
	| "foreign_homonym"
	| "other_meaning";

interface Entry {
	/** "state:VE01", "mun:VE0513", "parish:VE010121", "gn:<geonames id>". */
	id: string;
	name: string;
	kind: "state" | "municipality" | "city" | "sector";
	stateCode: string;
	/** A place like Caracas that spans more than one state still has one primary state. */
	population?: number;
}

interface Term {
	phrase: string;
	entries: Entry[];
	/** States this term can refer to (ISO codes). */
	states: Set<string>;
	types: Set<AmbiguityType>;
	curated: boolean;
}

export interface PlaceMention {
	readonly term: string;
	readonly place: string;
	readonly kind: Entry["kind"];
	/** ISO 3166-2 code. */
	readonly state: string;
	readonly confidence: number;
	readonly how: "unambiguous" | "cue" | "context" | "outlet-local";
}

export interface PlaceTags {
	readonly mentions: readonly PlaceMention[];
	/** The state the item is mainly about, when one is clear. */
	readonly primaryState: string | null;
	readonly confidence: number;
}

const CUES = new Set(["estado", "edo", "municipio", "mcpio", "mun", "parroquia", "ciudad", "cdad"]);
/** Words that make a following term a person, not a place: "Simón Bolívar", "Antonio José de Sucre". */
const PERSON_BEFORE = new Set([
	"simon",
	"jose",
	"antonio",
	"francisco",
	"general",
	"mariscal",
	"don",
	"gran",
]);
/** Terms never accepted without a cue, whatever the list says (too common in headlines). */
const ALWAYS_CUE = new Set([
	"libertad",
	"union",
	"independencia",
	"paz",
	"victoria",
	"capital",
	"guaire",
	"orinoco",
	// Place names that are also ordinary phrases in headlines ("la Guardia Revolucionaria", "el progreso de…").
	"la guardia",
	"guardia",
	"la esperanza",
	"el progreso",
	"la plaza",
	"el centro",
	"la costa",
	"el llano",
	"la sierra",
	"el puerto",
	"la isla",
	"la montana",
	"el cementerio",
	"la carlota",
]);
/**
 * Curated: overwhelmingly places in Venezuelan news despite a flag in the list (a mountain range, a Peruvian port,
 * a region). Accepted from Venezuelan outlets like unambiguous terms, at the foreign-homonym confidence.
 */
const PLACE_FIRST = new Set([
	"merida",
	"el callao",
	"guayana",
	"chacao",
	"valencia",
	"barcelona",
	"maturin",
	"cumana",
]);
/** State names that are also a prócer or the currency: need "estado", a dateline or a qualifier. */
const PERSON_STATES = new Set(["bolivar", "sucre", "miranda"]);
/** Phrases that contain a place name but are not a location in the news sense. */
const NOT_PLACES = [
	"guayana esequiba",
	"zona en reclamacion",
	"cordillera de merida",
	"sierra de merida",
	"plaza bolivar",
	"plaza venezuela",
	"avenida bolivar",
	"teatro teresa carreño",
	"estadio monumental",
];
/** Country names that mark a foreign homonym as foreign ("Barcelona, España"). */
const FOREIGN = new Set([
	"españa",
	"colombia",
	"peru",
	"chile",
	"mexico",
	"argentina",
	"ecuador",
	"bolivia",
	"eeuu",
	"estados",
	"brasil",
	"panama",
	"cuba",
	"italia",
	"francia",
	"portugal",
	"filipinas",
]);

interface Index {
	/** First token → terms starting with it, longest first. */
	byFirst: Map<string, Term[]>;
}

function isoOf(code: string): string | null {
	return stateByCode(code)?.iso ?? null;
}

function buildIndex(): Index {
	const terms = new Map<string, Term>();
	const add = (phrase: string, entry: Entry, curated: boolean) => {
		const key = normalize(phrase);
		if (!key) return;
		const iso = isoOf(entry.stateCode);
		if (!iso) return;
		let term = terms.get(key);
		if (!term) {
			term = { phrase: key, entries: [], states: new Set(), types: new Set(), curated };
			terms.set(key, term);
		}
		if (!term.entries.some((e) => e.id === entry.id)) term.entries.push(entry);
		term.states.add(iso);
		term.curated ||= curated;
	};
	const gaz = gazetteerJson as unknown as {
		entries: (Entry & { variants?: string[]; curatedVariants?: string[]; placement?: string })[];
	};
	for (const e of gaz.entries) {
		if (e.placement === "outside") continue;
		add(e.name, e, false);
		for (const v of e.variants ?? []) add(v, e, false);
		for (const v of e.curatedVariants ?? []) add(v, e, true);
	}
	const amb = ambiguousJson as unknown as { terms: { normalized: string; types: AmbiguityType[] }[] };
	for (const a of amb.terms) {
		const term = terms.get(normalize(a.normalized));
		if (term) for (const t of a.types) term.types.add(t);
	}
	for (const [key, term] of terms) {
		if (ALWAYS_CUE.has(key)) term.types.add("common_word");
		if (key.replace(/ /g, "").length <= 4) term.types.add("short_token");
	}
	const byFirst = new Map<string, Term[]>();
	for (const term of terms.values()) {
		const first = term.phrase.split(" ")[0] ?? "";
		byFirst.set(first, [...(byFirst.get(first) ?? []), term]);
	}
	for (const list of byFirst.values()) list.sort((a, b) => b.phrase.length - a.phrase.length);
	return { byFirst };
}

let index: Index | null = null;
function getIndex(): Index {
	index ??= buildIndex();
	return index;
}

const NEEDS_CUE: readonly AmbiguityType[] = ["person_name", "common_word", "other_meaning"];

interface Hit {
	term: Term;
	start: number;
	cue: boolean;
	personBefore: boolean;
}

function findHits(words: readonly string[]): Hit[] {
	const { byFirst } = getIndex();
	const hits: Hit[] = [];
	const joined = ` ${words.join(" ")} `;
	const blocked = new Set<number>();
	for (const phrase of NOT_PLACES) {
		let at = joined.indexOf(` ${phrase} `);
		while (at !== -1) {
			const start = joined
				.slice(0, at + 1)
				.split(" ")
				.filter(Boolean).length;
			for (let k = 0; k < phrase.split(" ").length; k++) blocked.add(start + k);
			at = joined.indexOf(` ${phrase} `, at + 1);
		}
	}
	for (let i = 0; i < words.length; ) {
		if (blocked.has(i)) {
			i++;
			continue;
		}
		const candidates = byFirst.get(words[i] ?? "");
		let matched: Term | null = null;
		if (candidates) {
			for (const term of candidates) {
				const parts = term.phrase.split(" ");
				if (parts.every((p, k) => words[i + k] === p)) {
					matched = term;
					break;
				}
			}
		}
		if (matched) {
			const len = matched.phrase.split(" ").length;
			const prev = words[i - 1] ?? "";
			hits.push({ term: matched, start: i, cue: CUES.has(prev), personBefore: PERSON_BEFORE.has(prev) });
			i += len;
		} else i++;
	}
	return hits;
}

/** Picks the entry that best represents a term within a state: state > city (largest) > municipality > sector. */
function bestEntry(term: Term, state: string): Entry | undefined {
	const rank = { state: 0, city: 1, municipality: 2, sector: 3 } as const;
	return term.entries
		.filter((e) => isoOf(e.stateCode) === state)
		.sort((a, b) => rank[a.kind] - rank[b.kind] || (b.population ?? 0) - (a.population ?? 0))[0];
}

export interface TagOptions {
	/** Outlet is Venezuelan (national or regional): foreign homonyms default to the Venezuelan place. */
	readonly venezuelanOutlet?: boolean;
	/** Regional outlet's home state (ISO): breaks ties between candidate states. */
	readonly homeState?: string;
}

/** A state named in the next two tokens ("Sucre de Miranda", "Sucre, Miranda", "Sucre, estado Miranda"). */
function qualifierState(words: readonly string[], after: number, term: Term): string | null {
	const { byFirst } = getIndex();
	for (let i = after; i < Math.min(words.length, after + 3); i++) {
		const w = words[i] ?? "";
		if (w === "de" || w === "del" || w === "estado" || w === "edo") continue;
		for (const candidate of byFirst.get(w) ?? []) {
			const parts = candidate.phrase.split(" ");
			if (!parts.every((p, k) => words[i + k] === p)) continue;
			const state = candidate.entries.find((e) => e.kind === "state");
			const iso = state ? isoOf(state.stateCode) : null;
			if (iso && term.states.has(iso)) return iso;
		}
		return null;
	}
	return null;
}

/** Venezuelan press datelines: "Zulia: …", "Bolívar | …" at the start of a headline name the state. */
function datelineTerm(text: string): string | null {
	const m = /^\s*([^:|–—-]{2,32})\s*[:|–—]\s/.exec(text);
	return m?.[1] ? normalize(m[1]) : null;
}

export function tagPlaces(text: string, options: TagOptions = {}): PlaceTags {
	const words = normalize(text).split(" ").filter(Boolean);
	const hits = findHits(words);
	const dateline = datelineTerm(text);
	const accepted: PlaceMention[] = [];
	const pending: Hit[] = [];
	/** "Caracas y Miranda", "Carabobo, Aragua y Miranda": a prócer-named state inside a list of places. */
	const personStates: Hit[] = [];

	const accept = (hit: Hit, state: string, confidence: number, how: PlaceMention["how"]) => {
		const entry = bestEntry(hit.term, state);
		if (!entry) return;
		accepted.push({ term: hit.term.phrase, place: entry.name, kind: entry.kind, state, confidence, how });
	};

	for (const hit of hits) {
		const { term } = hit;
		if (hit.personBefore) continue;
		const types = term.types;
		const len = term.phrase.split(" ").length;
		const after = hit.start + len;
		if (types.has("short_token") && !term.curated) continue;
		const foreign = types.has("foreign_homonym");
		if (foreign && [0, 1, 2].some((k) => FOREIGN.has(words[after + k] ?? ""))) continue;
		const curatedPlace = PLACE_FIRST.has(term.phrase);
		const needsCue = !curatedPlace && NEEDS_CUE.some((t) => types.has(t));
		const single = term.states.size === 1;
		const onlyState = single ? ([...term.states][0] as string) : null;
		const onlyGeoNamesSectors = term.entries.every((e) => e.kind === "sector" && e.id.startsWith("gn:"));

		// Dateline: the first words before ":" name a state (or a city whose state is clear).
		if (hit.start === 0 && dateline === term.phrase) {
			const stateEntry = term.entries.find((e) => e.kind === "state");
			const iso = stateEntry ? isoOf(stateEntry.stateCode) : onlyState;
			if (iso) {
				accept(hit, iso, 0.85, "cue");
				continue;
			}
		}
		const qualified = qualifierState(words, after, term);
		if (qualified && !single) {
			accept(hit, qualified, 0.85, "cue");
			continue;
		}
		if (onlyGeoNamesSectors) {
			pending.push(hit);
			continue;
		}
		// A bare state name means the state, except the three that are also people or money.
		const stateEntry = term.entries.find((e) => e.kind === "state" && normalize(e.name) === term.phrase);
		if (stateEntry && !PERSON_STATES.has(term.phrase)) {
			const iso = isoOf(stateEntry.stateCode);
			if (iso) {
				accept(hit, iso, 0.8, "unambiguous");
				continue;
			}
		}

		if (hit.cue) {
			// "estado Sucre": the cue says which level; with a state cue, prefer the state entry.
			const stateEntry = term.entries.find((e) => e.kind === "state");
			const iso = stateEntry ? isoOf(stateEntry.stateCode) : onlyState;
			if (iso) accept(hit, iso, 0.9, "cue");
			else pending.push(hit);
			continue;
		}
		if (needsCue) {
			if (PERSON_STATES.has(term.phrase)) personStates.push(hit);
			continue;
		}
		if (foreign && !options.venezuelanOutlet) continue;
		if (onlyState) {
			const conf = foreign ? 0.6 : types.has("small_places_elsewhere") ? 0.75 : 0.85;
			accept(hit, onlyState, conf, "unambiguous");
			continue;
		}
		pending.push(hit);
	}

	// A prócer-named state counts when it sits in a list with an accepted place ("… en Caracas y Miranda").
	const acceptedHits = hits.filter((h) => accepted.some((m) => m.term === h.term.phrase));
	for (const hit of personStates) {
		const listed = acceptedHits.some((h) => {
			const hEnd = h.start + h.term.phrase.split(" ").length;
			const between =
				hit.start > h.start ? words.slice(hEnd, hit.start) : words.slice(hit.start + 1, h.start);
			return between.length <= 1 && between.every((w) => w === "y" || w === "e");
		});
		const stateEntry = hit.term.entries.find((e) => e.kind === "state");
		const iso = stateEntry ? isoOf(stateEntry.stateCode) : null;
		if (listed && iso) accept(hit, iso, 0.75, "context");
	}

	// Context: an ambiguous term resolves to a state already named by an accepted mention.
	const named = new Set(accepted.map((m) => m.state));
	for (const hit of pending) {
		const shared = [...hit.term.states].filter((s) => named.has(s));
		if (shared.length === 1) accept(hit, shared[0] as string, 0.7, "context");
		else if (options.homeState && hit.term.states.has(options.homeState)) {
			accept(hit, options.homeState, 0.55, "outlet-local");
		}
	}

	// Primary state: highest summed confidence; ties → none (honest).
	const score = new Map<string, number>();
	for (const m of accepted) score.set(m.state, (score.get(m.state) ?? 0) + m.confidence);
	const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
	const [top, second] = ranked;
	const primaryState = top && (!second || top[1] > second[1]) ? top[0] : null;
	const confidence = primaryState
		? Math.max(...accepted.filter((m) => m.state === primaryState).map((m) => m.confidence))
		: 0;
	return { mentions: accepted, primaryState, confidence };
}
