import { useEffect } from "preact/hooks";
import { OfflineBanner, RoutePage } from "../../App.tsx";
import { addStyles } from "../../lib/css.ts";
import { connection, health, metaById, now, version } from "../../lib/data.ts";
import { fullStamp } from "../../lib/format.ts";
import { lang, t } from "../../lib/i18n.ts";
import { deskKeys, helpOpen } from "../../lib/keys.ts";
import { isPanelId, revealHook } from "../../lib/layout.ts";
import { MODULE_BY_ID, MODULES, moduleOfPanel } from "../../lib/modules.ts";
import { moduleId, openEntity, openModule, route } from "../../lib/router.ts";
import { STATE_SLUG } from "../../lib/states.ts";
import { selectedEntity, selectedState } from "../../map/view.ts";
import wsCss from "../../styles/workstation.css?inline";
import { CommandBar } from "./CommandBar.tsx";
import { Inspector, InspectorTab } from "./Inspector.tsx";
import { Rail } from "./Rail.tsx";
import { Strip } from "./Strip.tsx";
import { inspectorOpen, toggleInspector, toggleStrip } from "./state.ts";
import { ModuleView, Situation } from "./Workspace.tsx";

addStyles(wsCss);

/**
 * The desk (≥1000 px): a fixed-viewport workstation. Command bar on top; the rail of modules on the left; the open
 * module in the middle (Situación is the map); the inspector on the right with whatever is selected; the priority
 * list and the event log along the bottom; a status line under everything. Nothing scrolls the page itself: each
 * column scrolls on its own. Phones keep the one calm scrolling page (ui/Wall.tsx); this chunk is not in their first load.
 */

/** "hace 42 s": the status line is the one place where seconds matter. */
function agoShort(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	const text = s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
	return t(`hace ${text}`, `${text} ago`);
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
			class="status__item"
			title={`${t("Dato más reciente", "Newest datum")}: ${name} · ${fullStamp(best.at, lang.value)}`}
		>
			{t("último dato", "newest datum")} <span class="mono">{agoShort(now.value - best.at)}</span>
			<span class="status__dim"> · {name}</span>
		</span>
	);
}

function StatusLine() {
	const c = connection.value;
	return (
		<footer class="status">
			<span class={`status__item status__conn status__conn--${c}`}>
				<span class="live-dot" aria-hidden="true" />
				{c === "live"
					? t("Conectado", "Connected")
					: c === "offline"
						? t("Sin conexión: últimos datos guardados", "Offline: last saved data")
						: t("Conectando…", "Connecting…")}
			</span>
			<Newest />
			<button type="button" class="status__keys" onClick={() => (helpOpen.value = true)}>
				<kbd>/</kbd> {t("buscar", "search")} <kbd>1–0</kbd> {t("módulos", "modules")} <kbd>I</kbd>{" "}
				{t("inspector", "inspector")} <kbd>B</kbd> {t("registro", "log")} <kbd>P</kbd> {t("ficha", "page")}{" "}
				<kbd>L</kbd> {t("capas", "layers")} <kbd>?</kbd> {t("atajos", "shortcuts")}
			</button>
			<span class="status__item status__right">
				Vigía {version.value ? <span class="mono">{version.value}</span> : null}
			</span>
		</footer>
	);
}

/** Desk keys: 1–0 open modules, I the inspector, B the strip, P the selected place's page. */
function useDeskKeys(): void {
	useEffect(() => {
		for (const m of MODULES) deskKeys[m.key] = () => openModule(m.id);
		deskKeys.i = () => toggleInspector();
		deskKeys.b = () => toggleStrip();
		deskKeys.p = () => {
			const slug = STATE_SLUG.get(selectedState.value ?? "");
			const id = selectedEntity.value ?? (slug ? `ve.${slug}` : null);
			if (id) openEntity(id);
		};
		// "Go to panel X" from the palette, a link or a key opens the module that holds it first.
		revealHook.current = (id) => {
			if (id === "mapa") {
				openModule("situacion");
				return true;
			}
			if (!isPanelId(id)) return false;
			// Incidents and "Lo inusual ahora" live in the inspector (nothing selected).
			if (id === "incidentes" || id === "inusual") {
				if (!inspectorOpen.value) toggleInspector(true);
				if (selectedState.value) selectedState.value = null;
				return true;
			}
			openModule(moduleOfPanel(id).id);
			return true;
		};
		return () => {
			for (const k of Object.keys(deskKeys)) delete deskKeys[k];
			revealHook.current = null;
		};
	}, []);
}

export function Workstation() {
	useDeskKeys();
	const r = route.value;
	const m = MODULE_BY_ID.get(moduleId.value) ?? MODULES[0];
	const page = r !== "wall";
	// A secondary page or a place's own page takes the whole canvas; the inspector returns with the room.
	const insp = inspectorOpen.value && !page;
	// A page brings its own <main>; the room and the modules get one here, with a heading that names the view
	// (whole-release review, M17: the desk had no main landmark, no h1, no skip link).
	const Main = page ? "div" : "main";
	return (
		<div class={`ws${insp ? "" : " ws--no-insp"}${page ? " ws--page" : ""}`}>
			<a class="skip-link" href="#main">
				{t("Saltar al contenido", "Skip to content")}
			</a>
			<CommandBar />
			<Rail />
			{/* tabIndex -1: the skip link's target takes focus (a page's own <main> sits inside it). */}
			<Main class="ws__main" id="main" tabIndex={-1}>
				{page ? null : <h1 class="sr-only">{`Vigía · ${t(m?.es ?? "Situación", m?.en ?? "Situation")}`}</h1>}
				<OfflineBanner />
				{page ? (
					<div class="ws__page">
						<RoutePage />
					</div>
				) : m && m.id !== "situacion" ? (
					<ModuleView key={m.id} m={m} />
				) : (
					<Situation />
				)}
			</Main>
			{page ? null : <Strip />}
			{page ? null : insp ? <Inspector /> : <InspectorTab />}
			<StatusLine />
		</div>
	);
}
