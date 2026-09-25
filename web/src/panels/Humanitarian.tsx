import { addStyles } from "../lib/css.ts";
import { now, panels } from "../lib/data.ts";
import { ago } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { PANEL_META } from "../lib/panel-meta.ts";
import humanitarianCss from "../styles/humanitarian.css?inline";
import { Panel } from "../ui/Panel.tsx";
import { HumanitarianBody } from "./HumanitarianBody.tsx";

addStyles(humanitarianCss);

/* Mirrors src/panels/humanitarian.ts: the server computes every figure; this file and its body only format.
   The whole panel is its own chunk (ui/LazyPanel.tsx), styles included. */

export interface HealthFigure {
	id: string;
	labelEs: string;
	labelEn: string;
	week: number | null;
	previous: number | null;
	yearToDate: number | null;
	previousYearToDate: number | null;
	weeks: { week: number; value: number | null }[];
	/** Transcription checks that held a figure back (optional: an older server does not send them). */
	notes?: { es: string; en: string }[];
}
interface WeekRef {
	year: number;
	week: number;
	from: string;
	to: string;
	pdfUrl: string;
	observedAt: number;
}
export interface WhoRow {
	id: string;
	labelEs: string;
	labelEn: string;
	unit: string;
	year: number;
	value: number;
	low: number | null;
	high: number | null;
	updated: string | null;
	basis: string;
	sourceUrl: string;
	observedAt: number;
}
export interface Plan {
	code: string;
	name: string;
	year: number;
	kind: "hrp" | "rmrp";
	requirementsUsd: number;
	originalRequirementsUsd: number | null;
	fundedUsd: number;
	pctFunded: number | null;
	gapUsd: number;
	sourceUrl: string;
	observedAt: number;
}
export interface OvvYear {
	year: number;
	violentDeaths: number;
	homicides: number;
	interventionDeaths: number;
	underInvestigation: number;
	ratePer100k: number;
	population: number | null;
	publishedOn: string;
	url: string;
	noteEs: string | null;
	noteEn: string | null;
}
export interface HumanitarianView {
	health: {
		bulletin: WeekRef | null;
		listed: WeekRef | null;
		untranscribed: number;
		transcribedAt: string;
		coveragePct: number | null;
		figures: HealthFigure[];
		measles: { suspected: number; discarded: number; investigating: number; consistent: boolean } | null;
		yellowFever: { cases: number; deaths: number } | null;
		stale: boolean;
		who: WhoRow[];
		malaria: {
			year: number;
			reported: number;
			estimated: number;
			low: number | null;
			high: number | null;
		} | null;
	};
	migration: {
		r4v: {
			total: { people: number; month: string; observedAt: number } | null;
			countries: {
				id: string;
				countryEs: string;
				countryEn: string;
				people: number;
				previous: number | null;
				month: string;
				publishedMonth: string | null;
				publisherEs: string | null;
				publisherEn: string | null;
			}[];
			stale: boolean;
		};
		unhcr: {
			year: number | null;
			observedAt: number | null;
			abroad: {
				refugees: number | null;
				asylumSeekers: number | null;
				otherInNeed: number | null;
				total: number | null;
			} | null;
			abroadByYear: { year: number; total: number | null }[];
			hosted: {
				year: number;
				refugees: number | null;
				asylumSeekers: number | null;
				total: number | null;
			} | null;
			top: { country: string; name: string; total: number }[];
			stale: boolean;
		};
	};
	aid: {
		plans: Plan[];
		hrpCurve: { at: number; pct: number }[];
		disasters: { title: string; url: string; glide: string | null; observedAt: number }[];
		reports: { title: string; url: string; orgs: string[]; observedAt: number }[];
		stale: boolean;
	};
	security: { years: OvvYear[]; checkedOn: string; sourceUrl: string };
	rules: { es: string; en: string };
	attributions: { feed: string; text: string; licenceUrl: string }[];
}

/**
 * The age of the newest figure the body shows, for the header while the feeds have not answered in this instance
 * (the bulletin and the OVV table are transcribed and dated on their own): "hace 12 d", muted.
 */
function shownAge(view: HumanitarianView): string | undefined {
	const dates = [
		view.health.bulletin?.observedAt,
		view.migration.r4v.total?.observedAt,
		view.migration.unhcr.observedAt,
		...view.aid.plans.map((p) => p.observedAt),
	].filter((d): d is number => typeof d === "number" && d <= now.value);
	if (!dates.length) return undefined;
	return ago(now.value - Math.max(...dates), lang.value);
}

export function HumanitarianPanel() {
	const view = panels.value.humanitarian as HumanitarianView | undefined;
	const l = lang.value;
	return (
		<Panel
			id="humanitario"
			title={PANEL_META.humanitario.title()}
			question={PANEL_META.humanitario.question()}
			feeds={PANEL_META.humanitario.feeds()}
			whenWaiting={view ? shownAge(view) : undefined}
			method={
				view ? (
					<>
						<p>{l === "es" ? view.rules.es : view.rules.en}</p>
						<p>
							{t(
								"Salud: las cifras semanales son las del Boletín Epidemiológico del MPPS, transcritas de cada PDF (enlazado) y verificadas a mano en la semana más reciente; solo cuentan lo que notificaron los centros que reportaron esa semana, por eso se muestra la cobertura de notificación. Las cifras anuales son las que Venezuela notifica a la OMS; la estimación de la OMS va al lado, nunca mezclada.",
								"Health: weekly figures are those of the MPPS Epidemiological Bulletin, transcribed from each PDF (linked) and checked by hand for the newest week; they count only what the facilities that reported that week notified, which is why the reporting coverage is shown. Yearly figures are those Venezuela reports to WHO; WHO's estimate sits beside them, never blended.",
							)}
						</p>
						<p>
							{t(
								"Migración: R4V suma lo que informa cada gobierno de acogida, en fechas distintas; ACNUR cuenta refugiados, solicitantes de asilo y otras personas con necesidad de protección internacional al cierre de cada año. Miden cosas distintas.",
								"Migration: R4V adds up what each host government reports, on different dates; UNHCR counts refugees, asylum seekers and other people in need of international protection at the end of each year. They measure different things.",
							)}
						</p>
						<p>
							{t(
								"Solo cifras agregadas: ninguna persona, dirección ni caso individual. Seguridad: informes anuales del Observatorio Venezolano de Violencia, sin mapa de incidentes.",
								"Aggregate figures only: no person, address or individual case. Security: the Venezuelan Violence Observatory's annual reports, with no incident map.",
							)}
						</p>
						<ul class="hu-attrib">
							{view.attributions.map((a) => (
								<li key={a.feed}>
									<a href={a.licenceUrl} target="_blank" rel="noopener noreferrer">
										{a.text}
									</a>
								</li>
							))}
						</ul>
					</>
				) : null
			}
		>
			{view ? <HumanitarianBody view={view} /> : null}
		</Panel>
	);
}
