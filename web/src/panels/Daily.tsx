import { addStyles } from "../lib/css.ts";
import { panels } from "../lib/data.ts";
import { lang, t } from "../lib/i18n.ts";
import { PANEL_META } from "../lib/panel-meta.ts";
import dailyCss from "../styles/daily.css?inline";
import { Panel } from "../ui/Panel.tsx";
import { GazetteBody, PocketBody, ServicesBody } from "./DailyBody.tsx";

addStyles(dailyCss);

/*
 * The daily-life panels: Bolsillo (converter and minimum wage), Servicios (electricity, water, gas, fuel) and
 * Gaceta (the Official Gazette). Mirrors src/panels/pocket.ts, services.ts and gazette.ts: the server computes every
 * figure; the only arithmetic here is the converter's, in lib/convert.ts (tested). This file and DailyBody.tsx load
 * on demand with the panels (ui/LazyPanel.tsx); their styles come with them.
 */

export interface PocketRate {
	id: string;
	kind: "official" | "quote";
	currency: "USD" | "EUR";
	labelEs: string;
	labelEn: string;
	vesPerUnit: number;
	asOf: number;
	fetchedAt: number;
	feed: string;
	sourceUrl: string;
	stale: boolean;
	noteEs: string | null;
	noteEn: string | null;
}
export interface PocketView {
	rates: PocketRate[];
	wage: {
		labelEs: string;
		labelEn: string;
		vesMonthly: number;
		vesDaily: number;
		publisherEs: string;
		publisherEn: string;
		instrument: string;
		inForceFrom: string;
		publishedOn: string;
		sourceUrl: string;
		documentUrl: string;
		checkedOn: string;
		currentEs: string;
		currentEn: string;
		evidence: { label: string; url: string; date: string }[];
		inCurrency: { rateId: string; amount: number; currency: "USD" | "EUR" }[];
	};
	pending: {
		id: string;
		labelEs: string;
		labelEn: string;
		whyEs: string;
		whyEn: string;
		checkedOn: string;
	}[];
	ruleEs: string;
	ruleEn: string;
}

export interface GuriPoint {
	t: number;
	m: number;
}
export interface GuriChange {
	m: number;
	fromM: number;
	fromObservedAt: number;
}
export interface GuriView {
	feed: string;
	attribution: string;
	licenceUrl: string;
	sourceUrl: string;
	latest: { m: number; uncertaintyM: number; observedAt: number; fetchedAt: number; mission: string } | null;
	change30d: GuriChange | null;
	change1y: GuriChange | null;
	season: {
		years: number;
		below: number;
		firstYear: number;
		lastYear: number;
		lowest: { m: number; year: number };
		highest: { m: number; year: number };
	} | null;
	record: { min: GuriPoint; max: GuriPoint; since: number } | null;
	spark: GuriPoint[];
	stale: boolean;
	ruleEs: string;
	ruleEn: string;
}
export interface Unavailable {
	id: string;
	labelEs: string;
	labelEn: string;
	checkedEs: string;
	checkedEn: string;
	whereEs: string;
	whereEn: string;
	checkedOn: string;
}
export interface ServicesView {
	guri: GuriView;
	unavailable: Unavailable[];
}

/** Mirrors src/adapters/gaceta-oficial/redact.ts ActCategory. */
export type GazetteCategory =
	| "designacion"
	| "delegacion"
	| "traslado"
	| "jubilacion"
	| "ascenso"
	| "condecoracion"
	| "cese"
	| "personal"
	| "otro";

export interface GazetteIssue {
	number: number;
	kind: "ordinaria" | "extraordinaria";
	date: string;
	observedAt: number;
	fetchedAt: number;
	sourceUrl: string;
	pdfUrl: string | null;
	actsListed: boolean;
	acts: { organ: string; title: string; instrument: string | null }[];
	moreActs: number;
	/** Acts whose title is never shown (it names or may name a person), counted per category. */
	withheld: { category: GazetteCategory; n: number }[];
	instruments: { name: string; n: number }[];
	notable: boolean;
}
export interface GazetteView {
	feed: string;
	attribution: string;
	homepage: string;
	issues: GazetteIssue[];
	newest: { date: string; observedAt: number } | null;
	lagDays: number | null;
	stale: boolean;
}

