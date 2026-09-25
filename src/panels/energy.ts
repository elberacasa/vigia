import type { FireDetection, FireFile, FirmsValue } from "../adapters/firms-fires/index.ts";
import { FIRMS_LICENCE, firmsMapUrl } from "../adapters/firms-fires/index.ts";
import {
	FACILITY_LIST,
	type Facility,
	type FacilityKind,
	facilityFor,
} from "../adapters/firms-flares/facilities.ts";
import type { FlareFile, FlareValue } from "../adapters/firms-flares/index.ts";
import type { Store } from "../core/store.ts";
import { stateByIso } from "../geo/index.ts";
import type { Panel } from "../server/panels.ts";

/**
 * Oil and gas from space: a per-facility flaring index from VIIRS (NOAA-20) night-time hot pixels.
 *
 * Why night only: at night a flare is the hottest thing for kilometres and the sun adds nothing; by day, sunlit
 * roofs and tanks add noise. Every NOAA-20 night pass over Venezuela falls between 03:00 and 08:00 UTC (hour
 * histogram of the 2026-09-17..24 file), so a "night" is a UTC date.
 *
 * A night "has data" when a stored FIRMS file (the 7-day file of `firms-flares`, or the hourly 24 h file of
 * `firms-fires`) spans that date's 04:00–08:00 UTC. Nights without data are left out of every average, never
 * counted as zero. A night with data but no detection counts as zero: that includes cloudy nights, which is why
 * the index compares weeks, not nights.
 *
 * Index: mean night-time fire radiative power per night with data (MW), and the share of nights with at least one
 * detection. Status compares the last 7 nights with the baseline (the nights from 90 days back to 8 days back):
 * see `statusOf`.
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** A night counts as covered when a file spans [date 04:00Z, date 08:00Z]. */
const PASS_START_H = 4;
const PASS_END_H = 8;
export const RULES = {
	/** Minimum nights with data in the last 7 for any status. */
	minRecentNights: 4,
	/** Minimum baseline nights for a comparison. */
	minBaselineNights: 14,
	/** Ratio of the 7-night mean to the baseline mean at or above which the status is "up". */
	upRatio: 2,
	/** At or below which it is "down". */
	downRatio: 0.5,
	/** A facility "usually lit" has detections on at least this share of baseline nights. */
	usuallyLitShare: 0.5,
} as const;

export type FlareStatus = "no-data" | "no-baseline" | "usual" | "up" | "down" | "dark" | "new" | "quiet";

export type FlareWindow = {
	/** Calendar nights in the window. */
	nights: number;
	/** Of those, nights with FIRMS data. */
	nightsWithData: number;
	/** Nights with data and at least one night detection at the facility. */
	activeNights: number;
	detections: number;
	frpSumMW: number;
	/** frpSumMW / nightsWithData, MW; null without data. */
	meanNightFrpMW: number | null;
};

export type FacilityRow = {
	id: string;
	nameEs: string;
	nameEn: string;
	kind: FacilityKind;
	stateIso: string | null;
	stateName: string | null;
	operatorEs: string;
	noteEs: string | null;
	lat: number;
	lon: number;
	d7: FlareWindow;
	d30: FlareWindow;
	d90: FlareWindow;
	baseline: FlareWindow;
	/** d7.meanNightFrpMW / baseline.meanNightFrpMW, when both exist and the baseline is > 0. */
	ratio: number | null;
	status: FlareStatus;
	/** Last 30 nights, oldest first: MW that night, null for a night without data. */
	nights30: { date: string; frpMW: number | null }[];
	lastDetectionAt: number | null;
	/** GFMR's annual estimate for the facility's flare sites, million m³ (fields only). */
	ggfr2025MillionM3: number | null;
	url: string;
	sources: { label: string; url: string }[];
};

