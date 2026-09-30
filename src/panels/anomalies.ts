import { ADAPTERS } from "../adapters/registry.ts";
import type { Store } from "../core/store.ts";
import type { Adapter } from "../core/types.ts";
import { ANOMALY_RULES, anomalyRulesText, chainByOnset, type Evaluation } from "../intel/anomaly.ts";
import { type Judged, judgeAll, METRICS, type MetricSpec } from "../intel/anomaly-series.ts";
import { INCIDENTS_SOURCE } from "../intel/archive.ts";
import { refOf } from "../ontology/entity-view.ts";
import { linkBacklogOf } from "../ontology/links-store.ts";
import { registry } from "../ontology/registry.ts";
import type { AnomaliesView, AnomalyItem } from "../ontology/view.ts";
import type { Panel, PanelReader } from "../server/panels.ts";
import { type ConnectivityView, connectivityView } from "./connectivity.ts";
import type { IncidentItem, IncidentsView } from "./incidents.ts";

/**
 * "Lo inusual ahora": every series the anomaly engine judges (src/intel/anomaly-series.ts), the unusual ones as a
 * ranked list with their entity, value, baseline and window, score, rule in words, source and age. Deterministic;
 * figures from sources whose terms forbid passing their rows on (IODA) are given as derived results only (the change
 * and the score, never the raw value). An anomaly an open incident in the same state already explains points to it.
 */

const ADAPTER_BY_ID: ReadonlyMap<string, Adapter> = new Map(ADAPTERS.map((a) => [a.id, a]));

const fmt = (x: number, digits = 2) =>
	new Intl.NumberFormat("es-VE", { maximumFractionDigits: digits }).format(x);
const fmtEn = (x: number, digits = 2) =>
	new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(x);

/** This reading's rule in words, with its numbers. */
export function ruleOf(j: Judged, e: Evaluation): { es: string; en: string } {
	const R = ANOMALY_RULES;
	const z = `z = ${fmt(e.score, 1)}`;
	const zEn = `z = ${fmtEn(e.score, 1)}`;
	switch (j.metric.cls) {
		case "connectivity":
			return {
				es: `Caída fuerte según la regla del panel de conectividad (IODA, contra ${j.metric.window.es}); puntuación ${fmt(e.score, 1)}: −3 es exactamente el umbral de «caída».`,
				en: `Severe drop by the connectivity panel's rule (IODA, against ${j.metric.window.en}); score ${fmtEn(e.score, 1)}: −3 is exactly the "drop" threshold.`,
			};
		case "night":
			return {
				es: `Noche comparable ${fmt(e.changePct ?? 0, 1)} % frente a la mediana de ${e.points} noches despejadas; la regla de los incidentes pide ${R.nightMaxPct} % o menos (${z}).`,
				en: `Comparable night ${fmtEn(e.changePct ?? 0, 1)} % against the median of ${e.points} clear nights; the incidents' rule asks for ${R.nightMaxPct} % or less (${zEn}).`,
			};
		case "change":
			// A month-end reading of a series that steps at each month's close is judged against the month-ends.
			return j.detail.monthEnd === true
				? {
						es: `Cierre de mes: el cambio se aleja de la mediana de los ${e.points} cierres de mes anteriores por ${z}; inusual desde |z| ≥ ${R.minScore} y un mínimo por serie.`,
						en: `Month's close: the change lies ${zEn} from the median of the previous ${e.points} month-end changes; unusual from |z| ≥ ${R.minScore} and a per-series minimum.`,
					}
				: {
						es: `El último cambio se aleja de la mediana de ${j.metric.window.es} (${e.points}) por ${z}; inusual desde |z| ≥ ${R.minScore} y un mínimo por serie.`,
						en: `The newest change lies ${zEn} from the median of ${j.metric.window.en} (${e.points}); unusual from |z| ≥ ${R.minScore} and a per-series minimum.`,
					};
		case "level":
			return {
				es: `El último día frente a la mediana de ${j.metric.window.es} (${e.points}), en escala logarítmica: ${z}; inusual desde |z| ≥ ${R.minScore} con una razón mínima por serie.`,
				en: `The newest day against the median of ${j.metric.window.en} (${e.points}), on a log scale: ${zEn}; unusual from |z| ≥ ${R.minScore} with a per-series minimum ratio.`,
			};
		case "count":
		case "hourly": {
			const ratio = j.metric.cls === "count" ? R.count.minRatio : R.hourly.minRatio;
			const tail = R.count.maxTail;
			return {
				es: `${fmt(e.value, 0)} frente a una mediana de ${fmt(e.baseline, 1)} en ${j.metric.window.es} (${e.points}): ${z}, ${fmt(e.value / Math.max(e.baseline, 1), 1)} veces la mediana, probabilidad de Poisson de ver tantos o más ${e.tail === null ? "—" : e.tail === 0 ? "< 10⁻¹²" : fmt(e.tail, 12)}. Inusual con z ≥ ${R.minScore}, al menos ${ratio} veces la mediana y probabilidad ≤ ${tail}.`,
				en: `${fmtEn(e.value, 0)} against a median of ${fmtEn(e.baseline, 1)} over ${j.metric.window.en} (${e.points}): ${zEn}, ${fmtEn(e.value / Math.max(e.baseline, 1), 1)} times the median, Poisson probability of that many or more ${e.tail === null ? "—" : e.tail === 0 ? "< 1e-12" : fmtEn(e.tail, 12)}. Unusual with z ≥ ${R.minScore}, at least ${ratio} times the median and probability ≤ ${tail}.`,
			};
		}
	}
}

