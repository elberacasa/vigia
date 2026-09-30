import { type GdeltArticle, type GdeltBatch, gdeltVe } from "../adapters/gdelt-ve/index.ts";
import type { Store } from "../core/store.ts";
import type { Panel } from "../server/panels.ts";

/**
 * "El mundo escribe sobre…": what GDELT's machine coding of world news placed in Venezuela over the last 24 hours:
 * events per state and per kind (CAMEO root), an hourly curve over 48 hours, and the newest source articles with
 * links. Every count is a sum of GDELT's batches, computed here; the view says how many batches arrived.
 *
 * These are news reports coded by a machine, never verified events: the UI labels them "codificación automática de
 * GDELT" and links every article.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Batches per stream per day (one every 15 min). */
const BATCHES_PER_DAY = 96;

/** CAMEO root codes, as GDELT defines them. */
export const CAMEO_ROOTS: Readonly<Record<string, { es: string; en: string }>> = {
	"01": { es: "declaración pública", en: "public statement" },
	"02": { es: "llamamiento", en: "appeal" },
	"03": { es: "intención de cooperar", en: "intent to cooperate" },
	"04": { es: "consulta", en: "consult" },
	"05": { es: "cooperación diplomática", en: "diplomatic cooperation" },
	"06": { es: "cooperación material", en: "material cooperation" },
	"07": { es: "ayuda", en: "provide aid" },
	"08": { es: "concesión", en: "yield" },
	"09": { es: "investigación", en: "investigate" },
	"10": { es: "exigencia", en: "demand" },
	"11": { es: "desaprobación", en: "disapprove" },
	"12": { es: "rechazo", en: "reject" },
	"13": { es: "amenaza", en: "threaten" },
	"14": { es: "protesta", en: "protest" },
	"15": { es: "demostración de fuerza", en: "exhibit force posture" },
	"16": { es: "reducción de relaciones", en: "reduce relations" },
	"17": { es: "coerción", en: "coerce" },
	"18": { es: "agresión", en: "assault" },
	"19": { es: "combate", en: "fight" },
	"20": { es: "violencia masiva", en: "unconventional mass violence" },
};

export const QUAD_CLASSES: Readonly<Record<string, { es: string; en: string }>> = {
	"1": { es: "cooperación verbal", en: "verbal cooperation" },
	"2": { es: "cooperación material", en: "material cooperation" },
	"3": { es: "conflicto verbal", en: "verbal conflict" },
	"4": { es: "conflicto material", en: "material conflict" },
};

export type GdeltStateCount = {
	events: number;
	/** Source articles with a protest event here (CAMEO 14). Articles, not events: one article can code several. */
	protestArticles: number;
	/** Source articles with a material-conflict event here (QuadClass 4: coercion, assault, fight, mass violence). */
	materialConflictArticles: number;
};

export type GdeltItem = {
	url: string;
	domain: string;
	at: number;
	stream: "en" | "tr";
	state: string | null;
	placedBy: GdeltArticle["placedBy"];
	place: string;
	roots: string[];
	quads: number[];
	events: number;
	tone: number | null;
};

export type GdeltView = {
	from: number;
	to: number;
	events: number;
	/** Events with no state: country-level mentions ("Venezuela") or points outside the boundaries. */
	national: number;
	droppedHomonym: number;
	byState: Record<string, GdeltStateCount>;
	byRoot: Record<string, number>;
	byQuad: Record<string, number>;
	/**
	 * 48 hourly bins (oldest first), events per hour in both streams, and the batches read in that hour (0: Vigía read
	 * nothing then, so the hour is unknown, not quiet; 8 is a full hour).
	 */
	hourly: { at: number; events: number; batches: number }[];
	/** Batches in the 24 h window: received (either stream), listed but missing at GDELT, expected (2 × 96). */
	batches: { received: number; missing: number; expected: number; newestAt: number | null };
	/** Newest source articles (40), newest first. */
	latest: GdeltItem[];
	/** Sites with the most articles in the window. */
	topDomains: { domain: string; articles: number }[];
	articles24h: number;
	roots: typeof CAMEO_ROOTS;
	quads: typeof QUAD_CLASSES;
	methodEs: string;
	methodEn: string;
};

function add(into: Record<string, number>, from: Readonly<Record<string, number>>): void {
	for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
}

