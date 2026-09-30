import { useEffect, useState } from "preact/hooks";
import { addStyles } from "../lib/css.ts";
import { healthById, now, panels } from "../lib/data.ts";
import { entityPath } from "../lib/entity-route.ts";
import { ago, clock, stamp } from "../lib/format.ts";
import { groupFreshness } from "../lib/fresh.ts";
import { lang, t } from "../lib/i18n.ts";
import { incidentFocus } from "../lib/keys.ts";
import { viewport } from "../lib/layout.ts";
import { PANEL_META } from "../lib/panel-meta.ts";
import { entityLink } from "../lib/router.ts";
import { stateName } from "../lib/states.ts";
import { selectedState, selectState } from "../map/view.ts";
import incidentsCss from "../styles/incidents.css?inline";
import panelsCss from "../styles/panels.css?inline";
import { Panel } from "../ui/Panel.tsx";

addStyles(panelsCss);

addStyles(incidentsCss);

/** Mirrors src/panels/incidents.ts (the server is the source of truth; the client only formats). */
type Family =
	| "ioda"
	| "ripe-atlas"
	| "viirs"
	| "usgs"
	| "funvisis"
	| "prensa"
	| "gdacs"
	| "usuarios"
	| "camaras"
	| "cloudflare";
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
	usuarios: { es: "Reportes de usuarios", en: "User reports", kind: "report" },
	camaras: {
		es: "Cámaras públicas (brillo nocturno)",
		en: "Public cameras (night brightness)",
		kind: "measure",
	},
	cloudflare: { es: "Cloudflare Radar (tráfico)", en: "Cloudflare Radar (traffic)", kind: "report" },
};

/**
 * An evidence row's link: the source's page in a new tab; for user reports and cameras, the server gives the
 * entity's API address (`/api/v1/entities/ve.miranda.chacao`, `/api/v1/entities/cam.…`): the room opens its page
 * instead of a JSON file.
 */
