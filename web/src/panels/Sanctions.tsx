import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { addStyles } from "../lib/css.ts";
import { now, panels, wantPanel } from "../lib/data.ts";
import { ago, int, stamp } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { PANEL_META } from "../lib/panel-meta.ts";
import {
	type Action,
	type ChangeRow,
	changesByMonth,
	dayText,
	groupOffices,
	KIND_LABEL,
	licenceBadge,
	monthText,
	type Office,
	type OfficialsView,
	officeLine,
	programText,
	type SanctionsView,
	type Tally,
} from "../lib/sanctions-view.ts";
import { registerSummary } from "../lib/summary.ts";
import sanctionsCss from "../styles/sanctions.css?inline";
import { Panel } from "../ui/Panel.tsx";
import { SourceTag } from "../ui/Source.tsx";

addStyles(sanctionsCss);

/*
 * "Sanciones de EE. UU." (OFAC's Venezuela programmes, its general licences, the Federal Register) and "Cargos
 * públicos" (Venezuela's offices as Wikidata records them). Both views are served on demand and computed on the
 * server (src/panels/sanctions.ts, src/panels/officials.ts); this file only lays them out. Private persons are never
 * named: OFAC's individuals who are not public officials are a count (the project's safety rules).
 */

export type { OfficialsView, SanctionsView };

/** Asks for an on-demand view when its panel opens; says so if it cannot be fetched. */
function useOnDemand<V>(id: string): { view: V | undefined; failed: boolean; retry: () => void } {
	const view = panels.value[id] as V | undefined;
	const [failed, setFailed] = useState(false);
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		let live = true;
		wantPanel(id).catch(() => {
			if (live) setFailed(true);
		});
		return () => {
			live = false;
		};
	}, [id, attempt]);
	return {
		view,
		failed: failed && !view,
		retry: () => {
			setFailed(false);
			setAttempt((a) => a + 1);
		},
	};
}

function Failed({ retry }: { retry: () => void }) {
	return (
		<p class="empty">
			{t(
				"No se pudo cargar este panel (se pide al abrirlo).",
				"This panel could not be loaded (it is fetched when opened).",
			)}{" "}
			<button type="button" class="link-button" onClick={retry}>
				{t("Reintentar", "Retry")}
			</button>
		</p>
	);
}

/** A source's calendar date as a moment for a source tag's age (noon in Caracas; the source gives no hour). */
const dayAt = (iso: string) => Date.parse(`${iso.slice(0, 10)}T16:00:00Z`);

/* ---------- Pieces ---------- */

function Figures({ cells }: { cells: { label: string; value: string; note?: string }[] }) {
	return (
		<dl class="sx-figs">
			{cells.map((c) => (
				<div class="sx-fig" key={c.label}>
					<dt>{c.label}</dt>
					<dd>
						<span class="sx-fig__v">{c.value}</span>
						{c.note ? <span class="sx-fig__note">{c.note}</span> : null}
					</dd>
				</div>
			))}
		</dl>
	);
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ComponentChildren }) {
	return (
		<section class="sx-sec">
			<h3 class="sx-h">
				<span class="caps">{title}</span>
				{hint ? <span class="sx-h__hint">{hint}</span> : null}
			</h3>
			{children}
		</section>
	);
}

/** A long list behind a disclosure that says how many rows it holds. */
function More({ label, n, children }: { label: string; n: number; children: ComponentChildren }) {
	return (
		<details class="sx-more">
			<summary>
				{label} <span class="mono">({int(n, lang.value)})</span>
			</summary>
			{children}
		</details>
	);
}

const ACTION: Record<Action, { es: string; en: string }> = {
	add: { es: "Alta", en: "Added" },
	remove: { es: "Baja", en: "Removed" },
	update: { es: "Cambio", en: "Updated" },
};

function tallyText(x: Tally): string {
	const l = lang.value;
	return t(
		`${int(x.add, l)} altas, ${int(x.remove, l)} bajas, ${int(x.update, l)} cambios`,
		`${int(x.add, l)} added, ${int(x.remove, l)} removed, ${int(x.update, l)} updated`,
	);
}

