import type { Store } from "../core/store.ts";
import { showable } from "../crowd/counts.ts";
import {
	CROWD_LICENCE,
	CROWD_RULES,
	CROWD_SOURCE,
	type CrowdMode,
	crowdRulesText,
	SERVICE_TEXT,
} from "../crowd/rules.ts";
import type { CrowdAggregate } from "../crowd/service.ts";
import { crowdLabel, crowdMethod, crowdText } from "../crowd/text.ts";
import { registry } from "../ontology/registry.ts";
import type { Panel } from "../server/panels.ts";

/**
 * "Reportes de usuarios": the published crowd aggregates (source "vigia-crowd"), newest per municipality or state and
 * service, as they stand now. Pure over the archive: the service decides what may be published (thresholds, flood
 * rules, the mode); this panel only reads what it published, drops tombstones and anything whose window has passed,
 * and marks a figure stale when the publisher stopped refreshing it.
 */

export type CrowdItem = CrowdAggregate & {
	name: { es: string; en: string };
	stateName: string | null;
	serviceName: { es: string; en: string };
	label: { es: string; en: string };
	text: { es: string; en: string };
	method: string;
	observedAt: number;
	fetchedAt: number;
	stale: boolean;
	series: string;
};

export type CrowdView = {
	asOf: number;
	/** Always "report": these are unverified reports, never a measurement. */
	basis: "report";
	label: { es: string; en: string };
	windowMs: number;
	mode: CrowdMode | null;
	source: { id: string; name: string; licence: string; licenceUrl: string; attribution: string };
	municipalities: CrowdItem[];
	states: CrowdItem[];
	counts: { municipalities: number; states: number; flagged: number; reports: number };
	rules: { es: string[]; en: string[] };
};

/**
 * The newest published aggregate per level, entity and service, current at `now` (tombstones and passed windows
 * dropped; on a public instance, nothing a personal Vigía published on the same database).
 */
export function currentAggregates(store: Store, now: number): CrowdItem[] {
	const since = now - CROWD_RULES.windowMs - CROWD_RULES.staleAfterMs;
	const newest = new Map<string, CrowdItem | null>();
	const at = new Map<string, number>();
	const reg = registry();
	for (const o of store.latestPerSeries(CROWD_SOURCE, since, 20_000)) {
		const a = o.value as unknown as CrowdAggregate;
		if (!a || typeof a !== "object" || typeof a.entity !== "string" || typeof a.service !== "string")
			continue;
		const pair = `${a.level}|${a.entity}|${a.service}`;
		const seen = at.get(pair) ?? Number.NEGATIVE_INFINITY;
		// Newest first; on a tie a tombstone wins (hiding is the safe side).
		if (seen > o.observedAt || (seen === o.observedAt && a.shown)) continue;
		at.set(pair, o.observedAt);
		const e = reg.get(a.entity);
		const service = SERVICE_TEXT[a.service];
		if (
			!a.shown ||
			!e ||
			!service ||
			!showable(store, a.mode) ||
			o.observedAt > now + 60_000 ||
			now - o.observedAt > a.windowMs
		) {
			newest.set(pair, null);
			continue;
		}
		const st = a.state ? reg.byCode(`iso:${a.state}`) : undefined;
		newest.set(pair, {
			...a,
			// Rows published before the held reports were split by answer.
			heldAnswers: a.heldAnswers ?? { si: 0, no: a.held, intermitente: 0 },
			// Rows from before per-device tokens: every report was its own connection.
			connections: a.connections ?? a.reports ?? 0,
			minConnections: a.minConnections ?? 1,
			incidentMinConnections: a.incidentMinConnections ?? 1,
			name: { es: e.name.es, en: e.name.en },
			stateName: st?.name.es ?? null,
			serviceName: { es: service.es, en: service.en },
			label: crowdLabel(a.service),
			text: crowdText(a),
			method: crowdMethod(a.level, a.minReporters),
			observedAt: o.observedAt,
			fetchedAt: o.fetchedAt,
			stale: now - o.observedAt > CROWD_RULES.staleAfterMs,
			series: o.series,
		});
	}
	return [...newest.values()].filter((x): x is CrowdItem => x !== null);
}

const order = (a: CrowdItem, b: CrowdItem) =>
	Number(b.flagged) - Number(a.flagged) ||
	(b.outage?.count ?? 0) - (a.outage?.count ?? 0) ||
	(b.reports ?? 0) - (a.reports ?? 0) ||
	a.entity.localeCompare(b.entity) ||
	a.service.localeCompare(b.service);

export function crowdView(store: Store, now: number): CrowdView {
	const items = currentAggregates(store, now);
	const munis = items.filter((i) => i.level === "municipality").sort(order);
	const states = items.filter((i) => i.level === "state").sort(order);
	const mode = items[0]?.mode ?? null;
	return {
		asOf: now,
		basis: "report",
		label: { es: "reportes de usuarios", en: "user reports" },
		windowMs: CROWD_RULES.windowMs,
		mode,
		source: {
			id: CROWD_SOURCE,
			name: CROWD_LICENCE.attribution,
			licence: CROWD_LICENCE.id,
			licenceUrl: CROWD_LICENCE.url,
			attribution: CROWD_LICENCE.attribution,
		},
		municipalities: munis,
		states,
		counts: {
			municipalities: new Set(munis.filter((m) => m.reports !== null).map((m) => m.entity)).size,
			states: new Set(states.filter((s) => s.reports !== null).map((s) => s.entity)).size,
			flagged: munis.filter((m) => m.flagged).length,
			reports: munis.reduce((s, m) => s + (m.reports ?? 0), 0),
		},
		rules: crowdRulesText(mode ?? "public"),
	};
}

export const crowdPanel: Panel<CrowdView> = {
	id: "crowd",
	sources: [CROWD_SOURCE],
	// Served when asked for by id until the UI shows it.
	onDemand: true,
	compute: (store, now) => crowdView(store, now),
};