/** How the figure was computed (the "calculado por Vigía" line). */
function methodOf(m: MetricSpec): string {
	return `Calculado por Vigía: ${m.label.es} contra ${m.window.es}, con la regla de su clase (ver rules). Ninguna cifra la produce un modelo.`;
}

/** The state (ISO) an entity is in, for matching incidents; null for entities without one (the country, an ISP). */
function stateIsoOf(entity: string): string | null {
	const reg = registry();
	const e = reg.get(entity);
	if (!e) return null;
	const s = e.type === "state" ? e : reg.ancestors(entity).find((a) => a.type === "state");
	return s?.codes.iso ?? null;
}

/**
 * An incident (tier "incident") or a lone signal ("watch": one measured family, never counted as an incident) in the
 * same state that covers this reading: it started no later than `explainAfterMs` after the reading, and is active or
 * ended no earlier than `explainAfterMs` before it. Incidents win over watches. The tier travels with the pointer.
 */
export function explainingIncident(
	j: Judged,
	incidents: readonly IncidentItem[],
): AnomalyItem["explainedBy"] {
	const iso = stateIsoOf(j.entity);
	if (!iso) return null;
	const slack = ANOMALY_RULES.explainAfterMs;
	const hit = incidents
		.filter(
			(i) =>
				i.state === iso &&
				(ANOMALY_RULES.explains[i.kind] ?? []).includes(j.metric.family) &&
				i.startAt <= j.observedAt + slack &&
				(i.status === "active" || i.lastEvidenceAt + slack >= j.observedAt),
		)
		.sort((a, b) =>
			a.tier === b.tier ? b.lastEvidenceAt - a.lastEvidenceAt : a.tier === "incident" ? -1 : 1,
		)[0];
	return hit
		? {
				id: hit.id,
				title: { es: hit.title.es, en: hit.title.en },
				tier: hit.tier,
				href: `/api/v1/incidents/${encodeURIComponent(hit.id)}`,
			}
		: null;
}