export function PocketPanel() {
	const view = panels.value.pocket as PocketView | undefined;
	const l = lang.value;
	return (
		<Panel
			id="bolsillo"
			title={PANEL_META.bolsillo.title()}
			question={PANEL_META.bolsillo.question()}
			feeds={PANEL_META.bolsillo.feeds()}
			method={
				view ? (
					<>
						<p>{l === "es" ? view.ruleEs : view.ruleEn}</p>
						<p>
							{t(
								"La tasa oficial es la del BCV. Yadio y los mercados P2P son cotizaciones de terceros, con su nombre: Vigía no publica una tasa propia ni promedia.",
								"The official rate is the BCV's. Yadio and the P2P markets are third-party quotes, named: Vigía publishes no rate of its own and averages nothing.",
							)}
						</p>
						<p>
							<strong>{l === "es" ? view.wage.labelEs : view.wage.labelEn}:</strong>{" "}
							{l === "es" ? view.wage.currentEs : view.wage.currentEn}
						</p>
						<p class="caps">{t("Aún no se muestra", "Not shown yet")}</p>
						<ul class="daily-method__list">
							{view.pending.map((p) => (
								<li key={p.id}>
									<strong>{l === "es" ? p.labelEs : p.labelEn}.</strong> {l === "es" ? p.whyEs : p.whyEn}{" "}
									<span class="note data">({p.checkedOn})</span>
								</li>
							))}
						</ul>
					</>
				) : null
			}
		>
			{view ? <PocketBody view={view} /> : null}
		</Panel>
	);
}

export function ServicesPanel() {
	const view = panels.value.services as ServicesView | undefined;
	const l = lang.value;
	return (
		<Panel
			id="servicios"
			title={PANEL_META.servicios.title()}
			question={PANEL_META.servicios.question()}
			feeds={PANEL_META.servicios.feeds()}
			method={
				view ? (
					<>
						<p>
							{t(
								"Guri es el embalse de la represa Simón Bolívar, de la que sale la mayor parte de la electricidad del país. Su nivel baja despacio en la sequía y es la señal lenta detrás de los racionamientos. Aquí se mide desde satélites (altimetría radar de DAHITI, DGFI-TUM): es la altura del agua sobre el geoide, parecida pero no igual a la cota oficial en m.s.n.m. de Corpoelec, que no se publica en abierto. Por eso no se compara con umbrales oficiales.",
								"Guri is the reservoir of the Simón Bolívar dam, which produces most of the country's electricity. Its level falls slowly in the dry season and is the slow signal behind rationing. Here it is measured from satellites (DAHITI radar altimetry, DGFI-TUM): the water's height above the geoid, close to but not the same as Corpoelec's official level in metres above sea level, which is not openly published. So it is not compared with official thresholds.",
							)}
						</p>
						<p>{l === "es" ? view.guri.ruleEs : view.guri.ruleEn}</p>
						<p>
							{t(
								"Un punto nuevo llega cada ~10 días y DAHITI lo publica semanas después: la fecha del dato se muestra siempre. Los cortes de hoy se ven en las luces nocturnas y en internet por estado (enlaces en el panel).",
								"A new point arrives every ~10 days and DAHITI publishes it weeks later: the date of the figure is always shown. Today's cuts show up in night lights and internet by state (links in the panel).",
							)}
						</p>
						<p class="note">{view.guri.attribution}</p>
					</>
				) : null
			}
		>
			{view ? <ServicesBody view={view} /> : null}
		</Panel>
	);
}

export function GazettePanel() {
	const view = panels.value.gazette as GazetteView | undefined;
	return (
		<Panel
			id="gaceta"
			title={PANEL_META.gaceta.title()}
			question={PANEL_META.gaceta.question()}
			feeds={PANEL_META.gaceta.feeds()}
			method={
				<>
					<p>
						{t(
							"Números nuevos de la Gaceta Oficial según el índice que publica la Imprenta Nacional (gacetaoficial.gob.ve): número, tipo, fecha, enlace a la página oficial y al PDF, y los títulos de su sumario tal como los escribe el índice.",
							"New issues of the Official Gazette as listed by the index the Imprenta Nacional publishes (gacetaoficial.gob.ve): number, type, date, links to the official page and the PDF, and the titles in its table of contents as the index writes them.",
						)}
					</p>
					<p>
						{t(
							"El índice va atrasado respecto a la Gaceta impresa (el 24 de septiembre de 2026, el último número listado era del 15): el panel dice cuántos días.",
							"The index lags the printed Gazette (on 24 September 2026 the newest issue listed was from the 15th): the panel says by how many days.",
						)}
					</p>
					<p>
						{t(
							"Los actos de alcance general van primero; después, los actos sobre funcionarios públicos en ejercicio (designaciones, traslados, delegaciones, ascensos, ceses y destituciones, condecoraciones, firmas autorizadas, cartas credenciales), con sus nombres, como los publica la Gaceta. Las pensiones, jubilaciones y otros asuntos personales tratan de particulares: se cuentan sin listarlos. Vigía borra los números de cédula, RIF y pasaporte antes de guardar nada.",
							"Acts of general scope come first; then acts about public officials in office (appointments, transfers, delegations, promotions, removals and dismissals, decorations, signing authorisations, credentials), with their names, as the Gazette publishes them. Pensions, retirements and other personal matters are about private persons: they are counted, not listed. Vigía removes ID, RIF and passport numbers before storing anything.",
						)}
					</p>
				</>
			}
		>
			{view ? <GazetteBody view={view} /> : null}
		</Panel>
	);
}
