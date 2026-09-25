import { useState } from "preact/hooks";
import type { Lang } from "../lib/format.ts";
import { int, num, pct } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { SourceTag } from "../ui/Source.tsx";
import { Sparkline } from "../ui/Sparkline.tsx";
import type { HealthFigure, HumanitarianView, Plan } from "./Humanitarian.tsx";

/* The body of "Salud, migración y ayuda", in its own chunk: loaded only when the panel is open. Formatting only. */

type Tab = "salud" | "migracion" | "ayuda" | "seguridad";

const MONTHS_ES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic"];
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-08" → "ago 2026". */
function month(ym: string, l: Lang): string {
	const m = Number(ym.slice(5, 7)) - 1;
	return `${(l === "es" ? MONTHS_ES : MONTHS_EN)[m] ?? "?"} ${ym.slice(0, 4)}`;
}

/** "2026-09-06" → "6 sept" (a calendar day as the source gives it, no time zone shift). */
function day(iso: string, l: Lang): string {
	const m = Number(iso.slice(5, 7)) - 1;
	const d = Number(iso.slice(8, 10));
	return l === "es" ? `${d} ${MONTHS_ES[m]}` : `${MONTHS_EN[m]} ${d}`;
}

/** US$ in millions: "404,3 M US$" / "US$404.3 M". */
function usdM(v: number, l: Lang): string {
	const m = num(v / 1e6, 1, l);
	return l === "es" ? `${m} M US$` : `US$${m} M`;
}

function Change({ now, before }: { now: number | null; before: number | null }) {
	const l = lang.value;
	if (now === null || before === null || before === 0) return null;
	const p = (now / before - 1) * 100;
	return (
		<span
			class={`hu-change ${p > 0 ? "hu-change--up" : p < 0 ? "hu-change--down" : ""}`}
			title={t("Frente a la semana anterior", "Against the previous week")}
		>
			{pct(p, 0, l)}
		</span>
	);
}

function HealthRow({ f }: { f: HealthFigure }) {
	const l = lang.value;
	const label = l === "es" ? f.labelEs : f.labelEn;
	const values = f.weeks.flatMap((w) => (w.value === null ? [] : [w.value]));
	return (
		<li class="hu-row">
			<div class="hu-row__head">
				<span class="hu-row__label">{label}</span>
				<span class="hu-row__value data">
					{f.week === null ? "—" : int(f.week, l)} <Change now={f.week} before={f.previous} />
				</span>
			</div>
			<Sparkline
				values={values}
				width={220}
				height={22}
				tone="muted"
				summary={t(
					`${label}: casos por semana epidemiológica, ${values.length} semanas del año`,
					`${label}: cases per epidemiological week, ${values.length} weeks of the year`,
				)}
			/>
			{f.yearToDate !== null ? (
				<span class="hu-row__year note">
					{t(`En el año: ${int(f.yearToDate, l)}`, `Year to date: ${int(f.yearToDate, l)}`)}
					{f.previousYearToDate !== null
						? t(
								` (mismo período del año anterior: ${int(f.previousYearToDate, l)})`,
								` (same period last year: ${int(f.previousYearToDate, l)})`,
							)
						: null}
				</span>
			) : null}
			{(f.notes ?? []).map((n) => (
				<span key={n.es} class="hu-row__year note">
					{l === "es" ? n.es : n.en}
				</span>
			))}
		</li>
	);
}

