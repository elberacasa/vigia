import { useEffect, useState } from "preact/hooks";
import { convert, digitsFor, echoDigits, inWages, readAmount } from "../lib/convert.ts";
import { healthById, now } from "../lib/data.ts";
import { ago, num } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { link } from "../lib/router.ts";
import { summarize } from "../lib/summary.ts";
import { SourceTag } from "../ui/Source.tsx";
import { Sparkline } from "../ui/Sparkline.tsx";
import type {
	GazetteCategory,
	GazetteIssue,
	GazetteView,
	PocketRate,
	PocketView,
	ServicesView,
} from "./Daily.tsx";

/** Singular and plural, es and en; mirrors CATEGORY_LABEL in src/adapters/gaceta-oficial/redact.ts. */
const GAZETTE_CATEGORY: Record<GazetteCategory, [string, string, string, string]> = {
	designacion: ["designación", "designaciones", "appointment", "appointments"],
	delegacion: ["delegación", "delegaciones", "delegation", "delegations"],
	traslado: ["traslado", "traslados", "transfer", "transfers"],
	jubilacion: [
		"jubilación o pensión",
		"jubilaciones o pensiones",
		"retirement or pension",
		"retirements or pensions",
	],
	ascenso: ["ascenso", "ascensos", "promotion", "promotions"],
	condecoracion: ["condecoración", "condecoraciones", "decoration", "decorations"],
	cese: ["cese o remoción", "ceses o remociones", "removal or dismissal", "removals or dismissals"],
	personal: [
		"otro asunto de particulares",
		"otros asuntos de particulares",
		"other private matter",
		"other private matters",
	],
	otro: ["acto no listado", "actos no listados", "unlisted act", "unlisted acts"],
};

function withheldText(w: GazetteIssue["withheld"]): string {
	return w
		.map(({ category, n }) => {
			const [es1, esN, en1, enN] = GAZETTE_CATEGORY[category] ?? GAZETTE_CATEGORY.otro;
			return `${n} ${t(n === 1 ? es1 : esN, n === 1 ? en1 : enN)}`;
		})
		.join(" · ");
}

/* Bodies of the daily-life panels (loaded on demand; see Daily.tsx). Formatting only, plus lib/convert.ts. */