function subjectText(c: ChangeRow): string {
	const s = c.subject;
	switch (s.type) {
		case "individual":
			return s.named ? s.name : t("una persona (sin nombre)", "a person (not named)");
		case "entity":
			return s.name;
		case "vessel":
			return [s.name, s.vesselType, s.flag].filter(Boolean).join(" · ");
		case "aircraft":
			return s.model ? t(`aeronave ${s.model}`, `aircraft ${s.model}`) : t("aeronave", "aircraft");
	}
}

/** Twelve months of OFAC changes as small stacked columns, with the numbers in words for screen readers. */
function MonthStrip({ changes, at, read }: { changes: ChangeRow[]; at: number; read: number }) {
	const l = lang.value;
	const bins = changesByMonth(changes, at);
	const max = Math.max(1, ...bins.map((b) => b.add + b.remove + b.update));
	const described = bins
		.filter((b) => b.add + b.remove + b.update)
		.map((b) => `${monthText(b.month, l)}: ${tallyText(b)}`)
		.join("; ");
	return (
		<figure class="sx-months">
			<ol class="sx-months__bars" aria-hidden="true">
				{bins.map((b) => {
					const n = b.add + b.remove + b.update;
					return (
						<li key={b.month} title={`${monthText(b.month, l)}: ${tallyText(b)}`}>
							<span class="sx-months__col">
								{(["remove", "update", "add"] as const).map((k) =>
									b[k] ? (
										<i key={k} class={`sx-bar sx-bar--${k}`} style={{ height: `${(b[k] / max) * 100}%` }} />
									) : null,
								)}
							</span>
							<span class="sx-months__n mono">{n || ""}</span>
							<span class="sx-months__m">{monthText(b.month, l).split(" ")[0]}</span>
						</li>
					);
				})}
			</ol>
			<figcaption class="sx-note">
				<span class="sr-only">
					{described ||
						t(
							"Ningún cambio en las publicaciones leídas de los últimos 12 meses.",
							"No change in the publications read over the last 12 months.",
						)}{" "}
				</span>
				{t(
					`Cuenta solo las ${read} publicaciones de OFAC que Vigía leyó en 12 meses: un mes vacío puede no haberse leído.`,
					`Counts only the ${read} OFAC publications Vigía read in 12 months: an empty month may not have been read.`,
				)}
			</figcaption>
			<p class="sx-legend" aria-hidden="true">
				<span>
					<i class="sx-bar sx-bar--add" /> {t("altas", "added")}
				</span>
				<span>
					<i class="sx-bar sx-bar--remove" /> {t("bajas", "removed")}
				</span>
				<span>
					<i class="sx-bar sx-bar--update" /> {t("cambios", "updated")}
				</span>
			</p>
		</figure>
	);
}

function ChangeList({ rows }: { rows: ChangeRow[] }) {
	const l = lang.value;
	return (
		<ol class="sx-rows">
			{rows.map((c) => (
				<li class="sx-change" key={`${c.publicationId}:${c.action}:${subjectText(c)}`}>
					<time class="mono sx-change__at" dateTime={new Date(c.at).toISOString()}>
						{stamp(c.at, l, now.value)}
					</time>
					<span class={`sx-act sx-act--${c.action}`}>{t(ACTION[c.action].es, ACTION[c.action].en)}</span>
					<a class="sx-change__what" href={c.url} target="_blank" rel="noopener noreferrer">
						{subjectText(c)}
					</a>
					<span class="sx-change__meta">
						{t(`publicación N° ${c.publicationId}`, `publication No. ${c.publicationId}`)}
						{c.programs.length ? ` · ${c.programs.map(programText).join(", ")}` : ""}
					</span>
				</li>
			))}
		</ol>
	);
}

