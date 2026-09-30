import { type FrDocument, federalRegister } from "../adapters/federal-register/index.ts";
import {
	type ChangeValue,
	OFAC_SEARCH,
	type OfacValue,
	ofacSdn,
	type PublicationValue,
	type SnapshotValue,
	type Subject,
} from "../adapters/ofac-sdn/index.ts";
import {
	type GeneralLicence,
	type LicenceList,
	type OfacVenezuelaValue,
	ofacVenezuela,
	type RecentAction,
} from "../adapters/ofac-venezuela/index.ts";
import type { Store, StoredObservation } from "../core/store.ts";
import type { Json } from "../core/types.ts";
import type { Panel } from "../server/panels.ts";

/**
 * "¿Qué sanciona EE. UU. y qué autoriza?" OFAC's Venezuela programmes as OFAC publishes them: how many parties are on
 * the list and of what kind, who among them are public officials (named by OFAC's title or an unambiguous Wikidata
 * office holder; everyone else only counted), the companies and vessels by name, aircraft by model; every
 * designation, removal and update of the last year with OFAC's date; the general licences in force with the ones
 * issued or amended in the last 30 days marked; and the Federal Register documents about Venezuela. Counts and
 * diffs are computed here; nothing is inferred beyond OFAC's own files.
 */

const DAY = 86_400_000;
export const RECENT_DAYS = 30;
export const CHANGE_DAYS = 365;

export const NAMING_RULE =
	"Se nombra a funcionarios públicos: cuando el título que da OFAC es un cargo público venezolano o cuando Wikidata " +
	"registra a la persona como titular de un cargo público venezolano (coincidencia inequívoca del nombre). Las demás " +
	"personas se cuentan, sin nombre. Empresas y buques se nombran; las aeronaves se cuentan por modelo.";

export type ChangeRow = {
	/** OFAC's publication time (epoch ms). */
	at: number;
	publicationId: number;
	action: ChangeValue["action"];
	subject: Subject;
	programs: string[];
	listedOn: string | null;
	url: string;
};

export type SanctionsView = {
	now: number;
	namingRule: string;
	sdn: {
		/** The publication the counts reflect. */
		asOf: { publicationId: number; observedAt: number; fetchedAt: number } | null;
		/** Newer OFAC publications already known than the one the counts reflect (the list is being re-read). */
		publicationsBehind: number;
		counts: SnapshotValue["counts"] | null;
		byProgram: { program: string; n: number }[];
		officials: (SnapshotValue["officials"][number] & { url: string })[];
		unnamedIndividuals: number;
		entities: (SnapshotValue["entities"][number] & { url: string })[];
		vessels: (SnapshotValue["vessels"][number] & { url: string })[];
		aircraftByModel: SnapshotValue["aircraftByModel"];
		wikidataChecked: boolean;
		/** Venezuela-programme changes in OFAC's publications of the last year, newest first. */
		changes: ChangeRow[];
		/** Adds, removals and updates in the last 30 days and the last year. */
		tally: { days30: Tally; days365: Tally };
		/** The list compared with the previous snapshot: total count then and now. */
		sinceLast: { publicationId: number; totalBefore: number; totalNow: number } | null;
		/** OFAC publications of the last year that were read, with or without Venezuela entries. */
		publicationsRead: number;
		feed: string;
		sourceUrl: string;
		attribution: string;
	};
	licences: {
		/** Every licence on the page, the newest revision first. */
		list: (GeneralLicence & { recent: boolean })[];
		/** Licences on the previous version of the page whose number is gone from it (expired or revoked). */
		removed: string[];
		/** When the page's list last changed (the newest list's date), for "desde". */
		listSince: number | null;
		recentCount: number;
		actions: RecentAction[];
		feed: string;
		sourceUrl: string;
		attribution: string;
	};
	register: {
		/** Documents naming Venezuela in the title or abstract, or published by OFAC; newest first, at most 20. */
		documents: FrDocument[];
		/** Documents of the last 30 days that only mention Venezuela in their body (not listed). */
		bodyOnly30d: number;
		feed: string;
		sourceUrl: string;
		attribution: string;
	};
};

