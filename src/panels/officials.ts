import { type OfficeValue, wikidataOfficials } from "../adapters/wikidata-officials/index.ts";
import type { OfficeKind } from "../adapters/wikidata-officials/sparql.ts";
import type { Store } from "../core/store.ts";
import { stateByIso } from "../geo/index.ts";
import type { Panel } from "../server/panels.ts";

/**
 * "¿Quién ocupa cada cargo?" Venezuela's public offices as Wikidata records them, with the rule stated: the term
 * with the latest start date decides; an ended term with no successor is shown as such, never filled by a guess.
 * Labelled "según Wikidata (editable por cualquiera)" with a link to each item. The Official Gazette's appointments
 * are the official record this view will be checked against.
 */

export const RULE =
	"Según Wikidata (editable por cualquiera): para cada cargo cuenta el período con la fecha de inicio más reciente. " +
	"Si terminó y no hay sucesor registrado, se dice así; los períodos sin fecha no se usan.";

const ORDER: readonly OfficeKind[] = [
	"president",
	"vice-president",
	"minister",
	"legislature",
	"central-bank",
	"justice",
	"governor",
	"other",
];

export type OfficialsView = {
	rule: string;
	/** Offices by kind, in the order above; within a kind, current holders first, then by label. */
	offices: (OfficeValue & { stateName: string | null })[];
	counts: { current: number; ended: number; unknown: number };
	readAt: number | null;
	feed: string;
	attribution: string;
	stale: boolean;
};

export function officialsOf(values: readonly OfficeValue[]): OfficialsView["offices"] {
	const rank = { current: 0, ended: 1, unknown: 2 } as const;
	return values
		.map((v) => ({ ...v, stateName: v.state ? (stateByIso(v.state)?.name ?? null) : null }))
		.sort(
			(a, b) =>
				ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) ||
				rank[a.status] - rank[b.status] ||
				a.office.label.localeCompare(b.office.label, "es"),
		);
}

export function officialsView(store: Store, now: number): OfficialsView {
	const latest = store.latestPerSeries<OfficeValue>(wikidataOfficials.id, 0, 1_000);
	const readAt = latest.reduce<number | null>(
		(m, o) => (m === null || o.fetchedAt > m ? o.fetchedAt : m),
		null,
	);
	// Only the offices of the newest reading (an office Wikidata stops listing drops out).
	const newest = latest
		.filter((o) => readAt !== null && readAt - o.fetchedAt < 3_600_000)
		.map((o) => o.value);
	const offices = officialsOf(newest);
	return {
		rule: RULE,
		offices,
		counts: {
			current: offices.filter((o) => o.status === "current").length,
			ended: offices.filter((o) => o.status === "ended").length,
			unknown: offices.filter((o) => o.status === "unknown").length,
		},
		readAt,
		feed: wikidataOfficials.id,
		attribution: wikidataOfficials.licence.attribution,
		stale: readAt === null || now - readAt > wikidataOfficials.freshness.fetchMs,
	};
}

export const officialsPanel: Panel<OfficialsView> = {
	id: "officials",
	onDemand: true,
	sources: [wikidataOfficials.id],
	compute: (store: Store, now: number) => officialsView(store, now),
};