export function itemOf(
	j: Judged,
	e: Evaluation,
	now: number,
	incidents: readonly IncidentItem[],
): AnomalyItem | null {
	const entity = registry().get(j.entity);
	if (!entity) return null;
	const a = ADAPTER_BY_ID.get(j.feed);
	const raw = a ? a.licence.raw !== false : true;
	const many = j.metric.feeds.length > 3;
	const reverted = revertedOf(j);
	const pctEs = e.changePct === null ? "" : `: ${signedPct(e.changePct)}`;
	const pctEn = e.changePct === null ? "" : `: ${signedPct(e.changePct, true)}`;
	return {
		id: `${j.metric.id}|${j.entity}|${j.observedAt}`,
		title: reverted
			? {
					es: `${j.metric.label.es}, ${entity.name.es}${pctEs}, ${reverted.text.es}`,
					en: `${j.metric.label.en}, ${entity.name.en}${pctEn}, ${reverted.text.en}`,
				}
			: {
					es: `${j.metric.label.es}, ${entity.name.es}${pctEs}`,
					en: `${j.metric.label.en}, ${entity.name.en}${pctEn}`,
				},
		entity: refOf(entity),
		metric: {
			id: j.metric.id,
			label: { ...j.metric.label },
			unit: j.metric.unit ? { ...j.metric.unit } : null,
			class: j.metric.cls,
		},
		direction: e.direction,
		value: raw ? e.value : null,
		baseline: raw ? Math.round(e.baseline * 1e6) / 1e6 : null,
		changePct: e.changePct,
		score: e.score,
		tail: e.tail,
		window: { text: { ...j.metric.window }, points: e.points, from: j.from, to: j.to },
		rule: ruleOf(j, e),
		source: {
			feed: many ? null : j.feed || null,
			name: many ? "Medios (titulares)" : (a?.name.es ?? j.feed),
			sourceUrl: j.sourceUrl || null,
			licence: many ? "vigia-derived" : (a?.licence.id ?? "vigia-derived"),
			attribution: many
				? "Calculado por Vigía a partir de los titulares de los medios citados en /fuentes"
				: (a?.licence.attribution ?? "Calculado por Vigía"),
		},
		observedAt: j.observedAt,
		fetchedAt: j.fetchedAt,
		ageMs: Math.max(0, now - j.observedAt),
		explainedBy: explainingIncident(j, incidents),
		// An official rate is published for its value date, up to a day ahead: its "age" is then a value date, not 0 min.
		figures: { ...j.detail, ...(j.observedAt > now ? { valueDateAhead: true } : {}) },
		members: null,
		groupId: null,
		reverted: reverted ? { ...reverted, value: raw ? reverted.value : null } : null,
		computed: true,
		method: methodOf(j.metric),
		basis: "derived",
	};
}

const signedPct = (x: number, en = false) => `${x < 0 ? "−" : "+"}${(en ? fmtEn : fmt)(Math.abs(x), 1)} %`;

/** The reverted-move fact of a reading judged by the revert rule, in words. */
function revertedOf(j: Judged): AnomalyItem["reverted"] {
	const d = j.detail;
	if (d.reverted !== true || typeof d.revertedAfterSteps !== "number" || typeof d.revertedAt !== "number")
		return null;
	const n = d.revertedAfterSteps;
	const date = String(d.revertedDate ?? "");
	return {
		afterSteps: n,
		at: d.revertedAt,
		date,
		value: typeof d.revertedValue === "number" ? d.revertedValue : null,
		text: {
			es: `revertido por el BCV a los ${n} ${n === 1 ? "día hábil" : "días hábiles"} (dato del ${date})`,
			en: `reverted by the BCV ${n} business ${n === 1 ? "day" : "days"} later (figure of ${date})`,
		},
	};
}

/**
 * Folds state connectivity readings whose drops began together (ANOMALY_RULES.region) into one regional item each:
 * every state keeps its own figure in `members`; nothing is averaged. Returns the list with the regional items in
 * place of their members, and the members apart.
 */
