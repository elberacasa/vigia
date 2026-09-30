import { type ComponentChildren, createContext } from "preact";
import { useContext, useId, useState } from "preact/hooks";
import { addStyles } from "../../lib/css.ts";
import { healthById, tick } from "../../lib/data.ts";
import type {
	EntityFact,
	EntityItem,
	EntityModel,
	EntityRef,
	EntitySection,
	NearbyModel,
} from "../../lib/entity.ts";
import { safeUrl } from "../../lib/entity-api.ts";
import { type KeyFact, liveValue } from "../../lib/entity-signals.ts";
import { TYPE_WORD } from "../../lib/entity-words.ts";
import { ago, clock, int, num, stamp, TZ } from "../../lib/format.ts";
import { groupFreshness } from "../../lib/fresh.ts";
import { lang, t } from "../../lib/i18n.ts";
import { openIncident } from "../../lib/keys.ts";
import { later } from "../../lib/lazy.tsx";
import { MODULE_BY_ID, type ModuleId } from "../../lib/modules.ts";
import { PANEL_META } from "../../lib/panel-meta.ts";
import { entityLink, moduleLink } from "../../lib/router.ts";
import { AnomalyList } from "../Anomalies.tsx";
import { ReportButton } from "../crowd/Entry.tsx";
import { openSource } from "../Source.tsx";
import entityCss from "./entity.css?inline";

addStyles(entityCss);

/**
 * One entity (a place, a facility, a network, an institution, an outlet) drawn from its view model (lib/entity.ts).
 * The inspector variant is a narrow column; the page variant (/lugar/…, /infra/…, /red/…, /institucion/…,
 * /medio/…) spreads the same parts over the canvas with the map, the timeline and the neighbourhood. Every figure
 * keeps its source, its age, its basis and its stale mark; Vigía's own computations say so with their method.
 */

/** A camera's card (its state, picture and player), from the cameras view: loaded with the first camera shown. */
const CameraBlock = later(() => import("../../panels/Cameras.tsx").then((m) => m.CameraBlock));

/** "Lo inusual ahora" about this entity (or its state, said by the item's own name): the anomaly engine's list. */
function Unusual({ m }: { m: EntityModel }) {
	const items = m.anomalies ?? [];
	if (!items.length) return null;
	return (
		<section class="esec esec--unusual" aria-labelledby="esec-unusual">
			<header class="esec__head">
				<H id="esec-unusual">{t("Lo inusual ahora", "Unusual now")}</H>
				<span class="esec__count mono">{items.length}</span>
			</header>
			<AnomalyList items={items} self={m.ref.id} />
			<p class="esec__note">
				{t(
					"Lecturas raras frente a su propia historia, calculadas por Vigía con reglas fijas: dicen que una cifra se sale de lo habitual, no por qué ni si es grave.",
					"Readings rare against their own history, computed by Vigía by fixed rules: they say a figure breaks from the usual, not why or whether it is serious.",
				)}
			</p>
		</section>
	);
}

/** Section headings sit under the entity's name: h2 on a page (under its h1), h3 in the inspector (under its h2). */
const Level = createContext<2 | 3>(3);
function H({ id, children }: { id: string; children: ComponentChildren }) {
	return useContext(Level) === 2 ? (
		<h2 class="esec__title" id={id}>
			{children}
		</h2>
	) : (
		<h3 class="esec__title" id={id}>
			{children}
		</h3>
	);
}

/** The clock for ages: the 15 s tick, so an entity view is not re-rendered every second. */
function clockNow(): number {
	return tick.value;
}

const BASIS: Record<string, { es: string; en: string }> = {
	measured: { es: "medido", en: "measured" },
	name: { es: "por su nombre", en: "by name" },
	forecast: { es: "pronóstico", en: "forecast" },
	keyword: { es: "palabra clave", en: "keyword" },
	reported: { es: "reportado", en: "reported" },
	official: { es: "oficial", en: "official" },
	derived: { es: "derivado", en: "derived" },
	quote: { es: "cotización", en: "quote" },
	status: { es: "estado del feed", en: "feed status" },
};

const dayKey = new Intl.DateTimeFormat("en-CA", {
	timeZone: TZ,
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});
const dayMonth = {
	es: new Intl.DateTimeFormat("es", { timeZone: TZ, day: "numeric", month: "short" }),
	en: new Intl.DateTimeFormat("en", { timeZone: TZ, day: "numeric", month: "short" }),
};

const yearOf = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric" });

/** "14:05" today, "24 sept" before, "11 abr 2025" in another year (the full time is in the row's title). */
function when(at: number): string {
	const l = lang.value;
	const n = clockNow();
	if (dayKey.format(at) === dayKey.format(n)) return clock(at, l);
	const day = dayMonth[l].format(at).replace(".", "");
	return yearOf.format(at) === yearOf.format(n) ? day : `${day} ${yearOf.format(at)}`;
}

export function Tone({ tone }: { tone: EntityFact["tone"] }) {
	return <span class={`tone-mark tone-mark--${tone}`} aria-hidden="true" />;
}

/** A link to another entity's page (plain text when it has none). */
export function EntityLinkTo({ r, class: cls }: { r: EntityRef; class?: string }) {
	return r.path ? (
		<a class={cls} {...entityLink(r.id)}>
			{r.name}
		</a>
	) : (
		<span class={cls}>{r.name}</span>
	);
}

