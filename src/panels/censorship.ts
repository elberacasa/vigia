import { ISPS } from "../adapters/ioda-asn/index.ts";
import { categoryEs } from "../adapters/ooni-ve/categories.ts";
import {
	FLAG_RATE,
	MIN_MEASUREMENTS,
	OONI_LICENCE,
	type OoniDomain,
	type OoniIsp,
	type OoniSummary,
	type OoniValue,
} from "../adapters/ooni-ve/index.ts";
import { VESINFILTRO_LICENCE, type VsfSite } from "../adapters/vesinfiltro-blocks/index.ts";
import type { Store, StoredObservation } from "../core/store.ts";
import type { Panel } from "../server/panels.ts";
import { type BlockTimeline, blockTimeline } from "./blocktimeline.ts";
import { newestCompleteRun } from "./ooni-runs.ts";

/**
 * Website blocking in Venezuela from two independent sources, side by side and never blended:
 * - OONI: volunteers' automated measurements; a domain is a "posible bloqueo" on an ISP when ≥ 10 measurements
 *   in 7 days show ≥ 50 % anomalies (rule and its measured agreement in src/adapters/ooni-ve).
 * - VE sin Filtro: a hand-checked list with the blocking method per ISP, dated by its last update.
 * Every count says which source it comes from. Sites are joined on the domain without "www.".
 */

const DAY = 86_400_000;
/** OONI rows older than this are not shown (the feed's own stale badge covers shorter delays). */
const OONI_MAX_AGE_MS = 3 * DAY;

export type OoniBlock = {
	/** When the aggregates were read (UTC ms). */
	fetchedAt: number;
	/** Newest VE measurement OONI had then (UTC ms), or the read time when unknown. */
	observedAt: number;
	since: string;
	until: string;
	measurements: number;
	anomalies: number;
	domainsTested: number;
	domainsFlagged: number;
	rule: string;
	feed: string;
	sourceUrl: string;
	attribution: string;
	licence: string;
};

export type VsfBlock = {
	/** The list's update date (YYYY-MM-DD, Venezuela) and the same as UTC ms. */
	updated: string;
	observedAt: number;
	fetchedAt: number;
	sitesListed: number;
	sitesActive: number;
	/** Active sites (join key) blocked on at least one ISP. */
	sitesBlocked: number;
	feed: string;
	sourceUrl: string;
	attribution: string;
	licence: string;
};

export type CategoryRow = {
	code: string;
	label: string;
	/** OONI domains flagged on ≥ 1 ISP, by OONI's category. */
	ooni: number;
	/** VE sin Filtro active entries blocked on ≥ 1 ISP, by its category. */
	vsf: number;
};

export type IspRow = {
	isp: string;
	name: string;
	ooni: { flagged: number; tested: number; measurements: number; anomalyRatePct: number } | null;
	vsf: {
		blocked: number;
		/** How many blocked sites use each method on this ISP (a site can use several). */
		methods: { method: string; count: number }[];
		/** Active sites VE sin Filtro could not test on this ISP. */
		noData: number;
	} | null;
};

export type SiteRow = {
	/** Join key: domain without "www.". */
	key: string;
	/** VE sin Filtro's name for the site, else the domain. */
	name: string;
	category: string;
	categoryLabel: string;
	/** Which sources flag it. */
	agreement: "both" | "vsf-only" | "ooni-only";
	vsf: { blockedOn: string[]; methods: string[]; active: boolean } | null;
	ooni: { flaggedOn: string[]; anomalyRatePct: number; measurements: number; url: string } | null;
};

export type CensorshipView = {
	/** Blocks and unblocks detected between stored versions, newest first (30 days). */
	timeline: BlockTimeline;
	ooni: OoniBlock | null;
	vsf: VsfBlock | null;
	agreement: { both: number; vsfOnly: number; ooniOnly: number };
	byCategory: CategoryRow[];
	byIsp: IspRow[];
	sites: SiteRow[];
	notes: string[];
	feeds: string[];
};

const pct = (x: number) => Math.round(x * 1_000) / 10;

function latestRun<V extends OoniValue>(
	rows: StoredObservation<OoniValue>[],
	kind: V["kind"],
): StoredObservation<V>[] {
	return rows.filter((o) => o.value.kind === kind) as StoredObservation<V>[];
}

