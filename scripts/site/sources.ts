/**
 * The landing page's sources showcase (site/src/data/sources.json): every adapter in the registry with what the
 * sources atlas says about it (src/sources/atlas.ts), grouped for reading, and the regional outlets per state for
 * the mini map. Everything here comes from the code; nothing is typed by hand except the group names.
 */
import { ADAPTERS } from "../../src/adapters/registry.ts";
import { OUTLETS } from "../../src/adapters/rss/outlets.ts";
import type { Adapter } from "../../src/core/types.ts";
import { PANELS } from "../../src/server/panel-registry.ts";
import { type AtlasEntry, buildAtlas } from "../../src/sources/atlas.ts";
import { FRAME, STATES } from "../../web/src/map/geometry.gen.ts";
import {
	categoryNote,
	countryLabel,
	kindLabel,
	langLabel,
	stanceLabel,
} from "../../web/src/ui/atlas/labels.ts";
import { rings } from "./map.ts";

type L = { es: string; en: string };

/** Reading groups, in page order. News is split by reach and by channel; the rest follow the atlas category. */
export const GROUPS = [
	"money",
	"markets",
	"energy",
	"internet",
	"censorship",
	"earth",
	"space",
	"airspace",
	"attention",
	"society",
	"national",
	"regional",
	"international",
	"video",
	"telegram",
] as const;
export type Group = (typeof GROUPS)[number];

/** Group names and one line each. Spanish slugs are the page's anchors (/fuentes#dinero). */
const GROUP_TEXT: Readonly<Record<Group, { slug: string; name: L; note: L }>> = {
	money: { slug: "dinero", name: { es: "Dinero", en: "Money" }, note: n("money") },
	markets: {
		slug: "mercados",
		name: { es: "Mercados", en: "Markets" },
		note: {
			es: "Petróleo, monedas vecinas, materias primas, puertos",
			en: "Oil, neighbours' currencies, commodities, ports",
		},
	},
	energy: { slug: "energia", name: { es: "Energía", en: "Energy" }, note: n("energy") },
	internet: { slug: "internet", name: { es: "Internet", en: "Internet" }, note: n("internet") },
	censorship: { slug: "censura", name: { es: "Censura", en: "Censorship" }, note: n("censorship") },
	earth: {
		slug: "tierra-y-clima",
		name: { es: "Tierra y clima", en: "Earth and weather" },
		note: n("earth"),
	},
	space: { slug: "espacio", name: { es: "Espacio", en: "Space" }, note: n("space") },
	airspace: { slug: "espacio-aereo", name: { es: "Espacio aéreo", en: "Airspace" }, note: n("airspace") },
	attention: { slug: "atencion", name: { es: "Atención", en: "Attention" }, note: n("attention") },
	society: {
		slug: "salud-y-migracion",
		name: { es: "Salud, migración y Gaceta", en: "Health, migration and Gazette" },
		note: {
			es: "Boletines de salud, migración, ayuda humanitaria y la Gaceta Oficial",
			en: "Health bulletins, migration, humanitarian aid and the Official Gazette",
		},
	},
	national: {
		slug: "medios-nacionales",
		name: { es: "Medios nacionales", en: "National outlets" },
		note: {
			es: "Prensa, radio, TV, ONG e instituciones de alcance nacional",
			en: "Press, radio, TV, NGOs and institutions with national reach",
		},
	},
	regional: {
		slug: "medios-regionales",
		name: { es: "Medios regionales", en: "Regional outlets" },
		note: { es: "Diarios y portales de cada estado", en: "Each state's papers and news sites" },
	},
	international: {
		slug: "prensa-internacional",
		name: { es: "Prensa internacional y diáspora", en: "International press and diaspora" },
		note: {
			es: "Solo lo que menciona a Venezuela, cuando el medio cubre el mundo",
			en: "Only what mentions Venezuela, when the outlet covers the world",
		},
	},
	video: {
		slug: "tv-y-video",
		name: { es: "TV, radio y video", en: "TV, radio and video" },
		note: {
			es: "Canales de video de los medios y señales en vivo",
			en: "Outlets' video channels and live signals",
		},
	},
	telegram: {
		slug: "telegram",
		name: { es: "Telegram", en: "Telegram" },
		note: {
			es: "Canales públicos verificados, leídos desde su vista web",
			en: "Verified public channels, read from their web preview",
		},
	},
};

