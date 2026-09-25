import type { FunctionComponent } from "preact";
import { useEffect, useState } from "preact/hooks";
import { t } from "../lib/i18n.ts";
import { cleanView, helpOpen, installKeys, paletteOpen, setCleanView } from "../lib/keys.ts";
import { shading, showQuakes } from "../panels/MapPanel.tsx";
import { Announcer } from "./Digits.tsx";
import { loadDesk } from "./StatusBar.tsx";

/**
 * Command palette (/ or Ctrl/⌘K; the search button on phones) and keyboard shortcuts (?). This shell is in the
 * first load; the search itself (index of ~600 places, panels, layers, sources and commands, ~9 KB gzip) is a
 * separate chunk fetched when the page is idle or on first use, so it never delays the first paint.
 */

let loading: Promise<FunctionComponent> | null = null;
function loadSearch(): Promise<FunctionComponent> {
	loading ??= import("./PaletteSearch.tsx").then((m) => m.default);
	return loading;
}

function LazySearch() {
	const [Search, setSearch] = useState<FunctionComponent | null>(null);
	const open = paletteOpen.value;
	useEffect(() => {
		if (!open || Search) return;
		loadSearch()
			.then((c) => setSearch(() => c))
			.catch(() => {
				// Offline before the chunk was ever fetched: nothing to search with; say so instead of hanging.
				paletteOpen.value = false;
			});
	}, [open, Search]);
	return Search ? <Search /> : null;
}

/** The shortcuts sheet lives in the desktop chunk; on a phone it loads the first time it is asked for. */
function LazyHelp() {
	const [Help, setHelp] = useState<FunctionComponent | null>(null);
	const open = helpOpen.value;
	useEffect(() => {
		if (!open || Help) return;
		loadDesk()
			.then((m) => setHelp(() => m.HelpDialog))
			.catch(() => {
				helpOpen.value = false;
			});
	}, [open, Help]);
	return Help ? <Help /> : null;
}

/** Who each map layer's data comes from, for the clean view's caption (a screenshot must carry its sources). */
const LAYER_SOURCES: Record<string, string> = {
	connectivity: "IODA (Georgia Tech)",
	nightlights: "NASA GIBS / Black Marble (VIIRS)",
	satellite: "NOAA/NESDIS/STAR, GOES-19",
	reports: "titulares de medios venezolanos, ubicación por palabra clave",
	fires: "NASA FIRMS (VIIRS NOAA-20)",
	aiBlackouts: "noticias clasificadas por un modelo de IA (puede equivocarse)",
};

function CleanViewNote() {
	if (!cleanView.value) return null;
	const layer = LAYER_SOURCES[shading.value] ?? "";
	return (
		<>
			<button type="button" class="clean-note" onClick={() => setCleanView(false)}>
				{t("Vista limpia · V o Esc para salir", "Clean view · V or Esc to exit")}
			</button>
			<p class="clean-sources">
				{t("Datos", "Data")}: {layer}
				{showQuakes.value ? " · USGS, FUNVISIS" : ""} · {t("límites", "boundaries")}: INE {t("vía", "via")}{" "}
				OCHA/HDX ·{" "}
				{t(
					"Vigía, código abierto: cada cifra con su fuente y su hora",
					"Vigía, open source: every figure with its source and time",
				)}
			</p>
		</>
	);
}

export function SearchIcon() {
	return (
		<svg class="search-icon" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">
			<circle cx="8.5" cy="8.5" r="5.75" fill="none" stroke="currentColor" stroke-width="1.8" />
			<path d="M13 13l4.25 4.25" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
		</svg>
	);
}

/** The header's search button: an icon on phones, "Buscar /" on desktop. */
export function PaletteButton() {
	return (
		<button
			type="button"
			class="palette-btn"
			aria-label={t("Buscar (atajo: /)", "Search (shortcut: /)")}
			aria-haspopup="dialog"
			onClick={() => (paletteOpen.value = true)}
		>
			<SearchIcon />
			<span class="palette-btn__text">{t("Buscar", "Search")}</span>
			<kbd class="palette-btn__kbd">/</kbd>
		</button>
	);
}

/** Mount once in App: the palette, the shortcuts sheet, the clean-view note, the figure announcer and the keys. */
export function Palette() {
	useEffect(() => installKeys(), []);
	useEffect(() => {
		// Fetch the search chunk once the page has settled, so it is instant later and cached for offline use.
		const idle = setTimeout(() => void loadSearch().catch(() => {}), 6_000);
		return () => clearTimeout(idle);
	}, []);
	return (
		<>
			<LazySearch />
			<LazyHelp />
			<CleanViewNote />
			<Announcer />
		</>
	);
}