export function censorshipView(store: Store, now: number): CensorshipView {
	// OONI: rows of the newest COMPLETE run only (a domain no longer flagged simply is not in it, which is only
	// evidence when the run carried OONI's usual volume: src/panels/ooni-runs.ts). A thin newest run leaves the
	// previous complete one on screen, with its own age.
	const ooniRunAt = newestCompleteRun(store, now - OONI_MAX_AGE_MS, now);
	const ooniRows =
		ooniRunAt === null ? [] : store.fetchedAt<OoniValue>("ooni-ve", ooniRunAt, OONI_MAX_AGE_MS + 8 * DAY);
	const summary = latestRun<OoniSummary>(ooniRows, "summary")[0];
	const ooniDomains = latestRun<OoniDomain>(ooniRows, "domain");
	const ooniIsps = latestRun<OoniIsp>(ooniRows, "isp");

	// VE sin Filtro: rows of the newest list update.
	const vsfAll = store.latestPerSeries<VsfSite>("vesinfiltro-blocks", 0, 5_000);
	let vsfAt = 0;
	for (const o of vsfAll) vsfAt = Math.max(vsfAt, o.observedAt);
	const vsfRows = vsfAll.filter((o) => o.observedAt === vsfAt);
	const blockedOn = (s: VsfSite) => s.isps.filter((c) => c.status === "blocked").map((c) => c.isp);
	const vsfBlocked = vsfRows.filter((o) => o.value.active && blockedOn(o.value).length > 0);

	const ooni: OoniBlock | null = summary
		? {
				fetchedAt: summary.fetchedAt,
				observedAt: summary.observedAt,
				since: summary.value.since,
				until: summary.value.until,
				measurements: summary.value.measurements,
				anomalies: summary.value.anomalies,
				domainsTested: summary.value.domainsTested,
				domainsFlagged: summary.value.domainsFlagged,
				rule: `Posible bloqueo: en un proveedor, al menos ${MIN_MEASUREMENTS} mediciones en 7 días y ${Math.round(FLAG_RATE * 100)} % o más con anomalía. OONI casi nunca «confirma» en Venezuela porque el bloqueo es por DNS.`,
				feed: "ooni-ve",
				sourceUrl: summary.sourceUrl,
				attribution: OONI_LICENCE.attribution,
				licence: OONI_LICENCE.id,
			}
		: null;

	const first = vsfRows[0];
	const vsf: VsfBlock | null = first
		? {
				updated: first.value.updated,
				observedAt: vsfAt,
				fetchedAt: Math.max(...vsfRows.map((o) => o.fetchedAt)),
				sitesListed: vsfRows.length,
				sitesActive: vsfRows.filter((o) => o.value.active).length,
				sitesBlocked: new Set(vsfBlocked.map((o) => o.value.key)).size,
				feed: "vesinfiltro-blocks",
				sourceUrl: first.sourceUrl,
				attribution: VESINFILTRO_LICENCE.attribution,
				licence: VESINFILTRO_LICENCE.id,
			}
		: null;

	// Sites, joined on the key. VE sin Filtro may list "www.x" and "x": their blocks are united.
	type Acc = { key: string; name: string; category: string; vsf: SiteRow["vsf"]; ooni: SiteRow["ooni"] };
	const sites = new Map<string, Acc>();
	for (const o of vsfRows) {
		const s = o.value;
		const on = blockedOn(s);
		if (!s.active || on.length === 0) continue;
		const methods = [...new Set(s.isps.flatMap((c) => c.methods))].sort();
		const prev = sites.get(s.key);
		if (prev?.vsf) {
			prev.vsf.blockedOn = [...new Set([...prev.vsf.blockedOn, ...on])];
			prev.vsf.methods = [...new Set([...prev.vsf.methods, ...methods])].sort();
			continue;
		}
		sites.set(s.key, {
			key: s.key,
			name: s.site,
			category: s.category,
			vsf: { blockedOn: on, methods, active: true },
			ooni: null,
		});
	}
	for (const o of ooniDomains) {
		const d = o.value;
		const entry: NonNullable<SiteRow["ooni"]> = {
			flaggedOn: d.isps.filter((c) => c.flagged).map((c) => c.isp),
			anomalyRatePct: pct(d.anomalyRate),
			measurements: d.measurements,
			url: o.sourceUrl,
		};
		const prev = sites.get(d.domain);
		if (prev) prev.ooni = entry;
		else sites.set(d.domain, { key: d.domain, name: d.domain, category: d.category, vsf: null, ooni: entry });
	}
	const ispOrder = new Map(ISPS.map((i, n) => [i.id, n]));
	const byIspOrder = (a: string, b: string) => (ispOrder.get(a) ?? 99) - (ispOrder.get(b) ?? 99);
	const siteRows: SiteRow[] = [...sites.values()].map((s) => {
		if (s.vsf) s.vsf.blockedOn.sort(byIspOrder);
		s.ooni?.flaggedOn.sort(byIspOrder);
		return {
			key: s.key,
			name: s.name,
			category: s.category,
			categoryLabel: categoryEs(s.category),
			agreement: s.vsf && s.ooni ? "both" : s.vsf ? "vsf-only" : "ooni-only",
			vsf: s.vsf,
			ooni: s.ooni,
		};
	});
	const rank = { both: 0, "vsf-only": 1, "ooni-only": 2 } as const;
	const reach = (s: SiteRow) => Math.max(s.vsf?.blockedOn.length ?? 0, s.ooni?.flaggedOn.length ?? 0);
	siteRows.sort(
		(a, b) => rank[a.agreement] - rank[b.agreement] || reach(b) - reach(a) || a.key.localeCompare(b.key),
	);

	const categories = new Map<string, CategoryRow>();
	const cat = (code: string) => {
		let row = categories.get(code);
		if (!row) {
			row = { code, label: categoryEs(code), ooni: 0, vsf: 0 };
			categories.set(code, row);
		}
		return row;
	};
	for (const o of ooniDomains) cat(o.value.category).ooni++;
	const vsfKeys = new Map<string, string>();
	for (const o of vsfBlocked) vsfKeys.set(o.value.key, o.value.category);
	for (const code of vsfKeys.values()) cat(code).vsf++;

	const byIsp: IspRow[] = ISPS.map((isp) => {
		const o = ooniIsps.find((r) => r.value.isp === isp.id)?.value;
		const blockedHere = vsfRows.filter(
			(r) => r.value.active && r.value.isps.some((c) => c.isp === isp.id && c.status === "blocked"),
		);
		const hasColumn = vsfRows.some((r) => r.value.isps.some((c) => c.isp === isp.id));
		// Per site (join key), so "www.x" and "x" count once; a site's methods are the union of its entries'.
		const perKey = new Map<string, Set<string>>();
		for (const r of blockedHere) {
			const set = perKey.get(r.value.key) ?? new Set<string>();
			for (const m of r.value.isps.find((c) => c.isp === isp.id)?.methods ?? []) set.add(m);
			perKey.set(r.value.key, set);
		}
		const methods = new Map<string, number>();
		for (const set of perKey.values()) for (const m of set) methods.set(m, (methods.get(m) ?? 0) + 1);
		return {
			isp: isp.id,
			name: isp.name,
			ooni: o
				? {
						flagged: o.domainsFlagged,
						tested: o.domainsTested,
						measurements: o.measurements,
						anomalyRatePct: pct(o.anomalyRate),
					}
				: null,
			vsf: hasColumn
				? {
						blocked: perKey.size,
						methods: [...methods]
							.map(([method, count]) => ({ method, count }))
							.sort((a, b) => b.count - a.count),
						noData: new Set(
							vsfRows
								.filter(
									(r) =>
										r.value.active && r.value.isps.some((c) => c.isp === isp.id && c.status === "no-data"),
								)
								.map((r) => r.value.key),
						).size,
					}
				: null,
		};
	});

	return {
		timeline: blockTimeline(store, now),
		ooni,
		vsf,
		agreement: {
			both: siteRows.filter((s) => s.agreement === "both").length,
			vsfOnly: siteRows.filter((s) => s.agreement === "vsf-only").length,
			ooniOnly: siteRows.filter((s) => s.agreement === "ooni-only").length,
		},
		byCategory: [...categories.values()].sort(
			(a, b) => b.ooni + b.vsf - (a.ooni + a.vsf) || a.code.localeCompare(b.code),
		),
		byIsp,
		sites: siteRows,
		notes: [
			"Dos fuentes independientes, lado a lado: OONI (mediciones automáticas de voluntarios) y VE sin Filtro (lista verificada a mano). No se suman ni se promedian.",
			"«Posible bloqueo» de OONI es una señal estadística; VE sin Filtro indica el método (DNS, HTTP/HTTPS, TCP IP) por proveedor.",
			"Que un sitio no aparezca no prueba que esté accesible: puede no haberse medido.",
		],
		feeds: ["ooni-ve", "vesinfiltro-blocks"],
	};
}

export const censorshipPanel: Panel<CensorshipView> = {
	id: "censorship",
	sources: ["ooni-ve", "vesinfiltro-blocks"],
	compute: (store: Store, now: number) => censorshipView(store, now),
};
