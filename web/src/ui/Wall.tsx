import { useEffect } from "preact/hooks";
import { connection } from "../lib/data.ts";
import { t } from "../lib/i18n.ts";
import {
	announcement,
	type Column,
	hiddenPanels,
	inColumn,
	type PanelId,
	reveal,
	shouldOnboard,
	viewport,
	visibleOrder,
	wallFocus,
} from "../lib/layout.ts";
import { later } from "../lib/lazy.tsx";
import { density } from "../lib/prefs.ts";
import { panelName, summarize } from "../lib/summary.ts";
import { selectedState } from "../map/view.ts";
import { Ahora } from "../panels/Ahora.tsx";
import { MapPanel } from "../panels/MapPanel.tsx";
import { Pulse } from "../panels/Pulse.tsx";
import { PanelSlot, prefetchPanels } from "./LazyPanel.tsx";
import { TabBar } from "./TabBar.tsx";

/** Only when a state is selected on the map. */
const StatePanel = later(() => import("../panels/StatePanel.tsx").then((m) => m.StatePanel));
const LazyOnboarding = later(() => import("./Onboarding.tsx").then((m) => m.Onboarding));

function StateSlot() {
	return selectedState.value ? <StatePanel /> : null;
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

/**
 * Pared (wall display): side panels show their summary rows and one opens at a time, rotating every 45 s among
 * the panels whose summary is not normal. With one such panel it stays open; with none, nothing moves.
 */
function usePared(): { on: boolean; count: number } {
	const on = density.value === "pared" && viewport.value !== "phone";
	const candidates = on
		? visibleOrder.value.filter((id) => (summarize(id)?.tone ?? "normal") !== "normal")
		: [];
	const key = candidates.join(",");
	useEffect(() => {
		const ids = key ? (key.split(",") as PanelId[]) : [];
		if (!on || !ids.length) {
			wallFocus.value = null;
			return;
		}
		let i = Math.max(0, ids.indexOf(wallFocus.value as PanelId));
		wallFocus.value = ids[i] ?? null;
		if (ids.length < 2) return;
		const timer = setInterval(() => {
			i = (i + 1) % ids.length;
			wallFocus.value = ids[i] ?? null;
		}, 45_000);
		return () => clearInterval(timer);
	}, [on, key]);
	return { on, count: candidates.length };
}

function ParedNote({ count }: { count: number }) {
	return (
		<p class="wall__note">
			{count === 0
				? t(
						"Modo pared: todo está normal, así que nada rota.",
						"Wall mode: everything is normal, so nothing rotates.",
					)
				: count === 1
					? t(
							"Modo pared: abierto el único panel fuera de lo normal.",
							"Wall mode: the one panel out of the ordinary is open.",
						)
					: t(
							`Modo pared: rotan cada 45 s los ${count} paneles fuera de lo normal.`,
							`Wall mode: the ${count} panels out of the ordinary rotate every 45 s.`,
						)}
		</p>
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
 * The wall, laid out by viewport:
 * - wide (≥1500 px): one fixed composition, left column · map · right column; the columns scroll inside
 *   themselves and the page does not;
 * - mid (1000–1499 px): the map beside the right column in one screen-high frame, the other panels below in
 *   masonry columns;
 * - narrow and phone: one list in the reader's order with the map after the first two panels; on a phone every
 *   panel starts as a summary row and a tab bar sits at the bottom.
 */
export function Wall() {
	const vp = viewport.value;
	const pared = usePared();
	usePrefetch(vp);
	const pulse = (
		<div class="wall__pulse">
			<Ahora />
			{vp === "phone" ? null : <Pulse />}
		</div>
	);
	if (vp === "wide") {
		return (
			<>
				<main class="wall wall--wide">
					{pulse}
					<div class="wall__col wall__col--left">
						{pared.on ? <ParedNote count={pared.count} /> : null}
						{list(inColumn("left"))}
						<Hidden column="left" />
					</div>
					<div class="wall__map">
						<MapPanel />
					</div>
					<div class="wall__col wall__col--right">
						<StateSlot />
						{list(inColumn("right"))}
						<Hidden column="right" />
					</div>
					<Announcer />
				</main>
				<Onboarding />
			</>
		);
	}
	if (vp === "mid") {
		return (
			<>
				<main class="wall wall--mid">
					{pulse}
					<div class="wall__frame">
						<div class="wall__map">
							<MapPanel />
						</div>
						<div class="wall__col wall__col--right">
							<StateSlot />
							{list(inColumn("right"))}
						</div>
					</div>
					{pared.on ? <ParedNote count={pared.count} /> : null}
					<div class="wall__more">{list(inColumn("left"))}</div>
					<Hidden />
					<Announcer />
				</main>
				<Onboarding />
			</>
		);
	}
	const order = visibleOrder.value;
	return (
		<>
			<main class={`wall wall--flow${vp === "phone" ? " wall--phone" : ""}`}>
				{pulse}
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