function Officials({ view }: { view: SanctionsView }) {
	const l = lang.value;
	const s = view.sdn;
	const first = s.officials.slice(0, 8);
	const rest = s.officials.slice(8);
	const row = (o: SanctionsView["sdn"]["officials"][number]) => (
		<li class="sx-person" key={o.uid}>
			<a class="sx-person__name" href={o.url} target="_blank" rel="noopener noreferrer">
				{o.name}
			</a>
			<span class={`sx-basis sx-basis--${o.basis}`}>
				{o.basis === "ofac-title"
					? t("cargo según OFAC", "office per OFAC")
					: t("titular según Wikidata", "holder per Wikidata")}
			</span>
			<span class="sx-person__role">
				{o.basis === "wikidata" && o.wikidata ? o.wikidata.position : (o.title ?? "")}
			</span>
		</li>
	);
	return (
		<Section
			title={t("Funcionarios públicos", "Public officials")}
			hint={t(
				`${int(s.officials.length, l)} nombrados por su cargo; el resto de las personas solo se cuenta`,
				`${int(s.officials.length, l)} named for their office; other persons are only counted`,
			)}
		>
			<p class="sx-rule">
				{t(
					"Se nombra solo a quien OFAC titula con un cargo público venezolano, o a quien Wikidata registra como titular de uno (coincidencia inequívoca del nombre).",
					"Only people OFAC titles with a Venezuelan public office, or whom Wikidata records as holding one (unambiguous name match), are named.",
				)}
				{s.wikidataChecked
					? ""
					: t(
							" Esta vez Wikidata no respondió: solo nombra el título de OFAC.",
							" Wikidata did not answer this time: only OFAC's title names anyone.",
						)}
			</p>
			<ul class="sx-rows">{first.map(row)}</ul>
			{rest.length ? (
				<More label={t("Ver los demás funcionarios", "See the other officials")} n={rest.length}>
					<ul class="sx-rows">{rest.map(row)}</ul>
				</More>
			) : null}
			<p class="sx-unnamed">
				<span class="mono">{int(s.unnamedIndividuals, l)}</span>{" "}
				{t(
					"personas más, sin nombre: no constan como funcionarios públicos (Vigía no nombra a particulares).",
					"more persons, not named: not on record as public officials (Vigía does not name private persons).",
				)}
			</p>
		</Section>
	);
}

function Listed({ view }: { view: SanctionsView }) {
	const l = lang.value;
	const s = view.sdn;
	return (
		<Section title={t("Empresas, buques y aeronaves", "Companies, vessels and aircraft")}>
			{s.entities.length ? (
				<More label={t("Empresas y organizaciones", "Companies and organisations")} n={s.entities.length}>
					<ul class="sx-rows sx-rows--cols">
						{s.entities.map((e) => (
							<li key={e.uid}>
								<a href={e.url} target="_blank" rel="noopener noreferrer">
									{e.name}
								</a>
							</li>
						))}
					</ul>
				</More>
			) : null}
			{s.vessels.length ? (
				<More label={t("Buques", "Vessels")} n={s.vessels.length}>
					<ul class="sx-rows">
						{s.vessels.map((v) => (
							<li class="sx-vessel" key={v.uid}>
								<a href={v.url} target="_blank" rel="noopener noreferrer">
									{v.name}
								</a>
								<span class="sx-vessel__meta">
									{[
										v.vesselType,
										v.flag ? t(`bandera: ${v.flag}`, `flag: ${v.flag}`) : null,
										v.imo ? `IMO ${v.imo}` : null,
									]
										.filter(Boolean)
										.join(" · ")}
								</span>
							</li>
						))}
					</ul>
				</More>
			) : null}
			{s.aircraftByModel.length ? (
				<div class="sx-aircraft">
					<span class="sx-aircraft__h">
						{t(
							`Aeronaves (${int(s.counts?.aircraft ?? 0, l)}), por modelo:`,
							`Aircraft (${int(s.counts?.aircraft ?? 0, l)}), by model:`,
						)}
					</span>{" "}
					{s.aircraftByModel.map((a, i) => (
						<span key={a.model} class="sx-aircraft__m">
							{i ? " · " : ""}
							{a.model} <span class="mono">×{a.count}</span>
						</span>
					))}
				</div>
			) : null}
		</Section>
	);
}

