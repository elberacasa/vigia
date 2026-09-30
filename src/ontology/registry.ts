/**
 * The entity registry: every entity Vigía can link a signal to, built once from the official boundaries
 * (src/geo), the generated infrastructure file (scripts/ontology/build.ts), Vigía's own lists (ISPs, outlets,
 * institutions) and the flare facilities. Pure and synchronous; built lazily on first use (about 40 ms for 3,126 entities, measured
 * 2026-09-28) and then read-only.
 *
 * Ids are stable and readable:
 *   ve                                   the country
 *   ve.zulia                             a state (slug of its name)
 *   ve.zulia.maracaibo                   a municipality (formal prefixes dropped: "Bolivariano Guaicaipuro" → guaicaipuro)
 *   ve.distrito-capital.libertador.altagracia   a parish
 *   infra.planta-centro                  infrastructure (scripts/ontology/build.ts decides the slug)
 *   net.cantv, asn.8048                  an ISP and one of its autonomous systems
 *   outlet.el-pitazo                     a publisher (all its feeds: site, YouTube, Telegram)
 *   inst.bcv                             a public institution
 */
import { ISPS } from "../adapters/ioda-asn/index.ts";
import { STANCE_LABELS } from "../adapters/rss/factory.ts";
import { OUTLETS } from "../adapters/rss/outlets.ts";
import { CAMERAS } from "../cameras/list.ts";
import type { Json } from "../core/types.ts";
import gazetteerJson from "../geo/data/gazetteer.json" with { type: "json" };
import { municipalities, stateByCode, states } from "../geo/index.ts";
import { normalize } from "../news/text.ts";
import infrastructureJson from "./data/infrastructure.json" with { type: "json" };
import { DATASETS } from "./datasets.ts";
import { parishes, placeAt } from "./geo.ts";
import { INSTITUTIONS } from "./institutions.ts";
import { shortMunicipalityName, slug } from "./slug.ts";
import type { Dataset, DatasetId, Entity, EntityType, Relation } from "./types.ts";

export type InfraItem = {
	readonly id: string;
	readonly kind: string;
	readonly es: string;
	readonly en?: string;
	readonly aliases?: readonly string[];
	readonly lat: number;
	readonly lon: number;
	readonly state?: string;
	readonly municipality?: string;
	readonly parish?: string;
	readonly placement?: string;
	readonly dataset: DatasetId;
	readonly codes: Readonly<Record<string, string>>;
	readonly attributes?: Readonly<Record<string, Json>>;
	readonly operator?: string;
	readonly lines?: readonly (readonly (readonly [number, number])[])[];
};

export const INFRA_META = (infrastructureJson as unknown as { meta: Record<string, Json> }).meta;
export const INFRA_ITEMS = (infrastructureJson as unknown as { items: InfraItem[] }).items;

type GazEntry = {
	id: string;
	name: string;
	kind: string;
	stateCode: string;
	municipalityCode?: string;
	lat: number;
	lon: number;
	variants?: string[];
};

export type SearchHit = { readonly entity: Entity; readonly score: number; readonly matched: string };

export interface Registry {
	readonly all: readonly Entity[];
	get(id: string): Entity | undefined;
	/** Direct children (entities whose first parent is `id`), in id order. */
	children(id: string): readonly Entity[];
	/** Parent chain, nearest first (a parish: its municipality, state, country). */
	ancestors(id: string): readonly Entity[];
	/** Every entity whose ancestor chain contains `id` (a state's municipalities, parishes and facilities). */
	within(id: string): readonly Entity[];
	/** An entity by an external code: "pcode:VE0101", "iso:VE-V", "asn:8048", "isp:cantv", "feed:yt-el-pitazo"… */
	byCode(key: string): Entity | undefined;
	search(query: string, options?: { type?: EntityType | undefined; limit?: number | undefined }): SearchHit[];
	readonly datasets: Readonly<Record<DatasetId, Dataset>>;
}

