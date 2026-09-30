import type { NewsItem, OutletSpec } from "../adapters/rss/factory.ts";
import { OUTLETS } from "../adapters/rss/outlets.ts";
import type { Store } from "../core/store.ts";
import { signature, similarity } from "../news/cluster.ts";
import { publishers } from "../news/publishers.ts";
import { normalize } from "../news/text.ts";
import type { Panel } from "../server/panels.ts";

/**
 * "Desmentidos": what Venezuelan (and, about Venezuela, regional) fact-checkers published in the last 30 days, each
 * with the verdict its own text states and, when the words allow, the news story it most likely concerns.
 *
 * All rules, no model:
 * - Verdict: a verdict word in the headline (outside a "¿…?" question), else in the first sentence of the summary:
 *   falso, engañoso, impreciso, sin evidencia, sátira, verdadero. Nothing found: no verdict shown (the item still is).
 * - Related story: the news items Vigía read from 7 days before the check to 1 day after, compared with the check's
 *   headline minus fact-checking words ("falso", "verificamos", "circula", "video", "redes"…), by the same title
 *   signature the news clustering uses. A story is linked when they share at least 3 distinctive words, those are at
 *   least 60 % of the shorter signature, and at least 2 of them are rare in the window's headlines (under 0.5 %):
 *   "María Corina Machado" alone links nothing. The best such story is shown as "posible relación", with the shared
 *   words.
 *   Many checks are about posts on social media that no outlet reported: those have no link, by design.
 */

const DAY = 86_400_000;
const WINDOW_MS = 30 * DAY;
const MATCH_BEFORE_MS = 7 * DAY;
const MATCH_AFTER_MS = DAY;
const MIN_SHARED = 3;
const MIN_OVERLAP = 0.6;
/** Shared words must include this many rare ones (in under 0.5 % of the window's headlines): names alone do not link. */
const MIN_RARE = 2;
const RARE_SHARE = 0.005;

export type Verdict = "false" | "misleading" | "context" | "partly" | "unproven" | "satire" | "true";

export const VERDICT_LABELS: Readonly<Record<Verdict, { es: string; en: string }>> = {
	false: { es: "falso", en: "false" },
	misleading: { es: "engañoso", en: "misleading" },
	context: { es: "falta contexto", en: "missing context" },
	partly: { es: "impreciso", en: "partly true" },
	unproven: { es: "sin evidencia", en: "unproven" },
	satire: { es: "sátira", en: "satire" },
	true: { es: "verdadero", en: "true" },
};

/** Checked in this order: a headline saying "no es falso… es engañoso" is rare; the stronger claim wins. */
const VERDICT_WORDS: readonly [Verdict, RegExp][] = [
	[
		"misleading",
		/\b(enga[ñn]os[oa]s?|sacad[oa]s? de contexto|fuera de contexto|manipulad[oa]s?|descontextualizad[oa]s?)\b/,
	],
	["context", /\b(falta contexto|sin contexto|le falta contexto|necesita contexto)\b/],
	[
		"unproven",
		/\b(sin evidencias?|sin pruebas|no hay pruebas|inverificable|no verificable|no se puede verificar)\b/,
	],
	[
		"partly",
		/\b(imprecis[oa]s?|inexact[oa]s?|exagerad[oa]s?|a medias|parcialmente (cierto|falso|verdadero))\b/,
	],
	["satire", /\b(satira|satiric[oa]s?|parodia)\b/],
	["false", /\b(falso|falsa|falsos|falsas|fake|bulo|es mentira|no es cierto|no es verdad)\b/],
	["true", /\b(verdadero|verdadera|es cierto|es verdad)\b/],
];

/**
 * Pure: a feed entry that is a site page, not an article: a WordPress tag or section archive ("TikTok archivos",
 * "… - Página 217 de 217") or a title of three words or fewer, which on the checkers' feeds is an author or tag page
 * (measured 2026-09-28: two people's names from Cotejo via Google News). Dropped: never listed, never counted, and a
 * page named after a person never shows that name.
 */
export function notAnArticle(title: string): boolean {
	const t = title.trim();
	if (/\barchivos?\s*$/i.test(t) || /\barchivos\s*[-–|]/i.test(t) || /\bP[aá]gina \d+ de \d+\b/i.test(t))
		return true;
	return t.split(/\s+/).filter(Boolean).length <= 3;
}