function Licences({ view }: { view: SanctionsView }) {
	const l = lang.value;
	const g = view.licences;
	const recent = g.list.filter((x) => x.recent);
	const older = g.list.filter((x) => !x.recent);
	const row = (x: SanctionsView["licences"]["list"][number]) => {
		const badge = licenceBadge(x);
		return (
			<li class="sx-gl" key={x.id}>
				<span class="sx-gl__id mono">GL {x.id}</span>
				{badge ? (
					<span class={`sx-tag sx-tag--${badge}`}>
						{badge === "new" ? t("nueva", "new") : t("enmendada", "amended")}
					</span>
				) : null}
				<a class="sx-gl__title" href={x.url} target="_blank" rel="noopener noreferrer">
					{x.title}
				</a>
				<span class="sx-gl__date mono">{dayText(x.issued, l)}</span>
			</li>
		);
	};
	return (
		<Section
			title={t("Licencias generales", "General licences")}
			hint={t(
				`${int(g.list.length, l)} vigentes en la página de OFAC · ${int(g.recentCount, l)} nuevas o enmendadas en 30 días`,
				`${int(g.list.length, l)} on OFAC's page · ${int(g.recentCount, l)} new or amended in 30 days`,
			)}
		>
			{recent.length ? <ul class="sx-rows">{recent.map(row)}</ul> : null}
			{older.length ? (
				<More label={t("Las demás licencias vigentes", "The other licences in force")} n={older.length}>
					<ul class="sx-rows">{older.map(row)}</ul>
				</More>
			) : null}
			{g.removed.length ? (
				<p class="sx-note">
					{t(
						"Ya no aparecen en la página (vencidas o revocadas): ",
						"No longer on the page (expired or revoked): ",
					)}
					<span class="mono">{g.removed.join(", ")}</span>
				</p>
			) : null}
			{g.actions.length ? (
				<>
					<h4 class="sx-h4 caps">{t("Acciones recientes de OFAC", "OFAC recent actions")}</h4>
					<ul class="sx-rows">
						{g.actions.map((a) => (
							<li class="sx-doc" key={a.url}>
								<span class="mono sx-doc__date">{dayText(a.date, l)}</span>
								<a href={a.url} target="_blank" rel="noopener noreferrer">
									{a.title}
								</a>
							</li>
						))}
					</ul>
				</>
			) : null}
		</Section>
	);
}

function Register({ view }: { view: SanctionsView }) {
	const l = lang.value;
	const r = view.register;
	return (
		<Section
			title={t("Registro Federal de EE. UU.", "US Federal Register")}
			hint={t(
				"documentos que nombran a Venezuela o publica OFAC",
				"documents naming Venezuela or published by OFAC",
			)}
		>
			{r.documents.length ? (
				<ul class="sx-rows">
					{r.documents.map((d) => (
						<li class="sx-doc" key={d.number}>
							<span class="mono sx-doc__date">{dayText(d.publicationDate, l)}</span>
							<a href={d.htmlUrl} target="_blank" rel="noopener noreferrer">
								{d.title ?? d.number}
							</a>
							<span class="sx-doc__meta">
								{d.type}
								{d.agencies.length ? ` · ${d.agencies.join(", ")}` : ""}
							</span>
						</li>
					))}
				</ul>
			) : (
				<p class="sx-note">{t("Ningún documento en 12 meses.", "No document in 12 months.")}</p>
			)}
			{r.bodyOnly30d ? (
				<p class="sx-note">
					{t(
						`Y ${int(r.bodyOnly30d, l)} documentos de los últimos 30 días que solo mencionan a Venezuela en su texto (no se listan).`,
						`And ${int(r.bodyOnly30d, l)} documents of the last 30 days that only mention Venezuela in their text (not listed).`,
					)}
				</p>
			) : null}
		</Section>
	);
}

/* ---------- Sanciones ---------- */