export type EnergyView = {
	/** Newest night with data (YYYY-MM-DD, UTC), null before the first file. */
	latestNight: string | null;
	/** Oldest night with data. */
	firstNight: string | null;
	nightsWithData90: number;
	facilities: FacilityRow[];
	/** Facilities with no night detection in 90 days (not listed in `facilities`, except refineries). */
	quietCount: number;
	venezuela: { d7: FlareWindow; baseline: FlareWindow; ratio: number | null; status: FlareStatus };
	/** Listed facilities with at least one night detection in the last 7 nights. */
	lit7: number;
	newestDetectionAt: number | null;
	rules: typeof RULES & { es: string; en: string };
	facilityRule: string;
	facilitySources: { label: string; url: string }[];
	caveatEs: string;
	caveatEn: string;
	feeds: string[];
	attribution: string;
	licence: string;
	sourceUrl: string;
};

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const dayStart = (date: string) => Date.parse(`${date}T00:00:00Z`);
const addDays = (date: string, n: number) => iso(dayStart(date) + n * DAY);

/** The UTC dates whose night pass lies inside one of the files' spans. */
export function coveredNights(files: readonly { oldestAcqAt: number; newestAcqAt: number }[]): Set<string> {
	const out = new Set<string>();
	for (const f of files) {
		if (!(f.newestAcqAt >= f.oldestAcqAt)) continue;
		for (let d = dayStart(iso(f.oldestAcqAt)); d <= f.newestAcqAt; d += DAY) {
			if (d + PASS_START_H * HOUR >= f.oldestAcqAt && d + PASS_END_H * HOUR <= f.newestAcqAt) out.add(iso(d));
		}
	}
	return out;
}

type Night = { facilityId: string; date: string; frpMW: number; at: number };

function windowOf(
	nights: readonly Night[],
	covered: ReadonlySet<string>,
	from: string,
	to: string,
): FlareWindow {
	let total = 0;
	let withData = 0;
	const dataDays = new Set<string>();
	for (let d = from; d <= to; d = addDays(d, 1)) {
		total++;
		if (covered.has(d)) {
			withData++;
			dataDays.add(d);
		}
	}
	const active = new Set<string>();
	let detections = 0;
	let frp = 0;
	for (const n of nights) {
		if (!dataDays.has(n.date)) continue;
		active.add(n.date);
		detections++;
		frp += n.frpMW;
	}
	return {
		nights: total,
		nightsWithData: withData,
		activeNights: active.size,
		detections,
		frpSumMW: Math.round(frp * 100) / 100,
		meanNightFrpMW: withData ? Math.round((frp / withData) * 100) / 100 : null,
	};
}

/**
 * The status rule, in order:
 * - fewer than 4 of the last 7 nights with data: "no-data";
 * - fewer than 14 baseline nights with data: "no-baseline" (the 7-night figures still show);
 * - usually lit (detections on ≥ 50 % of baseline nights) and no detection in the last 7 nights: "dark";
 * - nothing in the baseline and detections on ≥ 2 of the last 7 nights: "new";
 * - nothing in either: "quiet";
 * - 7-night mean ≥ 2 × baseline mean: "up"; ≤ 0.5 ×: "down"; otherwise "usual".
 */
export function statusOf(
	d7: FlareWindow,
	baseline: FlareWindow,
): { status: FlareStatus; ratio: number | null } {
	if (d7.nightsWithData < RULES.minRecentNights) return { status: "no-data", ratio: null };
	if (baseline.nightsWithData < RULES.minBaselineNights) return { status: "no-baseline", ratio: null };
	const base = baseline.meanNightFrpMW ?? 0;
	const recent = d7.meanNightFrpMW ?? 0;
	const ratio = base > 0 ? Math.round((recent / base) * 100) / 100 : null;
	const litShare = baseline.activeNights / baseline.nightsWithData;
	if (litShare >= RULES.usuallyLitShare && d7.activeNights === 0) return { status: "dark", ratio };
	if (base === 0) return { status: d7.activeNights >= 2 ? "new" : "quiet", ratio: null };
	if (ratio !== null && ratio >= RULES.upRatio) return { status: "up", ratio };
	if (ratio !== null && ratio <= RULES.downRatio) return { status: "down", ratio };
	return { status: "usual", ratio };
}

