import { computed } from "@preact/signals";
import { connection, healthById, panels, tick } from "../lib/data.ts";
import { ago, stamp } from "../lib/format.ts";
import { type CurrentClause, currentClauses, type HeadlineInput } from "../lib/headline.ts";
import { lang, t } from "../lib/i18n.ts";
import { ignoredTime, replaying, setViewTime } from "../map/view.ts";

/**
 * "Prioridad": what matters right now as a short ops list, built by the fixed rules of lib/headline.ts from the
 * computed panels (the same clauses as the share cards and /ahora.txt). Each row has a severity word and shape (never
 * colour alone), links to the panel that holds its source and age, and a stale row says how old its data is.
 * It replaced the one-sentence "Ahora" banner (2026-09-28): the same facts, read like a log instead of shouted.
 */

type Tone = CurrentClause["tone"];

const SEVERITY: Record<Tone, { es: string; en: string }> = {
	alert: { es: "Alerta", en: "Alert" },
	warn: { es: "Aviso", en: "Notice" },
	normal: { es: "Info", en: "Info" },
};

/** A severity mark: a shape plus a word, so it reads without colour (WCAG 1.4.1). */
export function Severity({ tone }: { tone: Tone }) {
	return (
		<span class={`sev sev--${tone}`}>
			<svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">
				{tone === "alert" ? (
					<path d="M5 1 9.2 8.6H.8Z" />
				) : tone === "warn" ? (
					<path d="M5 .8 9.2 5 5 9.2.8 5Z" />
				) : (
					<circle cx="5" cy="5" r="3.2" />
				)}
			</svg>
			{t(SEVERITY[tone].es, SEVERITY[tone].en)}
		</span>
	);
}

/**
 * An incident clause ends with its evidence in brackets ("(IODA y prensa, última señal hace 2 min)"): shown as the
 * row's secondary text. Other clauses keep their brackets (a state name, "(Táchira)").
 */
function split(c: CurrentClause): { main: string; meta: string | null } {
	if (c.href !== "#incidentes") return { main: c.text, meta: null };
	const m = /^(.*) \(([^()]*)\)$/.exec(c.text);
	return m ? { main: m[1] as string, meta: m[2] as string } : { main: c.text, meta: null };
}

function Row({ c }: { c: CurrentClause }) {
	const l = lang.value;
	const { main, meta } = split(c);
	return (
		<li class={`prio__row prio__row--${c.tone}${c.stale ? " is-stale" : ""}`}>
			<a href={c.href} class="prio__link">
				<Severity tone={c.tone} />
				<span class="prio__text">
					<span class="prio__main">{main}</span>
					{meta ? <span class="prio__meta">{meta}</span> : null}
					{c.stale ? (
						// The feed's clock, said as such: when Vigía last read it, not when the event happened.
						<span class="prio__stale">
							{c.lastAt
								? t(
										`fuente con retraso · leída ${ago(tick.value - c.lastAt, l)}`,
										`source delayed · read ${ago(tick.value - c.lastAt, l)}`,
									)
								: t("fuente sin actualizar", "source not updated")}
						</span>
					) : null}
				</span>
			</a>
		</li>
	);
}

/** The replay and ignored-link notes that used to sit under the Ahora line. */
function TimeNote() {
	const l = lang.value;
	const shown = replaying.value;
	const ignored = ignoredTime.value;
	if (shown !== null)
		// Not a live region: the history strip's status is the one place that announces the replay.
		return (
			<p class="prio__note">
				{t(
					`El mapa muestra el ${stamp(shown, l, tick.value)}; esta lista y los paneles siguen en vivo.`,
					`The map shows ${stamp(shown, l, tick.value)}; this list and the panels are live.`,
				)}{" "}
				<button type="button" class="link-button" onClick={() => setViewTime(null)}>
					{t("Volver a en vivo", "Back to live")}
				</button>
			</p>
		);
	if (ignored)
		return (
			<p class="prio__note">
				{ignored.reason === "layer"
					? t(
							`El enlace pedía el ${stamp(ignored.at, l, tick.value)}, pero solo la capa Internet tiene historial: el mapa está en vivo.`,
							`The link asked for ${stamp(ignored.at, l, tick.value)}, but only the Internet layer has history: the map is live.`,
						)
					: t(
							`El enlace pedía el ${stamp(ignored.at, l, tick.value)}, fuera del historial guardado: el mapa está en vivo.`,
							`The link asked for ${stamp(ignored.at, l, tick.value)}, outside the stored history: the map is live.`,
						)}{" "}
				<button type="button" class="link-button" onClick={() => (ignoredTime.value = null)}>
					{t("Entendido", "OK")}
				</button>
			</p>
		);
	return null;
}

/**
 * No clause to list. "Esperando los primeros datos" only while nothing has ever arrived; with data that is too old
 * to list, it says how old the newest reading is, or that this device is offline (whole-release review, M16: the
 * waiting line stayed forever after a blackout or offline, which is exactly when it was wrong).
 */
function EmptyPriority() {
	const l = lang.value;
	const hasData = Object.keys(panels.value).length > 0;
	const newest = Math.max(0, ...[...healthById.value.values()].map((h) => h.lastSuccessAt ?? 0));
	if (!hasData || newest === 0)
		return (
			<p class="prio__empty" data-state="waiting">
				{t("Esperando los primeros datos…", "Waiting for the first data…")}
			</p>
		);
	const age = ago(Math.max(0, tick.value - newest), l);
	return (
		<p class="prio__empty" data-state="stale">
			{connection.value === "offline"
				? t(
						`Sin conexión: nada al día que priorizar. La última lectura llegó ${age}.`,
						`Offline: nothing current to prioritise. The last reading arrived ${age}.`,
					)
				: t(
						`Nada al día que priorizar: la última lectura llegó ${age}.`,
						`Nothing current to prioritise: the last reading arrived ${age}.`,
					)}
		</p>
	);
}

/** The clauses, rebuilt when the data, the health or the language change, or every 15 s (never on the 1 s clock). */
const clausesNow = computed(() =>
	currentClauses(panels.value as HeadlineInput, healthById.value, tick.value, lang.value),
);

/** The priority list. `compact` styles it for the desk's bottom strip (flush, one line per row). */
export function Priority({ compact = false }: { compact?: boolean }) {
	const clauses = clausesNow.value;
	const alerts = clauses.filter((c) => c.tone !== "normal").length;
	return (
		<section class={`prio${compact ? " prio--compact" : ""}`} aria-labelledby="prio-title">
			<header class="prio__head">
				<h2 class="prio__title" id="prio-title">
					{t("Prioridad", "Priority")}
				</h2>
				<span class="prio__count">
					{clauses.length
						? alerts
							? t(`${alerts} fuera de lo normal`, `${alerts} out of the ordinary`)
							: t("ninguna alerta según las reglas", "no alert by the rules")
						: ""}
				</span>
			</header>
			<TimeNote />
			{clauses.length ? (
				<ol class="prio__list">
					{clauses.map((c) => (
						<Row key={c.text} c={c} />
					))}
				</ol>
			) : (
				<EmptyPriority />
			)}
		</section>
	);
}
