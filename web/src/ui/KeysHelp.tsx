import { useEffect, useRef } from "preact/hooks";
import { addStyles } from "../lib/css.ts";
import { lang, t } from "../lib/i18n.ts";
import { helpOpen } from "../lib/keys.ts";

/** The keyboard shortcuts sheet (?), its own chunk: loaded the first time it is asked for. */

addStyles(
	`.keys-help{width:min(600px,calc(100vw - 24px))}.keys-help__group{margin:var(--s-4) 0 0;color:var(--text-3)}.keys-help__list{display:grid;margin:var(--s-2) 0 0}.keys-help__list>div{display:grid;grid-template-columns:8.5rem 1fr;gap:var(--s-3);align-items:baseline;padding:6px 0;border-top:1px solid var(--line)}.keys-help__list dt{display:flex;gap:4px;flex-wrap:wrap}.keys-help__list dd{margin:0;color:var(--text-2);font-size:var(--fs-sm)}`,
);

interface Shortcut {
	keys: readonly string[];
	es: string;
	en: string;
}

const EVERYWHERE: readonly Shortcut[] = [
	{
		keys: ["/", "Ctrl K"],
		es: "Buscar y ejecutar: lugares, módulos, paneles, capas, fuentes, comandos",
		en: "Search and run: places, modules, panels, layers, sources, commands",
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

const DESK: readonly Shortcut[] = [
	{
		keys: ["1", "…", "9", "0"],
		es: "Abrir un módulo: Situación, Dinero, Mercados, Internet, Energía, Tierra, Noticias, Oficial, Humanitario, En vivo",
		en: "Open a module: Situation, Money, Markets, Internet, Energy, Earth, News, Official, Humanitarian, Live",
	},
	{ keys: ["I"], es: "Mostrar u ocultar el inspector", en: "Show or hide the inspector" },
	{ keys: ["B"], es: "Plegar o desplegar prioridad y registro", en: "Fold or unfold priority and log" },
	{ keys: ["P"], es: "Abrir la ficha del lugar seleccionado", en: "Open the selected place's page" },
];

const PHONE: readonly Shortcut[] = [
	{
		keys: ["1–9"],
		es: "Ir a un panel (mapa, dólar, internet…)",
		en: "Jump to a panel (map, dollar, internet…)",
	},
];

function List({ items }: { items: readonly Shortcut[] }) {
	return (
		<dl class="keys-help__list">
			{items.map((s) => (
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
	);
}

export function HelpDialog() {
	const ref = useRef<HTMLDialogElement>(null);
	const open = helpOpen.value;
	useEffect(() => {
		const d = ref.current;
		if (!d) return;
		if (open && !d.open) d.showModal();
		if (!open && d.open) d.close();
	}, [open]);
	const desk = matchMedia("(min-width: 1000px)").matches;
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
					<p class="caps keys-help__group">
						{desk ? t("Estación de trabajo", "Workstation") : t("Página", "Page")}
					</p>
					<List items={desk ? DESK : PHONE} />
					<p class="caps keys-help__group">{t("En todas partes", "Everywhere")}</p>
					<List items={EVERYWHERE} />
				</div>
			) : null}
		</dialog>
	);
}