export function energyView(store: Store, now: number): EnergyView {
	const since = now - 91 * DAY;
	// Detections: the 7-day file's (facility-filtered at fetch) and the hourly 24 h file's newest two days,
	// re-matched to facilities here. Same pixel, same series id: kept once.
	const bySeries = new Map<string, Night>();
	for (const o of store.latestPerSeries<FlareValue>("firms-flares", since, 100_000)) {
		const v = o.value;
		if (v.kind !== "detection" || v.daynight !== "night" || o.observedAt > now) continue;
		const lat = o.location?.lat;
		const lon = o.location?.lon;
		// Re-match with the current list, so a corrected outline applies to history too.
		const hit = lat !== undefined && lon !== undefined ? facilityFor(lat, lon) : null;
		if (!hit) continue;
		bySeries.set(o.series, {
			facilityId: hit.facility.id,
			date: v.acqDate,
			frpMW: v.frpMW,
			at: o.observedAt,
		});
	}
	for (const o of store.latestPerSeries<FirmsValue>("firms-fires", now - 48 * HOUR, 50_000)) {
		const v = o.value as FireDetection | FireFile;
		if (v.kind !== "detection" || v.daynight !== "night" || o.observedAt > now) continue;
		if (bySeries.has(o.series)) continue;
		const lat = o.location?.lat;
		const lon = o.location?.lon;
		const hit = lat !== undefined && lon !== undefined ? facilityFor(lat, lon) : null;
		if (!hit) continue;
		bySeries.set(o.series, {
			facilityId: hit.facility.id,
			date: iso(o.observedAt),
			frpMW: v.frpMW,
			at: o.observedAt,
		});
	}
	const files = [
		...store.history<FlareValue>("firms-flares", "flares:file", since, now).map((o) => o.value as FlareFile),
		...store.history<FirmsValue>("firms-fires", "firms:file", since, now).map((o) => o.value as FireFile),
	].filter((v) => v.kind === "file");
	const covered = coveredNights(files);
	const nightsSorted = [...covered].sort();
	const latestNight = nightsSorted.at(-1) ?? null;

	const nightsByFacility = new Map<string, Night[]>();
	let newestDetectionAt: number | null = null;
	for (const n of bySeries.values()) {
		nightsByFacility.set(n.facilityId, [...(nightsByFacility.get(n.facilityId) ?? []), n]);
		newestDetectionAt = newestDetectionAt === null ? n.at : Math.max(newestDetectionAt, n.at);
	}

	const empty: FlareWindow = {
		nights: 0,
		nightsWithData: 0,
		activeNights: 0,
		detections: 0,
		frpSumMW: 0,
		meanNightFrpMW: null,
	};
	const windows = (nights: readonly Night[]) => {
		if (!latestNight) return { d7: empty, d30: empty, d90: empty, baseline: empty };
		return {
			d7: windowOf(nights, covered, addDays(latestNight, -6), latestNight),
			d30: windowOf(nights, covered, addDays(latestNight, -29), latestNight),
			d90: windowOf(nights, covered, addDays(latestNight, -89), latestNight),
			baseline: windowOf(nights, covered, addDays(latestNight, -89), addDays(latestNight, -7)),
		};
	};

	const rows: FacilityRow[] = [];
	let quietCount = 0;
	for (const f of FACILITY_LIST.facilities) {
		const nights = nightsByFacility.get(f.id) ?? [];
		const w = windows(nights);
		const alwaysShow = f.kind === "refinery" || f.kind === "complex" || !f.id.startsWith("other-");
		if (w.d90.detections === 0 && !alwaysShow) {
			quietCount++;
			continue;
		}
		const { status, ratio } = statusOf(w.d7, w.baseline);
		const perNight = new Map<string, number>();
		for (const n of nights) perNight.set(n.date, (perNight.get(n.date) ?? 0) + n.frpMW);
		const nights30: FacilityRow["nights30"] = [];
		if (latestNight) {
			for (let d = addDays(latestNight, -29); d <= latestNight; d = addDays(d, 1)) {
				nights30.push({
					date: d,
					frpMW: covered.has(d) ? Math.round((perNight.get(d) ?? 0) * 100) / 100 : null,
				});
			}
		}
		rows.push(facilityRow(f, w, status, ratio, nights30, nights));
	}
	rows.sort(
		(a, b) =>
			(b.d7.meanNightFrpMW ?? -1) - (a.d7.meanNightFrpMW ?? -1) ||
			(b.d90.meanNightFrpMW ?? -1) - (a.d90.meanNightFrpMW ?? -1) ||
			a.nameEs.localeCompare(b.nameEs, "es"),
	);

	const all = [...bySeries.values()];
	const national = windows(all);
	const nationalStatus = statusOf(national.d7, national.baseline);

	return {
		latestNight,
		firstNight: nightsSorted[0] ?? null,
		nightsWithData90: national.d90.nightsWithData,
		facilities: rows,
		quietCount,
		venezuela: {
			d7: national.d7,
			baseline: national.baseline,
			ratio: nationalStatus.ratio,
			status: nationalStatus.status,
		},
		lit7: rows.filter((r) => r.d7.activeNights > 0).length,
		newestDetectionAt,
		rules: {
			...RULES,
			es: "Índice: potencia radiativa media por noche con datos (MW), solo detecciones nocturnas. Estado: últimas 7 noches frente a la línea base (de 90 a 8 días atrás, ≥ 14 noches con datos). ≥ 2× «más que lo habitual», ≤ 0,5× «menos»; «sin llama vista» si solía verse ≥ la mitad de las noches y no se vio en 7.",
			en: "Index: mean radiative power per night with data (MW), night detections only. Status: last 7 nights against the baseline (90 to 8 days back, ≥ 14 nights with data). ≥ 2× 'above usual', ≤ 0.5× 'below'; 'no flame seen' if usually seen on ≥ half the nights and not in 7.",
		},
		facilityRule: FACILITY_LIST.rule,
		facilitySources: FACILITY_LIST.sources,
		caveatEs:
			"Las nubes ocultan las llamas: una noche nublada cuenta como cero, por eso se comparan semanas. Una detección es un píxel caliente de 375 m, no un volumen de gas ni de crudo.",
		caveatEn:
			"Clouds hide flares: a cloudy night counts as zero, which is why weeks are compared. A detection is a hot 375 m pixel, not a volume of gas or crude.",
		feeds: ["firms-flares", "firms-fires"],
		attribution: FIRMS_LICENCE.attribution,
		licence: FIRMS_LICENCE.id,
		sourceUrl: "https://firms.modaps.eosdis.nasa.gov/map/",
	};
}

function facilityRow(
	f: Facility,
	w: { d7: FlareWindow; d30: FlareWindow; d90: FlareWindow; baseline: FlareWindow },
	status: FlareStatus,
	ratio: number | null,
	nights30: FacilityRow["nights30"],
	nights: readonly Night[],
): FacilityRow {
	return {
		id: f.id,
		nameEs: f.nameEs,
		nameEn: f.nameEn,
		kind: f.kind,
		stateIso: f.state,
		stateName: f.state ? (stateByIso(f.state)?.name ?? f.state) : null,
		operatorEs: f.operatorEs,
		noteEs: f.noteEs ?? null,
		lat: f.centroid.lat,
		lon: f.centroid.lon,
		...w,
		ratio,
		status,
		nights30,
		lastDetectionAt: nights.length ? Math.max(...nights.map((n) => n.at)) : null,
		ggfr2025MillionM3: f.ggfrMillionM3?.["2025"] ?? null,
		url: firmsMapUrl(f.centroid.lat, f.centroid.lon),
		sources: f.sources,
	};
}

export const energyPanel: Panel<EnergyView> = {
	id: "energy",
	sources: ["firms-flares", "firms-fires"],
	compute: (store: Store, now: number) => energyView(store, now),
};
