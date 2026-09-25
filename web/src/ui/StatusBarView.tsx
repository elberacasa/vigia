import { useEffect, useRef, useState } from "preact/hooks";
import { addStyles } from "../lib/css.ts";
import { health, metaById, now, panels } from "../lib/data.ts";
import { clock, fullStamp, stamp, TZ } from "../lib/format.ts";
import { feedCounts } from "../lib/fresh.ts";
import { lang, t } from "../lib/i18n.ts";
import { helpOpen, jumpTo } from "../lib/keys.ts";
import { link } from "../lib/router.ts";
import { useFresh } from "../lib/seen.ts";
import { type TickerEvent, tickerEvents } from "../lib/ticker.ts";
import { selectedState } from "../panels/MapPanel.tsx";
import statusbarCss from "../styles/statusbar.css?inline";

addStyles(statusbarCss);

/**
 * The desktop-only chunk (loaded after first paint, and never on phones unless ? is pressed): the status bar and
 * the keyboard shortcuts sheet.
 *
 * Desktop status bar (fixed, 28 px): feed health on the left, the latest real events in the middle, the Caracas
 * clock and the age of the newest datum on the right. The ticker never scrolls by itself: it changes only when a
 * new event appears in the data, and that event slides in once with the "nuevo" treatment.
 */

const HINTS_KEY = "vigia:hints";

function hintsHidden(): boolean {
	try {
		return localStorage.getItem(HINTS_KEY) === "off";
	} catch {
		return false;
	}
}

/** "hace 42 s" / "42 s ago": the bar is the one place where seconds matter. */
function agoShort(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	const text = s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
	return t(`hace ${text}`, `${text} ago`);
}

