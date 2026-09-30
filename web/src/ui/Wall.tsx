import { useEffect } from "preact/hooks";
import { connection } from "../lib/data.ts";
import { t } from "../lib/i18n.ts";
import {
	announcement,
	type Column,
	hiddenPanels,
	type PanelId,
	reveal,
	shouldOnboard,
	viewport,
	visibleOrder,
} from "../lib/layout.ts";
import { later } from "../lib/lazy.tsx";
import { panelName } from "../lib/summary.ts";
import { pickedPoint, selectedEntity, selectedState } from "../map/view.ts";
import { Priority } from "../panels/Ahora.tsx";
import { MapPanel } from "../panels/MapPanel.tsx";
import { Pulse } from "../panels/Pulse.tsx";
import { ReportRow } from "./crowd/Entry.tsx";
import { PanelSlot, prefetchPanels } from "./LazyPanel.tsx";
import { TabBar } from "./TabBar.tsx";

/** Only when a state is selected on the map. */
const StatePanel = later(() => import("../panels/StatePanel.tsx").then((m) => m.StatePanel));
const LazyOnboarding = later(() => import("./Onboarding.tsx").then((m) => m.Onboarding));

function StateSlot() {
	return selectedState.value || selectedEntity.value || pickedPoint.value ? <StatePanel /> : null;
}

/** First visit only (see shouldOnboard); everyone else never downloads the preset sheet. */
const onboard = shouldOnboard();
function Onboarding() {
	return onboard ? <LazyOnboarding /> : null;
}

/**
 * On a screen wider than a phone every open panel shows its body, so once the first data is on screen and the
 * page is idle, the bodies not yet near the view load one by one (a scrolling column then never shows a
 * skeleton). Phones load a body only when its panel is opened.
 */
function usePrefetch(vp: string): void {
	const ready = connection.value !== "connecting";
	useEffect(() => {
		if (vp === "phone" || !ready) return;
		const idle = (fn: () => void) =>
			"requestIdleCallback" in window ? requestIdleCallback(fn, { timeout: 4000 }) : setTimeout(fn, 1500);
		const timer = setTimeout(() => idle(() => void prefetchPanels(visibleOrder.peek())), 1500);
		return () => clearTimeout(timer);
	}, [vp, ready]);
}

function list(ids: readonly PanelId[]) {
	return ids.map((id) => <PanelSlot key={id} id={id} />);
}

/** "Paneles ocultos (3)" at the foot of a column: each one comes back with one tap. */
function Hidden({ column }: { column?: Column }) {
	const ids = hiddenPanels(column);
	if (!ids.length) return null;
	return (
		<details class="hidden-panels">
			<summary>{t(`Paneles ocultos (${ids.length})`, `Hidden panels (${ids.length})`)}</summary>
			<ul>
				{ids.map((id) => (
					<li key={id}>
						<span>{panelName(id)}</span>
						<button type="button" class="chip" onClick={() => reveal(id, true)}>
							{t("Mostrar", "Show")}
						</button>
					</li>
				))}
			</ul>
		</details>
	);
}

function Announcer() {
	return (
		<p class="sr-only" aria-live="polite">
			{announcement.value}
		</p>
	);
}

/**
 * The room on a phone or a narrow screen (below 1000 px; desks get the workstation, ui/ws/Workstation.tsx): one
 * list in the reader's order, the priority list first and the map after the first two panels. On a phone every
 * panel starts as a summary row and a tab bar sits at the bottom.
 */
export function Wall() {
	const vp = viewport.value;
	usePrefetch(vp);
	const order = visibleOrder.value;
	return (
		<>
			<main class={`wall wall--flow${vp === "phone" ? " wall--phone" : ""}`}>
				{/* The page's heading, for screen readers (the room shows its sections' titles instead). */}
				<h1 class="sr-only">
					{t("Vigía · Situación de Venezuela ahora", "Vigía · Venezuela's situation now")}
				</h1>
				<div class="wall__pulse">
					<Priority />
					{vp === "phone" ? <ReportRow /> : <Pulse />}
				</div>
				<div class="wall__rows">{list(order.slice(0, 2))}</div>
				<div class="wall__map">
					<MapPanel />
				</div>
				<StateSlot />
				<div class="wall__rows wall__rows--more">{list(order.slice(2))}</div>
				<Hidden />
				<Announcer />
			</main>
			{vp === "phone" ? <TabBar /> : null}
			<Onboarding />
		</>
	);
}
