import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { arrange, shownColumns } from "../../lib/arrange.ts";
import { connection } from "../../lib/data.ts";
import { lang, t } from "../../lib/i18n.ts";
import { deskHook, layout, type PanelId, showPanel } from "../../lib/layout.ts";
import { MODULES, type ModuleDef, moduleName } from "../../lib/modules.ts";
import { stateName } from "../../lib/states.ts";
import { panelName } from "../../lib/summary.ts";
import { selectedState } from "../../map/view.ts";
import { MapPanel } from "../../panels/MapPanel.tsx";
import { Pulse } from "../../panels/Pulse.tsx";
import { PanelSlot, prefetchPanels } from "../LazyPanel.tsx";

const threeQuery = matchMedia("(min-width: 1700px)");
/** ≥1700 px the canvas has room for a module's third column. */
const threeColumns = signal(threeQuery.matches);
threeQuery.addEventListener("change", () => {
	threeColumns.value = threeQuery.matches;
});

// A panel's place among its module's shown columns, for the ⋯ menu's moves and Alt+↑/↓ (lib/layout.ts).
deskHook.placement = (id) => {
	const m = MODULES.find((x) => x.columns.some((c) => c.includes(id)));
	if (!m) return null;
	const l = layout.value;
	const shown = shownColumns(m, arrange(m, l.order, l.hidden, l.deskColumn), threeColumns.value);
	const col = shown.findIndex((c) => c.panels.includes(id));
	if (col === -1) return null;
	return {
		col,
		cols: shown.length,
		peers: shown[col]?.panels ?? [],
		target: (by) => shown[col + by]?.from[0] ?? null,
	};
};

/** Panels that follow the selected place today; the module header says so (never a silent filter). */
const FOLLOWS: ReadonlySet<PanelId> = new Set(["noticias", "sismos", "conectividad", "incendios", "gdelt"]);

/** Situación: the vital signs over the map, its layer stack and its time machine. */
export function Situation() {
	return (
		<section class="sit" aria-label={t("Situación", "Situation")}>
			<Pulse />
			<div class="sit__canvas">
				<MapPanel />
			</div>
		</section>
	);
}

/** A module: its panels in columns that scroll on their own; the page itself never scrolls. */
export function ModuleView({ m }: { m: ModuleDef }) {
	const l = lang.value;
	const lay = layout.value;
	const hidden = lay.hidden;
	// The reader's arrangement (Personalizar and each panel's ⋯ menu): order, column, hidden. Three columns need a
	// wide canvas; below it the third joins the second (each column scrolls anyway).
	const columns = shownColumns(m, arrange(m, lay.order, hidden, lay.deskColumn), threeColumns.value);
	const hiddenHere = m.columns.flat().filter((id) => hidden.includes(id));
	const iso = selectedState.value;
	const following = m.columns.flat().filter((id) => FOLLOWS.has(id));
	const ready = connection.value !== "connecting";
	// Bodies of this module's panels load at once (they are all on screen); other modules load on their first visit.
	useEffect(() => {
		if (ready) void prefetchPanels(columns.flatMap((c) => c.panels));
	}, [m.id, ready]);
	return (
		<section class="mod" aria-labelledby="mod-title">
			<header class="mod__head">
				<h1 class="mod__title" id="mod-title">
					{moduleName(m, l)}
				</h1>
				<p class="mod__q">{l === "es" ? m.qEs : m.qEn}</p>
				{iso ? (
					<p class="mod__scope">
						{following.length
							? t(
									`${following.map((id) => panelName(id)).join(", ")}: filtrado por ${stateName(iso)}; el resto, todo el país`,
									`${following.map((id) => panelName(id)).join(", ")}: filtered to ${stateName(iso)}; the rest, the whole country`,
								)
							: t(
									`Estos paneles cubren todo el país; ${stateName(iso)} está en el inspector`,
									`These panels cover the whole country; ${stateName(iso)} is in the inspector`,
								)}
					</p>
				) : null}
				{hiddenHere.length ? (
					<div class="mod__hidden">
						<span>
							{t(
								`${hiddenHere.length} oculto${hiddenHere.length > 1 ? "s" : ""}:`,
								`${hiddenHere.length} hidden:`,
							)}
						</span>
						{hiddenHere.map((id) => (
							<button key={id} type="button" class="btn btn--quiet" onClick={() => showPanel(id)}>
								{panelName(id)}
							</button>
						))}
					</div>
				) : null}
			</header>
			<div
				class="mod__cols"
				style={{ gridTemplateColumns: columns.map((c) => `minmax(0, ${c.width}fr)`).join(" ") }}
			>
				{columns.map((col) => (
					<div class="mod__col" key={col.from.join()}>
						{col.panels.map((id) => (
							<PanelSlot key={id} id={id} />
						))}
					</div>
				))}
			</div>
		</section>
	);
}