function Health({ v }: { v: HumanitarianView["health"] }) {
	const l = lang.value;
	const b = v.bulletin;
	const malariaWho = v.malaria;
	const coverage = v.who.filter((w) => w.unit === "%");
	const reported = v.who.filter((w) => w.id === "measles-reported" || w.id === "diphtheria-reported");
	return (
		<div class="hu-section">
			{b ? (
				<div class="hu-lead">
					<p class="hu-lead__title">
						{t(
							`Boletín Epidemiológico del MPPS · semana ${b.week} (${day(b.from, l)}–${day(b.to, l)} ${b.year})`,
							`MPPS Epidemiological Bulletin · week ${b.week} (${day(b.from, l)}–${day(b.to, l)} ${b.year})`,
						)}
					</p>
					<SourceTag
						source={{
							feed: "mpps-boletin",
							observedAt: b.observedAt,
							url: b.pdfUrl,
							detail: t(
								`Cifras nacionales transcritas del PDF de la semana ${b.week} (transcripción del ${v.transcribedAt}).`,
								`National figures transcribed from the week ${b.week} PDF (transcribed ${v.transcribedAt}).`,
							),
						}}
						label="MPPS"
					/>
				</div>
			) : null}
			{v.untranscribed > 0 && v.listed ? (
				<p class="hu-callout hu-callout--warn">
					{t(
						`El MPPS ya publicó hasta la semana ${v.listed.week}; Vigía aún no transcribió ${v.untranscribed === 1 ? "esa semana" : `esas ${v.untranscribed} semanas`}. Las cifras de abajo son de la semana ${b?.week ?? "—"}.`,
						`The MPPS has published up to week ${v.listed.week}; Vigía has not transcribed ${v.untranscribed === 1 ? "that week" : `those ${v.untranscribed} weeks`} yet. The figures below are for week ${b?.week ?? "—"}.`,
					)}{" "}
					<a href={v.listed.pdfUrl} target="_blank" rel="noopener noreferrer">
						{t("Abrir el boletín más reciente", "Open the newest bulletin")}
					</a>
				</p>
			) : null}
			{v.coveragePct !== null ? (
				<p class="hu-coverage">
					<span class="hu-coverage__bar" aria-hidden="true">
						<i style={{ width: `${Math.min(100, v.coveragePct)}%` }} />
					</span>
					<span>
						{t(
							`Reportó el ${num(v.coveragePct, 1, l)} % de los centros de salud esa semana: los casos son los notificados, no todos los que hubo.`,
							`${num(v.coveragePct, 1, l)}% of health facilities reported that week: cases are those notified, not all that occurred.`,
						)}
					</span>
				</p>
			) : null}
			{b && v.figures.some((f) => f.previous !== null) ? (
				<p class="note hu-legend">
					{t(
						`Casos de la semana ${b.week}; el % a su lado compara con la semana ${b.week - 1}.`,
						`Cases in week ${b.week}; the % beside them compares with week ${b.week - 1}.`,
					)}
				</p>
			) : null}
			<ul class="hu-rows">
				{v.figures.map((f) => (
					<HealthRow key={f.id} f={f} />
				))}
			</ul>
			<ul class="hu-facts">
				{v.measles ? (
					<li>
						<strong>{t("Sarampión y rubéola", "Measles and rubella")}</strong>{" "}
						{t(
							`${int(v.measles.suspected, l)} casos sospechosos en el año: ${int(v.measles.discarded, l)} descartados, ${int(v.measles.investigating, l)} en investigación.`,
							`${int(v.measles.suspected, l)} suspected cases this year: ${int(v.measles.discarded, l)} ruled out, ${int(v.measles.investigating, l)} under investigation.`,
						)}
						{v.measles.consistent
							? null
							: t(
									" (el boletín no cuadra: se muestra tal cual)",
									" (the bulletin's parts do not add up: shown as printed)",
								)}
					</li>
				) : null}
				{v.yellowFever ? (
					<li>
						<strong>{t("Fiebre amarilla", "Yellow fever")}</strong>{" "}
						{t(
							`${int(v.yellowFever.cases, l)} casos confirmados y ${int(v.yellowFever.deaths, l)} muertes en el año.`,
							`${int(v.yellowFever.cases, l)} confirmed cases and ${int(v.yellowFever.deaths, l)} deaths this year.`,
						)}
					</li>
				) : null}
			</ul>

			<h3 class="hu-h">{t("Cifras anuales ante la OMS", "Yearly figures reported to WHO")}</h3>
			{malariaWho ? (
				<div class="hu-pair">
					<div class="hu-pair__cell">
						<span class="hu-pair__label">
							{t(
								`Malaria ${malariaWho.year}: notificado por el país`,
								`Malaria ${malariaWho.year}: reported by the country`,
							)}
						</span>
						<span class="hu-pair__value data">{int(malariaWho.reported, l)}</span>
						<span class="note">{t("casos confirmados", "confirmed cases")}</span>
					</div>
					<div class="hu-pair__cell">
						<span class="hu-pair__label">{t("Estimado por la OMS", "Estimated by WHO")}</span>
						<span class="hu-pair__value data">{int(malariaWho.estimated, l)}</span>
						{malariaWho.low !== null && malariaWho.high !== null ? (
							<span class="note">
								{t(
									`intervalo ${int(malariaWho.low, l)}–${int(malariaWho.high, l)}`,
									`range ${int(malariaWho.low, l)}–${int(malariaWho.high, l)}`,
								)}
							</span>
						) : null}
					</div>
				</div>
			) : null}
			<ul class="hu-mini">
				{[...reported, ...coverage].map((w) => (
					<li key={w.id}>
						<span class="hu-mini__label">
							{l === "es" ? w.labelEs : w.labelEn} <span class="data note">{w.year}</span>
						</span>
						<span class="hu-mini__value data">
							{w.unit === "%" ? `${int(w.value, l)} %` : int(w.value, l)}
						</span>
						<SourceTag
							source={{
								feed: "who-gho",
								observedAt: w.observedAt,
								url: w.sourceUrl,
								detail:
									w.unit === "%"
										? t(
												`Cobertura estimada por la OMS y UNICEF (WUENIC), % de niños de un año. Actualizado ${w.updated ?? "—"}.`,
												`Coverage estimated by WHO and UNICEF (WUENIC), % of one-year-olds. Updated ${w.updated ?? "—"}.`,
											)
										: t(
												`Casos que Venezuela notificó a la OMS en ${w.year}. Actualizado ${w.updated ?? "—"}.`,
												`Cases Venezuela reported to WHO in ${w.year}. Updated ${w.updated ?? "—"}.`,
											),
							}}
							label={t("OMS", "WHO")}
						/>
					</li>
				))}
			</ul>
		</div>
	);
}