/** "calculado por Vigía", opening its method in place (never a tooltip only: phones have no hover). */
export function Computed({ method }: { method: string | undefined }) {
	return method ? (
		<details class="computed">
			<summary>{t("calculado por Vigía", "computed by Vigía")}</summary>
			<p>{method}</p>
		</details>
	) : (
		<span class="computed computed--plain">{t("calculado por Vigía", "computed by Vigía")}</span>
	);
}

/** "6 h", "12 min", "ahora": an age in a column headed "Edad". */
function shortAge(ms: number, l: "es" | "en"): string {
	return ago(ms, l)
		.replace(/^hace /, "")
		.replace(/ ago$/, "");
}

/** The time a figure is true for, or when Vigía read it (a count over linked rows has only that); never "now". */
function ageOf(f: EntityFact, n: number): { text: string; read: boolean; at: number | null } {
	const l = lang.value;
	const p = f.prov;
	const feed = p.feeds.length === 1 ? p.feeds[0] : undefined;
	if (p.observedAt !== null && p.observedAt <= n)
		return { text: shortAge(n - p.observedAt, l), read: false, at: p.observedAt };
	const read = p.fetchedAt ?? (feed ? (healthById.value.get(feed)?.lastSuccessAt ?? null) : null);
	if (read !== null && read <= n) return { text: shortAge(n - read, l), read: true, at: read };
	return { text: t("sin hora", "no time"), read: false, at: null };
}

/** The source's short name; one feed opens its sheet (licence, health), several are said in words. */
function SourceButton({ f }: { f: EntityFact }) {
	const p = f.prov;
	const feed = p.feeds.length === 1 ? p.feeds[0] : undefined;
	const short = f.sourceShort ?? p.source;
	return feed ? (
		<button
			type="button"
			class="sig__srcbtn"
			title={`${p.source}. ${t("Ver la fuente, su licencia y su estado", "See the source, its licence and its health")}`}
			onClick={() => {
				openSource.value = { feed, observedAt: p.observedAt, ...(p.url ? { url: p.url } : {}) };
			}}
		>
			{short}
		</button>
	) : (
		<span class="sig__srcname" title={p.source}>
			{short}
		</span>
	);
}

/**
 * One signal as a table row: name (whose, when an ancestor's; one line of context), value, against its normal,
 * basis ("medido", "pronóstico"…, and "calculado" for Vigía's own counts), source, age and "desactualizado". The
 * name opens the row: the server's sentence, every part behind the value, the times, the method and the link.
 */
function SignalRow({ f, cols, idx }: { f: EntityFact; cols: number; idx: number }) {
	const l = lang.value;
	const [open, setOpen] = useState(false);
	const n = clockNow();
	const age = ageOf(f, n);
	const id = `sig-${idx}-${f.key.replace(/[^\w-]/g, "_")}`;
	const p = f.prov;
	return (
		<tbody role="rowgroup" class={`sig sig--${f.tone}${f.stale ? " is-stale" : ""}${open ? " is-open" : ""}`}>
			<tr role="row">
				<th scope="row" role="rowheader" class="sig__name">
					<button
						type="button"
						class="sig__open"
						aria-expanded={open}
						aria-controls={id}
						onClick={() => setOpen(!open)}
					>
						<svg class="sig__chev" viewBox="0 0 8 8" width="8" height="8" aria-hidden="true">
							<path d="M2.5 1.5 5.5 4l-3 2.5" />
						</svg>
						<span class="sig__title">{f.name ?? f.label}</span>
					</button>
					{f.scopeName ? (
						<span class="sig__scope">
							{t(`dato ${f.scopeOf ?? f.scopeName}`, `figure ${f.scopeOf ?? f.scopeName}`)}
						</span>
					) : null}
					{f.context ? <span class="sig__ctx">{f.context}</span> : null}
				</th>
				<td role="cell" class={`sig__value${f.textValue ? " sig__value--text" : ""}`}>
					<Tone tone={f.tone} />
					<span class="data">{f.value}</span>
					{f.unit ? <span class="sig__unit">{f.unit}</span> : null}
				</td>
				{cols === 6 ? (
					<td class={`sig__vs mono${f.vs ? "" : " sig__vs--none"}`} role="cell">
						{f.vs ?? (
							<>
								<span aria-hidden="true">—</span>
								<span class="sr-only">{t("sin comparación", "no comparison")}</span>
							</>
						)}
					</td>
				) : null}
				<td role="cell" class="sig__basis">
					<span class="sig__chip">{BASIS[p.basis]?.[l] ?? p.basis}</span>
					{f.computed ? <span class="sig__chip sig__chip--calc">{t("calculado", "computed")}</span> : null}
				</td>
				<td role="cell" class="sig__src">
					<SourceButton f={f} />
				</td>
				<td role="cell" class="sig__age">
					<span class="mono" title={age.at !== null ? stamp(age.at, l) : undefined}>
						{age.read ? t(`leído ${age.text}`, `read ${age.text}`) : age.text}
					</span>
					{f.stale ? <span class="prov__stale">{t("desactualizado", "out of date")}</span> : null}
				</td>
			</tr>
			{open ? (
				<tr role="row" class="sig__more">
					<td role="cell" colSpan={cols} id={id}>
						<p class="sig__full">
							<strong>{f.label}</strong>
							{f.text && f.text !== `${f.label}: ${f.value}` ? `: ${f.text}` : ""}
						</p>
						{f.detail && f.detail !== f.text ? <p>{f.detail}</p> : null}
						{f.breakdown ? <p>{f.breakdown}</p> : null}
						{f.inherited ? (
							<p>
								{t(
									`Esta cifra es la ${f.scopeOf ?? ""}, no la de este lugar: la fuente no la mide más fino.`,
									`This is the figure ${f.scopeOf ?? ""}, not this place's: the source does not measure it any finer.`,
								)}
							</p>
						) : null}
						<dl class="sig__times">
							<div>
								<dt>{t("Fuente", "Source")}</dt>
								<dd>
									{p.source}
									{p.url ? (
										<>
											{" · "}
											<a class="sig__link" href={p.url} target="_blank" rel="noopener noreferrer">
												{f.computed
													? t("el dato más reciente en su fuente", "the newest item at its source")
													: t("ver en la fuente", "see at the source")}{" "}
												<span aria-hidden="true">↗</span>
											</a>
										</>
									) : null}
								</dd>
							</div>
							<div>
								<dt>{t("Dato de", "Datum of")}</dt>
								<dd class="mono">
									{p.observedAt !== null
										? stamp(p.observedAt, l)
										: t("la fuente no da hora", "the source gives no time")}
								</dd>
							</div>
							{p.fetchedAt ? (
								<div>
									<dt>{t("Leído", "Read")}</dt>
									<dd class="mono">{stamp(p.fetchedAt, l)}</dd>
								</div>
							) : null}
							<div>
								<dt>{t("Base", "Basis")}</dt>
								<dd>{BASIS_LONG[p.basis]?.[l] ?? BASIS[p.basis]?.[l] ?? p.basis}</dd>
							</div>
						</dl>
						{f.stale ? (
							<p class="sig__stale">
								{t(
									"Desactualizado: la fuente pasó su plazo de frescura; se muestra su último dato bueno con su hora, nunca como actual.",
									"Out of date: the source missed its freshness budget; its last good datum is shown with its time, never as current.",
								)}
							</p>
						) : null}
						{f.computed ? <Computed method={f.method} /> : null}
					</td>
				</tr>
			) : null}
		</tbody>
	);
}

