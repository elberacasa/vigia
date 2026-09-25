import { useState } from "preact/hooks";
import { addStyles } from "../lib/css.ts";
import { healthById, now, panels } from "../lib/data.ts";
import { ago, clock, stamp } from "../lib/format.ts";
import { groupFreshness } from "../lib/fresh.ts";
import { lang, t } from "../lib/i18n.ts";
import { viewport } from "../lib/layout.ts";
import { PANEL_META } from "../lib/panel-meta.ts";
import { selectedState } from "../map/view.ts";
import incidentsCss from "../styles/incidents.css?inline";
import panelsCss from "../styles/panels.css?inline";
import { Panel } from "../ui/Panel.tsx";

addStyles(panelsCss);

addStyles(incidentsCss);

/** Mirrors src/panels/incidents.ts (the server is the source of truth; the client only formats). */
type Family = "ioda" | "ripe-atlas" | "viirs" | "usgs" | "funvisis" | "prensa" | "gdacs";
interface Evidence {
	id: string;
	family: Family;
	role: "signal" | "context";
	feed: string;
	es: string;
	en: string;
	at: number;
	lastAt: number;
	url: string;
}
export interface IncidentItem {
	id: string;
	kind: "corte" | "sismo";
	state: string | null;
	stateName: string | null;
	title: { es: string; en: string };
	startAt: number;
	lastEvidenceAt: number;
	families: Family[];
	corroboration: number;
	reportsOnly: boolean;
	outlets: number;
	evidence: Evidence[];
	evidenceTotal: number;
	context: Evidence[];
	status: "active" | "ended";
	endedAt: number | null;
	strength: { es: string; en: string };
	/** "corroborado después por luces nocturnas (dato publicado 38 h después)". */
	lateNotes?: { es: string; en: string }[];
}
export interface IncidentsView {
	asOf: number;
	incidents: IncidentItem[];
	/** One measured family alone ("señal sin corroborar"): listed apart, never counted as incidents. */
	watches?: IncidentItem[];
	counts: { active: number; corroborated: number; reportsOnly: number; ended: number; watches?: number };
	rules: { es: string[]; en: string[] };
	activeMs: number;
	feeds: string[];
}

const FAMILY: Record<Family, { es: string; en: string; kind: "measure" | "report" | "context" }> = {
	ioda: { es: "IODA", en: "IODA", kind: "measure" },
	"ripe-atlas": { es: "RIPE Atlas", en: "RIPE Atlas", kind: "measure" },
	viirs: { es: "Luces NASA", en: "NASA lights", kind: "measure" },
	usgs: { es: "USGS", en: "USGS", kind: "measure" },
	funvisis: { es: "FUNVISIS", en: "FUNVISIS", kind: "measure" },
	prensa: { es: "Prensa", en: "Press", kind: "report" },
	gdacs: { es: "GDACS", en: "GDACS", kind: "context" },
};

/**
 * Which sensor fired when: one row per family, a dot for a point in time (a headline, a quake), a bar for
 * something that lasted (an IODA outage, a drop seen over several readings). Positions are times; nothing else.
 */
function Timeline({ incident, at }: { incident: IncidentItem; at: number }) {
	const l = lang.value;
	const items = [...incident.evidence, ...incident.context];
	const from = Math.min(...items.map((e) => e.at));
	const to = incident.status === "active" ? Math.max(at, incident.lastEvidenceAt) : incident.lastEvidenceAt;
	const span = Math.max(to - from, 10 * 60_000);
	const x = (ms: number) => Math.max(0, Math.min(100, ((ms - from) / span) * 100));
	const rows = [...new Set(items.map((e) => e.family))];
	return (
		<figure
			class="itl"
			aria-label={t(
				`Línea de tiempo de la evidencia, de ${clock(from, l)} a ${incident.status === "active" ? "ahora" : clock(to, l)}`,
				`Evidence timeline, from ${clock(from, l)} to ${incident.status === "active" ? "now" : clock(to, l)}`,
			)}
		>
			{rows.map((family) => (
				<div class="itl__row" key={family}>
					<span class="itl__label">{FAMILY[family][l]}</span>
					<span class="itl__track">
						{items
							.filter((e) => e.family === family)
							.map((e) => {
								const long = e.lastAt - e.at > 15 * 60_000;
								const tone = e.role === "context" ? "context" : FAMILY[family].kind;
								return long ? (
									<span
										key={e.id}
										class={`itl__bar itl__mark--${tone}`}
										style={{ left: `${x(e.at)}%`, width: `${Math.max(1.5, x(e.lastAt) - x(e.at))}%` }}
										title={`${clock(e.at, l)}–${clock(e.lastAt, l)} · ${e[l]}`}
									/>
								) : (
									<span
										key={e.id}
										class={`itl__dot itl__mark--${tone}`}
										style={{ left: `${x(e.at)}%` }}
										title={`${clock(e.at, l)} · ${e[l]}`}
									/>
								);
							})}
					</span>
				</div>
			))}
			<figcaption class="itl__axis">
				<span class="data">{stamp(from, l)}</span>
				<span class="data">{incident.status === "active" ? t("ahora", "now") : clock(to, l)}</span>
			</figcaption>
		</figure>
	);
}