export type Tally = { add: number; remove: number; update: number };

// ---------------------------------------------------------------------------------------------------------
// Pure computations (exported for tests)

export function tally(changes: readonly ChangeRow[], since: number): Tally {
	const t: Tally = { add: 0, remove: 0, update: 0 };
	for (const c of changes) if (c.at >= since) t[c.action]++;
	return t;
}

const licenceNumber = (id: string) => /^\d+/.exec(id)?.[0] ?? id;

/**
 * Licences on the older list whose number the newer one no longer shows (expired or revoked). A licence replaced by
 * its next revision (5Y → 5Z) is an amendment, not a removal.
 */
export function removedIds(previous: readonly string[] | null, latest: readonly string[]): string[] {
	if (!previous) return [];
	const numbers = new Set(latest.map(licenceNumber));
	return previous.filter((id) => !numbers.has(licenceNumber(id)));
}

const details = (uid: string) => `${OFAC_SEARCH}Details.aspx?id=${encodeURIComponent(uid)}`;

/** Licences sorted newest revision first; `recent` when issued within RECENT_DAYS of now. */
export function licenceList(
	rows: readonly { observedAt: number; value: GeneralLicence }[],
	ids: readonly string[] | null,
	now: number,
): (GeneralLicence & { recent: boolean })[] {
	const newestPerNumber = new Map<string, { observedAt: number; value: GeneralLicence }>();
	for (const r of rows) {
		const seen = newestPerNumber.get(r.value.number);
		if (!seen || r.observedAt >= seen.observedAt) newestPerNumber.set(r.value.number, r);
	}
	const shown = ids ? new Set(ids) : null;
	return [...newestPerNumber.values()]
		.filter((r) => !shown || shown.has(r.value.id))
		.sort((a, b) => b.observedAt - a.observedAt || Number(a.value.number) - Number(b.value.number))
		.map((r) => ({ ...r.value, recent: now - r.observedAt <= RECENT_DAYS * DAY }));
}

// ---------------------------------------------------------------------------------------------------------

function newestFirst<V extends Json>(rows: readonly StoredObservation<V>[]): StoredObservation<V>[] {
	return [...rows].sort((a, b) => b.observedAt - a.observedAt || b.id - a.id);
}

