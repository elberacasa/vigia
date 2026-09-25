import {
	GACETA_HOME,
	GACETA_LICENCE,
	type GacetaIssue,
	gacetaOficial,
} from "../adapters/gaceta-oficial/index.ts";
import { type ActCategory, classifyAct } from "../adapters/gaceta-oficial/redact.ts";
import type { Store } from "../core/store.ts";
import { caracasDateToMs } from "../formats/time.ts";
import type { Panel } from "../server/panels.ts";

/**
 * "¿Qué salió en la Gaceta?" The newest issues of the Official Gazette as the official index lists them: number,
 * ordinary or extraordinary, date, links to the page and the PDF, and each issue's acts. Only acts whose title has a
 * form that names no one are listed, in the index's own words; every other act (appointments, pensions,
 * delegations, transfers, and any wording the allowlist does not know) is counted per category, never shown
 * (adapters/gaceta-oficial/redact.ts). The rule is applied again here, so a row stored by an older version cannot
 * reach the page.
 */

const DAY = 86_400_000;
/** Issues shown: the last 30 days of the index. */
export const WINDOW_DAYS = 30;
export const MAX_ISSUES = 12;
/** Acts listed per issue before "y N más". */
export const MAX_ACTS = 6;

export type GazetteAct = { organ: string; title: string; instrument: string | null };

export type GazetteIssue = {
	number: number;
	kind: GacetaIssue["kind"];
	date: string;
	observedAt: number;
	fetchedAt: number;
	sourceUrl: string;
	pdfUrl: string | null;
	actsListed: boolean;
	/** Acts that name no person, in the index's order (at most MAX_ACTS). */
	acts: GazetteAct[];
	/** Further such acts beyond MAX_ACTS. */
	moreActs: number;
	/** Acts whose title is not shown, counted per category ("designacion": 5), largest first. */
	withheld: { category: ActCategory; n: number }[];
	/** Count of acts per instrument ("Resolución": 9, "Decreto": 1), largest first. */
	instruments: { name: string; n: number }[];
	/** The issue contains a law or a decree (shown first in the panel). */
	notable: boolean;
};

export type GazetteView = {
	feed: string;
	attribution: string;
	homepage: string;
	issues: GazetteIssue[];
	newest: { date: string; observedAt: number } | null;
	/** Days between the newest listed issue and now (the index lags the printed Gaceta). */
	lagDays: number | null;
	stale: boolean;
};

const NOTABLE = new Set(["Ley", "Decreto"]);

export function gazetteIssue(
	v: GacetaIssue,
	observedAt: number,
	fetchedAt: number,
	sourceUrl: string,
): GazetteIssue {
	const general: { organ: string; title: string; instrument: string | null }[] = [];
	const withheld = new Map<ActCategory, number>();
	for (const a of v.acts) {
		// Re-checked on read: a title is listed only if it is still listed under today's rule.
		const c = typeof a.title === "string" && a.title ? classifyAct(a.title) : null;
		if (c?.listed) general.push({ organ: a.organ, title: c.title, instrument: a.instrument });
		else {
			const k = a.withheld ?? c?.category ?? "otro";
			withheld.set(k, (withheld.get(k) ?? 0) + 1);
		}
	}
	const counts = new Map<string, number>();
	for (const a of v.acts) {
		const k = a.instrument ?? "Otro";
		counts.set(k, (counts.get(k) ?? 0) + 1);
	}
	return {
		number: v.number,
		kind: v.kind,
		date: v.date,
		observedAt,
		fetchedAt,
		sourceUrl,
		pdfUrl: v.pdfUrl,
		actsListed: v.actsListed,
		acts: general.slice(0, MAX_ACTS),
		moreActs: Math.max(0, general.length - MAX_ACTS),
		withheld: [...withheld.entries()]
			.map(([category, n]) => ({ category, n }))
			.sort((a, b) => b.n - a.n || a.category.localeCompare(b.category)),
		instruments: [...counts.entries()]
			.map(([name, n]) => ({ name, n }))
			.sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)),
		notable: v.acts.some((a) => a.instrument !== null && NOTABLE.has(a.instrument)),
	};
}

export function gazetteView(store: Store, now: number): GazetteView {
	const rows = store.latestPerSeries<GacetaIssue>(gacetaOficial.id, now - WINDOW_DAYS * DAY - DAY, 200);
	const issues = rows
		.filter((r) => caracasDateToMs(r.value.date) !== null && r.observedAt <= now)
		.map((r) => gazetteIssue(r.value, r.observedAt, r.fetchedAt, r.sourceUrl))
		.sort(
			(a, b) =>
				b.date.localeCompare(a.date) ||
				(a.kind === b.kind ? b.number - a.number : a.kind === "extraordinaria" ? -1 : 1),
		)
		.slice(0, MAX_ISSUES);
	const newest = issues[0] ?? null;
	return {
		feed: gacetaOficial.id,
		attribution: GACETA_LICENCE.attribution,
		homepage: GACETA_HOME,
		issues,
		newest: newest ? { date: newest.date, observedAt: newest.observedAt } : null,
		lagDays: newest ? Math.floor((now - newest.observedAt) / DAY) : null,
		stale: !newest || now - newest.observedAt > (gacetaOficial.freshness.dataMs ?? 21 * DAY),
	};
}

export const gazettePanel: Panel<GazetteView> = {
	id: "gazette",
	sources: [gacetaOficial.id],
	compute: (store: Store, now: number) => gazetteView(store, now),
};