function shareText(i: IncidentItem, l: "es" | "en"): string {
	const families = i.families.map((f) => FAMILY[f][l]).join(", ");
	const status =
		i.status === "active"
			? t("sigue activo", "still active")
			: t(`terminado ${stamp(i.lastEvidenceAt, l)}`, `ended ${stamp(i.lastEvidenceAt, l)}`);
	return t(
		`${i.title.es}: ${i.strength.es} (${families}). Desde ${stamp(i.startAt, "es")} hora de Caracas, ${status}. Fuente: Vigía, evidencia enlazada en ${location.origin}/api/incidents?id=${encodeURIComponent(i.id)}`,
		`${i.title.en}: ${i.strength.en} (${families}). Since ${stamp(i.startAt, "en")} Caracas time, ${status}. Source: Vigía, linked evidence at ${location.origin}/api/incidents?id=${encodeURIComponent(i.id)}`,
	);
}

function Card({ incident, activeMs }: { incident: IncidentItem; activeMs: number }) {
	const l = lang.value;
	const [copied, setCopied] = useState(false);
	const [open, setOpen] = useState(false);
	const active = incident.status === "active";
	const tone = incident.reportsOnly ? "reports" : active ? "active" : "ended";
	return (
		<li class={`incident incident--${tone}`}>
			<div class="incident__head">
				<h3 class="incident__title">
					<span class={`incident__dot incident__dot--${tone}`} aria-hidden="true" />
					{incident.title[l]}
				</h3>
				<span
					class={`incident__strength incident__strength--${incident.reportsOnly ? "reports" : "measured"}`}
				>
					{incident.strength[l]}
				</span>
			</div>
			<p class="incident__when">
				{active ? (
					<>
						{t("Desde", "Since")} <span class="data">{stamp(incident.startAt, l)}</span> ·{" "}
						{t("última evidencia", "last evidence")}{" "}
						<span class="data">{ago(now.value - incident.lastEvidenceAt, l)}</span>
					</>
				) : (
					<>
						<span class="data">{stamp(incident.startAt, l)}</span> →{" "}
						<span class="data">{clock(incident.lastEvidenceAt, l)}</span> ·{" "}
						{t(
							`terminado: sin evidencia nueva en ${Math.round((activeMs || 10_800_000) / 3_600_000)} h`,
							`ended: no new evidence in ${Math.round((activeMs || 10_800_000) / 3_600_000)} h`,
						)}
					</>
				)}
			</p>
			{incident.lateNotes?.map((n) => (
				<p class="incident__late" key={n.es}>
					{n[l]}
				</p>
			))}
			<Timeline incident={incident} at={now.value} />
			<div class="incident__foot">
				<button
					type="button"
					class="incident__toggle"
					aria-expanded={open}
					aria-controls={`ev-${incident.id}`}
					onClick={() => setOpen(!open)}
				>
					<span aria-hidden="true">{open ? "▾" : "▸"}</span>
					{t("Evidencia", "Evidence")} ({incident.evidenceTotal}
					{incident.context.length ? ` + ${incident.context.length} ${t("de contexto", "context")}` : ""})
				</button>
				{incident.state ? (
					<button
						type="button"
						class="link-button"
						onClick={() => {
							selectedState.value = incident.state;
							document.getElementById("mapa")?.scrollIntoView({ behavior: "smooth", block: "start" });
						}}
					>
						{t(`Ver ${incident.stateName ?? ""} en el mapa`, `Show ${incident.stateName ?? ""} on the map`)}
					</button>
				) : null}
				<a
					class="link-button"
					href={`/api/evidence?incident=${encodeURIComponent(incident.id)}`}
					download
					title={t(
						"Un archivo JSON con cada observación, su enlace y sus horas, y la prueba de que está en el archivo sellado. Compruébalo con «vigia verify <archivo>».",
						"A JSON file with each observation, its link and times, and the proof it is in the sealed archive. Check it with 'vigia verify <file>'.",
					)}
				>
					{t("Guardar evidencia", "Save evidence")}
				</a>
				<button
					type="button"
					class="link-button"
					onClick={() => {
						const text = shareText(incident, l);
						const done = () => {
							setCopied(true);
							setTimeout(() => setCopied(false), 2_000);
						};
						if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => {});
					}}
				>
					{copied ? t("Copiado", "Copied") : t("Copiar resumen", "Copy summary")}
				</button>
			</div>
			{open ? (
				<div class="incident__evidence" id={`ev-${incident.id}`}>
					<ol class="evidence">
						{incident.evidence.map((e) => (
							<li key={e.id} class="evidence__item">
								<span class="data evidence__time">{clock(e.at, l)}</span>
								<span class={`evidence__family evidence__family--${FAMILY[e.family].kind}`}>
									{FAMILY[e.family][l]}
								</span>
								<a class="evidence__text" href={e.url} target="_blank" rel="noopener noreferrer">
									{e[l]}
								</a>
							</li>
						))}
						{incident.evidenceTotal > incident.evidence.length ? (
							<li class="note">
								{t(
									`y ${incident.evidenceTotal - incident.evidence.length} reportes más antiguos`,
									`and ${incident.evidenceTotal - incident.evidence.length} older reports`,
								)}
							</li>
						) : null}
					</ol>
					{incident.context.length ? (
						<>
							<p class="caps evidence__context-title">
								{t(
									"Contexto: posible causa, no cuenta como confirmación",
									"Context: possible cause, not counted",
								)}
							</p>
							<ol class="evidence">
								{incident.context.map((e) => (
									<li key={e.id} class="evidence__item">
										<span class="data evidence__time">{clock(e.at, l)}</span>
										<span class="evidence__family evidence__family--context">{FAMILY[e.family][l]}</span>
										<a class="evidence__text" href={e.url} target="_blank" rel="noopener noreferrer">
											{e[l]}
										</a>
									</li>
								))}
							</ol>
						</>
					) : null}
				</div>
			) : null}
		</li>
	);
}