function n(category: string): L {
	return { es: categoryNote(category, "es"), en: categoryNote(category, "en") };
}

/** How a source starts on a fresh install: no key and on, needs a key, or off until the user turns it on. */
export type Access = "free" | "key" | "optin";

export function accessOf(a: Pick<Adapter, "keys" | "optIn">): Access {
	if (a.keys.length > 0) return "key";
	if (a.optIn) return "optin";
	return "free";
}

const telegram = new Set(OUTLETS.filter((o) => o.kind === "telegram").map((o) => o.id));
/** Broadcast availability probes: they belong with the video channels, not with the national press. */
const BROADCAST = new Set(["youtube-live", "radio-streams"]);

export function groupOf(a: Adapter, e: AtlasEntry, panelsOf: (id: string) => readonly string[]): Group {
	const primary = e.category[0] ?? a.layer;
	if (primary === "news" && a.layer === "news") {
		if (telegram.has(a.id)) return "telegram";
		if (e.kind === "video" || BROADCAST.has(a.id)) return "video";
		if (e.region.startsWith("VE-")) return "regional";
		if (e.region === "VE") return "national";
		return "international";
	}
	// The markets panel's inputs are described by their layer (money) in the atlas; they read as markets.
	const panels = panelsOf(a.id);
	if (panels.includes("markets") && !panels.includes("money")) return "markets";
	if (primary === "news") return "society";
	return (GROUPS as readonly string[]).includes(primary) ? (primary as Group) : "society";
}

export interface SourceRow {
	id: string;
	group: Group;
	/** The name Vigía shows (outlets: the outlet's name). */
	name: L;
	/** Who publishes the data. */
	provider: string;
	homepage: string;
	access: Access;
	kind: L;
	/** "VE", a state code "VE-X", "diaspora" or "intl". */
	region: string;
	/** ISO 3166-1 alpha-2 of the publisher's base; "INT" when there is no single one, "EU" for EU bodies. */
	cc: string;
	country: L;
	lang: L;
	licence: { name: string; url: string };
	stance?: L;
}

export interface SourcesData {
	total: number;
	free: number;
	key: number;
	optin: number;
	/** Distinct news publishers (the same rule as facts.newsPublishers). */
	outlets: number;
	licences: number;
	countries: number;
	groups: { id: Group; slug: string; name: L; note: L; count: number }[];
	rows: SourceRow[];
	/** Regional news outlets (distinct publishers) per state, and the states' outlines for the mini map. */
	/** `small`: too small on the mini map for a number inside (the ranked list beside it carries it). */
	states: {
		iso: string;
		name: string;
		outlets: number;
		d: string;
		label: [number, number];
		small: boolean;
	}[];
	frame: { width: number; height: number };
}

/** Douglas-Peucker: the points of a polyline that keep it within `tol` of the original. */
function simplify(pts: readonly [number, number][], tol: number): [number, number][] {
	if (pts.length < 3) return [...pts];
	const keep = new Uint8Array(pts.length);
	keep[0] = 1;
	keep[pts.length - 1] = 1;
	const stack: [number, number][] = [[0, pts.length - 1]];
	while (stack.length > 0) {
		const [a, b] = stack.pop() as [number, number];
		const [ax, ay] = pts[a] as [number, number];
		const [bx, by] = pts[b] as [number, number];
		const len = Math.hypot(bx - ax, by - ay) || 1;
		let worst = -1;
		let at = -1;
		for (let i = a + 1; i < b; i++) {
			const [px, py] = pts[i] as [number, number];
			const dist = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
			if (dist > worst) {
				worst = dist;
				at = i;
			}
		}
		if (worst > tol && at > 0) {
			keep[at] = 1;
			stack.push([a, at], [at, b]);
		}
	}
	return pts.filter((_, i) => keep[i] === 1);
}

/**
 * A state's outline for the mini map: scaled by `k`, simplified to within half a unit, rounded to whole units (about
 * a pixel on screen), consecutive duplicates dropped.
 */