type L = "es" | "en";
const MONTHS_ES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic"];
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "15 sept 2026" from "2026-09-15" (a calendar date, no time zone involved). */
function dateLabel(iso: string, l: L, year = true): string {
	const [y = "", m = "1", d = "1"] = iso.split("-");
	const mon = (l === "es" ? MONTHS_ES : MONTHS_EN)[Number(m) - 1];
	const day = l === "es" ? `${Number(d)} ${mon}` : `${mon} ${Number(d)}`;
	return year ? `${day} ${y}` : day;
}
/** The UTC calendar date of an instant (altimetry passes are dated in UTC). */
function utcDate(ms: number, l: L, year = true): string {
	return dateLabel(new Date(ms).toISOString().slice(0, 10), l, year);
}
function monthYear(ms: number, l: L): string {
	const d = new Date(ms);
	return `${(l === "es" ? MONTHS_ES : MONTHS_EN)[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
const signed = (v: number, digits: number, l: L) =>
	`${v > 0 ? "+" : v < 0 ? "−" : ""}${num(Math.abs(v), digits, l)}`;

// ---------------------------------------------------------------------------------------------------------
// Bolsillo

type Unit = "VES" | "USD" | "EUR";
const SYMBOL: Record<Unit, string> = { VES: "Bs", USD: "US$", EUR: "€" };

function money(value: number, unit: Unit, l: L): string {
	return `${SYMBOL[unit]} ${num(value, digitsFor(value), l)}`;
}

function RateRow({ rate, amount, unit }: { rate: PocketRate; amount: number | null; unit: Unit }) {
	const l = lang.value;
	const direction = unit === "VES" ? "toForeign" : "toVes";
	const result = amount === null ? null : convert(amount, rate.vesPerUnit, direction);
	const outUnit: Unit = unit === "VES" ? rate.currency : "VES";
	return (
		<li class={`pocket__row pocket__row--${rate.kind}${rate.stale ? " pocket__row--stale" : ""}`}>
			<div class="pocket__row-head">
				<span class="pocket__who">
					{l === "es" ? rate.labelEs : rate.labelEn}
					{rate.kind === "official" ? (
						<span class="pocket__tag">{t("oficial", "official")}</span>
					) : (
						<span class="pocket__tag pocket__tag--quote">{t("cotización", "quote")}</span>
					)}
				</span>
				<SourceTag
					source={{
						feed: rate.feed,
						observedAt: rate.asOf,
						url: rate.sourceUrl,
						detail: (l === "es" ? rate.noteEs : rate.noteEn) ?? undefined,
					}}
				/>
			</div>
			<p class="pocket__result data">
				{result === null ? (
					<>
						1 {SYMBOL[rate.currency]} = <strong>{num(rate.vesPerUnit, 2, l)}</strong> Bs
					</>
				) : (
					<strong>{money(result, outUnit, l)}</strong>
				)}
			</p>
			<p class="pocket__meta">
				{result !== null ? (
					<span class="data">
						{t("a", "at")} {num(rate.vesPerUnit, 2, l)} Bs/{SYMBOL[rate.currency]}
						{" · "}
					</span>
				) : null}
				{rate.kind === "official"
					? t(
							`vigente desde el ${utcDate(rate.asOf - 4 * 3_600_000, l, false)}`,
							`in force since ${utcDate(rate.asOf - 4 * 3_600_000, l, false)}`,
						)
					: t(`publicada ${ago(now.value - rate.asOf, l)}`, `published ${ago(now.value - rate.asOf, l)}`)}
				{rate.stale ? <span class="warn-text"> · {t("dato atrasado", "delayed figure")}</span> : null}
			</p>
		</li>
	);
}

/**
 * What the converter read, always shown under the input (review 4, M3: "0,500" was read as 500 and nothing said so):
 * "Leído como Bs 0,5"; an ambiguous "1.500" adds how to write the other reading.
 */
function readAs(r: { value: number; ambiguous: boolean }, unit: Unit, l: L): string {
	const shown = `${SYMBOL[unit]} ${num(r.value, echoDigits(r.value), l)}`;
	if (!r.ambiguous) return t(`Leído como ${shown}`, `Read as ${shown}`);
	const other =
		r.value >= 1000 ? num(r.value / 1000, echoDigits(r.value / 1000), l) : num(r.value * 1000, 0, l);
	return t(
		`Leído como ${shown} (si querías ${other}, escribe ${other})`,
		`Read as ${shown} (for ${other}, type ${other})`,
	);
}

/** One polite live line, spoken after typing pauses (the rate list itself is not live: it re-read every row). */
function Announce({ text }: { text: string }) {
	const [said, setSaid] = useState("");
	useEffect(() => {
		const id = setTimeout(() => setSaid(text), 800);
		return () => clearTimeout(id);
	}, [text]);
	return (
		<p class="sr-only" aria-live="polite">
			{said}
		</p>
	);
}

export function PocketBody({ view }: { view: PocketView }) {
	const l = lang.value;
	const [text, setText] = useState("");
	const [unit, setUnit] = useState<Unit>("VES");
	const reading = readAmount(text, l);
	const amount = reading?.value ?? null;
	const invalid = text.trim() !== "" && amount === null;
	const rows = view.rates.filter((r) => unit === "VES" || r.currency === unit);
	const w = view.wage;
	const wages = unit === "VES" && amount !== null ? inWages(amount, w.vesMonthly) : null;
	const bcv = view.rates.find((r) => r.id === "bcv-usd");
	const wageAt = (id: string) => w.inCurrency.find((x) => x.rateId === id);
	const quick = (v: string, u: Unit) => () => {
		setUnit(u);
		setText(v);
	};
	return (
		<div class="pocket">
			<div class="pocket__converter">
				<label class="pocket__label" for="pocket-amount">
					{t("Monto", "Amount")}
				</label>
				<div class="pocket__input">
					<input
						id="pocket-amount"
						class="data"
						inputMode="decimal"
						autoComplete="off"
						placeholder={unit === "VES" ? "1.000" : "20"}
						value={text}
						aria-invalid={invalid}
						aria-describedby="pocket-hint"
						onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
					/>
					<fieldset class="segmented">
						<legend class="sr-only">{t("Moneda del monto", "Currency of the amount")}</legend>
						{(["VES", "USD", "EUR"] as const).map((u) => (
							<button type="button" key={u} aria-pressed={unit === u} onClick={() => setUnit(u)}>
								{SYMBOL[u]}
							</button>
						))}
					</fieldset>
				</div>
				<p id="pocket-hint" class={`pocket__hint${invalid ? " warn-text" : ""}`}>
					{invalid
						? t("Escribe solo el número, por ejemplo 1.500,50", "Type just the number, e.g. 1,500.50")
						: reading
							? readAs(reading, unit, l)
							: t(
									"Cada tasa por separado, con su fuente. Nada se promedia.",
									"Each rate separately, with its source. Nothing is averaged.",
								)}
					{wages !== null ? (
						<span class="pocket__wages">
							{t(
								`= ${num(wages, wages < 10 ? 2 : 0, l)} salarios mínimos (Bs ${num(w.vesMonthly, 0, l)} al mes)`,
								`= ${num(wages, wages < 10 ? 2 : 0, l)} monthly minimum wages (Bs ${num(w.vesMonthly, 0, l)})`,
							)}
						</span>
					) : null}
				</p>
				<Announce
					text={
						reading && bcv && unit !== "EUR"
							? `${readAs(reading, unit, l)}. ${t("Tasa BCV", "BCV rate")}: ${money(convert(reading.value, bcv.vesPerUnit, unit === "VES" ? "toForeign" : "toVes") ?? 0, unit === "VES" ? "USD" : "VES", l)}`
							: ""
					}
				/>
				<div class="pocket__quick">
					<button type="button" class="filter-chip" onClick={quick(String(w.vesMonthly), "VES")}>
						{t("Salario mínimo", "Minimum wage")}
					</button>
					<button type="button" class="filter-chip" onClick={quick("1", "USD")}>
						US$ 1
					</button>
					<button type="button" class="filter-chip" onClick={quick("100", "USD")}>
						US$ 100
					</button>
					<button type="button" class="filter-chip" onClick={quick(num(10_000, 0, l), "VES")}>
						Bs {num(10_000, 0, l)}
					</button>
				</div>
			</div>
			{rows.length ? (
				<ul class="pocket__rows">
					{rows.map((r) => (
						<RateRow key={r.id} rate={r} amount={amount} unit={unit} />
					))}
				</ul>
			) : (
				<p class="empty">
					{view.rates.length
						? t(
								"No hay una tasa oficial vigente en euros ahora mismo.",
								"No official euro rate is in force right now.",
							)
						: t("Esperando las tasas…", "Waiting for the rates…")}
				</p>
			)}
			<div class="pocket__wage">
				<p class="pocket__wage-title">
					{l === "es" ? w.labelEs : w.labelEn} <span class="pocket__tag">{t("oficial", "official")}</span>
				</p>
				<p class="pocket__wage-figure">
					<strong class="data">Bs {num(w.vesMonthly, 2, l)}</strong> {t("al mes", "a month")}
					<span class="pocket__meta data">
						{" "}
						· Bs {num(w.vesDaily, 2, l)} {t("al día", "a day")}
					</span>
				</p>
				{bcv && wageAt("bcv-usd") ? (
					<p class="pocket__wage-usd">
						= <strong class="data">{money(wageAt("bcv-usd")?.amount ?? 0, "USD", l)}</strong>{" "}
						{t("a la tasa BCV", "at the BCV rate")}
						{view.rates
							.filter((r) => r.kind === "quote")
							.map((r) => {
								const x = wageAt(r.id);
								return x ? (
									<span key={r.id} class="pocket__meta">
										{" "}
										· {money(x.amount, "USD", l)} {t("a", "at")}{" "}
										{(l === "es" ? r.labelEs : r.labelEn).replace(/ \(.*\)$/, "")}
									</span>
								) : null;
							})}
					</p>
				) : null}
				<p class="pocket__meta">
					{w.instrument}, {t("vigente desde el", "in force since")} {dateLabel(w.inForceFrom, l)}.{" "}
					<a href={w.sourceUrl} target="_blank" rel="noopener noreferrer">
						{t("Gaceta", "Gazette")}
					</a>{" "}
					·{" "}
					<a href={w.documentUrl} target="_blank" rel="noopener noreferrer">
						PDF
					</a>
				</p>
				<p class="pocket__meta">
					{t(
						"Sin bonos: el ingreso mínimo integral y el cestaticket se anuncian aparte (ver «?»).",
						"Bonuses not included: the ingreso mínimo integral and cestaticket are announced separately (see “?”).",
					)}
				</p>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------------------------------------
// Servicios

function Guri({ view }: { view: ServicesView["guri"] }) {
	const l = lang.value;
	const state = healthById.value.get(view.feed)?.state;
	const g = view.latest;
	if (!g) {
		return (
			<div class="svc-guri">
				<p class="svc-guri__title">{t("Embalse de Guri", "Guri reservoir")}</p>
				{state === "locked" ? (
					<p class="svc-guri__locked">
						{t(
							"El nivel de Guri medido desde satélites necesita una clave gratuita de DAHITI (sin tarjeta).",
							"Guri's level measured from satellites needs a free DAHITI key (no card).",
						)}{" "}
						<a {...link("guide")}>{t("Cómo activarlo", "How to turn it on")} →</a>
					</p>
				) : (
					<p class="empty">{t("Aún sin datos de DAHITI.", "No DAHITI data yet.")}</p>
				)}
			</div>
		);
	}
	const s = view.season;
	const low = s ? s.below / s.years < 0.25 : false;
	return (
		<div class={`svc-guri${view.stale ? " svc-guri--stale" : ""}`}>
			<div class="svc-guri__head">
				<p class="svc-guri__title">{t("Embalse de Guri", "Guri reservoir")}</p>
				<SourceTag
					source={{
						feed: view.feed,
						observedAt: g.observedAt,
						url: view.sourceUrl,
						detail: view.attribution,
					}}
					label="DAHITI"
				/>
			</div>
			<p class="svc-guri__value data">
				{num(g.m, 2, l)}
				<span class="figure__unit">m</span>
			</p>
			<p class="svc-guri__meta">
				{t(
					`Nivel del agua medido por satélite el ${utcDate(g.observedAt, l)} (±${num(g.uncertaintyM * 100, 1, l)} cm). Estimación satelital, no la cota oficial.`,
					`Water level measured by satellite on ${utcDate(g.observedAt, l)} (±${num(g.uncertaintyM * 100, 1, l)} cm). A satellite estimate, not the official gauge.`,
				)}
				{view.stale ? <span class="warn-text"> {t("Dato atrasado.", "Delayed figure.")}</span> : null}
			</p>
			<div class="rate__deltas">
				{view.change30d ? (
					<span class="delta delta--flat">
						{signed(view.change30d.m, 2, l)} m{" "}
						<span class="delta__label">{t("en ~30 días", "in ~30 days")}</span>
					</span>
				) : null}
				{view.change1y ? (
					<span class="delta delta--flat">
						{signed(view.change1y.m, 2, l)} m <span class="delta__label">{t("en un año", "in a year")}</span>
					</span>
				) : null}
			</div>
			{s ? (
				<p class={`svc-guri__season${low ? " warn-text" : ""}`}>
					{t(
						`Más alto que en ${s.below} de ${s.years} años en estas mismas semanas (${s.firstYear}–${s.lastYear}).`,
						`Higher than in ${s.below} of ${s.years} years at this time of year (${s.firstYear}–${s.lastYear}).`,
					)}
				</p>
			) : null}
			{view.spark.length > 1 ? (
				<>
					<Sparkline
						tone="info"
						values={view.spark.map((p) => p.m)}
						summary={t(
							`Nivel de Guri en dos años, de ${num(view.spark[0]?.m ?? 0, 2, l)} a ${num(g.m, 2, l)} m`,
							`Guri's level over two years, from ${num(view.spark[0]?.m ?? 0, 2, l)} to ${num(g.m, 2, l)} m`,
						)}
					/>
					<p class="chart-block__axis note data">
						<span>{monthYear(view.spark[0]?.t ?? 0, l)}</span>
						<span>{monthYear(g.observedAt, l)}</span>
					</p>
				</>
			) : null}
			{view.record ? (
				<p class="note data">
					{t("Registro desde", "Record since")}{" "}
					{view.record.since ? new Date(view.record.since).getUTCFullYear() : ""}: {t("mín", "min")}{" "}
					{num(view.record.min.m, 2, l)} m ({monthYear(view.record.min.t, l)}) · {t("máx", "max")}{" "}
					{num(view.record.max.m, 2, l)} m ({monthYear(view.record.max.t, l)})
				</p>
			) : null}
		</div>
	);
}