/** One measured family alone: a line each, below the incidents, never styled or counted as an incident. */
function Watches({ items }: { items: IncidentItem[] }) {
	const l = lang.value;
	if (!items.length) return null;
	return (
		<details class="incidents__group incidents__watches">
			<summary>
				{t("Señales sin corroborar", "Uncorroborated signals")} <span class="data">({items.length})</span>
			</summary>
			<p class="note">
				{t(
					"Una sola fuente medida, sin otra que coincida: no es un incidente. Pasa a serlo si otra fuente independiente coincide.",
					"One measured source with no other agreeing: not an incident. It becomes one if another independent source agrees.",
				)}
			</p>
			<ul class="watches">
				{items.map((w) => (
					<li key={w.id} class="watch">
						<span class="watch__title">{w.title[l]}</span>
						<span class="watch__meta">
							{w.families.map((f) => FAMILY[f][l]).join(", ")} ·{" "}
							<span class="data">
								{t("desde", "since")} {stamp(w.startAt, l)} · {ago(now.value - w.lastEvidenceAt, l)}
							</span>
						</span>
					</li>
				))}
			</ul>
		</details>
	);
}

function Group(props: { title: string; items: IncidentItem[]; open?: boolean; activeMs: number }) {
	if (!props.items.length) return null;
	return (
		<details class="incident-group" open={props.open}>
			<summary>
				{props.title} <span class="data">({props.items.length})</span>
			</summary>
			<ul class="incidents">
				{props.items.map((i) => (
					<Card key={i.id} incident={i} activeMs={props.activeMs} />
				))}
			</ul>
		</details>
	);
}