/** What each basis means, when a row opens. */
const BASIS_LONG: Record<string, { es: string; en: string }> = {
	measured: {
		es: "medido por un instrumento o una red de sensores",
		en: "measured by an instrument or a sensor network",
	},
	forecast: { es: "pronóstico de un modelo, no una medición", en: "a model's forecast, not a measurement" },
	keyword: {
		es: "ubicado por palabra clave en el texto; puede equivocarse",
		en: "placed by a keyword in the text; can be wrong",
	},
	name: { es: "vinculado por su nombre en el título", en: "linked by its name in the title" },
	reported: {
		es: "reportado (prensa, directorios o usuarios), no medido",
		en: "reported (press, directories or users), not measured",
	},
	official: {
		es: "cifra oficial, como la publica su emisor",
		en: "official figure, as its issuer publishes it",
	},
	derived: { es: "derivado por Vigía de cifras publicadas", en: "derived by Vigía from published figures" },
	quote: { es: "cotización o lectura de un tercero", en: "a third party's quote or reading" },
	status: {
		es: "juicio de Vigía sobre si el feed está al día, no una cifra del emisor",
		en: "Vigía's judgement of whether the feed is current, not the publisher's figure",
	},
};

/**
 * The signals table: one row per live signal, dense and aligned; the ones with nothing to say now fold into one
 * line ("Sin datos ahora: Internet, sin datos suficientes · Luz nocturna, nublado") that opens them. The "frente a lo
 * normal" column only when a row has a comparison to show.
 */