function Evidence({ id, label }: { id: "luces" | "conectividad"; label: string }) {
	const s = summarize(id);
	return (
		<li>
			<a href={`#${id}`} class="svc-link">
				<span class="svc-link__label">{label}</span>
				<span class={`svc-link__text${s && s.tone !== "normal" ? ` svc-link__text--${s.tone}` : ""}`}>
					{s?.text ?? t("sin datos aún", "no data yet")}
				</span>
				<span aria-hidden="true">→</span>
			</a>
		</li>
	);
}

export function ServicesBody({ view }: { view: ServicesView }) {
	const l = lang.value;
	return (
		<div class="svc">
			<h3 class="svc__h caps">{t("Electricidad", "Electricity")}</h3>
			<Guri view={view.guri} />
			<p class="svc__sub">{t("Señales de cortes hoy", "Signs of cuts today")}</p>
			<ul class="svc-links">
				<Evidence id="luces" label={t("Luces nocturnas (NASA)", "Night lights (NASA)")} />
				<Evidence id="conectividad" label={t("Internet por estado (IODA)", "Internet by state (IODA)")} />
			</ul>
			<h3 class="svc__h caps">{t("Sin fuente abierta todavía", "No open source yet")}</h3>
			<ul class="svc-gaps">
				{view.unavailable.map((u) => (
					<li key={u.id}>
						<details>
							<summary>
								<span>{l === "es" ? u.labelEs : u.labelEn}</span>
								<span class="svc-gaps__state">{t("sin datos", "no data")}</span>
							</summary>
							<p>{l === "es" ? u.checkedEs : u.checkedEn}</p>
							<p>{l === "es" ? u.whereEs : u.whereEn}</p>
							<p class="note data">
								{t("Comprobado el", "Checked on")} {dateLabel(u.checkedOn, l)}
							</p>
						</details>
					</li>
				))}
			</ul>
		</div>
	);
}