/** Pure: the verdict the checker's own words state, or null. */
export function verdictOf(title: string, summary: string): Verdict | null {
	// A question in the headline ("¿Es falso que…?") states no verdict.
	const headline = normalize(title.replace(/¿[^?]*\?/g, " "));
	for (const [v, re] of VERDICT_WORDS) if (re.test(headline)) return v;
	const first = normalize(summary.split(/(?<=[.!?])\s/)[0] ?? "");
	for (const [v, re] of VERDICT_WORDS) if (re.test(first)) return v;
	return null;
}

/**
 * Words that describe the checking, not the claim: removed before comparing with news headlines. Passed through the
 * same `signature` (normalised, stemmed) as the headlines, so "redes sociales" removes "rede" and "social".
 */
const CHECK_WORDS = signature(
	`falso falsa falsos falsas fake bulo engañoso engañosa enganoso enganosa verificamos verifica verificacion
	chequeo chequeamos cazadores cotejo espaja desmentido desmiente circula circulan viral virales video videos
	imagen imagenes foto fotos audio publicacion publicaciones redes sociales tiktok facebook instagram whatsapp
	twitter usuarios cuenta cuentas mensaje mensajes cadena contexto sacado manipulado impreciso inexacto sin
	evidencia pruebas cierto verdad mentira atribuyen atribuida atribuido`,
);

/** The claim's signature: the check's headline without the checking words. */
export function claimSignature(title: string): Set<string> {
	const sig = signature(title);
	for (const w of [...sig]) if (CHECK_WORDS.has(w)) sig.delete(w);
	return sig;
}

export type RelatedStory = {
	title: string;
	url: string;
	outlet: string;
	outletName: string;
	at: number;
	sharedWords: string[];
	overlap: number;
};

export type FactCheck = {
	id: string;
	title: string;
	url: string;
	at: number;
	dateMissing: boolean;
	checker: string;
	checkerName: string;
	/** Read through Google News: its link goes through Google. */
	via: "google-news" | null;
	verdict: Verdict | null;
	related: RelatedStory | null;
};

export type FactCheckView = {
	from: number;
	to: number;
	items: FactCheck[];
	byChecker: { id: string; name: string; items: number }[];
	byVerdict: Partial<Record<Verdict | "none", number>>;
	/** Checks with a related story found. */
	related: number;
	verdicts: typeof VERDICT_LABELS;
	methodEs: string;
	methodEn: string;
};

type NewsRow = { id: string; outlet: OutletSpec; item: NewsItem; at: number; sig: Set<string> };