function SignalTable({
	facts,
	title,
	id,
	more,
	legend = false,
}: {
	facts: readonly EntityFact[];
	title: string;
	id: string;
	more?: ComponentChildren;
	/** The line that explains the columns: under the entity's own table only, not under every list's. */
	legend?: boolean;
}) {
	const [showSilent, setShowSilent] = useState(false);
	const silent = facts.filter((f) => f.silent);
	const rows = showSilent ? facts : facts.filter((f) => !f.silent);
	const cols = facts.some((f) => f.vs) ? 6 : 5;
	const anyComputed = rows.some((f) => f.computed);
	return (
		<div class="sigs">
			<header class="esec__head">
				<H id={id}>{title}</H>
				<span class="esec__count mono">{facts.length}</span>
				{more}
			</header>
			{rows.length ? (
				// Explicit roles: the narrow layout changes the cells' display, which some screen readers take as "not a table".
				<table role="table" class={`sigt sigt--${cols}`}>
					<thead role="rowgroup">
						<tr role="row">
							<th scope="col" role="columnheader">
								{t("Señal", "Signal")}
							</th>
							<th scope="col" role="columnheader" class="sigt__num">
								{t("Valor", "Value")}
							</th>
							{cols === 6 ? (
								<th scope="col" role="columnheader">
									{t("Frente a lo normal", "Vs. normal")}
								</th>
							) : null}
							<th scope="col" role="columnheader">
								{t("Base", "Basis")}
							</th>
							<th scope="col" role="columnheader">
								{t("Fuente", "Source")}
							</th>
							<th scope="col" role="columnheader">
								{t("Edad", "Age")}
							</th>
						</tr>
					</thead>
					{rows.map((f, i) => (
						<SignalRow key={f.key} f={f} cols={cols} idx={i} />
					))}
				</table>
			) : null}
			{silent.length && showSilent ? (
				<p class="sigs__silent">
					<button type="button" class="link-button" onClick={() => setShowSilent(false)}>
						{t("ocultar las señales sin datos", "hide the signals without data")}
					</button>
				</p>
			) : null}
			{silent.length && !showSilent ? (
				<p class="sigs__silent">
					<span class="sigs__silent-head">{t("Sin datos ahora", "No data now")}:</span>{" "}
					{silent.map((f, i) => (
						<span key={f.key}>
							{i ? " · " : ""}
							{f.name ?? f.label}
							{f.scopeName ? ` (${f.scopeName})` : ""} <span class="sigs__why">{f.silent}</span>
							{f.stale ? <span class="sigs__stale"> ({t("desactualizado", "out of date")})</span> : null}
						</span>
					))}{" "}
					<button type="button" class="link-button" onClick={() => setShowSilent(true)}>
						{t("mostrar", "show")}
					</button>
				</p>
			) : null}
			{legend ? (
				<p class="esec__note sigs__legend">
					{t(
						"Toca una señal para ver la frase completa, sus horas y su fuente. «Base» dice cómo se obtuvo la cifra",
						"Press a signal for the full sentence, its times and its source. “Basis” says how the figure was obtained",
					)}
					{anyComputed
						? t(
								"; «calculado»: Vigía la cuenta o la compara a partir de la fuente, con su método en la fila.",
								"; “computed”: Vigía counts or compares it from the source, with its method in the row.",
							)
						: "."}
				</p>
			) : null}
		</div>
	);
}

/**
 * The header strip's key facts: a place's people (census and WorldPop side by side, never one number), area,
 * capital; a facility's capacity and operator; open incidents and unusual readings. Each says whose it is under
 * the figure; a press on that source opens the whole provenance under the strip.
 */
function KeyStrip({ facts, signals }: { facts: readonly KeyFact[]; signals: readonly EntityFact[] }) {
	const l = lang.value;
	const [open, setOpen] = useState<string | null>(null);
	const shown = facts.find((k) => k.key === open) ?? null;
	const noteId = useId();
	const health = healthById.value;
	// A live count is only an answer when its inputs are current: the incidents panel's feeds, the entity's signals.
	const staleOf = (k: KeyFact): boolean =>
		k.live === "incidents"
			? groupFreshness(PANEL_META.incidentes.feeds(), health).stale
			: k.live === "unusual"
				? // The engine says how many series it judged (review M10: a Wikidata row, never judged, vouched for a
					// "0"); a server without that count falls back to "a current reading with a time of its own".
					k.judged !== undefined
					? k.judged === 0
					: !signals.some((f) => !f.stale && f.prov.observedAt !== null)
				: false;
	return (
		<div class="keys">
			<dl class="keys__row">
				{facts.map((k) => {
					const live = liveValue(k, staleOf(k), l);
					return (
						<div key={k.key} class={`key key--${k.key}${live.stale ? " is-stale" : ""}`}>
							<dt class="key__label">{k.label}</dt>
							<dd class="key__value">
								{k.entity ? (
									<a class="key__link" {...entityLink(k.entity)}>
										{k.value}
									</a>
								) : k.url && safeUrl(k.url) ? (
									<a class="key__link" href={safeUrl(k.url)} target="_blank" rel="noopener noreferrer">
										{k.value}
									</a>
								) : k.jump && live.value !== "—" ? (
									<button
										type="button"
										class="key__jump"
										aria-label={t(
											`${k.label}: ${live.value}. Ir a la lista`,
											`${k.label}: ${live.value}. Go to the list`,
										)}
										onClick={() => {
											const el = k.jump ? document.getElementById(k.jump) : null;
											if (!el) return;
											el.scrollIntoView({ block: "start" });
											if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
											el.focus({ preventScroll: true });
										}}
									>
										{live.value}
									</button>
								) : (
									<span class="data">{live.value}</span>
								)}
								{k.unit ? <span class="key__unit">{k.unit}</span> : null}
								{live.stale && live.value !== "—" ? (
									<span class="prov__stale">{t("desactualizado", "out of date")}</span>
								) : null}
							</dd>
							<dd class="key__src">
								<button
									type="button"
									aria-expanded={open === k.key}
									aria-controls={noteId}
									title={k.note}
									onClick={() => {
										setOpen(open === k.key ? null : k.key);
										// On a phone the note sits under the strip: bring it into view.
										requestAnimationFrame(() =>
											document.getElementById(noteId)?.scrollIntoView({ block: "nearest" }),
										);
									}}
								>
									{live.source}
									{k.computed ? <span class="key__calc">{t(" · calculado", " · computed")}</span> : null}
								</button>
							</dd>
						</div>
					);
				})}
			</dl>
			<p class="keys__note" id={noteId} hidden={!shown}>
				{shown ? (
					<>
						<strong>{shown.label}.</strong> {shown.note}
						{staleOf(shown)
							? t(
									" Sus datos no están al día: no se da una cifra que parezca actual.",
									" Its inputs are not current: no figure is given that would look current.",
								)
							: ""}
					</>
				) : null}
			</p>
		</div>
	);
}