// ---------------------------------------------------------------------------------------------------------
// Gaceta

function Issue({ issue }: { issue: GazetteIssue }) {
	const l = lang.value;
	const kind =
		issue.kind === "extraordinaria" ? t("Extraordinaria", "Extraordinary") : t("Ordinaria", "Ordinary");
	return (
		<li class={`gz-issue${issue.notable ? " gz-issue--notable" : ""}`}>
			<div class="gz-issue__head">
				<a class="gz-issue__num" href={issue.sourceUrl} target="_blank" rel="noopener noreferrer">
					N° {num(issue.number, 0, l)} <span class="gz-issue__kind">{kind}</span>
				</a>
				<span class="gz-issue__date data">{dateLabel(issue.date, l, false)}</span>
				{issue.pdfUrl ? (
					<a class="gz-issue__pdf" href={issue.pdfUrl} target="_blank" rel="noopener noreferrer">
						PDF
					</a>
				) : null}
			</div>
			{issue.acts.length ? (
				<ul class="gz-acts">
					{issue.acts.map((a, i) => (
						<li key={i}>
							<span
								class={`gz-acts__title${a.instrument === "Ley" || a.instrument === "Decreto" ? " gz-acts__title--notable" : ""}`}
							>
								{a.title}
							</span>
							<span class="gz-acts__organ">{a.organ}</span>
						</li>
					))}
				</ul>
			) : null}
			<p class="gz-issue__foot">
				{issue.moreActs ? t(`y ${issue.moreActs} actos más · `, `and ${issue.moreActs} more acts · `) : null}
				{issue.withheld.length ? (
					<span
						title={t(
							"Títulos no mostrados: tratan de personas particulares (pensiones, jubilaciones y otros asuntos personales) o de actos que Vigía no sabe clasificar. Están en el PDF oficial.",
							"Titles not shown: they are about private persons (pensions, retirements and other personal matters) or acts Vigía cannot classify. They are in the official PDF.",
						)}
					>
						{withheldText(issue.withheld)}
					</span>
				) : null}
				{!issue.actsListed
					? t(
							"El índice no lista su sumario: ver el PDF.",
							"The index does not list its contents: see the PDF.",
						)
					: null}
			</p>
		</li>
	);
}

