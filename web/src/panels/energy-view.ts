import { num } from "../lib/format.ts";
import { t } from "../lib/i18n.ts";

/* Mirrors src/panels/energy.ts (the server computes every figure; this file only formats). */

export type FlareStatus = "no-data" | "no-baseline" | "usual" | "up" | "down" | "dark" | "new" | "quiet";
export interface FlareWindow {
	nights: number;
	nightsWithData: number;
	activeNights: number;
	detections: number;
	frpSumMW: number;
	meanNightFrpMW: number | null;
}
export interface FacilityRow {
	id: string;
	nameEs: string;
	nameEn: string;
	kind: "refinery" | "complex" | "oil-field" | "gas-field";
	stateName: string | null;
	operatorEs: string;
	noteEs: string | null;
	lat: number;
	lon: number;
	d7: FlareWindow;
	d30: FlareWindow;
	d90: FlareWindow;
	baseline: FlareWindow;
	ratio: number | null;
	status: FlareStatus;
	nights30: { date: string; frpMW: number | null }[];
	lastDetectionAt: number | null;
	ggfr2025MillionM3: number | null;
	url: string;
	sources: { label: string; url: string }[];
}
export interface EnergyView {
	latestNight: string | null;
	firstNight: string | null;
	nightsWithData90: number;
	facilities: FacilityRow[];
	quietCount: number;
	venezuela: { d7: FlareWindow; baseline: FlareWindow; ratio: number | null; status: FlareStatus };
	lit7: number;
	newestDetectionAt: number | null;
	rules: { es: string; en: string; minBaselineNights: number };
	facilityRule: string;
	facilitySources: { label: string; url: string }[];
	caveatEs: string;
	caveatEn: string;
	attribution: string;
	sourceUrl: string;
}

export const STATUS: Record<
	FlareStatus,
	{ es: string; en: string; tone: "ok" | "warn" | "alert" | "muted" }
> = {
	"no-data": { es: "pocas noches con datos", en: "few nights with data", tone: "muted" },
	"no-baseline": { es: "sin línea base aún", en: "no baseline yet", tone: "muted" },
	usual: { es: "habitual", en: "usual", tone: "ok" },
	up: { es: "más que lo habitual", en: "above usual", tone: "warn" },
	down: { es: "menos que lo habitual", en: "below usual", tone: "warn" },
	dark: { es: "sin llama vista", en: "no flame seen", tone: "alert" },
	new: { es: "actividad nueva", en: "new activity", tone: "warn" },
	quiet: { es: "sin actividad", en: "no activity", tone: "muted" },
};

/** Status worth a word in the collapsed summary and on the map. */
export const NOTABLE: readonly FlareStatus[] = ["dark", "up", "down", "new"];

/**
 * For the map (owned by the map module): one point per facility, at its centroid, with a tone and a 0..1 weight
 * from its 7-night mean radiative power. The layer can draw them as it likes; the label says what the point is.
 */
export function energyPoints(view: EnergyView | undefined): {
	id: string;
	lat: number;
	lon: number;
	label: string;
	tone: "ok" | "warn" | "alert" | "muted";
	weight: number;
	kind: FacilityRow["kind"];
}[] {
	if (!view) return [];
	const max = Math.max(1, ...view.facilities.map((f) => f.d7.meanNightFrpMW ?? 0));
	return view.facilities.map((f) => ({
		id: f.id,
		lat: f.lat,
		lon: f.lon,
		label: t(
			`${f.nameEs}: ${f.d7.meanNightFrpMW === null ? "sin datos" : `${num(f.d7.meanNightFrpMW, 1, "es")} MW por noche, 7 noches`} (${STATUS[f.status].es})`,
			`${f.nameEn}: ${f.d7.meanNightFrpMW === null ? "no data" : `${num(f.d7.meanNightFrpMW, 1, "en")} MW per night, 7 nights`} (${STATUS[f.status].en})`,
		),
		tone: STATUS[f.status].tone,
		weight: Math.sqrt((f.d7.meanNightFrpMW ?? 0) / max),
		kind: f.kind,
	}));
}