function Estimate({ e }: { e: NonNullable<EntityItem["estimate"]> }) {
	return (
		<details class="estimate">
			<summary>
				<span class="estimate__label">{e.label}</span> <span class="estimate__value data">≈ {e.value}</span>{" "}
				<span class="estimate__tag">
					{t("estimación · calculado por Vigía", "estimate · computed by Vigía")}
				</span>
			</summary>
			<p>{e.caveat}</p>
			<p class="estimate__src">
				{e.source}. {e.note} {e.method}
			</p>
		</details>
	);
}

function Item({ it }: { it: EntityItem }) {
	const title = it.url ? (
		<a class="item__title" href={safeUrl(it.url)} target="_blank" rel="noopener noreferrer">
			{it.title}
		</a>
	) : it.incident ? (
		<button
			type="button"
			class="item__title item__title--button"
			onClick={() => openIncident(it.incident ?? "")}
			title={t("Abrirlo en el panel de incidentes de la sala", "Open it in the room's incidents panel")}
		>
			{it.title}
		</button>
	) : it.entity ? (
		<EntityLinkTo r={it.entity} class="item__title" />
	) : (
		<span class="item__title">{it.title}</span>
	);
	return (
		<li class={`item${it.tone ? ` item--${it.tone}` : ""}`}>
			{it.at ? (
				<time
					class="item__time mono"
					dateTime={new Date(it.at).toISOString()}
					title={stamp(it.at, lang.value)}
				>
					{when(it.at)}
				</time>
			) : (
				<span class="item__time" />
			)}
			<span class="item__body">
				{title}
				<span class="item__meta">
					{it.unverified ? <span class="unverified">{t("sin verificar", "unverified")}</span> : null}
					{it.keyword ? <span class="keyword">{t("palabra clave", "keyword")}</span> : null}
					{it.meta}
				</span>
				{it.estimate ? <Estimate e={it.estimate} /> : null}
			</span>
		</li>
	);
}

function Section({ s, limit }: { s: EntitySection; limit?: number }) {
	const mod = s.module ? MODULE_BY_ID.get(s.module as ModuleId) : undefined;
	const [all, setAll] = useState(false);
	const items = limit && !all ? s.items.slice(0, limit) : s.items;
	const n = clockNow();
	const age = s.prov?.observedAt ? ago(n - s.prov.observedAt, lang.value) : null;
	// A section built from a panel says when its feed is behind, like any figure (an absence from an old list too).
	const stale = s.prov ? groupFreshness(s.prov.feeds, healthById.value).stale : false;
	const empty = !items.length && !s.facts.length;
	const more =
		mod && mod.id !== "situacion" ? (
			<a class="esec__more" {...moduleLink(mod.id)}>
				{t(`Módulo ${mod.es}`, `${mod.en} module`)} <span aria-hidden="true">→</span>
			</a>
		) : null;
	// Nothing to list: one line (its title and what the absence means), never a tall empty block.
	if (empty)
		return (
			<section class={`esec esec--${s.key} esec--empty`} aria-labelledby={`esec-${s.key}`}>
				<header class="esec__head">
					<H id={`esec-${s.key}`}>{s.title}</H>
					<span class="esec__empty">{s.empty ?? t("nada vinculado ahora", "nothing linked now")}</span>
					{more}
				</header>
			</section>
		);
	return (
		<section class={`esec esec--${s.key}`} aria-labelledby={`esec-${s.key}`}>
			{s.facts.length ? (
				<SignalTable facts={s.facts} title={s.title} id={`esec-${s.key}`} more={more} />
			) : (
				<header class="esec__head">
					<H id={`esec-${s.key}`}>{s.title}</H>
					{s.items.length ? <span class="esec__count mono">{s.items.length}</span> : null}
					{more}
				</header>
			)}
			{items.length ? (
				<ol class="items">
					{items.map((it) => (
						<Item key={it.id} it={it} />
					))}
				</ol>
			) : null}
			{limit && s.items.length > limit && !all ? (
				<button type="button" class="link-button esec__all" onClick={() => setAll(true)}>
					{t(`Ver los ${s.items.length}`, `Show all ${s.items.length}`)}
				</button>
			) : null}
			{s.prov ? (
				<p class="esec__prov">
					{s.prov.source}
					{age ? ` · ${t("leído", "read")} ${age}` : ""}
					{stale ? <span class="prov__stale">{t("desactualizado", "out of date")}</span> : null}
				</p>
			) : null}
			{s.note ? <p class="esec__note">{s.note}</p> : null}
		</section>
	);
}