export function SanctionsPanel() {
	const l = lang.value;
	const { view, failed, retry } = useOnDemand<SanctionsView>("sanctions");
	const meta = PANEL_META.sanciones;
	const s = view?.sdn;
	const newestDoc = view?.register.documents[0]?.publicationDate;
	return (
		<Panel
			id="sanciones"
			class="panel--sanctions"
			title={meta.title()}
			question={meta.question()}
			feeds={meta.feeds()}
			ready={failed || view !== undefined}
			method={
				view ? (
					<>
						<p>
							{t(
								"Las listas de OFAC (Departamento del Tesoro de EE. UU.) tal como OFAC las publica: las entradas de los programas de Venezuela, contadas por tipo y por programa (una entrada en dos programas cuenta en ambos). Cada alta, baja o cambio sale de los archivos de cambios de OFAC, con su fecha de publicación. Las licencias generales salen de la página de Venezuela de OFAC; «nueva» o «enmendada» si su fecha de emisión cae en los últimos 30 días (una letra de revisión significa enmienda).",
								"OFAC's lists (US Treasury) as OFAC publishes them: the entries on the Venezuela programmes, counted by type and by programme (an entry on two programmes counts in both). Every addition, removal or update comes from OFAC's change files, with its publication date. The general licences come from OFAC's Venezuela page; “new” or “amended” when issued in the last 30 days (a revision letter means an amendment).",
							)}
						</p>
						<p>{view.namingRule}</p>
						<p>
							{t(
								"Registro Federal: documentos que nombran a Venezuela en el título o el resumen, o que publica OFAC. Los que solo la mencionan en el cuerpo se cuentan.",
								"Federal Register: documents naming Venezuela in their title or abstract, or published by OFAC. Those that only mention it in the body are counted.",
							)}
						</p>
					</>
				) : null
			}
		>
			{failed ? <Failed retry={retry} /> : null}
			{view && s ? (
				<div class="sx">
					{s.counts ? (
						<>
							<Figures
								cells={[
									{
										label: t("En las listas", "Listed"),
										value: int(s.counts.total, l),
										note: t("entradas", "entries"),
									},
									{
										label: t("Personas", "Persons"),
										value: int(s.counts.individuals, l),
										note: t(`${int(s.officials.length, l)} nombradas`, `${int(s.officials.length, l)} named`),
									},
									{ label: t("Empresas", "Companies"), value: int(s.counts.entities, l) },
									{ label: t("Buques", "Vessels"), value: int(s.counts.vessels, l) },
									{ label: t("Aeronaves", "Aircraft"), value: int(s.counts.aircraft, l) },
								]}
							/>
							<p class="sx-asof">
								{s.asOf
									? t(
											`Según la publicación N° ${s.asOf.publicationId} de OFAC, ${stamp(s.asOf.observedAt, l, now.value)}.`,
											`As of OFAC publication No. ${s.asOf.publicationId}, ${stamp(s.asOf.observedAt, l, now.value)}.`,
										)
									: null}
								{s.sinceLast && s.sinceLast.totalBefore !== s.sinceLast.totalNow
									? t(
											` Antes (N° ${s.sinceLast.publicationId}): ${int(s.sinceLast.totalBefore, l)}.`,
											` Before (No. ${s.sinceLast.publicationId}): ${int(s.sinceLast.totalBefore, l)}.`,
										)
									: null}
								{s.publicationsBehind > 0 ? (
									<span class="sx-behind">
										{t(
											` OFAC publicó ${s.publicationsBehind} ${s.publicationsBehind === 1 ? "lista nueva" : "listas nuevas"} después; Vigía las está releyendo y estas cifras aún no las incluyen.`,
											` OFAC has published ${s.publicationsBehind} newer ${s.publicationsBehind === 1 ? "list" : "lists"} since; Vigía is re-reading them and these figures do not include them yet.`,
										)}
									</span>
								) : null}
							</p>
						</>
					) : (
						<p class="empty">
							{t("Todavía no se ha leído la lista de OFAC.", "OFAC's list has not been read yet.")}
						</p>
					)}
					<Section
						title={t("Cambios en 12 meses", "Changes in 12 months")}
						hint={t(
							`30 días: ${tallyText(s.tally.days30)} · 12 meses: ${tallyText(s.tally.days365)}`,
							`30 days: ${tallyText(s.tally.days30)} · 12 months: ${tallyText(s.tally.days365)}`,
						)}
					>
						<MonthStrip changes={s.changes} at={view.now} read={s.publicationsRead} />
						{s.changes.length ? (
							<>
								<ChangeList rows={s.changes.slice(0, 8)} />
								{s.changes.length > 8 ? (
									<More label={t("Cambios anteriores", "Earlier changes")} n={s.changes.length - 8}>
										<ChangeList rows={s.changes.slice(8)} />
									</More>
								) : null}
							</>
						) : (
							<p class="sx-note">
								{t(
									`Ningún cambio en los programas de Venezuela en las ${s.publicationsRead} publicaciones de OFAC leídas del último año.`,
									`No change to the Venezuela programmes in the ${s.publicationsRead} OFAC publications read from the last year.`,
								)}
							</p>
						)}
					</Section>
					{s.byProgram.length ? (
						<Section title={t("Por programa", "By programme")}>
							<ul class="sx-prog">
								{s.byProgram.map((p) => (
									<li key={p.program}>
										<span title={p.program}>{programText(p.program)}</span>
										<span class="mono">{int(p.n, l)}</span>
									</li>
								))}
							</ul>
						</Section>
					) : null}
					{s.counts ? <Officials view={view} /> : null}
					{s.counts ? <Listed view={view} /> : null}
					<Licences view={view} />
					<Register view={view} />
					<div class="sources-row">
						{s.asOf ? (
							<SourceTag
								source={{ feed: s.feed, observedAt: s.asOf.observedAt, url: s.sourceUrl }}
								label={t("OFAC, lista SDN", "OFAC, SDN list")}
							/>
						) : null}
						{view.licences.listSince ? (
							<SourceTag
								source={{
									feed: view.licences.feed,
									observedAt: view.licences.listSince,
									url: view.licences.sourceUrl,
								}}
								label={t("OFAC, licencias", "OFAC, licences")}
							/>
						) : null}
						{newestDoc ? (
							<SourceTag
								source={{
									feed: view.register.feed,
									observedAt: dayAt(newestDoc),
									url: view.register.sourceUrl,
								}}
								label={t("Registro Federal", "Federal Register")}
							/>
						) : null}
					</div>
				</div>
			) : null}
		</Panel>
	);
}