const COUNTRY_ID = "ve";

/** The id of a state from its ISO code, without building the registry (for hot paths). */
export function stateId(iso: string): string | null {
	const s = states().find((x) => x.iso === iso);
	return s ? `ve.${slug(s.name)}` : null;
}

function build(): Registry {
	const list: Entity[] = [];
	const codes = new Map<string, string>();
	const add = (e: Entity, keys: readonly string[] = []) => {
		list.push(e);
		for (const k of keys) {
			if (codes.has(k)) throw new Error(`code ${k} maps to two entities (${codes.get(k)}, ${e.id})`);
			codes.set(k, e.id);
		}
	};
	const gaz = (gazetteerJson as unknown as { entries: GazEntry[] }).entries;
	const gazById = new Map(gaz.map((g) => [g.id, g]));

	// ——— country and states ———
	const all = states();
	const area = all.reduce((s, x) => s + x.areaKm2, 0);
	add(
		{
			id: COUNTRY_ID,
			type: "country",
			kind: null,
			name: { es: "Venezuela", en: "Venezuela" },
			short: null,
			aliases: ["República Bolivariana de Venezuela"],
			parents: [],
			related: [],
			point: { lat: 7.1, lon: -66.2 },
			geometry: "cod-ab:VE",
			codes: { iso: "VE", pcode: "VE" },
			attributes: {
				areaKm2: Math.round(area),
				note: "El territorio es el de los límites oficiales (COD-AB): no incluye la Guayana Esequiba ni la Isla de Aves.",
			},
			dataset: "cod-ab-ven",
		},
		["iso:VE"],
	);
	const stateIdByCode = new Map<string, string>();
	for (const s of all) {
		const id = `ve.${slug(s.name)}`;
		stateIdByCode.set(s.code, id);
		const g = gazById.get(`state:${s.code}`);
		add(
			{
				id,
				type: "state",
				kind: null,
				name: { es: s.name, en: s.name },
				short: null,
				aliases: g?.variants ?? [],
				parents: [COUNTRY_ID],
				related: [],
				point: { lat: s.label.lat, lon: s.label.lon },
				geometry: `cod-ab:${s.code}`,
				codes: { pcode: s.code, iso: s.iso },
				attributes: { capital: s.capital, areaKm2: s.areaKm2 },
				dataset: "cod-ab-ven",
			},
			[`pcode:${s.code}`, `iso:${s.iso}`],
		);
	}

	// ——— municipalities and parishes ———
	const muniId = new Map<string, string>();
	for (const m of municipalities()) {
		const state = stateIdByCode.get(m.stateCode);
		// OCHA's placeholder VE2501 carries Dependencias Federales down a level; it is not a municipality.
		if (!state || m.code === "VE2501") continue;
		const short = shortMunicipalityName(m.name);
		const id = `${state}.${slug(short)}`;
		muniId.set(m.code, id);
		const g = gazById.get(`mun:${m.code}`);
		add(
			{
				id,
				type: "municipality",
				kind: null,
				name: { es: m.name, en: m.name },
				short: short !== m.name ? short : null,
				aliases: g?.variants ?? [],
				parents: [state],
				related: [],
				point: g ? { lat: g.lat, lon: g.lon } : null,
				geometry: `cod-ab:${m.code}`,
				codes: { pcode: m.code },
				attributes: {},
				dataset: "cod-ab-ven",
			},
			[`pcode:${m.code}`],
		);
	}
	const parishId = new Map<string, string>();
	for (const p of parishes()) {
		const parent = muniId.get(p.municipality);
		if (!parent) continue;
		const id = `${parent}.${slug(p.name)}`;
		parishId.set(p.code, id);
		const g = gazById.get(`parish:${p.code}`);
		add(
			{
				id,
				type: "parish",
				kind: null,
				name: { es: p.name, en: p.name },
				short: null,
				aliases: g?.variants ?? [],
				parents: [parent],
				related: [],
				point: { lat: p.lat, lon: p.lon },
				geometry: `cod-ab:${p.code}`,
				codes: { pcode: p.code },
				attributes: { areaKm2: p.areaKm2 },
				dataset: "cod-ab-ven",
			},
			[`pcode:${p.code}`],
		);
	}

	// ——— infrastructure ———
	const stateIdByIso = new Map(all.map((s) => [s.iso, stateIdByCode.get(s.code) ?? ""]));
	for (const r of INFRA_ITEMS) {
		const parent =
			(r.parish && parishId.get(r.parish)) ||
			(r.municipality && muniId.get(r.municipality)) ||
			(r.state && stateIdByIso.get(r.state)) ||
			COUNTRY_ID;
		const related: Relation[] = r.operator ? [{ rel: "operator", id: r.operator }] : [];
		const keys = Object.entries(r.codes)
			.filter(([k]) => k !== "voltageKV" && k !== "ourairports")
			.map(([k, v]) => `${k}:${v}`);
		add(
			{
				id: r.id,
				type: "infrastructure",
				kind: r.kind,
				name: { es: r.es, en: r.en ?? r.es },
				short: null,
				aliases: r.aliases ?? [],
				parents: [parent],
				related,
				point: { lat: r.lat, lon: r.lon },
				geometry: r.codes.osm ? `osm:${r.codes.osm}` : r.lines ? `grid:${r.id}` : null,
				codes: r.codes,
				attributes: { ...(r.attributes ?? {}), ...(r.placement ? { placement: r.placement } : {}) },
				dataset: r.dataset,
			},
			keys,
		);
	}

	// ——— public cameras (src/cameras/list.ts): placed by point in polygon, like the facilities ———
	for (const c of CAMERAS) {
		const where = c.country === "VE" ? placeAt(c.lat, c.lon, 2) : null;
		const parent =
			(where?.parish && parishId.get(where.parish)) ||
			(where?.municipality && muniId.get(where.municipality)) ||
			(where?.state && stateIdByIso.get(where.state)) ||
			(c.country === "VE" ? COUNTRY_ID : null);
		add(
			{
				id: `cam.${c.id}`,
				type: "camera",
				kind: c.kind,
				name: c.name,
				short: null,
				aliases: [c.operator.name],
				parents: parent ? [parent] : [],
				related: [],
				point: { lat: c.lat, lon: c.lon },
				geometry: null,
				codes: { camera: c.id },
				attributes: {
					operator: c.operator.name,
					operatorUrl: c.operator.url,
					page: c.page,
					headingDeg: c.headingDeg,
					country: c.country,
					access: c.access.type,
					view: c.view.es,
					positionFrom: c.positionFrom,
				},
				dataset: "vigia-cameras",
			},
			[`camera:${c.id}`],
		);
	}

	// ——— networks ———
	const ISP_OPERATOR: Record<string, string> = { cantv: "inst.cantv", movilnet: "inst.movilnet" };
	for (const isp of ISPS) {
		const id = `net.${isp.id}`;
		add(
			{
				id,
				type: "network",
				kind: "isp",
				name: { es: isp.name, en: isp.name },
				short: null,
				aliases: [isp.holder],
				parents: [COUNTRY_ID],
				related: [
					...(ISP_OPERATOR[isp.id] ? [{ rel: "operator" as const, id: ISP_OPERATOR[isp.id] as string }] : []),
				],
				point: null,
				geometry: null,
				codes: { isp: isp.id },
				attributes: { service: isp.kind, asns: [...isp.asns], holder: isp.holder },
				dataset: "vigia-isps",
			},
			[`isp:${isp.id}`],
		);
		for (const asn of isp.asns)
			add(
				{
					id: `asn.${asn}`,
					type: "network",
					kind: "asn",
					name: { es: `AS${asn} (${isp.name})`, en: `AS${asn} (${isp.name})` },
					short: `AS${asn}`,
					aliases: [`AS${asn}`, asn, isp.holder],
					parents: [id],
					related: [{ rel: "network-of", id }],
					point: null,
					geometry: null,
					codes: { asn },
					attributes: { holder: isp.holder },
					dataset: "vigia-isps",
				},
				[`asn:${asn}`],
			);
	}

	// ——— outlets (publishers; each feed maps to its publisher) ———
	const byFeed = new Map(OUTLETS.map((o) => [o.id, o]));
	const feedsOf = new Map<string, string[]>();
	for (const o of OUTLETS) {
		const pub = o.publisher && byFeed.has(o.publisher) ? o.publisher : o.id;
		feedsOf.set(pub, [...(feedsOf.get(pub) ?? []), o.id]);
	}
	for (const [pub, feeds] of [...feedsOf].sort((a, b) => a[0].localeCompare(b[0]))) {
		const o = byFeed.get(pub);
		if (!o) continue;
		const home = o.region.startsWith("VE-") ? stateIdByIso.get(o.region) : undefined;
		add(
			{
				id: `outlet.${pub}`,
				type: "outlet",
				kind: o.stance,
				name: { es: o.name, en: o.name },
				short: null,
				aliases: feeds.filter((f) => f !== pub).map((f) => byFeed.get(f)?.name ?? f),
				parents: home ? [home] : o.region === "national" ? [COUNTRY_ID] : [],
				related: [],
				point: null,
				geometry: null,
				codes: { outlet: pub },
				attributes: {
					region: o.region,
					stance: o.stance,
					stanceLabel: STANCE_LABELS[o.stance].es,
					genre: o.genre ?? "news",
					lang: o.lang ?? "es",
					homepage: o.homepage,
					feeds,
				},
				dataset: "vigia-outlets",
			},
			[`outlet:${pub}`, ...feeds.map((f) => `feed:${f}`)],
		);
	}

	// ——— institutions ———
	for (const i of INSTITUTIONS) {
		const related: Relation[] = [
			...(i.attachedTo ? [{ rel: "attached-to" as const, id: i.attachedTo }] : []),
		];
		add(
			{
				id: i.id,
				type: "institution",
				kind: i.kind,
				name: { es: i.es, en: i.en },
				short: i.short ?? null,
				aliases: [...(i.aliases ?? []), ...(i.organs ?? [])],
				parents: [COUNTRY_ID],
				related,
				point: null,
				geometry: null,
				codes: {},
				attributes: {
					...(i.homepage ? { homepage: i.homepage } : {}),
					...(i.organs?.length ? { gazetteOrgans: [...i.organs] } : {}),
					...(i.publishes?.length ? { publishes: [...i.publishes] } : {}),
				},
				dataset: "vigia-institutions",
			},
			[...(i.organs ?? []).map((o) => `organ:${o}`), ...(i.publishes ?? []).map((f) => `publisher-of:${f}`)],
		);
	}

	// ——— indexes ———
	const byId = new Map<string, Entity>();
	for (const e of list) {
		if (byId.has(e.id)) throw new Error(`duplicate entity id ${e.id}`);
		byId.set(e.id, e);
	}
	const kids = new Map<string, Entity[]>();
	for (const e of list) {
		const p = e.parents[0];
		if (p) kids.set(p, [...(kids.get(p) ?? []), e]);
	}
	for (const v of kids.values()) v.sort((a, b) => a.id.localeCompare(b.id));
	const chain = new Map<string, Entity[]>();
	const ancestorsOf = (id: string): Entity[] => {
		const hit = chain.get(id);
		if (hit) return hit;
		const out: Entity[] = [];
		let cur = byId.get(id)?.parents[0];
		for (let depth = 0; cur && depth < 10; depth++) {
			const e = byId.get(cur);
			if (!e) break;
			out.push(e);
			cur = e.parents[0];
		}
		chain.set(id, out);
		return out;
	};
	const inside = new Map<string, Entity[]>();
	for (const e of list) for (const a of ancestorsOf(e.id)) inside.set(a.id, [...(inside.get(a.id) ?? []), e]);

	// Search keys: names, short names, aliases and codes, normalised once.
	// Search keys: names and aliases (matched anywhere), and codes (matched whole or as a prefix only: "8048" must
	// not find an OSM way whose id contains it). Normalised once.
	const keysOf = new Map<string, SearchKeys>();
	const OPAQUE = new Set(["osm", "ourairports", "portwatch", "facility", "voltageKV"]);
	for (const e of list) {
		const names = [e.name.es, e.name.en, e.short ?? "", ...e.aliases];
		const codes = Object.entries(e.codes)
			.filter(([k]) => !OPAQUE.has(k))
			.map(([, v]) => v);
		keysOf.set(e.id, {
			names: [...new Set(names.map(normalize).filter(Boolean))],
			codes: [...new Set(codes.map(normalize).filter(Boolean))],
		});
	}

	return {
		all: list,
		get: (id) => byId.get(id),
		children: (id) => kids.get(id) ?? [],
		ancestors: ancestorsOf,
		within: (id) => inside.get(id) ?? [],
		byCode: (key) => {
			const id = codes.get(key);
			return id ? byId.get(id) : undefined;
		},
		search: (query, options = {}) => search(list, keysOf, query, options),
		datasets: DATASETS,
	};
}

