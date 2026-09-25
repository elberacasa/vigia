import { addStyles } from "../lib/css.ts";
import { panels } from "../lib/data.ts";
import { lang, t } from "../lib/i18n.ts";
import { PANEL_META } from "../lib/panel-meta.ts";
import airspaceCss from "../styles/airspace.css?inline";
import panelsCss from "../styles/panels.css?inline";
import { Panel } from "../ui/Panel.tsx";
import { SourceTag } from "../ui/Source.tsx";

addStyles(panelsCss);

addStyles(airspaceCss);

/* Mirrors src/panels/airspace.ts. */

interface CzibRow {
	nid: string;
	number: string | null;
	name: string;
	status: "active" | "withdrawn";
	issuedDate: string;
	validUntil: string | null;
	url: string;
}
interface FaaItem {
	title: string;
	url: string;
}
interface FaaSectionRow {
	country: string;
	items: FaaItem[];
	codes: string[];
	url: string;
}
export interface AirspaceView {
	status: "advisory" | "none" | "unknown";
	easa: {
		venezuelaActive: CzibRow[];
		venezuelaHistory: CzibRow[];
		activeWorldwide: number;
		checkedAt: number | null;
		url: string;
	};
	faa: {
		lastUpdated: string | null;
		venezuela: FaaSectionRow | null;
		mentions: (FaaItem & { section: string })[];
		nearby: FaaSectionRow[];
		checkedAt: number | null;
		url: string;
	};
	ruleEs: string;
	ruleEn: string;
	notCoveredEs: string;
	notCoveredEn: string;
}

const COUNTRY_ES: Record<string, string> = {
	Colombia: "Colombia",
	Panama: "Panamá",
	Ecuador: "Ecuador",
	"Central America": "Centroamérica",
	Haiti: "Haití",
	Cuba: "Cuba",
	Bahamas: "Bahamas",
};

const MONTHS_ES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A source's own calendar date ("2026-01-03"), shown as written: no time zone shift. */
function day(date: string | null): string {
	if (!date) return t("sin fecha de fin", "no end date");
	const [y, m, d] = date.split("-");
	const months = lang.value === "es" ? MONTHS_ES : MONTHS_EN;
	return `${Number(d)} ${months[Number(m) - 1] ?? m} ${y}`;
}

function Czib({ c }: { c: CzibRow }) {
	return (
		<li class="air-item">
			<a href={c.url} target="_blank" rel="noopener noreferrer">
				EASA CZIB {c.number ?? ""} · {c.name}
			</a>
			<span class="note data">
				{day(c.issuedDate)} → {day(c.validUntil)}
				{c.status === "withdrawn" ? ` · ${t("retirado", "withdrawn")}` : ` · ${t("vigente", "in force")}`}
			</span>
		</li>
	);
}

/** Links scraped from a source page: only https:, never javascript: or data: (review 3, L1). */
export function httpsOnly(url: string): string | undefined {
	try {
		return new URL(url).protocol === "https:" ? url : undefined;
	} catch {
		return undefined;
	}
}

export function AirspacePanel() {
	const view = panels.value.airspace as AirspaceView | undefined;
	const l = lang.value;
	const faaVe = view ? [...(view.faa.venezuela?.items ?? []), ...view.faa.mentions] : [];
	return (
		<Panel
			id="espacio-aereo"
			title={PANEL_META["espacio-aereo"].title()}
			question={PANEL_META["espacio-aereo"].question()}
			feeds={PANEL_META["espacio-aereo"].feeds()}
			method={
				view ? (
					<>
						<p>{l === "es" ? view.ruleEs : view.ruleEn}</p>
						<p>{l === "es" ? view.notCoveredEs : view.notCoveredEn}</p>
						<p>
							{t(
								"Vecinos: las secciones de la FAA de Colombia, Panamá, Ecuador, Centroamérica, Haití, Cuba y Bahamas, tal como las publica.",
								"Nearby: the FAA sections for Colombia, Panama, Ecuador, Central America, Haiti, Cuba and the Bahamas, as published.",
							)}
						</p>
					</>
				) : null
			}
		>
			{!view ? null : (
				<div class="air">
					<p class={`air-status air-status--${view.status}`} role="status">
						<span class="air-status__dot" aria-hidden="true" />
						{view.status === "advisory"
							? t(
									"Hay un aviso vigente sobre el espacio aéreo venezolano",
									"There is an advisory in force on Venezuelan airspace",
								)
							: view.status === "none"
								? t(
										"Ningún aviso vigente de EASA ni de la FAA nombra a Venezuela",
										"No advisory in force from EASA or the FAA names Venezuela",
									)
								: t("Aún sin leer ambas fuentes", "Both sources not read yet")}
					</p>
					{view.easa.venezuelaActive.length || faaVe.length ? (
						<ul class="air-list">
							{view.easa.venezuelaActive.map((c) => (
								<Czib key={c.nid} c={c} />
							))}
							{faaVe.map((i) => (
								<li class="air-item" key={i.url}>
									<a href={httpsOnly(i.url)} target="_blank" rel="noopener noreferrer">
										FAA · {i.title}
									</a>
								</li>
							))}
						</ul>
					) : null}
					{view.easa.venezuelaHistory.length ? (
						<>
							<h3 class="air__h caps">{t("Antes", "Earlier")}</h3>
							<ul class="air-list">
								{view.easa.venezuelaHistory.map((c) => (
									<Czib key={c.nid} c={c} />
								))}
							</ul>
						</>
					) : null}
					{view.faa.nearby.length ? (
						<>
							<h3 class="air__h caps">{t("Vecinos (FAA)", "Nearby (FAA)")}</h3>
							<ul class="air-near">
								{view.faa.nearby.map((s) => (
									<li key={s.country}>
										<a href={httpsOnly(s.url)} target="_blank" rel="noopener noreferrer">
											{l === "es" ? (COUNTRY_ES[s.country] ?? s.country) : s.country}
										</a>
										<span class="data air-near__codes">
											{s.codes.length
												? s.codes.join(" · ")
												: t(`${s.items.length} avisos`, `${s.items.length} notices`)}
										</span>
									</li>
								))}
							</ul>
						</>
					) : null}
					<div class="sources-row">
						{view.easa.checkedAt ? (
							<SourceTag
								source={{
									feed: "easa-czib",
									observedAt: view.easa.checkedAt,
									url: view.easa.url,
									detail: t(
										`Revisado. ${view.easa.activeWorldwide} boletines activos en el mundo.`,
										`Checked. ${view.easa.activeWorldwide} bulletins active worldwide.`,
									),
								}}
								label="EASA"
							/>
						) : null}
						{view.faa.checkedAt ? (
							<SourceTag
								source={{
									feed: "faa-prohibitions",
									observedAt: view.faa.checkedAt,
									url: view.faa.url,
									detail: t(
										`Revisado. Página actualizada por la FAA el ${day(view.faa.lastUpdated)}.`,
										`Checked. Page updated by the FAA on ${day(view.faa.lastUpdated)}.`,
									),
								}}
								label="FAA"
							/>
						) : null}
					</div>
				</div>
			)}
		</Panel>
	);
}