export function groupRegions(items: readonly AnomalyItem[]): {
	items: AnomalyItem[];
	grouped: AnomalyItem[];
} {
	const R = ANOMALY_RULES.region;
	const candidates = items
		.filter(
			(i) =>
				i.metric.id === "connectivity" && i.entity.type === "state" && typeof i.figures.onsetAt === "number",
		)
		.map((i) => ({ item: i, onsetAt: i.figures.onsetAt as number }));
	const groups = chainByOnset(candidates, R.windowMs).filter((g) => g.length >= R.minStates);
	if (groups.length === 0) return { items: [...items], grouped: [] };
	const folded = new Set<string>();
	const grouped: AnomalyItem[] = [];
	const regions: AnomalyItem[] = [];
	const country = registry().get("ve");
	for (const g of groups) {
		// Largest drop first (what a reader compares); the item's score is its strongest member's.
		const members = [...g].sort(
			(a, b) => (a.item.changePct ?? 0) - (b.item.changePct ?? 0) || a.item.score - b.item.score,
		);
		const strongest = [...g].sort((a, b) => a.item.score - b.item.score)[0]?.item;
		const first = members[0]?.item;
		if (!first || !country) continue;
		const onsets = g.map((m) => m.onsetAt);
		const id = `connectivity.region|${members
			.map((m) => m.item.entity.id)
			.sort()
			.join(",")}|${Math.min(...onsets)}`;
		for (const m of members) {
			folded.add(m.item.id);
			grouped.push({ ...m.item, groupId: id });
		}
		const names = (lang: "es" | "en") => {
			const parts = members.map(
				(m) =>
					`${m.item.entity.name[lang]} (${m.item.changePct === null ? "—" : signedPct(m.item.changePct, lang === "en")})`,
			);
			const and = lang === "es" ? " y " : " and ";
			return parts.length > 1 ? `${parts.slice(0, -1).join(", ")}${and}${parts.at(-1)}` : (parts[0] ?? "");
		};
		const minutes = Math.round((Math.max(...onsets) - Math.min(...onsets)) / 60_000);
		const allExplained = members.every((m) => m.item.explainedBy !== null);
		regions.push({
			...first,
			id,
			title: {
				es: `Caída simultánea de conectividad: ${names("es")}`,
				en: `Simultaneous connectivity drop: ${names("en")}`,
			},
			entity: refOf(country),
			metric: {
				id: "connectivity.region",
				label: {
					es: "Caída de conectividad en varios estados a la vez (IODA)",
					en: "Connectivity drop in several states at once (IODA)",
				},
				unit: null,
				class: "connectivity",
			},
			value: null,
			baseline: null,
			changePct: null,
			score: strongest?.score ?? first.score,
			rule: {
				es: `${members.length} estados cuyas caídas fuertes empezaron con ${minutes} min de diferencia (se agrupan si cada una empieza a menos de ${R.windowMs / 60_000} min de la anterior); cada estado con su propia cifra, sin promediar. ${first.rule.es}`,
				en: `${members.length} states whose severe drops began ${minutes} min apart (grouped when each begins within ${R.windowMs / 60_000} min of the previous one); each state with its own figure, never averaged. ${first.rule.en}`,
			},
			observedAt: Math.max(...members.map((m) => m.item.observedAt)),
			fetchedAt: members.reduce<number | null>(
				(x, m) => (m.item.fetchedAt === null ? x : Math.max(x ?? 0, m.item.fetchedAt)),
				null,
			),
			ageMs: Math.min(...members.map((m) => m.item.ageMs)),
			explainedBy: allExplained ? first.explainedBy : null,
			figures: {
				states: members.length,
				firstOnsetAt: Math.min(...onsets),
				lastOnsetAt: Math.max(...onsets),
			},
			members: members.map((m) => ({
				entity: m.item.entity,
				changePct: m.item.changePct,
				score: m.item.score,
				onsetAt: m.onsetAt,
				observedAt: m.item.observedAt,
				explainedBy: m.item.explainedBy,
			})),
			groupId: null,
			reverted: null,
		});
	}
	return { items: [...items.filter((i) => !folded.has(i.id)), ...regions], grouped };
}

