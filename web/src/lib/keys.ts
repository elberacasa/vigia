import { signal } from "@preact/signals";
import { type Shading, selectedState, shading, showQuakes } from "../panels/MapPanel.tsx";
import { addStyles } from "./css.ts";
import { lang, setLang } from "./i18n.ts";
import { isPanelId, reveal, visibleOrder } from "./layout.ts";
import { letterKeys, reducedMotion, setTheme, theme } from "./prefs.ts";
import { go, route } from "./router.ts";

/**
 * Keyboard shortcuts: one window listener for the whole app. Keys typed into a field are left alone (except Esc),
 * and so are chords with Alt, Ctrl or ⌘ (the browser's own), except Ctrl/⌘K for search.
 *
 * Map actions go through a cancelable `vigia:map` CustomEvent on window, detail `{ action, ... }`:
 *   { action: "cycle-layer" }            L: next shading layer
 *   { action: "toggle-quakes" }          Q: quakes on/off
 *   { action: "share" }                  S: share image of the map
 *   { action: "layer", layer: Shading }  palette: switch to that layer
 *   { action: "municipality", code, state }  palette: a municipality or city (code "VE2313", state "VE-V")
 * The map code may listen and call `event.preventDefault()` to take an action over; if nobody does, the fallback
 * here uses the signals exported by panels/MapPanel.tsx, so every key works with today's map too.
 */

export const paletteOpen = signal(false);
export const helpOpen = signal(false);
export const cleanView = signal(false);
/**
 * Letters typed after "/" but before the palette's field has focus (the search chunk may still be loading), so
 * "/lara" typed fast still searches "lara" instead of losing letters or firing shortcuts.
 */
export let typedAhead = "";
export function takeTypedAhead(): string {
	const text = typedAhead;
	typedAhead = "";
	return text;
}

/**
 * What 1–9 open: the map, then the reader's own panel order (moved and hidden panels respected, Incidentes
 * included). PANEL_KEYS below only names panels for the palette.
 */
export function panelKeyOrder(): string[] {
	return ["mapa", ...visibleOrder.value].slice(0, 9);
}

/** Panels the palette lists by name. */
export const PANEL_KEYS: readonly { id: string; es: string; en: string }[] = [
	{ id: "mapa", es: "Mapa", en: "Map" },
	{ id: "dinero", es: "Dólar", en: "Dollar" },
	{ id: "conectividad", es: "Internet", en: "Internet" },
	{ id: "noticias", es: "Noticias", en: "News" },
	{ id: "sismos", es: "Sismos", en: "Quakes" },
	{ id: "clima", es: "Clima", en: "Weather" },
	{ id: "luces", es: "Luces", en: "Lights" },
	{ id: "incendios", es: "Incendios", en: "Fires" },
	{ id: "censura", es: "Censura", en: "Censorship" },
];

export const LAYERS: readonly Shading[] = ["connectivity", "nightlights", "satellite", "reports", "fires"];

export type MapDetail =
	| { action: "cycle-layer" }
	| { action: "toggle-quakes" }
	| { action: "share" }
	| { action: "layer"; layer: Shading }
	| { action: "municipality"; code: string; state: string };

/** Asks the map to do something; returns after the map or the fallback has done it. */
export function mapAction(detail: MapDetail): void {
	const handled = !window.dispatchEvent(new CustomEvent("vigia:map", { detail, cancelable: true }));
	if (handled) return;
	switch (detail.action) {
		case "cycle-layer": {
			const i = LAYERS.indexOf(shading.value);
			shading.value = LAYERS[(i + 1) % LAYERS.length] ?? "connectivity";
			break;
		}
		case "toggle-quakes":
			showQuakes.value = !showQuakes.value;
			break;
		case "share":
			document.querySelector<HTMLButtonElement>(".share-button")?.click();
			break;
		case "layer":
			shading.value = detail.layer;
			break;
		case "municipality":
			selectedState.value = detail.state;
			break;
	}
}