function Nearby({ n, limit }: { n: NearbyModel; limit?: number }) {
	const l = lang.value;
	const [all, setAll] = useState(false);
	const items = limit && !all ? n.items.slice(0, limit) : n.items;
	const total = n.byKind.reduce((a, b) => a + b.n, 0);
	return (
		<section class="esec" aria-labelledby="esec-nearby">
			<header class="esec__head">
				<H id="esec-nearby">{t("Instalaciones", "Facilities")}</H>
				<span class="esec__count mono">{int(total, l)}</span>
			</header>
			<p class="esec__note esec__note--top">{n.rule}</p>
			{n.byKind.length ? (
				<ul class="kinds">
					{n.byKind.map((k) => (
						<li key={k.kind}>
							<span>{k.label}</span> <span class="mono">{int(k.n, l)}</span>
						</li>
					))}
				</ul>
			) : null}
			{items.length ? (
				<ol class="near">
					{items.map((x) => (
						<li key={x.ref.id}>
							<EntityLinkTo r={x.ref} />
							<span class="near__kind">{x.ref.sub}</span>
							<span class="near__km mono">{x.inside ? t("dentro", "inside") : `${num(x.km, 1, l)} km`}</span>
						</li>
					))}
				</ol>
			) : null}
			{items.length < n.items.length ? (
				<button type="button" class="link-button esec__all" onClick={() => setAll(true)}>
					{t(`Ver las ${n.items.length}`, `Show all ${n.items.length}`)}
				</button>
			) : null}
			{n.truncated || (limit && n.items.length > limit) ? (
				<p class="esec__note">
					{t(
						n.nearest
							? `Se listan las ${items.length} más cercanas de ${int(total, l)}; las cifras por tipo cuentan todas.`
							: `Se listan ${items.length} de ${int(total, l)}, por tipo; las cifras por tipo cuentan todas.`,
						n.nearest
							? `The ${items.length} nearest of ${int(total, l)} listed; the counts by kind include all.`
							: `${items.length} of ${int(total, l)} listed, by kind; the counts by kind include all.`,
					)}
				</p>
			) : null}
		</section>
	);
}

function Children({ groups, limit }: { groups: NonNullable<EntityModel["childGroups"]>; limit?: number }) {
	const l = lang.value;
	return (
		<>
			{groups.map((g) => {
				const shown = (limit ? g.items.slice(0, limit) : g.items)
					.slice()
					.sort((a, b) => a.name.localeCompare(b.name, "es"));
				return (
					<section class="esec" key={g.key} aria-labelledby={`esec-children-${g.key}`}>
						<header class="esec__head">
							<H id={`esec-children-${g.key}`}>{g.label}</H>
							<span class="esec__count mono">{int(g.total, l)}</span>
						</header>
						<ul class="children">
							{shown.map((c) => (
								<li key={c.id}>
									<EntityLinkTo r={c} />
								</li>
							))}
						</ul>
						{shown.length < g.total ? (
							<p class="esec__note">
								{t(
									`${int(shown.length, l)} de ${int(g.total, l)}; el resto en la búsqueda (/).`,
									`${int(shown.length, l)} of ${int(g.total, l)}; the rest through search (/).`,
								)}
							</p>
						) : null}
					</section>
				);
			})}
		</>
	);
}

function Details({ m, only }: { m: EntityModel; only?: "relations" }) {
	const l = lang.value;
	// What the header strip already shows is not repeated in the record.
	const inStrip = new Set((m.keyFacts ?? []).map((k) => k.key));
	const attrs = only ? [] : (m.attributes ?? []).filter((a) => !a.key || !inStrip.has(a.key));
	const rels = m.relations ?? [];
	const codes = only ? [] : (m.codes ?? []);
	const point = only ? null : (m.point ?? null);
	if (!attrs.length && !rels.length && !codes.length && !point) return null;
	return (
		<section class="esec" aria-labelledby={`esec-details-${only ?? "all"}`}>
			<header class="esec__head">
				<H id={`esec-details-${only ?? "all"}`}>
					{only ? t("Relaciones", "Relations") : t("Registro", "Record")}
				</H>
			</header>
			<dl class="details">
				{rels.map((r) => (
					<div key={`${r.label}:${r.ref.id}`} class="details__row">
						<dt>{r.label}</dt>
						<dd>
							<EntityLinkTo r={r.ref} />
						</dd>
					</div>
				))}
				{attrs.map((a) => (
					<div key={a.label} class="details__row">
						<dt>{a.label}</dt>
						<dd>{a.value}</dd>
					</div>
				))}
				{codes.map((c) => (
					<div key={c.label} class="details__row">
						<dt>{c.label}</dt>
						<dd class="mono">
							{c.url ? (
								<a href={safeUrl(c.url)} target="_blank" rel="noopener noreferrer">
									{c.value}
								</a>
							) : (
								c.value
							)}
						</dd>
					</div>
				))}
				{point ? (
					<div class="details__row">
						<dt>{t("Punto", "Point")}</dt>
						<dd class="mono">
							{num(point.lat, 4, l)}, {num(point.lon, 4, l)}
						</dd>
					</div>
				) : null}
			</dl>
		</section>
	);
}

function Dataset({ m }: { m: EntityModel }) {
	const d = m.dataset;
	if (!d) return null;
	return (
		<p class="dataset">
			{t("Entidad", "Entity")}:{" "}
			<a href={safeUrl(d.url)} target="_blank" rel="noopener noreferrer">
				{d.name}
			</a>{" "}
			·{" "}
			<a href={safeUrl(d.licenceUrl)} target="_blank" rel="noopener noreferrer">
				{d.licence}
			</a>{" "}
			· {d.attribution} · {t("datos del", "data of")} {d.retrieved}
		</p>
	);
}

