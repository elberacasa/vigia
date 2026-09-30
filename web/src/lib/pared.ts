import { useEffect } from "preact/hooks";
import { type PanelId, viewport, visibleOrder, wallFocus } from "./layout.ts";
import { density } from "./prefs.ts";
import { summarize } from "./summary.ts";

/**
 * Pared (wall display): one panel at a time is shown in full, rotating every 45 s among the panels whose summary is
 * not normal. With one such panel it stays; with none, nothing moves. Returns whether it is on and how many rotate.
 */
export function usePared(): { on: boolean; count: number } {
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