function Migration({ v }: { v: HumanitarianView["migration"] }) {
	const l = lang.value;
	const [all, setAll] = useState(false);
	const r4v = v.r4v;
	const u = v.unhcr;
	const max = r4v.countries[0]?.people ?? 1;
	const shown = all ? r4v.countries : r4v.countries.slice(0, 8);
	const series = u.abroadByYear.flatMap((y) => (y.total === null ? [] : [y.total]));
	return (
		<div class="hu-section">
			<div class="hu-pair">
				<div class="hu-pair__cell">
					<span class="hu-pair__label">
						{t(
							"Venezolanos refugiados y migrantes en América Latina y el Caribe",
							"Venezuelan refugees and migrants in Latin America and the Caribbean",
						)}
					</span>
					<span class="hu-pair__value data">{r4v.total ? int(r4v.total.people, l) : "—"}</span>
					{r4v.total ? (
						<SourceTag
							source={{
								feed: "r4v-figures",
								observedAt: r4v.total.observedAt,
								url: "https://www.r4v.info/es/refugiadosymigrantes",
								detail: t(
									`Cifra regional de R4V, «última actualización» ${month(r4v.total.month, l)}: suma de lo que informan los gobiernos de acogida; no incluye a quienes no tienen estatus regular.`,
									`R4V's regional figure, "last updated" ${month(r4v.total.month, l)}: the sum of what host governments report; people without regular status are not included.`,
								),
							}}
							label="R4V"
						/>
					) : null}
				</div>
				<div class="hu-pair__cell">
					<span class="hu-pair__label">
						{t(
							u.year === null
								? "Desplazados en el exterior según ACNUR"
								: `Desplazados en el exterior según ACNUR (fin de ${u.year})`,
							u.year === null
								? "Displaced abroad according to UNHCR"
								: `Displaced abroad according to UNHCR (end of ${u.year})`,
						)}
					</span>
					{u.abroad?.total != null ? (
						<span class="hu-pair__value data">{int(u.abroad.total, l)}</span>
					) : (
						<span class="hu-pair__empty note">{t("sin datos aún", "no data yet")}</span>
					)}
					{u.abroad && u.observedAt !== null ? (
						<SourceTag
							source={{
								feed: "unhcr-population",
								observedAt: u.observedAt,
								url: "https://www.unhcr.org/refugee-statistics/",
								detail: t(
									`Refugiados ${u.abroad.refugees !== null ? int(u.abroad.refugees, l) : "—"} + solicitantes de asilo ${u.abroad.asylumSeekers !== null ? int(u.abroad.asylumSeekers, l) : "—"} + otras personas con necesidad de protección internacional ${u.abroad.otherInNeed !== null ? int(u.abroad.otherInNeed, l) : "—"}, en todo el mundo.`,
									`Refugees ${u.abroad.refugees !== null ? int(u.abroad.refugees, l) : "—"} + asylum seekers ${u.abroad.asylumSeekers !== null ? int(u.abroad.asylumSeekers, l) : "—"} + other people in need of international protection ${u.abroad.otherInNeed !== null ? int(u.abroad.otherInNeed, l) : "—"}, worldwide.`,
								),
							}}
							label={t("ACNUR", "UNHCR")}
						/>
					) : null}
				</div>
			</div>
			<p class="note">
				{t(
					"Dos medidas distintas, lado a lado: no se suman ni se promedian. R4V cuenta la región y fechas distintas por país; ACNUR, el mundo al cierre del año.",
					"Two different measures, side by side: never added or averaged. R4V counts the region, with different dates per country; UNHCR, the world at year end.",
				)}
			</p>
			{series.length > 1 ? (
				<div class="hu-trend">
					<span class="note">
						{t(
							`ACNUR, desplazados en el exterior ${u.abroadByYear[0]?.year}–${u.year}`,
							`UNHCR, displaced abroad ${u.abroadByYear[0]?.year}–${u.year}`,
						)}
					</span>
					<Sparkline
						values={series}
						width={260}
						height={28}
						tone="info"
						summary={t(
							`Desplazados venezolanos en el exterior por año según ACNUR: ${u.abroadByYear.map((y) => `${y.year} ${y.total === null ? "sin dato" : int(y.total, l)}`).join(", ")}`,
							`Venezuelans displaced abroad per year according to UNHCR: ${u.abroadByYear.map((y) => `${y.year} ${y.total === null ? "no data" : int(y.total, l)}`).join(", ")}`,
						)}
					/>
				</div>
			) : null}

			<h3 class="hu-h">{t("Por país de acogida (R4V)", "By host country (R4V)")}</h3>
			<ul class="hu-bars">
				{shown.map((c) => (
					<li key={c.id} class="hu-bar">
						<span class="hu-bar__name">{l === "es" ? c.countryEs : c.countryEn}</span>
						<span class="hu-bar__track" aria-hidden="true">
							<i style={{ width: `${Math.max(0.5, (c.people / max) * 100)}%` }} />
						</span>
						<span class="hu-bar__value data">{int(c.people, l)}</span>
						<span class="hu-bar__meta note">
							{month(c.month, l)}
							{(l === "es" ? c.publisherEs : c.publisherEn)
								? ` · ${l === "es" ? c.publisherEs : c.publisherEn}`
								: ""}
						</span>
					</li>
				))}
			</ul>
			{r4v.countries.length > 8 ? (
				<button type="button" class="link-button" onClick={() => setAll(!all)}>
					{all
						? t("Ver menos", "Show fewer")
						: t(
								`Ver los ${r4v.countries.length} países y grupos`,
								`Show all ${r4v.countries.length} countries and groups`,
							)}
				</button>
			) : null}
			{u.hosted ? (
				<p class="hu-facts-line">
					<strong>{t("En Venezuela", "In Venezuela")}</strong>{" "}
					{t(
						`${u.hosted.total !== null ? int(u.hosted.total, l) : "—"} refugiados y solicitantes de asilo de otros países (ACNUR, fin de ${u.hosted.year}).`,
						`${u.hosted.total !== null ? int(u.hosted.total, l) : "—"} refugees and asylum seekers from other countries (UNHCR, end of ${u.hosted.year}).`,
					)}
				</p>
			) : null}
		</div>
	);
}