export function computeGdelt(store: Store, now: number): GdeltView {
	const from = now - DAY;
	const hourlyFrom = Math.floor((now - 2 * DAY) / HOUR) * HOUR + HOUR;
	const hourly = Array.from({ length: 48 }, (_, i) => ({ at: hourlyFrom + i * HOUR, events: 0, batches: 0 }));
	let events = 0;
	let national = 0;
	let dropped = 0;
	let received = 0;
	let missing = 0;
	let newestAt: number | null = null;
	const byStateTotal: Record<string, number> = {};
	const byRoot: Record<string, number> = {};
	const byQuad: Record<string, number> = {};
	for (const stream of ["en", "tr"] as const) {
		for (const o of store.history<GdeltBatch>(gdeltVe.id, `gdelt:batch:${stream}`, now - 2 * DAY, now)) {
			const b = o.value;
			const bin = Math.floor((o.observedAt - hourlyFrom) / HOUR);
			const h = !b.missing && bin >= 0 && bin < 48 ? hourly[bin] : undefined;
			if (h) {
				h.events += b.events;
				h.batches++;
			}
			if (o.observedAt < from) continue;
			if (b.missing) {
				missing++;
				continue;
			}
			received++;
			newestAt = Math.max(newestAt ?? 0, o.observedAt);
			events += b.events;
			national += b.national;
			dropped += b.droppedHomonym;
			add(byStateTotal, b.byState);
			add(byRoot, b.byRoot);
			add(byQuad, b.byQuad);
		}
	}

	// Per-state kinds come from the articles (a batch keeps only totals per state).
	const byState: Record<string, GdeltStateCount> = {};
	for (const [iso, n] of Object.entries(byStateTotal))
		byState[iso] = { events: n, protestArticles: 0, materialConflictArticles: 0 };
	const articles = store
		.latestPerSeries<GdeltArticle>(gdeltVe.id, from, 20_000)
		.filter((o) => o.series.startsWith("gdelt:article:") && o.observedAt <= now);
	const domains = new Map<string, number>();
	for (const o of articles) {
		const a = o.value;
		domains.set(a.domain, (domains.get(a.domain) ?? 0) + 1);
		const s = a.state ? byState[a.state] : undefined;
		if (!s) continue;
		if (a.roots.includes("14")) s.protestArticles++;
		if (a.quads.includes(4)) s.materialConflictArticles++;
	}
	const latest = [...articles]
		.sort((a, b) => b.observedAt - a.observedAt || a.series.localeCompare(b.series))
		.slice(0, 40)
		.map(
			(o): GdeltItem => ({
				url: o.value.url,
				domain: o.value.domain,
				at: o.observedAt,
				stream: o.value.stream,
				state: o.value.state,
				placedBy: o.value.placedBy,
				place: o.value.place,
				roots: [...o.value.roots],
				quads: [...o.value.quads],
				events: o.value.events,
				tone: o.value.tone,
			}),
		);
	return {
		from,
		to: now,
		events,
		national,
		droppedHomonym: dropped,
		byState,
		byRoot,
		byQuad,
		hourly,
		batches: { received, missing, expected: 2 * BATCHES_PER_DAY, newestAt },
		latest,
		topDomains: [...domains]
			.map(([domain, n]) => ({ domain, articles: n }))
			.sort((a, b) => b.articles - a.articles || a.domain.localeCompare(b.domain))
			.slice(0, 10),
		articles24h: articles.length,
		roots: CAMEO_ROOTS,
		quads: QUAD_CLASSES,
		methodEs:
			"GDELT lee noticias del mundo (en inglés y traducidas de 65 idiomas) y codifica por máquina quién hizo qué y " +
			"dónde (CAMEO). Aquí: los eventos que GDELT ubica en Venezuela, sumados por Vigía en las últimas 24 h. El " +
			"estado sale del punto de GDELT dentro de los límites oficiales; si el lugar es un homónimo extranjero " +
			"conocido (Valencia, Mérida, Barcelona…) y ni el sitio es venezolano ni el enlace menciona Venezuela, el " +
			"evento se descarta y se cuenta aparte. Son noticias codificadas automáticamente, no hechos verificados.",
		methodEn:
			"GDELT reads world news (English and machine-translated from 65 languages) and machine-codes who did what and " +
			"where (CAMEO). Here: the events GDELT places in Venezuela, summed by Vigía over the last 24 h. The state comes " +
			"from GDELT's point inside the official boundaries; when the place is a known foreign homonym (Valencia, " +
			"Mérida, Barcelona…) and neither the site is Venezuelan nor the link mentions Venezuela, the event is dropped " +
			"and counted apart. These are machine-coded news reports, not verified events.",
	};
}

export const gdeltPanel: Panel<GdeltView> = {
	id: "gdelt",
	sources: [gdeltVe.id],
	onDemand: true,
	compute: (store, now) => computeGdelt(store, now),
};