export function sanctionsView(store: Store, now: number): SanctionsView {
	const since = now - CHANGE_DAYS * DAY;
	const sdnRows = store.latestPerSeries<OfacValue>(ofacSdn.id, since, 20_000);
	const snapshots = newestFirst(store.history<OfacValue>(ofacSdn.id, "snapshot", 0, now, 5_000));
	const snapshot = snapshots[0];
	const snap = snapshot?.value.kind === "snapshot" ? snapshot.value : null;
	const previous = snapshots.find((s) => snapshot && s.observedAt < snapshot.observedAt);
	const pubs = sdnRows.filter(
		(o): o is StoredObservation<PublicationValue> => o.value.kind === "publication",
	);
	const changes: ChangeRow[] = sdnRows
		.filter((o): o is StoredObservation<ChangeValue> => o.value.kind === "change")
		.map((o) => ({
			at: o.observedAt,
			publicationId: o.value.publicationId,
			action: o.value.action,
			subject: o.value.subject,
			programs: o.value.programs,
			listedOn: o.value.listedOn,
			url: o.sourceUrl,
		}))
		.sort((a, b) => b.at - a.at || a.publicationId - b.publicationId);
	const byProgram = snap
		? Object.entries(snap.byProgram)
				.map(([program, n]) => ({ program, n }))
				.sort((a, b) => b.n - a.n || a.program.localeCompare(b.program))
		: [];

	const glRows = store
		.latestPerSeries<OfacVenezuelaValue>(ofacVenezuela.id, 0, 5_000)
		.filter((o) => o.series.startsWith("gl:"));
	const glHistory = store.history<OfacVenezuelaValue>(ofacVenezuela.id, "list", 0, now, 5_000);
	const lists = newestFirst(glHistory).filter(
		(o): o is StoredObservation<LicenceList> => o.value.kind === "list",
	);
	const latestList = lists[0]?.value.ids ?? null;
	const priorList =
		lists.find((l) => latestList && l.value.ids.join() !== latestList.join())?.value.ids ?? null;
	const licences = licenceList(
		glRows.filter((o): o is StoredObservation<GeneralLicence> => o.value.kind === "licence"),
		latestList,
		now,
	);
	const actions = store
		.latestPerSeries<OfacVenezuelaValue>(ofacVenezuela.id, since, 500)
		.filter((o): o is StoredObservation<RecentAction> => o.value.kind === "action")
		.sort((a, b) => b.observedAt - a.observedAt)
		.slice(0, 10)
		.map((o) => o.value);

	const docs = store
		.latestPerSeries<FrDocument>(federalRegister.id, since, 2_000)
		.sort((a, b) => b.observedAt - a.observedAt || b.value.number.localeCompare(a.value.number));

	return {
		now,
		namingRule: NAMING_RULE,
		sdn: {
			asOf:
				snapshot && snap
					? {
							publicationId: snap.publicationId,
							observedAt: snapshot.observedAt,
							fetchedAt: snapshot.fetchedAt,
						}
					: null,
			publicationsBehind: snapshot
				? pubs.filter((p) => p.observedAt > snapshot.observedAt).length
				: pubs.length,
			counts: snap?.counts ?? null,
			byProgram,
			officials: (snap?.officials ?? []).map((o) => ({ ...o, url: details(o.uid) })),
			unnamedIndividuals: snap?.unnamedIndividuals ?? 0,
			entities: (snap?.entities ?? []).map((e) => ({ ...e, url: details(e.uid) })),
			vessels: (snap?.vessels ?? []).map((v) => ({ ...v, url: details(v.uid) })),
			aircraftByModel: snap?.aircraftByModel ?? [],
			wikidataChecked: snap?.wikidataChecked ?? false,
			changes,
			tally: { days30: tally(changes, now - 30 * DAY), days365: tally(changes, since) },
			sinceLast:
				snap && previous?.value.kind === "snapshot"
					? {
							publicationId: previous.value.publicationId,
							totalBefore: previous.value.counts.total,
							totalNow: snap.counts.total,
						}
					: null,
			publicationsRead: pubs.length,
			feed: ofacSdn.id,
			sourceUrl: ofacSdn.homepage,
			attribution: ofacSdn.licence.attribution,
		},
		licences: {
			list: licences,
			removed: removedIds(priorList, latestList ?? []),
			listSince: lists[0]?.observedAt ?? null,
			recentCount: licences.filter((l) => l.recent).length,
			actions,
			feed: ofacVenezuela.id,
			sourceUrl: ofacVenezuela.homepage,
			attribution: ofacVenezuela.licence.attribution,
		},
		register: {
			documents: docs
				.filter((d) => d.value.relevance !== "text")
				.slice(0, 20)
				.map((d) => d.value),
			bodyOnly30d: docs.filter((d) => d.value.relevance === "text" && d.observedAt >= now - 30 * DAY).length,
			feed: federalRegister.id,
			sourceUrl: federalRegister.homepage,
			attribution: federalRegister.licence.attribution,
		},
	};
}

export const sanctionsPanel: Panel<SanctionsView> = {
	id: "sanctions",
	onDemand: true,
	sources: [ofacSdn.id, ofacVenezuela.id, federalRegister.id],
	compute: (store: Store, now: number) => sanctionsView(store, now),
};