/* ---------- Cargos ---------- */

const STATUS: Record<Office["status"], { es: string; en: string }> = {
	current: { es: "vigente", en: "current" },
	ended: { es: "terminado", en: "ended" },
	unknown: { es: "sin fecha", en: "undated" },
};

function OfficeRow({ o }: { o: Office }) {
	const l = lang.value;
	const term = o.latestTerm;
	return (
		<li class={`of-row of-row--${o.status}`}>
			<div class="of-row__office">
				<a href={o.wikidataUrl} target="_blank" rel="noopener noreferrer">
					{o.office.label}
				</a>
				{o.stateName ? <span class="of-row__state">{o.stateName}</span> : null}
			</div>
			<div class="of-row__holder">
				<span class={`of-status of-status--${o.status}`}>{t(STATUS[o.status].es, STATUS[o.status].en)}</span>
				{term ? (
					<a
						class="of-row__person"
						href={`https://www.wikidata.org/wiki/${encodeURIComponent(term.person.qid)}`}
						target="_blank"
						rel="noopener noreferrer"
					>
						{term.person.label}
					</a>
				) : null}
				<span class="of-row__line">{officeLine(o, l)}</span>
			</div>
			{term?.datesInconsistent ? (
				<p class="of-row__warn">
					<svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">
						<path d="M5 .8 9.2 5 5 9.2.8 5Z" />
					</svg>
					{t(
						"Fechas incoherentes: Wikidata da un fin anterior al inicio.",
						"Inconsistent dates: Wikidata gives an end before the start.",
					)}
				</p>
			) : null}
			{o.undatedTerms ? (
				<p class="of-row__undated">
					{t(
						`${o.undatedTerms} de ${o.termsRecorded} períodos registrados no tienen fecha y no se usan.`,
						`${o.undatedTerms} of ${o.termsRecorded} recorded terms have no date and are not used.`,
					)}
				</p>
			) : null}
		</li>
	);
}