export function miniPath(d: string, k: number): string {
	const out: string[] = [];
	for (const ring of rings(d)) {
		const pts: [number, number][] = [];
		for (let i = 0; i + 1 < ring.length; i += 2)
			pts.push([(ring[i] as number) * k, (ring[i + 1] as number) * k]);
		// A ring starts and ends on one point: simplify its two halves, split at the middle point.
		const mid = Math.floor(pts.length / 2);
		const half = [...simplify(pts.slice(0, mid + 1), 0.5), ...simplify(pts.slice(mid), 0.5).slice(1)];
		const kept: [number, number][] = [];
		for (const [x, y] of half) {
			const p: [number, number] = [Math.round(x), Math.round(y)];
			const last = kept.at(-1);
			if (!last || last[0] !== p[0] || last[1] !== p[1]) kept.push(p);
		}
		if (kept.length < 3) continue;
		// Relative line-tos after the first point, the repeated command implied: the shortest form of the ring.
		const deltas: number[] = [];
		for (let i = 1; i < kept.length; i++) {
			const [px, py] = kept[i - 1] as [number, number];
			const [x, y] = kept[i] as [number, number];
			deltas.push(x - px, y - py);
		}
		const [fx, fy] = kept[0] as [number, number];
		const body = deltas.map((v, i) => (i === 0 || v < 0 ? `${v}` : ` ${v}`)).join("");
		out.push(`M${fx} ${fy}l${body}z`);
	}
	return out.join("");
}

/** The area of a state's bounding box (its largest ring), in the app's frame units. */
function area(d: string): number {
	let best = 0;
	for (const ring of rings(d)) {
		const xs = ring.filter((_, i) => i % 2 === 0);
		const ys = ring.filter((_, i) => i % 2 === 1);
		best = Math.max(best, (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)));
	}
	return best;
}

const both = (f: (l: "es" | "en") => string): L => ({ es: f("es"), en: f("en") });

export function sources(adapters: readonly Adapter[] = ADAPTERS, newsPublishers: number): SourcesData {
	const atlas = buildAtlas(adapters);
	const panelsBy = new Map<string, string[]>();
	for (const p of PANELS) for (const s of p.sources) panelsBy.set(s, [...(panelsBy.get(s) ?? []), p.id]);
	const panelsOf = (id: string) => panelsBy.get(id) ?? [];
	const rows: SourceRow[] = adapters.map((a) => {
		const e = atlas.get(a.id);
		if (!e) throw new Error(`no atlas entry for ${a.id}`);
		const outlet = OUTLETS.find((o) => o.id === a.id);
		return {
			id: a.id,
			group: groupOf(a, e, panelsOf),
			name: { es: a.name.es, en: a.name.en },
			provider: a.provider,
			homepage: a.homepage,
			access: accessOf(a),
			kind: telegram.has(a.id)
				? { es: "Canal de Telegram", en: "Telegram channel" }
				: both((l) => kindLabel(e.kind, l)),
			region: e.region,
			cc: e.country,
			country: both((l) => countryLabel(e.country, l)),
			lang: both((l) => langLabel(e.lang, l)),
			licence: { name: a.licence.name, url: a.licence.url },
			...(outlet ? { stance: both((l) => stanceLabel(outlet.stance, l)) } : {}),
		};
	});
	const byState = new Map<string, Set<string>>();
	for (const a of adapters) {
		const e = atlas.get(a.id);
		if (!e || a.layer !== "news" || !e.region.startsWith("VE-")) continue;
		byState.set(e.region, (byState.get(e.region) ?? new Set()).add(e.publisher));
	}
	// The mini map is drawn at a quarter of the app's frame: whole units there are about a pixel on screen.
	const k = 0.25;
	return {
		total: adapters.length,
		free: rows.filter((r) => r.access === "free").length,
		key: rows.filter((r) => r.access === "key").length,
		optin: rows.filter((r) => r.access === "optin").length,
		outlets: newsPublishers,
		licences: new Set(adapters.map((a) => a.licence.name)).size,
		countries: new Set([...atlas.values()].map((e) => e.country).filter((c) => c !== "INT" && c !== "EU"))
			.size,
		groups: GROUPS.map((id) => ({
			id,
			...GROUP_TEXT[id],
			count: rows.filter((r) => r.group === id).length,
		})).filter((g) => g.count > 0),
		rows,
		states: STATES.map((s) => ({
			iso: s.iso,
			name: s.name,
			outlets: byState.get(s.iso)?.size ?? 0,
			d: miniPath(s.d, k),
			label: [Math.round(s.label[0] * k), Math.round(s.label[1] * k)],
			small: area(s.d) * k * k < 700,
		})),
		frame: { width: Math.round(FRAME.width * k), height: Math.round(FRAME.height * k) },
	};
}