/**
 * "No incident" is a claim of absence: it gives the age of the newest measured input (not the compute time), and
 * on late inputs it is not made at all (review 4, M2).
 */
function NoneNote({ view }: { view: IncidentsView }) {
	const f = groupFreshness(view.feeds ?? [], healthById.value);
	const age = f.lastAt ? ago(now.value - f.lastAt, lang.value) : null;
	if (f.stale)
		return (
			<p class="note incidents__none">
				{age
					? t(
							`Sin datos recientes para decir si hay incidentes: la última señal medida se leyó ${age}.`,
							`No recent data to tell whether there are incidents: the last measured signal was read ${age}.`,
						)
					: t(
							"Sin datos recientes para decir si hay incidentes.",
							"No recent data to tell whether there are incidents.",
						)}
			</p>
		);
	return (
		<p class="note incidents__none">
			{t(
				`Ninguna medición coincide ahora con otra fuente independiente${age ? ` (señales leídas ${age})` : ""}. No significa que no pase nada: mira los reportes y cada panel.`,
				`No measurement agrees with another independent source right now${age ? ` (signals read ${age})` : ""}. It does not mean nothing is happening: see the reports and each panel.`,
			)}
		</p>
	);
}

export function IncidentsPanel() {
	const view = panels.value.incidents as IncidentsView | undefined;
	const l = lang.value;
	const measured = view?.incidents.filter((i) => i.status === "active" && !i.reportsOnly) ?? [];
	const reports = view?.incidents.filter((i) => i.status === "active" && i.reportsOnly) ?? [];
	const ended = view?.incidents.filter((i) => i.status === "ended") ?? [];
	const [all, setAll] = useState(false);
	const limit = all ? measured.length : viewport.value === "phone" ? 2 : 4;
	return (
		<Panel
			id="incidentes"
			class="panel--incidents"
			title={PANEL_META.incidentes.title()}
			question={PANEL_META.incidentes.question()}
			feeds={PANEL_META.incidentes.feeds()}
			method={
				view ? (
					<>
						<ul class="incidents__rules">
							{view.rules[l].map((r) => (
								<li key={r}>{r}</li>
							))}
						</ul>
						<p class="incidents__evidence-note">
							{t(
								"«Guardar evidencia» descarga un archivo con cada observación, su enlace, sus horas y la prueba de que está en el archivo sellado de su día (cada día UTC se sella con SHA-256 y se encadena al anterior). Compruébalo con «vigia verify <archivo>». Lo de hoy se sella mañana a la 01:00 UTC.",
								"'Save evidence' downloads a file with each observation, its link, its times and the proof it is in its day's sealed archive (each UTC day is sealed with SHA-256 and chained to the one before). Check it with 'vigia verify <file>'. Today's data is sealed tomorrow at 01:00 UTC.",
							)}
						</p>
					</>
				) : null
			}
		>
			{!view ? (
				<p class="skeleton">…</p>
			) : (
				<>
					{measured.length ? (
						<>
							<ul class="incidents">
								{measured.slice(0, limit).map((i) => (
									<Card key={i.id} incident={i} activeMs={view.activeMs} />
								))}
							</ul>
							{measured.length > limit ? (
								<button type="button" class="incidents__more" onClick={() => setAll(true)}>
									{t(
										`Ver ${measured.length - limit} incidentes corroborados más`,
										`Show ${measured.length - limit} more corroborated incidents`,
									)}
								</button>
							) : null}
						</>
					) : (
						<NoneNote view={view} />
					)}
					<Group
						title={t("Solo reportes de prensa, sin medición", "Press reports only, no measurement")}
						items={reports}
						activeMs={view.activeMs}
						open={measured.length === 0}
					/>
					<Watches items={view.watches ?? []} />
					<Group
						title={t("Terminados en las últimas 48 h", "Ended in the last 48 h")}
						items={ended}
						activeMs={view.activeMs}
					/>
				</>
			)}
		</Panel>
	);
}