export function OfficialsPanel() {
	const l = lang.value;
	const { view, failed, retry } = useOnDemand<OfficialsView>("officials");
	const meta = PANEL_META.cargos;
	return (
		<Panel
			id="cargos"
			class="panel--offices"
			title={meta.title()}
			question={meta.question()}
			feeds={meta.feeds()}
			ready={failed || view !== undefined}
			method={
				view ? (
					<>
						<p>{view.rule}</p>
						<p>
							{t(
								"Wikidata es una base de datos abierta que cualquiera puede editar: sus datos sobre Venezuela son escasos y pueden estar atrasados o equivocados. Un cargo «terminado sin sucesor registrado» no significa que esté vacío: significa que nadie ha registrado al siguiente. Los nombramientos oficiales salen en la Gaceta Oficial (módulo Oficial).",
								"Wikidata is an open database anyone can edit: its data on Venezuela is thin and may be late or wrong. An office “ended with no successor recorded” is not vacant: nobody has recorded the next holder. Official appointments are published in the Official Gazette (Official module).",
							)}
						</p>
					</>
				) : null
			}
		>
			{failed ? <Failed retry={retry} /> : null}
			{view ? (
				<div class="of">
					<Figures
						cells={[
							{ label: t("Con titular", "With a holder"), value: int(view.counts.current, l) },
							{
								label: t("Terminados", "Ended"),
								value: int(view.counts.ended, l),
								note: t("sin sucesor registrado", "no successor recorded"),
							},
							{ label: t("Sin fecha", "Undated"), value: int(view.counts.unknown, l) },
						]}
					/>
					<p class="of-label">
						{t("Según Wikidata (editable por cualquiera)", "Per Wikidata (anyone can edit it)")}
						{view.readAt ? (
							<span class="mono">
								{" "}
								· {t("leído", "read")} {ago(now.value - view.readAt, l)}
							</span>
						) : null}
						{view.stale ? <span class="of-stale">{t("desactualizado", "out of date")}</span> : null}
					</p>
					{view.offices.length ? (
						groupOffices(view.offices).map((g) => (
							<section class="of-group" key={g.kind}>
								<h3 class="sx-h">
									<span class="caps">{t(KIND_LABEL[g.kind].es, KIND_LABEL[g.kind].en)}</span>
									<span class="sx-h__hint mono">{g.offices.length}</span>
								</h3>
								<ul class="sx-rows">
									{g.offices.map((o) => (
										<OfficeRow key={o.office.qid} o={o} />
									))}
								</ul>
							</section>
						))
					) : (
						<p class="empty">{t("Todavía no se ha leído Wikidata.", "Wikidata has not been read yet.")}</p>
					)}
					<div class="sources-row">
						{view.readAt ? (
							<SourceTag
								source={{ feed: view.feed, observedAt: view.readAt, url: "https://www.wikidata.org/" }}
								label={t("Wikidata (CC0)", "Wikidata (CC0)")}
							/>
						) : null}
					</div>
				</div>
			) : null}
		</Panel>
	);
}

registerSummary("sanciones", () => {
	const v = panels.value.sanctions as
		| { sdn: { counts: { total: number } | null; tally: { days30: { add: number; remove: number } } } }
		| undefined;
	if (!v?.sdn.counts) return null;
	const l = lang.value;
	const d = v.sdn.tally.days30;
	return {
		text: t(
			`${int(v.sdn.counts.total, l)} en los programas de Venezuela de OFAC${d.add || d.remove ? ` · en 30 días: ${d.add} altas, ${d.remove} bajas` : ""}`,
			`${int(v.sdn.counts.total, l)} on OFAC's Venezuela programmes${d.add || d.remove ? ` · in 30 days: ${d.add} added, ${d.remove} removed` : ""}`,
		),
		tone: "normal",
	};
});
registerSummary("cargos", () => {
	const v = panels.value.officials as { counts: { current: number; ended: number } } | undefined;
	if (!v) return null;
	return {
		text: t(
			`Según Wikidata: ${v.counts.current} cargos con titular, ${v.counts.ended} terminados sin sucesor registrado`,
			`Per Wikidata: ${v.counts.current} offices with a holder, ${v.counts.ended} ended with no successor recorded`,
		),
		tone: "normal",
	};
});