function PlanCard({ p, curve }: { p: Plan; curve: HumanitarianView["aid"]["hrpCurve"] | null }) {
	const l = lang.value;
	const name =
		p.kind === "hrp"
			? t(`Plan de Respuesta Humanitaria ${p.year}`, `Humanitarian Response Plan ${p.year}`)
			: t(
					`Plan regional para refugiados y migrantes (RMRP) ${p.year}`,
					`Regional Refugee and Migrant Response Plan (RMRP) ${p.year}`,
				);
	return (
		<div class={`hu-plan${p.kind === "hrp" ? " hu-plan--current" : ""}`}>
			<div class="hu-plan__head">
				<span class="hu-plan__name">{name}</span>
				<span class="hu-plan__pct data">{p.pctFunded === null ? "—" : `${num(p.pctFunded, 1, l)} %`}</span>
			</div>
			<span
				class="hu-plan__bar"
				role="img"
				aria-label={t(
					`Financiado ${usdM(p.fundedUsd, l)} de ${usdM(p.requirementsUsd, l)}`,
					`Funded ${usdM(p.fundedUsd, l)} of ${usdM(p.requirementsUsd, l)}`,
				)}
			>
				<i style={{ width: `${Math.min(100, p.pctFunded ?? 0)}%` }} />
			</span>
			<p class="hu-plan__line note">
				{t(
					`${usdM(p.fundedUsd, l)} recibidos de ${usdM(p.requirementsUsd, l)} requeridos · faltan ${usdM(p.gapUsd, l)}`,
					`${usdM(p.fundedUsd, l)} received of ${usdM(p.requirementsUsd, l)} required · ${usdM(p.gapUsd, l)} short`,
				)}
				{p.originalRequirementsUsd !== null && p.originalRequirementsUsd !== p.requirementsUsd
					? t(
							` · requerimiento revisado desde ${usdM(p.originalRequirementsUsd, l)}`,
							` · requirement revised from ${usdM(p.originalRequirementsUsd, l)}`,
						)
					: null}
				{p.kind === "rmrp"
					? t(" · para venezolanos en 17 países de acogida", " · for Venezuelans in 17 host countries")
					: null}
			</p>
			{curve && curve.length >= 7 ? (
				<div class="hu-trend">
					<span class="note">
						{t(
							`% financiado según cada lectura diaria de Vigía desde el ${new Date(curve[0]?.at ?? 0).toISOString().slice(0, 10)}`,
							`% funded at each of Vigía's daily reads since ${new Date(curve[0]?.at ?? 0).toISOString().slice(0, 10)}`,
						)}
					</span>
					<Sparkline
						values={curve.map((c) => c.pct)}
						width={260}
						height={24}
						tone="info"
						summary={t(
							`De ${num(curve[0]?.pct ?? 0, 1, l)} % a ${num(curve.at(-1)?.pct ?? 0, 1, l)} % financiado`,
							`From ${num(curve[0]?.pct ?? 0, 1, l)}% to ${num(curve.at(-1)?.pct ?? 0, 1, l)}% funded`,
						)}
					/>
				</div>
			) : null}
			<SourceTag
				source={{
					feed: "ocha-fts",
					observedAt: p.observedAt,
					url: p.sourceUrl,
					detail: t(
						`${p.name} (${p.code}): financiamiento informado a OCHA FTS hasta la lectura; % financiado calculado por Vigía.`,
						`${p.name} (${p.code}): funding reported to OCHA FTS as of the read; % funded computed by Vigía.`,
					),
				}}
				label="OCHA FTS"
			/>
		</div>
	);
}

