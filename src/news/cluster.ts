/**
 * Groups headlines about the same story across outlets, without a model: token overlap of normalised titles
 * within a time window, joined transitively (union–find). Deterministic, so the same input always gives the same
 * stories, and every story keeps links to every outlet that covered it.
 */
import { normalize, STOPWORDS } from "./text.ts";

export interface ClusterInput {
	readonly id: string;
	readonly title: string;
	readonly at: number;
	readonly outlet: string;
}

export interface ClusterOptions {
	/** Two items further apart than this are never the same story. */
	readonly windowMs?: number;
	/** Jaccard similarity of title signatures at or above which two items join. */
	readonly jaccard?: number;
	/** Overlap coefficient (shared / smaller) at or above which they join, if they share at least `minShared`. */
	readonly overlap?: number;
	readonly minShared?: number;
	/**
	 * Anti-drift: two groups merge only if their first items (seeds) also share at least this overlap coefficient
	 * (and two words). Without it, single-link chains join a speech, a meeting and the reactions to both into one
	 * "story" once enough outlets write overlapping headlines (measured: 66 outlets in one chain at 213 feeds).
	 */
	readonly seedOverlap?: number;
}

const DEFAULTS = {
	windowMs: 36 * 3_600_000,
	jaccard: 0.5,
	overlap: 0.75,
	minShared: 4,
	seedOverlap: 0.5,
} as const;

/** Light Spanish stemming: enough to match "protesta/protestas", "apagón/apagones". */
function stem(word: string): string {
	if (word.length > 5 && word.endsWith("es")) return word.slice(0, -2);
	if (word.length > 4 && word.endsWith("s")) return word.slice(0, -1);
	return word;
}

/**
 * Words that make broadcast bulletins look alike across channels ("Titulares emisión meridiana - jueves 24 de
 * septiembre"): dates and programme words carry no story.
 */
const GENERIC = new Set(
	`lunes martes miercoles jueves viernes sabado domingo enero febrero marzo abril mayo junio julio agosto septiembre
	setiembre octubre noviembre diciembre 2024 2025 2026 2027 titulares emision edicion meridiana estelar matutina
	nocturna resumen noticias noticiero vivo directo hoy semana ultima hora envivo avance especial programa completo`
		.split(/\s+/)
		.filter(Boolean),
);
/** A title with fewer distinctive words than this never joins another. */
const MIN_SIGNATURE = 3;

export function signature(title: string): Set<string> {
	const out = new Set<string>();
	for (const w of normalize(title).split(" ")) {
		if (!w || STOPWORDS.has(w) || GENERIC.has(w)) continue;
		if (w.length < 3 && !/^\d+$/.test(w)) continue;
		out.add(stem(w));
	}
	return out;
}

export function similarity(
	a: ReadonlySet<string>,
	b: ReadonlySet<string>,
): { jaccard: number; overlap: number; shared: number } {
	let shared = 0;
	for (const x of a) if (b.has(x)) shared++;
	const union = a.size + b.size - shared;
	return {
		jaccard: union ? shared / union : 0,
		overlap: Math.min(a.size, b.size) ? shared / Math.min(a.size, b.size) : 0,
		shared,
	};
}

/** Returns clusters as arrays of input ids, each sorted by time; clusters sorted newest first. */
export function cluster(items: readonly ClusterInput[], options: ClusterOptions = {}): string[][] {
	const o = { ...DEFAULTS, ...options };
	const sorted = [...items].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
	const sigs = sorted.map((i) => signature(i.title));
	const parent = sorted.map((_, i) => i);
	/** Earliest item of each group, by root. Items are in time order, so the smallest index. */
	const seed = sorted.map((_, i) => i);
	const find = (i: number): number => {
		let r = i;
		while (parent[r] !== r) r = parent[r] as number;
		let c = i;
		while (parent[c] !== r) {
			const next = parent[c] as number;
			parent[c] = r;
			c = next;
		}
		return r;
	};
	// Inverted index so each item is only compared with items sharing a token.
	const byToken = new Map<string, number[]>();
	for (let i = 0; i < sorted.length; i++) {
		const item = sorted[i] as ClusterInput;
		const sig = sigs[i] as Set<string>;
		if (sig.size < MIN_SIGNATURE) continue;
		const seen = new Set<number>();
		for (const token of sig) {
			for (const j of byToken.get(token) ?? []) {
				if (seen.has(j)) continue;
				seen.add(j);
				const other = sorted[j] as ClusterInput;
				if ((sigs[j] as Set<string>).size < MIN_SIGNATURE) continue;
				if (item.at - other.at > o.windowMs) continue;
				const s = similarity(sig, sigs[j] as Set<string>);
				// Same outlet: only near-identical titles join (updates), not daily programmes with a fixed name.
				const joins =
					item.outlet === other.outlet
						? s.jaccard >= 0.85
						: s.jaccard >= o.jaccard || (s.overlap >= o.overlap && s.shared >= o.minShared);
				if (joins) {
					const ri = find(i);
					const rj = find(j);
					if (ri === rj) continue;
					const a = seed[ri] as number;
					const b = seed[rj] as number;
					const anchored =
						o.seedOverlap <= 0 ||
						(a === i && b === j) ||
						(() => {
							const t = similarity(sigs[a] as Set<string>, sigs[b] as Set<string>);
							return t.shared >= 2 && t.overlap >= o.seedOverlap;
						})();
					if (anchored) {
						parent[ri] = rj;
						seed[rj] = Math.min(a, b);
					}
				}
			}
			const list = byToken.get(token);
			if (list) list.push(i);
			else byToken.set(token, [i]);
		}
	}
	const groups = new Map<number, number[]>();
	for (let i = 0; i < sorted.length; i++) {
		const root = find(i);
		const members = groups.get(root);
		if (members) members.push(i);
		else groups.set(root, [i]);
	}
	// Members are in time order, so a group's newest item is its last; ties keep the first-seen group first.
	const newest = (members: number[]) => (sorted[members[members.length - 1] as number] as ClusterInput).at;
	return [...groups.values()]
		.sort((a, b) => newest(b) - newest(a))
		.map((members) => members.map((i) => (sorted[i] as ClusterInput).id));
}