export function GazetteBody({ view }: { view: GazetteView }) {
	const l = lang.value;
	const [all, setAll] = useState(false);
	if (!view.issues.length)
		return <p class="empty">{t("Aún sin números de la Gaceta.", "No Gazette issues yet.")}</p>;
	const shown = all ? view.issues : view.issues.slice(0, 4);
	return (
		<div class="gz">
			{view.newest ? (
				<p class={`gz__lag${view.stale ? " warn-text" : ""}`}>
					{t(
						`Último número en el índice oficial: ${dateLabel(view.newest.date, l)} (hace ${view.lagDays ?? "?"} días). El índice suele ir atrasado.`,
						`Newest issue in the official index: ${dateLabel(view.newest.date, l)} (${view.lagDays ?? "?"} days ago). The index usually lags.`,
					)}
				</p>
			) : null}
			<ul class="gz-issues">
				{shown.map((i) => (
					<Issue key={`${i.kind}${i.number}`} issue={i} />
				))}
			</ul>
			<div class="gz__foot">
				{view.issues.length > shown.length ? (
					<button type="button" class="link-button" onClick={() => setAll(true)}>
						{t(
							`Ver ${view.issues.length - shown.length} números más`,
							`Show ${view.issues.length - shown.length} more issues`,
						)}
					</button>
				) : null}
				<SourceTag
					source={{
						feed: view.feed,
						observedAt: view.newest?.observedAt ?? now.value,
						url: view.homepage,
						detail: view.attribution,
					}}
					label={t("Gaceta Oficial", "Official Gazette")}
				/>
			</div>
		</div>
	);
}