/** Where the model came from, when it is not the server's current answer: said, with its age. */
function Origin({
	m,
	offline,
	savedAt,
	pending,
	serverError,
}: {
	m: EntityModel;
	offline: boolean;
	savedAt: number | null;
	pending: boolean;
	serverError: boolean;
}) {
	const l = lang.value;
	if (m.origin === "panels")
		return (
			<p class="entity__origin" role="status">
				{t(
					"Sin la vista enlazada del servidor: ficha armada en este dispositivo con los paneles cargados (sin parroquias, instalaciones ni cronología).",
					"Without the server's linked view: page built on this device from the loaded panels (no parishes, facilities or timeline).",
				)}
			</p>
		);
	if (!offline || savedAt === null) return null;
	const age = ago(clockNow() - savedAt, l);
	return (
		<p class="entity__origin" role="status">
			{pending
				? t(
						`Copia guardada en este dispositivo ${age}; pidiendo la vista actual al servidor…`,
						`Copy saved on this device ${age}; asking the server for the current view…`,
					)
				: serverError
					? t(
							`El servidor no respondió: copia guardada en este dispositivo ${age}.`,
							`The server did not answer: copy saved on this device ${age}.`,
						)
					: t(
							`Sin conexión: copia guardada en este dispositivo ${age}.`,
							`Offline: copy saved on this device ${age}.`,
						)}{" "}
			{t(
				"Si tiene más de 5 minutos, cada cifra se muestra desactualizada.",
				"Older than 5 minutes, every figure shows as out of date.",
			)}
		</p>
	);
}

export function EntityView({
	model,
	variant,
	onClose,
	aside,
	actions,
	timeline,
	offline = false,
	savedAt = null,
	pending = false,
	serverError = false,
	crumbs,
}: {
	model: EntityModel;
	variant: "inspector" | "page";
	/** The page's breadcrumb, drawn at the top of the header. */
	crumbs?: ComponentChildren;
	onClose?: () => void;
	/** The page's side column top (its map). */
	aside?: ComponentChildren;
	/** Extra buttons in the header (the page's "Ver en la sala"). */
	actions?: ComponentChildren;
	/** The page's timeline. */
	timeline?: ComponentChildren;
	offline?: boolean;
	savedAt?: number | null;
	pending?: boolean;
	serverError?: boolean;
}) {
	const l = lang.value;
	const r = model.ref;
	const asOf = model.asOf !== null ? ago(clockNow() - model.asOf, l) : null;
	const inspector = variant === "inspector";
	const within = (model.crumbs ?? []).filter((c) => c.kind !== "country");
	const typeWord = r.sub ?? TYPE_WORD[r.kind]?.[l] ?? r.kind;
	const keys = model.keyFacts ?? [];
	// The verdict never stands alone against "Lo inusual" (a move already taken back is not unusual now).
	const unusualNow = (model.anomalies ?? []).filter((a) => !a.reverted).length;
	// Incidents are summarised in the header strip; the list only when there is one to show.
	const sections = model.sections.filter((s) => s.key !== "incidents" || s.items.length || !keys.length);
	const facility = r.kind === "infrastructure";
	// Without a map (an institution, an outlet, most networks) the side column would hold the record alone: the
	// lists go there, so the two columns balance. Incidents stay with the signals.
	const side = !inspector && !aside;
	const mainSections = side ? sections.filter((s) => s.key === "incidents") : sections;
	const sideSections = side ? sections.filter((s) => s.key !== "incidents") : [];
	return (
		<Level.Provider value={inspector ? 3 : 2}>
			<article class={`entity entity--${variant} entity--${r.kind}`} aria-labelledby={`entity-${r.id}`}>
				<header class="entity__head">
					{crumbs}
					<p class="entity__kicker">
						<span>{typeWord}</span>
						<span class="mono entity__id">{r.id}</span>
					</p>
					<div class="entity__title-row">
						{inspector ? (
							<h2 class="entity__name" id={`entity-${r.id}`}>
								{r.name}
							</h2>
						) : (
							<h1 class="entity__name" id={`entity-${r.id}`}>
								{r.name}
							</h1>
						)}
						<div class="entity__actions">
							{actions}
							{r.kind === "municipality" ? (
								<ReportButton
									municipality={r.id}
									label={t("¿Tienes luz aquí? Reportar", "Power out here? Report")}
								/>
							) : null}
							{inspector && r.path ? (
								<a
									class="btn btn--quiet"
									{...entityLink(r.id)}
									title={t("Abrir la ficha completa (P)", "Open the full page (P)")}
								>
									{t("Ficha", "Page")} <span aria-hidden="true">↗</span>
								</a>
							) : null}
							{onClose ? (
								<button
									type="button"
									class="icon-btn"
									onClick={onClose}
									aria-label={t("Quitar la selección (Esc)", "Clear the selection (Esc)")}
									title={t("Quitar la selección (Esc)", "Clear the selection (Esc)")}
								>
									<svg class="ico" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
										<path d="M2 2l6 6M8 2 2 8" />
									</svg>
								</button>
							) : null}
						</div>
					</div>
					{inspector && within.length ? (
						<p class="entity__within">
							{t("en", "in")}{" "}
							{within
								.slice()
								.reverse()
								.map((c, i) => (
									<span key={c.id}>
										{i ? ", " : ""}
										<EntityLinkTo r={c} />
									</span>
								))}
						</p>
					) : null}
					<p class={`entity__status entity__status--${model.status.tone}`}>
						{r.kind === "camera" ? null : <Tone tone={model.status.tone} />}
						<span>
							{model.status.text}
							{unusualNow
								? t(
										` · ${unusualNow} ${unusualNow === 1 ? "lectura inusual" : "lecturas inusuales"} abajo`,
										` · ${unusualNow} unusual ${unusualNow === 1 ? "reading" : "readings"} below`,
									)
								: ""}
						</span>
						{asOf ? (
							<span class="entity__asof">
								{t("dato más reciente", "newest datum")} <span class="mono">{asOf}</span>
							</span>
						) : null}
					</p>
					<Origin m={model} offline={offline} savedAt={savedAt} pending={pending} serverError={serverError} />
					{keys.length ? <KeyStrip facts={keys} signals={model.facts} /> : null}
				</header>
				<div class="entity__grid">
					<div class="entity__main">
						{r.kind === "camera" ? <CameraBlock entity={r.id} page={!inspector} /> : null}
						{model.facts.length ? (
							<section class="esec esec--now" aria-labelledby={`esec-now-${variant}`}>
								<SignalTable
									facts={model.facts}
									title={t("Señales ahora", "Signals now")}
									id={`esec-now-${variant}`}
									legend
								/>
							</section>
						) : r.kind === "camera" ? null : (
							<p class="esec__empty entity__nofacts">
								{t(
									"Ninguna señal en vivo se mide directamente sobre esta entidad todavía; abajo, lo que el archivo le vincula.",
									"No live signal is measured on this entity directly yet; below, what the archive links to it.",
								)}
							</p>
						)}
						<Unusual m={model} />
						{mainSections.map((s) => (
							<Section key={s.key} s={s} limit={inspector ? 4 : 12} />
						))}
						{!inspector && facility && model.nearby ? <Nearby n={model.nearby} limit={12} /> : null}
						{timeline}
						{inspector ? (
							<>
								{model.nearby ? <Nearby n={model.nearby} limit={5} /> : null}
								<Details m={model} only="relations" />
								{model.childGroups?.length ? <Children groups={model.childGroups} limit={12} /> : null}
							</>
						) : null}
					</div>
					{inspector ? null : (
						<aside class="entity__aside">
							{aside}
							<Details m={model} />
							{sideSections.map((s) => (
								<Section key={s.key} s={s} limit={12} />
							))}
							{!facility && model.nearby ? <Nearby n={model.nearby} limit={12} /> : null}
							{model.childGroups?.length ? <Children groups={model.childGroups} /> : null}
							{model.children.length ? (
								<Children
									groups={[
										{
											key: "municipality",
											label: t("Municipios", "Municipalities"),
											total: model.children.length,
											items: model.children,
											truncated: false,
										},
									]}
								/>
							) : null}
							<Dataset m={model} />
						</aside>
					)}
				</div>
			</article>
		</Level.Provider>
	);
}