const sameDay = (a: number, b: number) => {
	const f = new Intl.DateTimeFormat("en-CA", {
		timeZone: TZ,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	return f.format(a) === f.format(b);
};

/** The one place on desktop that counts feeds (lib/fresh.ts feedCounts; the logo's meter reads the same count). */
function Health() {
	const c = feedCounts(health.value);
	return (
		<a
			class="statusbar__health"
			{...link("status")}
			title={t(
				"Fuentes con datos dentro de su plazo, de las activadas (sin contar las apagadas ni las que necesitan clave)",
				"Feeds with data inside their budget, of those turned on (not counting off feeds or ones that need a key)",
			)}
		>
			<span>
				<span class="dot dot--ok" aria-hidden="true" /> {c.live} {t("de", "of")} {c.enabled}{" "}
				{t("al día", "current")}
			</span>
			{c.late ? (
				<span>
					<span class="dot dot--stale" aria-hidden="true" /> {c.late} {t("con retraso", "delayed")}
				</span>
			) : null}
			{c.down ? (
				<span>
					<span class="dot dot--failing" aria-hidden="true" /> {c.down} {t("sin conexión", "unreachable")}
				</span>
			) : null}
			{c.waiting ? (
				<span>
					<span class="dot dot--pending" aria-hidden="true" /> {c.waiting} {t("esperando", "waiting")}
				</span>
			) : null}
		</a>
	);
}

function TickerItem({ e, fresh }: { e: TickerEvent; fresh: boolean }) {
	const l = lang.value;
	const when = sameDay(e.at, now.value) ? clock(e.at, l) : stamp(e.at, l);
	const title = `${e.text} · ${e.source} · ${fullStamp(e.at, l)}${
		e.kind === "rate" ? t(" (cuando Vigía la vio publicada)", " (when Vigía saw it published)") : ""
	}`;
	const go = () => {
		if (e.state) {
			selectedState.value = e.state;
			jumpTo("mapa");
		} else if (e.url) window.open(e.url, "_blank", "noopener,noreferrer");
	};
	return (
		<li class={`tick tick--${e.kind}${fresh ? " is-new" : ""}`}>
			<button type="button" class="tick__btn" title={title} onClick={go}>
				<span class="tick__dot" aria-hidden="true" />
				<time class="tick__time" dateTime={new Date(e.at).toISOString()}>
					{when}
				</time>
				<span class="tick__text">{e.text}</span>
				<span class="tick__src">{e.source}</span>
			</button>
		</li>
	);
}

function Ticker() {
	const events = tickerEvents(panels.value, now.value, lang.value);
	const eventAt = new Map(events.map((e) => [e.id, e.at]));
	const fresh = useFresh(
		"ticker",
		events.map((e) => e.id),
		(id) => eventAt.get(id),
	);
	if (!events.length) return <div class="statusbar__ticker" />;
	return (
		<ol
			class="statusbar__ticker"
			aria-label={t("Últimos eventos, del más antiguo al más reciente", "Latest events, oldest to newest")}
		>
			{events.map((e) => (
				<TickerItem key={e.id} e={e} fresh={fresh.has(e.id)} />
			))}
		</ol>
	);
}

/** Newest observation among all feeds (future-dated ones, like tomorrow's BCV rate, do not count). */
function Newest() {
	let best: { at: number; feed: string } | null = null;
	for (const h of health.value) {
		const at = h.newestObservedAt;
		if (at === null || at > now.value + 60_000) continue;
		if (!best || at > best.at) best = { at, feed: h.id };
	}
	if (!best) return null;
	const name = metaById.value.get(best.feed)?.name[lang.value] ?? best.feed;
	return (
		<span
			class="statusbar__newest"
			title={`${t("Dato más reciente", "Newest datum")}: ${name} · ${fullStamp(best.at, lang.value)}`}
		>
			{t("último dato", "newest datum")} <span class="mono">{agoShort(now.value - best.at)}</span>
		</span>
	);
}

function Hints() {
	const [hidden, setHidden] = useState(hintsHidden);
	if (hidden) return null;
	return (
		<div class="statusbar__hints">
			<button type="button" class="statusbar__hint" onClick={() => (helpOpen.value = true)}>
				<kbd>/</kbd> {t("buscar", "search")} · <kbd>1–9</kbd> {t("paneles", "panels")} · <kbd>L</kbd>{" "}
				{t("capas", "layers")} · <kbd>S</kbd> {t("compartir", "share")} · <kbd>?</kbd>{" "}
				{t("atajos", "shortcuts")}
			</button>
			<button
				type="button"
				class="statusbar__hint-close"
				aria-label={t("Ocultar atajos", "Hide shortcuts")}
				onClick={() => {
					setHidden(true);
					try {
						localStorage.setItem(HINTS_KEY, "off");
					} catch {
						// ignore
					}
				}}
			>
				✕
			</button>
		</div>
	);
}

export default function StatusBarView() {
	return (
		<aside class="statusbar" aria-label={t("Barra de estado", "Status bar")}>
			<Health />
			<Ticker />
			<Hints />
			<span class="statusbar__clock">
				Caracas{" "}
				<time class="mono" dateTime={new Date(now.value).toISOString()}>
					{clock(now.value, lang.value, true)}
				</time>
			</span>
			<Newest />
			<a
				class="statusbar__credit"
				href="https://github.com/elberacasa"
				target="_blank"
				rel="noopener noreferrer"
			>
				elberacasa
			</a>
		</aside>
	);
}

/** For the ? overlay and the hint strip; each entry lists the keys and what they do. */
export const SHORTCUTS: readonly { keys: readonly string[]; es: string; en: string }[] = [
	{
		keys: ["/", "Ctrl K"],
		es: "Buscar estados, municipios, paneles, fuentes",
		en: "Search states, places, panels, sources",
	},
	{
		keys: ["1–9"],
		es: "Ir a un panel (mapa, dólar, internet…)",
		en: "Jump to a panel (map, dollar, internet…)",
	},
	{ keys: ["L"], es: "Siguiente capa del mapa", en: "Next map layer" },
	{ keys: ["Q"], es: "Mostrar u ocultar sismos", en: "Show or hide quakes" },
	{ keys: ["S"], es: "Compartir imagen del mapa", en: "Share an image of the map" },
	{ keys: ["V"], es: "Vista limpia para capturas", en: "Clean view for screenshots" },
	{ keys: ["T"], es: "Tema claro u oscuro", en: "Light or dark theme" },
	{ keys: ["E"], es: "Español / English", en: "Español / English" },
	{ keys: ["?"], es: "Esta lista de atajos", en: "This list of shortcuts" },
	{ keys: ["Esc"], es: "Cerrar, salir o quitar la selección", en: "Close, exit or clear the selection" },
];

export function HelpDialog() {
	const ref = useRef<HTMLDialogElement>(null);
	const open = helpOpen.value;
	useEffect(() => {
		const d = ref.current;
		if (!d) return;
		if (open && !d.open) d.showModal();
		if (!open && d.open) d.close();
	}, [open]);
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a mouse shortcut; Escape closes the dialog natively.
		<dialog
			ref={ref}
			class="sheet keys-help"
			aria-labelledby="keys-title"
			onClose={() => (helpOpen.value = false)}
			onClick={(e) => {
				if (e.target === ref.current) helpOpen.value = false;
			}}
		>
			{open ? (
				<div class="sheet__inner">
					<header class="sheet__head">
						<div>
							<p class="caps sheet__kicker">{t("Teclado", "Keyboard")}</p>
							<h2 class="sheet__title" id="keys-title">
								{t("Atajos", "Shortcuts")}
							</h2>
						</div>
						<button
							type="button"
							class="sheet__close"
							onClick={() => (helpOpen.value = false)}
							aria-label={t("Cerrar", "Close")}
						>
							✕
						</button>
					</header>
					<dl class="keys-help__list">
						{SHORTCUTS.map((s) => (
							<div key={s.es}>
								<dt>
									{s.keys.map((k) => (
										<kbd key={k}>{k}</kbd>
									))}
								</dt>
								<dd>{s[lang.value]}</dd>
							</div>
						))}
					</dl>
				</div>
			) : null}
		</dialog>
	);
}
