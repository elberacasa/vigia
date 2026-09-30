import { connection, health, now } from "../../lib/data.ts";
import { clock } from "../../lib/format.ts";
import { feedCounts } from "../../lib/fresh.ts";
import { lang, setLang, t } from "../../lib/i18n.ts";
import { paletteOpen, toggleTheme } from "../../lib/keys.ts";
import { MODULE_BY_ID } from "../../lib/modules.ts";
import { theme } from "../../lib/prefs.ts";
import { entityTitle, link, moduleId, route } from "../../lib/router.ts";
import { stateName } from "../../lib/states.ts";
import { selectedState, selectState } from "../../map/view.ts";
import { ReportButton } from "../crowd/Entry.tsx";
import { CustomizeButton } from "../custom/Entry.tsx";
import { LiveMark, Wordmark } from "../Logo.tsx";
import { SearchIcon } from "../Palette.tsx";
import { PrefsMenu } from "../Prefs.tsx";

const PAGE_TITLE: Record<string, { es: string; en: string }> = {
	status: { es: "Estado de las fuentes", en: "Feed status" },
	sources: { es: "Fuentes y licencias", en: "Sources and licences" },
	guide: { es: "Configurar y claves", en: "Set up and keys" },
	ai: { es: "Capa IA", en: "AI layer" },
	brief: { es: "Resumen del día", en: "Daily brief" },
	bloqueos: { es: "Consulta de bloqueos", en: "Block lookup" },
	entity: { es: "Ficha", en: "Page" },
};

/** Where the reader is: module (or page) and the selected place, the scope every linked view follows. */
function Crumbs() {
	const l = lang.value;
	const r = route.value;
	const m = MODULE_BY_ID.get(moduleId.value);
	const title = r === "wall" ? (m ? (l === "es" ? m.es : m.en) : "") : (PAGE_TITLE[r]?.[l] ?? "");
	const iso = selectedState.value;
	const place = r === "entity" && entityTitle.value ? [entityTitle.value] : [];
	return (
		<div class="cmd__crumbs">
			<span class="cmd__module">{title}</span>
			{place.length ? (
				<span class="cmd__place">
					<span class="cmd__sep" aria-hidden="true">
						/
					</span>
					{place[0]}
				</span>
			) : null}
			{r === "wall" && iso ? (
				<span class="cmd__scope">
					<span class="cmd__sep" aria-hidden="true">
						/
					</span>
					<span class="scope-chip">
						<span class="scope-chip__label">{t("Lugar", "Place")}</span>
						<span class="scope-chip__name">{stateName(iso)}</span>
						<button
							type="button"
							class="scope-chip__x"
							aria-label={t(
								`Quitar la selección de ${stateName(iso)}`,
								`Clear the ${stateName(iso)} selection`,
							)}
							title={t("Quitar la selección (Esc)", "Clear the selection (Esc)")}
							onClick={() => selectState(null)}
						>
							<svg class="ico" viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">
								<path d="M2 2l6 6M8 2 2 8" />
							</svg>
						</button>
					</span>
				</span>
			) : null}
		</div>
	);
}

/** Feed health in one line: the same count as /estado (lib/fresh.ts), each state with a shape and a word. */
function Health() {
	const c = feedCounts(health.value);
	return (
		<a
			class="cmd__health"
			{...link("status")}
			title={t(
				"Fuentes con datos dentro de su plazo, de las activadas (sin contar las apagadas ni las que necesitan clave). Abre el estado de las fuentes.",
				"Feeds with data inside their budget, of those turned on (not counting off feeds or ones that need a key). Opens the feed status.",
			)}
		>
			<span class="cmd__health-item">
				<span class="dot dot--ok" aria-hidden="true" />
				<span class="mono">
					{c.live}/{c.enabled}
				</span>{" "}
				{t("al día", "current")}
			</span>
			{c.late ? (
				<span class="cmd__health-item cmd__health-item--warn">
					<span class="dot dot--stale" aria-hidden="true" />
					<span class="mono">{c.late}</span> {t("con retraso", "delayed")}
				</span>
			) : null}
			{c.down ? (
				<span class="cmd__health-item cmd__health-item--alert">
					<span class="dot dot--failing" aria-hidden="true" />
					<span class="mono">{c.down}</span> {t("sin conexión", "unreachable")}
				</span>
			) : null}
		</a>
	);
}

function Clock() {
	const live = connection.value === "live";
	return (
		<div
			class="cmd__clock"
			title={
				live
					? t("Conectado: los datos llegan en vivo", "Connected: data arrives live")
					: t("Sin conexión en vivo con Vigía", "No live connection to Vigía")
			}
		>
			<span class={`live-dot${live ? " is-live" : ""}`} aria-hidden="true" />
			<span class="caps">{t("Caracas", "Caracas")}</span>
			<time class="mono" dateTime={new Date(now.value).toISOString()}>
				{clock(now.value, lang.value, true)}
			</time>
		</div>
	);
}

/** The top bar of the desk: brand, where you are, the command palette, feed health, time and preferences. */
export function CommandBar() {
	const dark =
		theme.value === "dark" ||
		(theme.value === "system" && !matchMedia("(prefers-color-scheme: light)").matches);
	return (
		<header class="cmd">
			<a class="cmd__brand" {...link("wall")} title={t("Vigía: situación", "Vigía: situation")}>
				<LiveMark size={22} />
				<Wordmark height={11} />
			</a>
			<Crumbs />
			<button
				type="button"
				class="cmd__search"
				aria-haspopup="dialog"
				aria-label={t("Buscar y ejecutar (atajo: / o Ctrl K)", "Search and run (shortcut: / or Ctrl K)")}
				onClick={() => (paletteOpen.value = true)}
			>
				<SearchIcon />
				<span class="cmd__search-text">
					{t(
						"Buscar un lugar, instalación, red, institución, panel…",
						"Search a place, facility, network, institution, panel…",
					)}
				</span>
				<kbd>/</kbd>
				<kbd class="cmd__kbd2">Ctrl K</kbd>
			</button>
			<ReportButton class="btn btn--quiet cmd__report" />
			<Health />
			<Clock />
			<div class="cmd__tools">
				<button
					type="button"
					class="icon-btn cmd__lang"
					onClick={() => setLang(lang.value === "es" ? "en" : "es")}
					aria-label={t("Cambiar a inglés (E)", "Switch to Spanish (E)")}
					title={t("English (E)", "Español (E)")}
				>
					{lang.value === "es" ? "EN" : "ES"}
				</button>
				<button
					type="button"
					class="icon-btn"
					onClick={toggleTheme}
					aria-label={dark ? t("Tema claro (T)", "Light theme (T)") : t("Tema oscuro (T)", "Dark theme (T)")}
					title={dark ? t("Tema claro (T)", "Light theme (T)") : t("Tema oscuro (T)", "Dark theme (T)")}
				>
					<svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
						<circle cx="10" cy="10" r="6.2" fill="none" stroke="currentColor" stroke-width="1.5" />
						<path d="M10 3.8a6.2 6.2 0 0 1 0 12.4Z" fill="currentColor" />
					</svg>
				</button>
				<CustomizeButton />
				<PrefsMenu />
			</div>
		</header>
	);
}