function Aid({ v }: { v: HumanitarianView["aid"] }) {
	const l = lang.value;
	const year = v.plans[0]?.year;
	const current = v.plans.filter((p) => p.year === year);
	const past = v.plans.filter((p) => p.year !== year && p.kind === "hrp");
	const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
	if (!v.plans.length && !v.disasters.length && !v.reports.length)
		return (
			<div class="hu-section">
				<p class="empty">
					{t(
						"Sin datos aún de OCHA FTS ni de ReliefWeb: los planes de respuesta, su financiamiento y los informes aparecen aquí cuando esas fuentes respondan.",
						"No data yet from OCHA FTS or ReliefWeb: response plans, their funding and reports appear here once those sources answer.",
					)}
				</p>
			</div>
		);
	return (
		<div class="hu-section">
			{current.map((p) => (
				<PlanCard key={p.code} p={p} curve={p.kind === "hrp" ? v.hrpCurve : null} />
			))}
			{past.length ? (
				<>
					<h3 class="hu-h">{t("Planes anteriores: % financiado", "Earlier plans: % funded")}</h3>
					<ul class="hu-years">
						{past.map((p) => (
							<li key={p.code}>
								<a href={p.sourceUrl} target="_blank" rel="noopener noreferrer">
									<span class="data">{p.year}</span>
									<span class="hu-years__bar" aria-hidden="true">
										<i class="hu-years__fill" style={{ height: `${Math.min(100, p.pctFunded ?? 0)}%` }} />
									</span>
									<span class="data">{p.pctFunded === null ? "—" : `${num(p.pctFunded, 0, l)} %`}</span>
								</a>
							</li>
						))}
					</ul>
				</>
			) : null}
			{v.disasters.length ? (
				<>
					<h3 class="hu-h">
						{t(
							"Desastres registrados en Venezuela (ReliefWeb)",
							"Disasters recorded in Venezuela (ReliefWeb)",
						)}
					</h3>
					<ul class="hu-list">
						{v.disasters.map((d) => (
							<li key={d.url}>
								<a href={d.url} target="_blank" rel="noopener noreferrer">
									{d.title}
								</a>
								<span class="data note">
									{" "}
									{day(dateOf(d.observedAt), l)} {dateOf(d.observedAt).slice(0, 4)}
									{d.glide ? ` · ${d.glide}` : ""}
								</span>
							</li>
						))}
					</ul>
				</>
			) : null}
			{v.reports.length ? (
				<>
					<h3 class="hu-h">{t("Informes recientes (ReliefWeb)", "Recent reports (ReliefWeb)")}</h3>
					<ul class="hu-list">
						{v.reports.map((r) => (
							<li key={r.url}>
								<a href={r.url} target="_blank" rel="noopener noreferrer">
									{r.title}
								</a>
								<span class="note">
									{" "}
									{r.orgs.join(", ")} · <span class="data">{day(dateOf(r.observedAt), l)}</span>
								</span>
							</li>
						))}
					</ul>
					<p class="note">
						{t(
							"Titulares y enlaces: cada informe es de la organización que lo publica.",
							"Headlines and links: each report belongs to the organisation that published it.",
						)}
					</p>
				</>
			) : null}
		</div>
	);
}