function EvidenceLink({ e }: { e: Evidence }) {
	const l = lang.value;
	const m = /^\/api\/v1\/entities\/([^/?#]+)$/.exec(e.url);
	const id = m ? decodeURIComponent(m[1] as string) : null;
	if (id && entityPath(id))
		return (
			<a class="evidence__text" {...entityLink(id)}>
				{e[l]}
			</a>
		);
	if (!/^https?:\/\//i.test(e.url)) return <span class="evidence__text">{e[l]}</span>;
	return (
		<a class="evidence__text" href={e.url} target="_blank" rel="noopener noreferrer">
			{e[l]}
		</a>
	);
}

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

/** The element id of an incident's card or watch line, so it can be scrolled to by name. */
export function incidentDomId(id: string): string {
	return `incident-${id.replace(/[^\w-]/g, "_")}`;
}

function Card({ incident, activeMs }: { incident: IncidentItem; activeMs: number }) {
	const l = lang.value;
	const [copied, setCopied] = useState(false);
	const [open, setOpen] = useState(false);
	const active = incident.status === "active";
	const tone = incident.reportsOnly ? "reports" : active ? "active" : "ended";
	return (
		<li class={`incident incident--${tone}`} id={incidentDomId(incident.id)}>
			<div class="incident__head">
				{tone === "active" ? (
					// Its state, not a severity: the rules that rank what matters live in the priority list.
					<span class="sev sev--warn">
						<svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">
							<path d="M5 .8 9.2 5 5 9.2.8 5Z" />
						</svg>
						{t("En curso", "Ongoing")}
					</span>
				) : (
					<span class={`sev sev--${tone}`}>
						<svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">
							{tone === "reports" ? <circle cx="5" cy="5" r="3.2" /> : <path d="M1.5 1.5h7v7h-7z" />}
						</svg>
						{tone === "reports" ? t("Sin verificar", "Unverified") : t("Terminado", "Ended")}
					</span>
				)}
				<h3 class="incident__title">{incident.title[l]}</h3>
			</div>
			<p class="incident__when">
				<span class="incident__strength">{incident.strength[l]}</span>
				<span aria-hidden="true"> · </span>
				{active ? (
					<>
						{t("desde", "since")} <span class="data">{stamp(incident.startAt, l)}</span> ·{" "}
						{t("última evidencia", "last evidence")}{" "}
						<span class="data">{ago(now.value - incident.lastEvidenceAt, l)}</span>
					</>
				) : (
					<>
						<span class="data">{stamp(incident.startAt, l)}</span> →{" "}
						<span class="data">{clock(incident.lastEvidenceAt, l)}</span> ·{" "}
						{t(
							`sin evidencia nueva en ${Math.round((activeMs || 10_800_000) / 3_600_000)} h`,
							`no new evidence in ${Math.round((activeMs || 10_800_000) / 3_600_000)} h`,
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
						class="incident__act"
						onClick={() => {
							selectedState.value = incident.state;
							document.getElementById("mapa")?.scrollIntoView({ behavior: "smooth", block: "start" });
						}}
					>
						{t(`Ver ${incident.stateName ?? ""} en el mapa`, `Show ${incident.stateName ?? ""} on the map`)}
					</button>
				) : null}
				<a
					class="incident__act"
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
					class="incident__act"
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
								<EvidenceLink e={e} />
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
										<EvidenceLink e={e} />
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
function Watches({ items, open }: { items: IncidentItem[]; open?: boolean }) {
	const l = lang.value;
	if (!items.length) return null;
	return (
		<details class="incidents__group incidents__watches" open={open}>
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
					<li key={w.id} class="watch" id={incidentDomId(w.id)}>
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
function NoneNote({ view, iso }: { view: IncidentsView; iso: string | null }) {
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
	const where = iso ? t(` en ${stateName(iso)}`, ` in ${stateName(iso)}`) : "";
	return (
		<p class="note incidents__none">
			{t(
				`Ninguna medición coincide ahora con otra fuente independiente${where}${age ? ` (señales leídas ${age})` : ""}. No significa que no pase nada: mira los reportes y cada panel.`,
				`No measurement agrees with another independent source${where} right now${age ? ` (signals read ${age})` : ""}. It does not mean nothing is happening: see the reports and each panel.`,
			)}
		</p>
	);
}

export function IncidentsPanel() {
	const view = panels.value.incidents as IncidentsView | undefined;
	const l = lang.value;
	// A selected place narrows the lists to its incidents (linked selection); the chip says so and clears it.
	const iso = selectedState.value;
	const here = (i: IncidentItem) => !iso || i.state === iso;
	const inPlace = view?.incidents.filter(here) ?? [];
	const measured = inPlace.filter((i) => i.status === "active" && !i.reportsOnly);
	const reports = inPlace.filter((i) => i.status === "active" && i.reportsOnly);
	const ended = inPlace.filter((i) => i.status === "ended");
	const [all, setAll] = useState(false);
	const limit = all ? measured.length : viewport.value === "phone" ? 2 : 4;
	// An incident asked for by name: shown (its group opened, the list unfolded, a filter that hid it moved to its
	// state), then scrolled to and focused once the panel has been revealed.
	const focus = incidentFocus.value;
	// The incident last asked for keeps its folded group open after the request is done (else the group would close
	// on the next render and take the focused card with it).
	const [shown, setShown] = useState<string | null>(null);
	const wanted = focus ?? shown;
	const watches = (view?.watches ?? []).filter(here);
	const has = (list: readonly IncidentItem[]) => wanted !== null && list.some((i) => i.id === wanted);
	useEffect(() => {
		if (!focus || !view) return;
		const target = [...view.incidents, ...(view.watches ?? [])].find((i) => i.id === focus);
		if (!target) {
			incidentFocus.value = null;
			return;
		}
		if (iso && target.state !== iso) {
			selectState(target.state ?? null);
			return;
		}
		const at = measured.findIndex((i) => i.id === focus);
		if (at >= limit) {
			setAll(true);
			return;
		}
		setShown(focus);
		// After jumpTo has revealed and scrolled to the panel (two frames, and a route change when on another page).
		const timer = setTimeout(() => {
			const el = document.getElementById(incidentDomId(focus));
			incidentFocus.value = null;
			if (!el) return;
			el.setAttribute("tabindex", "-1");
			el.scrollIntoView({ block: "center" });
			el.focus({ preventScroll: true });
			el.classList.remove("is-target");
			void el.offsetWidth;
			el.classList.add("is-target");
			// The mark is a moment's cue, not a state: gone after a few seconds (reduced motion shows it still).
			setTimeout(() => el.classList.remove("is-target"), 3_000);
		}, 350);
		return () => clearTimeout(timer);
	}, [focus, view, iso, limit]);
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
					{iso ? (
						<div class="news-controls">
							<button type="button" class="filter-chip is-on" onClick={() => selectState(null)}>
								{stateName(iso)} ✕
							</button>
							<span class="note">
								{t(`Solo los incidentes de ${stateName(iso)}.`, `Only the incidents in ${stateName(iso)}.`)}
							</span>
						</div>
					) : null}
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
						<NoneNote view={view} iso={iso} />
					)}
					<Group
						title={t("Solo reportes de prensa, sin medición", "Press reports only, no measurement")}
						items={reports}
						activeMs={view.activeMs}
						open={measured.length === 0 || has(reports)}
					/>
					<Watches items={watches} open={has(watches)} />
					<Group
						title={t("Terminados en las últimas 48 h", "Ended in the last 48 h")}
						items={ended}
						activeMs={view.activeMs}
						open={has(ended)}
					/>
				</>
			)}
		</Panel>
	);
}
