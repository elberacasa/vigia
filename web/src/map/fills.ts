import { t } from "../lib/i18n.ts";
import type { ConnectivityView, Level } from "../panels/Connectivity.tsx";
import type { FiresView } from "../panels/Earth.tsx";
import type { StateFill } from "./Map.tsx";

/* State fills for the map's choropleth layers, in the first load (the panels they mirror load on demand). */

export function levelLabel(level: Level): string {
	switch (level) {
		case "normal":
			return t("Normal", "Normal");
		case "drop":
			return t("Caída de señal", "Signal drop");
		case "severe":
			return t("Caída fuerte", "Severe drop");
		case "no-data":
			return t("Sin datos", "No data");
	}
}

/** Map fills for the connectivity layer. */
export function connectivityFills(view: ConnectivityView | undefined): Record<string, StateFill> {
	const fills: Record<string, StateFill> = {};
	for (const s of view?.states ?? []) {
		const iso = s.kind === "state" ? s.id : null;
		if (!iso) continue;
		const tone = s.level === "normal" ? "ok" : s.level === "no-data" ? "nodata" : s.level;
		fills[iso] = { tone, label: `${levelLabel(s.level)}. ${s.headline}` };
	}
	return fills;
}

export function fireFills(view: FiresView | undefined): Record<string, StateFill> {
	const fills: Record<string, StateFill> = {};
	const max = Math.max(1, ...(view?.byState ?? []).map((s) => s.likelyFires24h));
	for (const s of view?.byState ?? []) {
		if (s.likelyFires24h === 0) continue;
		fills[s.stateIso] = {
			tone: "signal",
			intensity: Math.sqrt(s.likelyFires24h / max),
			label: t(
				`${s.likelyFires24h} ${s.likelyFires24h === 1 ? "detección" : "detecciones"} de calor en 24 h`,
				`${s.likelyFires24h} heat ${s.likelyFires24h === 1 ? "detection" : "detections"} in 24 h`,
			),
		};
	}
	return fills;
}