/** The loading silhouette: the header, the key strip and the table's rows, empty, so little jumps when it arrives. */
export function EntitySkeleton({ variant, label }: { variant: "inspector" | "page"; label: string }) {
	return (
		<article class={`entity entity--${variant} entity--loading`} aria-busy="true">
			<header class="entity__head">
				<p class="entity__kicker">
					<span>{t("Cargando", "Loading")}</span>
				</p>
				<p class="entity__name entity__name--ghost">{label}</p>
				<p class="entity__status entity__status--muted">
					<Tone tone="muted" />
					<span>
						{t("Pidiendo la vista enlazada al servidor…", "Asking the server for the linked view…")}
					</span>
				</p>
			</header>
			<div class="keys keys--ghost" aria-hidden="true">
				{[0, 1, 2, 3, 4].map((i) => (
					<div class="key key--ghost" key={i} />
				))}
			</div>
			<div class="sig-ghosts" aria-hidden="true">
				{[0, 1, 2, 3, 4, 5].map((i) => (
					<div class="sig-ghost" key={i} />
				))}
			</div>
		</article>
	);
}

/** An entity the server does not know, or cannot give while offline: said plainly, with a way on. */
export function EntityProblem({
	kind,
	retry,
}: {
	kind: "missing" | "error" | "offline";
	retry?: () => void;
}) {
	return (
		<div class="entity entity--problem" role="status">
			<p class="entity__origin">
				{kind === "missing"
					? t(
							"No hay ninguna entidad con esta dirección. Búscala con / (lugares, instalaciones, redes, instituciones, medios).",
							"No entity has this address. Search for it with / (places, facilities, networks, institutions, outlets).",
						)
					: kind === "offline"
						? t(
								"Sin conexión, y esta ficha no está guardada en este dispositivo todavía.",
								"Offline, and this page is not saved on this device yet.",
							)
						: t("El servidor no respondió.", "The server did not answer.")}{" "}
				{retry && kind !== "missing" ? (
					<button type="button" class="link-button" onClick={retry}>
						{t("Reintentar", "Retry")}
					</button>
				) : null}
			</p>
		</div>
	);
}