function Security({ v }: { v: HumanitarianView["security"] }) {
	const l = lang.value;
	const newest = v.years.at(-1);
	return (
		<div class="hu-section">
			<table class="hu-table">
				<caption class="sr-only">
					{t("Muertes violentas por año según el OVV", "Violent deaths per year according to the OVV")}
				</caption>
				<thead>
					<tr>
						<th scope="col">{t("Año", "Year")}</th>
						<th scope="col">{t("Muertes violentas", "Violent deaths")}</th>
						<th scope="col">{t("Tasa por 100 mil", "Rate per 100k")}</th>
					</tr>
				</thead>
				<tbody>
					{v.years.map((y) => (
						<tr key={y.year}>
							<th scope="row">
								<a href={y.url} target="_blank" rel="noopener noreferrer">
									{y.year}
								</a>
							</th>
							<td class="data">
								{int(y.violentDeaths, l)}
								<span class="hu-table__parts note">
									{t(
										`${int(y.homicides, l)} homicidios · ${int(y.interventionDeaths, l)} por intervención policial · ${int(y.underInvestigation, l)} en averiguación`,
										`${int(y.homicides, l)} homicides · ${int(y.interventionDeaths, l)} by police intervention · ${int(y.underInvestigation, l)} under investigation`,
									)}
								</span>
							</td>
							<td class="data">{num(y.ratePer100k, 1, l)}</td>
						</tr>
					))}
				</tbody>
			</table>
			{v.years.some((y) => y.noteEs) ? (
				<ul class="hu-notes note">
					{v.years
						.filter((y) => y.noteEs)
						.map((y) => (
							<li key={y.year}>
								{y.year}: {l === "es" ? y.noteEs : y.noteEn}
							</li>
						))}
				</ul>
			) : null}
			<p class="hu-callout">
				{t(
					`Fuente independiente: Observatorio Venezolano de Violencia (OVV). Su último informe nacional es de ${newest?.year ?? "—"}; no encontramos uno de años posteriores ni una serie oficial publicada con la que compararlo (revisado el ${v.checkedOn}).`,
					`Independent source: the Venezuelan Violence Observatory (OVV). Its newest national report covers ${newest?.year ?? "—"}; we found none for later years, and no published official series to set beside it (checked ${v.checkedOn}).`,
				)}{" "}
				<a href={v.sourceUrl} target="_blank" rel="noopener noreferrer">
					{t("Informes del OVV", "OVV reports")}
				</a>
			</p>
		</div>
	);
}

