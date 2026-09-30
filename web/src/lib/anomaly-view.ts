/**
 * "Lo inusual ahora": how one unusual reading of the anomaly engine (src/intel/anomaly.ts, `/api/v1/anomalies`)
 * reads, as pure words tested in anomaly-view.test.ts. Nothing is computed here but the words: the change, the
 * value and the baseline are the server's; a source whose terms forbid passing its data on (IODA) has only its
 * change, and no value is ever invented for it. An anomaly says a figure is rare against its own history, never why
 * or that it is serious: no status colour, a direction arrow and the rule in words.
 */
import type { AnomaliesView, AnomalyItem, AnomalyMember } from "../../../src/ontology/view.ts";
import { entityPath } from "./entity-route.ts";
import { ago, clock, int, type Lang, num, pct, stamp } from "./format.ts";

export type { AnomaliesView, AnomalyItem, AnomalyMember };

const tr = (l: Lang, es: string, en: string) => (l === "es" ? es : en);

/** "+8,0 %", "−62,6 %": a signed change with a real minus sign. */
export function signedPct(p: number, l: Lang): string {
	return pct(p, Math.abs(p) >= 100 ? 0 : 1, l);
}

/** A figure in its unit: "857,89 Bs.", "35 focos", "1.234 lecturas". */
function figure(v: number, unit: string | null, l: Lang): string {
	const n = Number.isInteger(v) ? int(v, l) : num(v, Math.abs(v) >= 100 ? 1 : 2, l);
	return unit ? `${n} ${unit}` : n;
}

/** The line under the title: the change, and the value against what the baseline expected when they may be shown. */
export function changeLine(
	a: Pick<AnomalyItem, "changePct" | "value" | "baseline" | "metric">,
	l: Lang,
): string {
	const unit = a.metric.unit?.[l] ?? null;
	const parts: string[] = [];
	if (a.changePct !== null)
		parts.push(
			tr(
				l,
				`${signedPct(a.changePct, l)} frente a lo esperado`,
				`${signedPct(a.changePct, l)} against the expected`,
			),
		);
	if (a.value !== null && a.baseline !== null)
		parts.push(
			tr(
				l,
				`${figure(a.value, unit, l)} (esperado ${figure(a.baseline, unit, l)})`,
				`${figure(a.value, unit, l)} (expected ${figure(a.baseline, unit, l)})`,
			),
		);
	else if (a.value !== null) parts.push(figure(a.value, unit, l));
	return parts.join(" · ");
}

/** "z = −14,2": the robust score, for ranking, said with its sign. */
export function scoreText(score: number, l: Lang): string {
	return `z = ${score < 0 ? "−" : ""}${num(Math.abs(score), 1, l)}`;
}

/**
 * When the reading is from: its age ("hace 20 min"); for an official rate published ahead of its value date, the
 * date it applies to ("tasa del 30 sept"), never a negative age; after a gap in the source, how long the gap was.
 */
export function whenLine(a: Pick<AnomalyItem, "observedAt" | "figures">, now: number, l: Lang): string {
	const parts: string[] = [];
	if (a.figures.valueDateAhead === true || a.observedAt > now + 60_000)
		parts.push(tr(l, `tasa del ${stamp(a.observedAt, l, now)}`, `rate for ${stamp(a.observedAt, l, now)}`));
	else parts.push(ago(now - a.observedAt, l));
	const span = a.figures.stepsSpanned;
	if (typeof span === "number" && span > 1)
		parts.push(
			tr(
				l,
				`tras ${num(span, span % 1 ? 1 : 0, l)} días sin datos`,
				`after ${num(span, span % 1 ? 1 : 0, l)} days without data`,
			),
		);
	return parts.join(" · ");
}

/** "ya es un incidente: Posible apagón en Zulia" / "señal sin corroborar: …": what already explains it. */
export function explainedText(e: NonNullable<AnomalyItem["explainedBy"]>, l: Lang): string {
	return e.tier === "incident"
		? tr(l, `ya es un incidente: ${e.title.es}`, `already an incident: ${e.title.en}`)
		: tr(l, `señal sin corroborar: ${e.title.es}`, `uncorroborated signal: ${e.title.en}`);
}

/** A regional item's member: its own figure, its own start, never a blended one. */
export function memberLine(m: AnomalyMember, now: number, l: Lang): string {
	const change =
		m.changePct !== null ? signedPct(m.changePct, l) : tr(l, "sin cifra publicable", "no publishable figure");
	const since =
		m.onsetAt > now
			? ""
			: now - m.onsetAt > 20 * 3_600_000
				? tr(l, `desde el ${stamp(m.onsetAt, l, now)}`, `since ${stamp(m.onsetAt, l, now)}`)
				: tr(l, `desde las ${clock(m.onsetAt, l)}`, `since ${clock(m.onsetAt, l)}`);
	return [change, since].filter(Boolean).join(" · ");
}

/** The page of the entity an item is about ("/lugar/zulia", "/red/cantv"); null when it has none. */
export function itemPath(a: Pick<AnomalyItem, "entity">): string | null {
	return entityPath(a.entity.id);
}

/** Only http(s) links reach the page. */
export function sourceUrl(a: Pick<AnomalyItem, "source">): string | null {
	const u = a.source.sourceUrl;
	return u && /^https?:\/\//i.test(u) ? u : null;
}

/**
 * The honest empty line: how many series were looked at, how many judged and why not the others. Never "todo
 * normal" when most series are not judged.
 */
export function countsLine(c: AnomaliesView["counts"], l: Lang): string {
	const parts = [
		tr(l, `${int(c.series, l)} series`, `${int(c.series, l)} series`),
		tr(l, `${int(c.judged, l)} juzgadas`, `${int(c.judged, l)} judged`),
	];
	if (c.thin)
		parts.push(tr(l, `${int(c.thin, l)} con poca historia`, `${int(c.thin, l)} with too little history`));
	if (c.stale)
		parts.push(tr(l, `${int(c.stale, l)} sin datos recientes`, `${int(c.stale, l)} without recent data`));
	if (c.weak)
		parts.push(tr(l, `${int(c.weak, l)} sin comparación posible`, `${int(c.weak, l)} not comparable`));
	return parts.join("; ");
}

/** The headline of the list: how many unusual readings, and how many are already explained by an incident. */
export function listLine(v: AnomaliesView, l: Lang): string {
	const n = v.items.length;
	if (!n)
		return tr(
			l,
			`Ninguna lectura inusual entre las ${int(v.counts.judged, l)} series que se pueden juzgar ahora.`,
			`No unusual reading among the ${int(v.counts.judged, l)} series that can be judged now.`,
		);
	const explained = v.items.filter((a) => a.explainedBy !== null).length;
	return tr(
		l,
		`${int(n, l)} ${n === 1 ? "lectura inusual" : "lecturas inusuales"} frente a su propia historia${explained ? `; ${int(explained, l)} ya ${explained === 1 ? "la explica" : "las explica"} un incidente` : ""}.`,
		`${int(n, l)} unusual ${n === 1 ? "reading" : "readings"} against their own history${explained ? `; ${int(explained, l)} already explained by an incident` : ""}.`,
	);
}