export function computeFactChecks(
	store: Store,
	now: number,
	outlets: readonly OutletSpec[] = OUTLETS,
): FactCheckView {
	const from = now - WINDOW_MS;
	const pubs = publishers(outlets);
	const checkers = outlets.filter((o) => o.genre === "fact-check");
	const checkerIds = new Set(checkers.map((o) => o.id));

	// Fact-checks: one per publisher and headline (a direct feed and its Google News fallback give the same item).
	const seen = new Set<string>();
	const raw: { outlet: OutletSpec; item: NewsItem; at: number; series: string }[] = [];
	for (const outlet of checkers) {
		for (const o of store.latestPerSeries<NewsItem>(outlet.id, from, 400)) {
			if (o.observedAt > now + 15 * 60_000) continue;
			if (notAnArticle(o.value.title)) continue;
			const key = `${pubs.get(outlet.id)?.id ?? outlet.id}\u0000${normalize(o.value.title)}`;
			if (seen.has(key)) continue;
			seen.add(key);
			raw.push({ outlet, item: o.value, at: o.observedAt, series: o.series });
		}
	}
	raw.sort((a, b) => b.at - a.at || a.series.localeCompare(b.series));

	// News items to match against: every other outlet, from a week before the oldest check to now.
	const oldest = raw.length ? Math.min(...raw.map((r) => r.at)) : now;
	const news: NewsRow[] = [];
	const byToken = new Map<string, number[]>();
	for (const outlet of outlets) {
		if (checkerIds.has(outlet.id)) continue;
		for (const o of store.latestPerSeries<NewsItem>(outlet.id, oldest - MATCH_BEFORE_MS, 2_000)) {
			const sig = signature(o.value.title);
			if (sig.size < MIN_SHARED) continue;
			const i =
				news.push({ id: `${outlet.id}:${o.series}`, outlet, item: o.value, at: o.observedAt, sig }) - 1;
			for (const t of sig) {
				const list = byToken.get(t);
				if (list) list.push(i);
				else byToken.set(t, [i]);
			}
		}
	}
	const rare = (t: string) => (byToken.get(t)?.length ?? 0) < Math.max(2, RARE_SHARE * news.length);

	const items: FactCheck[] = raw.map(({ outlet, item, at, series }) => {
		const claim = claimSignature(item.title);
		let best: { row: NewsRow; shared: number; overlap: number } | null = null;
		if (claim.size >= MIN_SHARED) {
			const candidates = new Set<number>();
			for (const t of claim) for (const i of byToken.get(t) ?? []) candidates.add(i);
			for (const i of candidates) {
				const row = news[i] as NewsRow;
				if (row.at < at - MATCH_BEFORE_MS || row.at > at + MATCH_AFTER_MS) continue;
				const s = similarity(claim, row.sig);
				if (s.shared < MIN_SHARED || s.overlap < MIN_OVERLAP) continue;
				if ([...claim].filter((w) => row.sig.has(w) && rare(w)).length < MIN_RARE) continue;
				if (
					!best ||
					s.overlap > best.overlap ||
					(s.overlap === best.overlap && s.shared > best.shared) ||
					(s.overlap === best.overlap && s.shared === best.shared && row.at < best.row.at)
				)
					best = { row, shared: s.shared, overlap: s.overlap };
			}
		}
		const pub = pubs.get(outlet.id);
		return {
			id: `${outlet.id}:${series}`,
			title: item.title,
			url: item.link,
			at,
			dateMissing: item.dateMissing,
			checker: pub?.id ?? outlet.id,
			checkerName: pub?.name ?? outlet.name,
			via: outlet.via ? "google-news" : null,
			verdict: verdictOf(item.title, item.summary),
			related: best
				? {
						title: best.row.item.title,
						url: best.row.item.link,
						outlet: pubs.get(best.row.outlet.id)?.id ?? best.row.outlet.id,
						outletName: pubs.get(best.row.outlet.id)?.name ?? best.row.outlet.name,
						at: best.row.at,
						sharedWords: [...claim].filter((w) => best?.row.sig.has(w)).sort(),
						overlap: Math.round(best.overlap * 100) / 100,
					}
				: null,
		};
	});

	const byChecker = new Map<string, { id: string; name: string; items: number }>();
	const byVerdict: FactCheckView["byVerdict"] = {};
	for (const f of items) {
		const c = byChecker.get(f.checker) ?? { id: f.checker, name: f.checkerName, items: 0 };
		c.items++;
		byChecker.set(f.checker, c);
		const v = f.verdict ?? "none";
		byVerdict[v] = (byVerdict[v] ?? 0) + 1;
	}
	return {
		from,
		to: now,
		items: items.slice(0, 80),
		byChecker: [...byChecker.values()].sort(
			(a, b) => b.items - a.items || a.name.localeCompare(b.name, "es"),
		),
		byVerdict,
		related: items.filter((f) => f.related).length,
		verdicts: VERDICT_LABELS,
		methodEs:
			"Verificaciones de los últimos 30 días. El veredicto es la palabra que usa el propio verificador en su titular " +
			"(o en la primera frase): falso, engañoso, falta contexto, impreciso, sin evidencia, sátira, verdadero. «Posible relación»: una " +
			"noticia leída por Vigía entre 7 días antes y 1 día después que comparte al menos 3 palabras distintivas con " +
			"el titular (al menos el 60 % del más corto, y 2 de ellas poco frecuentes en los titulares de esos días); es " +
			"una coincidencia de palabras, no una confirmación.",
		methodEn:
			"Fact-checks of the last 30 days. The verdict is the word the checker itself uses in its headline (or first " +
			"sentence): false, misleading, missing context, partly true, unproven, satire, true. “Possibly related”: a news item Vigía read " +
			"from 7 days before to 1 day after that shares at least 3 distinctive words with the headline (at least 60 % " +
			"of the shorter one, 2 of them rare in those days' headlines); a match of words, not a confirmation.",
	};
}

export const factCheckPanel: Panel<FactCheckView> = {
	id: "desmentidos",
	sources: OUTLETS.filter((o) => o.genre === "fact-check").map((o) => o.id),
	onDemand: true,
	compute: (store, now) => computeFactChecks(store, now),
};