/** How much a type weighs when two matches are equally good: places people look up first. */
const TYPE_WEIGHT: Record<EntityType, number> = {
	country: 7,
	state: 6,
	municipality: 5,
	institution: 4,
	network: 4,
	outlet: 3,
	infrastructure: 2,
	parish: 2,
	camera: 1,
};
const INFRA_WEIGHT: Record<string, number> = { hospital: -1, substation: -1, reservoir: -0.5, dam: -0.5 };

type SearchKeys = { readonly names: readonly string[]; readonly codes: readonly string[] };

function search(
	list: readonly Entity[],
	keysOf: ReadonlyMap<string, SearchKeys>,
	query: string,
	options: { type?: EntityType | undefined; limit?: number | undefined },
): SearchHit[] {
	const q = normalize(query);
	if (!q) return [];
	const qTokens = q.split(" ");
	const hits: SearchHit[] = [];
	for (const e of list) {
		if (options.type && e.type !== options.type) continue;
		let best = 0;
		let matched = "";
		const keys = keysOf.get(e.id);
		for (const k of keys?.names ?? []) {
			let s = 0;
			if (k === q) s = 100;
			else if (k.startsWith(q)) s = 80;
			else {
				const kt = k.split(" ");
				if (qTokens.every((t) => kt.some((w) => w.startsWith(t)))) s = 60;
				else if (k.includes(q)) s = 40;
			}
			if (s > best) {
				best = s;
				matched = k;
			}
		}
		for (const k of keys?.codes ?? []) {
			const s = k === q ? 100 : k.startsWith(q) ? 70 : 0;
			if (s > best) {
				best = s;
				matched = k;
			}
		}
		if (best > 0)
			hits.push({
				entity: e,
				score: best + TYPE_WEIGHT[e.type] + (INFRA_WEIGHT[e.kind ?? ""] ?? 0),
				matched,
			});
	}
	hits.sort(
		(a, b) =>
			b.score - a.score ||
			a.entity.name.es.length - b.entity.name.es.length ||
			a.entity.id.localeCompare(b.entity.id),
	);
	return hits.slice(0, Math.max(1, Math.min(51, options.limit ?? 20)));
}

let cached: Registry | null = null;

/** The registry, built on first use. */
export function registry(): Registry {
	cached ??= build();
	return cached;
}

/** The state entity id of a state P-code ("VE23" → "ve.zulia"). */
export function stateIdOfCode(code: string): string | null {
	const s = stateByCode(code);
	return s ? `ve.${slug(s.name)}` : null;
}