export function HumanitarianBody({ view }: { view: HumanitarianView }) {
	const [tab, setTab] = useState<Tab>("salud");
	const tabs: { id: Tab; es: string; en: string }[] = [
		{ id: "salud", es: "Salud", en: "Health" },
		{ id: "migracion", es: "Migración", en: "Migration" },
		{ id: "ayuda", es: "Ayuda", en: "Aid" },
		{ id: "seguridad", es: "Seguridad", en: "Security" },
	];
	return (
		<div class="hu">
			<div class="segmented segmented--wide hu-tabs" role="tablist" aria-label={t("Secciones", "Sections")}>
				{tabs.map((x) => (
					<button
						key={x.id}
						type="button"
						role="tab"
						id={`hu-tab-${x.id}`}
						aria-controls="hu-tabpanel"
						aria-selected={tab === x.id}
						onClick={() => setTab(x.id)}
					>
						{t(x.es, x.en)}
					</button>
				))}
			</div>
			<div id="hu-tabpanel" role="tabpanel" aria-labelledby={`hu-tab-${tab}`}>
				{tab === "salud" ? (
					<Health v={view.health} />
				) : tab === "migracion" ? (
					<Migration v={view.migration} />
				) : tab === "ayuda" ? (
					<Aid v={view.aid} />
				) : (
					<Security v={view.security} />
				)}
			</div>
		</div>
	);
}