function smooth(): ScrollBehavior {
	return reducedMotion.value || matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

/**
 * Opens a panel (shown if hidden, expanded if collapsed: lib/layout.ts `reveal`), scrolls to it, moves focus to its
 * header and flashes its frame once. The map is not a managed panel, so it is only scrolled to.
 */
export function jumpTo(id: string): void {
	const run = () => {
		if (isPanelId(id)) reveal(id, true);
		else document.getElementById(id)?.scrollIntoView({ behavior: smooth(), block: "start" });
		requestAnimationFrame(() => {
			const el = document.getElementById(id);
			if (!el) return;
			if (!isPanelId(id)) {
				if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
				el.focus({ preventScroll: true });
			}
			el.classList.remove("is-target");
			void el.offsetWidth;
			el.classList.add("is-target");
		});
	};
	if (route.value !== "wall") {
		go("wall");
		requestAnimationFrame(() => requestAnimationFrame(run));
	} else run();
}

export function toggleTheme(): void {
	const dark =
		theme.value === "dark" ||
		(theme.value === "system" && !matchMedia("(prefers-color-scheme: light)").matches);
	setTheme(dark ? "light" : "dark");
}

export function toggleLang(): void {
	setLang(lang.value === "es" ? "en" : "es");
}

/** The clean view's styles load the first time it is turned on; it turns on once they are in (no unstyled frame). */
let cleanStyles: Promise<void> | null = null;
let wantClean = false;

export function setCleanView(on: boolean): void {
	wantClean = on;
	if (!on) {
		cleanView.value = false;
		delete document.documentElement.dataset.view;
		return;
	}
	if (route.value !== "wall") go("wall");
	cleanStyles ??= import("../styles/clean.css?inline").then((m) => addStyles(m.default));
	cleanStyles.then(
		() => {
			if (!wantClean) return;
			cleanView.value = true;
			document.documentElement.dataset.view = "clean";
		},
		() => {
			cleanStyles = null;
		},
	);
}

function typing(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	return (
		target.isContentEditable ||
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement
	);
}

function onKey(e: KeyboardEvent): void {
	if (e.defaultPrevented || e.isComposing) return;
	const k = e.key;
	if ((e.ctrlKey || e.metaKey) && !e.altKey && (k === "k" || k === "K")) {
		e.preventDefault();
		helpOpen.value = false;
		paletteOpen.value = !paletteOpen.value;
		return;
	}
	if (k === "Escape") {
		// Open dialogs close themselves (native <dialog> cancel); this handles what is left.
		if (paletteOpen.value || helpOpen.value || document.querySelector("dialog[open]")) return;
		if (cleanView.value) setCleanView(false);
		else if (selectedState.value) selectedState.value = null;
		return;
	}
	if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
	// Space and Enter on a focused button or link are the reader's own action (Tab to "close", Space): never eaten.
	const onControl =
		e.target instanceof HTMLElement && e.target.closest("button, a, summary, [role=menuitem]");
	if (paletteOpen.value && k.length === 1 && !onControl) {
		e.preventDefault();
		typedAhead += k;
		return;
	}
	if (paletteOpen.value || helpOpen.value || document.querySelector("dialog[open]")) return;
	if (!letterKeys.value) return;
	const handler = SINGLE[k] ?? SINGLE[k.toLowerCase()] ?? digit(k);
	if (!handler) return;
	e.preventDefault();
	handler();
}

/** 1–9: the nth panel. */
function digit(k: string): (() => void) | undefined {
	const id = /^[1-9]$/.test(k) ? panelKeyOrder()[Number(k) - 1] : undefined;
	return id ? () => jumpTo(id) : undefined;
}

const SINGLE: Record<string, () => void> = {
	"/": () => {
		typedAhead = "";
		paletteOpen.value = true;
	},
	"?": () => {
		helpOpen.value = true;
	},
	v: () => setCleanView(!cleanView.value),
	t: toggleTheme,
	e: toggleLang,
	l: () => mapAction({ action: "cycle-layer" }),
	q: () => mapAction({ action: "toggle-quakes" }),
	s: () => mapAction({ action: "share" }),
	m: () => jumpTo("mapa"),
};

/** Installs the listener; returns the uninstaller. */
export function installKeys(): () => void {
	addEventListener("keydown", onKey);
	return () => removeEventListener("keydown", onKey);
}