/** Ranking: reverted moves after every other item; then by |score|, newest first, id. */
export function rank(a: AnomalyItem, b: AnomalyItem): number {
	return (
		Number(a.reverted !== null) - Number(b.reverted !== null) ||
		Math.abs(b.score) - Math.abs(a.score) ||
		b.observedAt - a.observedAt ||
		a.id.localeCompare(b.id)
	);
}

export type AnomalyInputs = {
	readonly connectivity: ConnectivityView | null;
	readonly incidents: readonly IncidentItem[];
	readonly linkBacklog: number;
};

/** Every judged series at `now`, and the unusual ones as the ranked list. */
export function anomaliesFrom(
	judged: readonly Judged[],
	now: number,
	incidents: readonly IncidentItem[],
): AnomaliesView {
	const byClass: AnomaliesView["counts"]["byClass"] = {};
	let judgedN = 0;
	let thin = 0;
	let stale = 0;
	let weak = 0;
	const items: AnomalyItem[] = [];
	const judgedByEntity: Record<string, number> = {};
	for (const j of judged) {
		const c = byClass[j.metric.cls] ?? { series: 0, judged: 0, unusual: 0 };
		byClass[j.metric.cls] = c;
		c.series++;
		if (typeof j.result === "string") {
			if (j.result === "thin") thin++;
			else if (j.result === "stale") stale++;
			else weak++;
			continue;
		}
		c.judged++;
		judgedN++;
		judgedByEntity[j.entity] = (judgedByEntity[j.entity] ?? 0) + 1;
		if (!j.result.unusual) continue;
		const item = itemOf(j, j.result, now, incidents);
		if (!item) continue;
		c.unusual++;
		items.push(item);
	}
	const unusual = items.length;
	const { items: listed, grouped } = groupRegions(items);
	listed.sort(rank);
	grouped.sort(rank);
	return {
		asOf: now,
		version: ANOMALY_RULES.version,
		items: listed.slice(0, ANOMALY_RULES.maxItems),
		truncated: listed.length > ANOMALY_RULES.maxItems,
		grouped,
		counts: {
			series: judged.length,
			judged: judgedN,
			unusual,
			explained: listed.filter((i) => i.explainedBy !== null).length,
			regions: listed.filter((i) => i.members !== null).length,
			grouped: grouped.length,
			reverted: listed.filter((i) => i.reverted !== null).length,
			thin,
			stale,
			weak,
			byClass,
			judgedByEntity,
		},
		rules: anomalyRulesText(),
	};
}

export function anomaliesView(store: Store, now: number, inputs: AnomalyInputs): AnomaliesView {
	const judged = judgeAll(store, now, { connectivity: inputs.connectivity, linkBacklog: inputs.linkBacklog });
	return anomaliesFrom(judged, now, inputs.incidents);
}

export const anomaliesPanel: Panel<AnomaliesView> = {
	id: "anomalies",
	// Invalidated by the feeds it reads (headline counts refresh with the cache's age, not on every headline).
	sources: [
		...new Set([
			...Object.values(METRICS)
				.filter((m) => m.id !== "headlines")
				.flatMap((m) => [...m.feeds]),
			INCIDENTS_SOURCE,
		]),
	],
	onDemand: true,
	compute: (store: Store, now: number, read?: PanelReader) => {
		const conn = (read?.("connectivity") as ConnectivityView | undefined) ?? connectivityView(store, now);
		const inc = read?.("incidents") as IncidentsView | undefined;
		return anomaliesView(store, now, {
			connectivity: conn,
			incidents: inc ? [...inc.incidents, ...inc.watches] : [],
			linkBacklog: linkBacklogOf(store),
		});
	},
};
