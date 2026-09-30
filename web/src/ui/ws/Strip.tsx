import { computed } from "@preact/signals";
import { panels, tick } from "../../lib/data.ts";
import { clock, fullStamp, stamp, TZ } from "../../lib/format.ts";
import { lang, t } from "../../lib/i18n.ts";
import { useFresh } from "../../lib/seen.ts";
import { stateName } from "../../lib/states.ts";
import { type TickerEvent, type TickerKind, tickerEvents } from "../../lib/ticker.ts";
import { selectState } from "../../map/view.ts";
import { Priority } from "../../panels/Ahora.tsx";
import { stripOpen, toggleStrip } from "./state.ts";

const KIND: Record<TickerKind, { es: string; en: string; tone: "alert" | "warn" | "ok" | "normal" }> = {
	quake: { es: "Sismo", en: "Quake", tone: "warn" },
	outage: { es: "Caída", en: "Drop", tone: "alert" },
	"outage-end": { es: "Fin caída", en: "Drop end", tone: "ok" },
	rate: { es: "Tasa", en: "Rate", tone: "normal" },
	alert: { es: "Alerta", en: "Alert", tone: "warn" },
	block: { es: "Bloqueo", en: "Block", tone: "alert" },
	unblock: { es: "Desbloqueo", en: "Unblock", tone: "ok" },
};

const dayKey = new Intl.DateTimeFormat("en-CA", {
	timeZone: TZ,
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});

/**
 * The event log: discrete things that happened, newest first, from panel data the page already has (lib/ticker.ts:
 * quakes, IODA outages starting and ending, BCV publications, GDACS alerts, block-list changes). Each row gives the
 * time its source says it happened, the kind, the place, and the source; a row with a state selects it.
 */
/** The log's rows, rebuilt when the data or the language change, or every 15 s (never on the 1 s clock). */
const logNow = computed(() => tickerEvents(panels.value, tick.value, lang.value, 40).reverse());

function OpsLog() {
	const events = logNow.value;
	const eventAt = new Map(events.map((e) => [e.id, e.at]));
	const fresh = useFresh(
		"ticker",
		events.map((e) => e.id),
		(id) => eventAt.get(id),
	);
	const today = dayKey.format(tick.value);
	return (
		<section class="log" aria-labelledby="log-title">
			<header class="bstrip__head">
				<h2 class="bstrip__title" id="log-title">
					{t("Registro de eventos", "Event log")}
				</h2>
				<span class="bstrip__hint">
					{t(
						"sismos, caídas de señal, tasas, alertas y bloqueos, según cada fuente",
						"quakes, signal drops, rates, alerts and blocks, as each source reports them",
					)}
				</span>
			</header>
			{events.length ? (
				<ol class="log__list">
					{events.map((e) => (
						<LogRow key={e.id} e={e} fresh={fresh.has(e.id)} today={today} />
					))}
				</ol>
			) : (
				<p class="bstrip__empty">{t("Sin eventos todavía.", "No events yet.")}</p>
			)}
		</section>
	);
}

/** The row's text without the kind the tag already says ("Sismo M3,6 · …" keeps its magnitude). */
function shortText(e: TickerEvent): string {
	if (e.kind === "quake") return e.text.replace(/^(Sismo|Quake) /, "");
	if (e.kind === "rate") return e.text;
	return e.text.replace(/^[^·]+·\s*/, "");
}

function LogRow({ e, fresh, today }: { e: TickerEvent; fresh: boolean; today: string }) {
	const l = lang.value;
	const k = KIND[e.kind];
	const sameDay = dayKey.format(e.at) === today;
	const title = `${e.text} · ${e.source} · ${fullStamp(e.at, l)}${
		e.kind === "rate" ? t(" (cuando Vigía la vio publicada)", " (when Vigía saw it published)") : ""
	}`;
	const text = shortText(e);
	return (
		<li class={`log__row${fresh ? " is-new" : ""}`}>
			<time class="log__time mono" dateTime={new Date(e.at).toISOString()} title={fullStamp(e.at, l)}>
				{/* An earlier day shows its date only (it fits the column); the full time is in the title. */}
				{sameDay ? clock(e.at, l) : stamp(e.at, l).split(",")[0]}
			</time>
			<span class={`log__kind log__kind--${k.tone}`}>{t(k.es, k.en)}</span>
			{e.url ? (
				<a class="log__text" href={e.url} target="_blank" rel="noopener noreferrer" title={title}>
					{text}
				</a>
			) : (
				<span class="log__text" title={title}>
					{text}
				</span>
			)}
			{e.state && stateName(e.state) !== text ? (
				<button
					type="button"
					class="log__place"
					onClick={() => selectState(e.state)}
					title={t(`Seleccionar ${stateName(e.state)}`, `Select ${stateName(e.state)}`)}
				>
					{stateName(e.state)}
				</button>
			) : (
				<span class="log__place log__place--none" />
			)}
			<span class="log__src">{e.source}</span>
		</li>
	);
}

/** The bottom strip of the desk: the priority list beside the event log; folds to its header (B). */
export function Strip() {
	const open = stripOpen.value;
	return (
		<section
			class={`bstrip${open ? "" : " is-folded"}`}
			aria-label={t("Prioridad y registro", "Priority and log")}
		>
			<button
				type="button"
				class="bstrip__fold icon-btn"
				aria-expanded={open}
				aria-label={
					open
						? t("Plegar la franja (B)", "Fold the strip (B)")
						: t("Desplegar la franja (B)", "Unfold the strip (B)")
				}
				title={open ? t("Plegar (B)", "Fold (B)") : t("Desplegar (B)", "Unfold (B)")}
				onClick={() => toggleStrip()}
			>
				<svg class="ico" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
					<path d={open ? "M2 3.5 5 6.5 8 3.5" : "M2 6.5 5 3.5 8 6.5"} />
				</svg>
			</button>
			{/* Folded, the panes leave the tab order and the accessibility tree (inert), not only the screen. */}
			<div class="bstrip__pane bstrip__pane--prio" inert={!open}>
				<Priority compact />
			</div>
			<div class="bstrip__pane bstrip__pane--log" inert={!open}>
				<OpsLog />
			</div>
		</section>
	);
}
