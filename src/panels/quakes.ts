import { FUNVISIS_FELT_FORM, FUNVISIS_HOME, type FunvisisQuake } from "../adapters/funvisis-quakes/index.ts";
import { type Quake, USGS_COMPLETENESS_MAG } from "../adapters/usgs-quakes/index.ts";
import type { Store, StoredObservation } from "../core/store.ts";
import { distanceKm, stateByIso } from "../geo/index.ts";
import type { Panel } from "../server/panels.ts";

/**
 * The quakes panel: USGS and FUNVISIS side by side, never blended. Each row is one earthquake with one reading
 * per source that reported it; when both did, both magnitudes are shown, each with its source, time and link.
 * All counts are over events (rows), not revisions and not readings.
 */

const DAY = 86_400_000;
const USGS = "usgs-quakes";
const FUNVISIS = "funvisis-quakes";

/**
 * Same-event rule. All three must hold, and pairs are assigned one-to-one, best score first.
 * - 90 s: FUNVISIS times are to the minute (up to 60 s of truncation or ±30 s of rounding; the file does not
 *   say which) plus up to 30 s of disagreement between two networks' origin times, which for the same event is
 *   normally a few seconds. The 2026-06-24 doublet (M7.2 then M7.5) came 32.2 s apart but 148 km apart, so time
 *   alone cannot separate events; distance does.
 * - 60 km: FUNVISIS gives epicentres to 0.01° (~1 km); USGS locations of M4 events here come from teleseismic
 *   and regional stations and differ from national-network epicentres by a few km to a few tens of km (the doublet:
 *   FUNVISIS "25 km E of San Felipe" vs USGS "20 km E of San Felipe"). Distinct events within 90 s and 60 km
 *   are rare: across 60 FUNVISIS events (live + two archive copies) the closest pair was 60 s and 18 km apart,
 *   and that pair was M2.7 and M2.4, which the magnitude check below keeps away from any USGS M≥4.
 * - |ΔM| ≤ 1.0: agencies use different magnitude types (USGS mb/mww, FUNVISIS unstated), which commonly differ
 *   by a few tenths; a full unit apart is not the same reading of one event.
 */
export const MATCH_RULE = { maxSeconds: 90, maxKm: 60, maxMagDiff: 1 } as const;
/** "Near Venezuela": epicentre within this many km of Venezuelan territory (research recommendation). */
export const NEAR_KM = 100;
/** Highlight rule from the product brief: large enough to be widely felt, or USGS has felt reports. */
export const FELT_SIZE_MAG = 3.5;
/** FUNVISIS revisions (new magnitude or epicentre) make a new series; same minute within this distance folds. */
const REVISION_KM = 10;

/**
 * Fixed reference: the 2026-06-24 doublet. Values from USGS ComCat (reviewed), as fetched 2026-09-24. Casualty
 * figures are deliberately absent: sources disagree (USGS impact text vs other reports) and are not built yet.
 */
export const DOUBLET = {
	titleEs: "Doble terremoto del 24 de junio de 2026",
	titleEn: "Doublet earthquake of 24 June 2026",
	events: [
		{
			id: "us6000t7zc",
			mag: 7.2,
			magType: "mww",
			at: 1782338671806,
			placeText: "20 km E of San Felipe, Venezuela",
			alert: "red",
			url: "https://earthquake.usgs.gov/earthquakes/eventpage/us6000t7zc",
		},
		{
			id: "us6000t7zp",
			mag: 7.5,
			magType: "mww",
			at: 1782338704053,
			placeText: "20 km W of Catia La Mar, Venezuela",
			alert: "red",
			url: "https://earthquake.usgs.gov/earthquakes/eventpage/us6000t7zp",
		},
	],
	/** USGS `event-sequence` product on us6000t7zp: the sequence region, valid until 2027-09-22. */
	sequence: { lat: 10.6, lon: -67.55, radiusKm: 145, until: Date.UTC(2027, 8, 22) },
	checkedAt: 1790291236000,
} as const;

export type QuakeReading = {
	feed: string;
	label: "USGS" | "FUNVISIS";
	series: string;
	at: number;
	fetchedAt: number;
	/** 1 for USGS (ms in the feed), 60 for FUNVISIS (minute precision). */
	timePrecisionS: number;
	mag: number;
	magType: string | null;
	depthKm: number | null;
	lat: number;
	lon: number;
	/** The source's own place text: USGS English ("45 km NNW of Duaca, Venezuela") or FUNVISIS Spanish. */
	sourcePlace: string | null;
	/** "reviewed" / "automatic" (USGS) or "official" (FUNVISIS national network). */
	status: string;
	confidence: number;
	url: string;
};

export type QuakeZone = "venezuela" | "near" | "far";

export type QuakeRow = {
	id: string;
	/** Which reading gives the row's time and pin: USGS when present (second precision), else FUNVISIS. */
	primary: string;
	at: number;
	lat: number;
	lon: number;
	zone: QuakeZone;
	state: string | null;
	stateName: string | null;
	country: string | null;
	borderKm: number;
	placeEs: string;
	usgs: QuakeReading | null;
	funvisis: QuakeReading | null;
	/** How far apart the two readings are, when both exist (USGS minus FUNVISIS). */
	match: { dtS: number; distanceKm: number; magDiff: number } | null;
	/** The larger reported magnitude. For ranking and highlighting only; the UI shows each source's own. */
	maxMag: number;
	feltSize: boolean;
	/** USGS "Did You Feel It?" responses and intensities, when USGS has the event. */
	felt: number | null;
	cdi: number | null;
	mmi: number | null;
	alert: string | null;
	tsunami: boolean;
	/** Where a person can report feeling it: the USGS event's DYFI form, or FUNVISIS's survey. */
	feltReportUrl: string;
};

export type QuakeWindow = {
	/** Events with the epicentre inside Venezuela. */
	venezuela: number;
	/** Outside, within NEAR_KM of Venezuelan territory (sea, border areas). */
	near: number;
	/** Of those two, how many are felt-size. */
	feltSize: number;
	/** Events inside the USGS sequence region of the 2026-06-24 doublet (any zone). */
	inSequenceRegion: number;
	/** False when Vigía's FUNVISIS history does not reach back to the window start (small quakes undercounted). */
	funvisisComplete: boolean;
};

export type QuakesView = {
	/** Newest first, every zone (the UI may hide "far"), at most 150. */
	items: QuakeRow[];
	windows: { day: QuakeWindow; week: QuakeWindow; month: QuakeWindow };
	/** Venezuela + near, both sources: windows.*.venezuela + windows.*.near. */
	counts: { day: number; week: number; month: number };
	/** Strongest (by maxMag) Venezuela or near event of the last 7 days. */
	strongestWeek: QuakeRow | null;
	reference: {
		titleEs: string;
		titleEn: string;
		events: {
			id: string;
			mag: number;
			magType: string;
			at: number;
			placeText: string;
			alert: string;
			url: string;
		}[];
		daysSince: number;
		sequence: { lat: number; lon: number; radiusKm: number; until: number; noteEs: string };
		checkedAt: number;
	};
	coverage: {
		usgsCompletenessMag: number;
		usgsNoteEs: string;
		/** Earliest time from which Vigía holds FUNVISIS's full list (null: never fetched). */
		funvisisHistoryFrom: number | null;
		funvisisNoteEs: string;
	};
	matchRule: { maxSeconds: number; maxKm: number; maxMagDiff: number; noteEs: string };
	sources: { feed: string; label: string; url: string; newestFetchedAt: number | null; licence: string }[];
};

function usgsReading(o: StoredObservation<Quake>): QuakeReading {
	return {
		feed: USGS,
		label: "USGS",
		series: o.series,
		at: o.observedAt,
		fetchedAt: o.fetchedAt,
		timePrecisionS: 1,
		mag: o.value.mag,
		magType: o.value.magType,
		depthKm: o.value.depthKm,
		lat: o.location?.lat ?? 0,
		lon: o.location?.lon ?? 0,
		sourcePlace: o.value.placeText,
		status: o.value.status,
		confidence: o.confidence,
		url: o.sourceUrl,
	};
}

function funvisisReading(o: StoredObservation<FunvisisQuake>): QuakeReading {
	return {
		feed: FUNVISIS,
		label: "FUNVISIS",
		series: o.series,
		at: o.observedAt,
		fetchedAt: o.fetchedAt,
		timePrecisionS: 60,
		mag: o.value.mag,
		magType: null,
		depthKm: o.value.depthKm,
		lat: o.location?.lat ?? 0,
		lon: o.location?.lon ?? 0,
		sourcePlace: o.value.addressEs,
		status: "official",
		confidence: o.confidence,
		url: o.sourceUrl,
	};
}

const km = (
	a: { location?: { lat: number; lon: number } },
	b: { location?: { lat: number; lon: number } },
): number =>
	distanceKm(a.location?.lat ?? 0, a.location?.lon ?? 0, b.location?.lat ?? 0, b.location?.lon ?? 0);

/** Keeps the newest-fetched version of each FUNVISIS event (same minute, within REVISION_KM). */
export function foldRevisions(
	list: readonly StoredObservation<FunvisisQuake>[],
): StoredObservation<FunvisisQuake>[] {
	const sorted = [...list].sort((a, b) => b.fetchedAt - a.fetchedAt || b.id - a.id);
	const kept: StoredObservation<FunvisisQuake>[] = [];
	for (const o of sorted) {
		if (!kept.some((k) => k.observedAt === o.observedAt && km(k, o) <= REVISION_KM)) kept.push(o);
	}
	return kept.sort((a, b) => b.observedAt - a.observedAt);
}

export type QuakePair = { u: number; f: number; dtS: number; km: number; dm: number };

/** One-to-one pairs of (USGS index, FUNVISIS index) that satisfy MATCH_RULE, closest first. */
export function matchEvents(usgs: readonly QuakeReading[], funvisis: readonly QuakeReading[]): QuakePair[] {
	const candidates: (QuakePair & { score: number })[] = [];
	usgs.forEach((u, ui) => {
		funvisis.forEach((f, fi) => {
			const dtS = (u.at - f.at) / 1000;
			if (Math.abs(dtS) > MATCH_RULE.maxSeconds) return;
			const d = distanceKm(u.lat, u.lon, f.lat, f.lon);
			if (d > MATCH_RULE.maxKm) return;
			const dm = u.mag - f.mag;
			if (Math.abs(dm) > MATCH_RULE.maxMagDiff) return;
			const score = Math.abs(dtS) / MATCH_RULE.maxSeconds + d / MATCH_RULE.maxKm;
			candidates.push({ u: ui, f: fi, dtS, km: d, dm, score });
		});
	});
	candidates.sort((a, b) => a.score - b.score);
	const usedU = new Set<number>();
	const usedF = new Set<number>();
	const out: QuakePair[] = [];
	for (const { score: _score, ...c } of candidates) {
		if (usedU.has(c.u) || usedF.has(c.f)) continue;
		usedU.add(c.u);
		usedF.add(c.f);
		out.push(c);
	}
	return out;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function zoneOf(inVenezuela: boolean, borderKm: number): QuakeZone {
	if (inVenezuela) return "venezuela";
	return borderKm <= NEAR_KM ? "near" : "far";
}

function inSequenceRegion(row: QuakeRow): boolean {
	const s = DOUBLET.sequence;
	return row.at <= s.until && distanceKm(row.lat, row.lon, s.lat, s.lon) <= s.radiusKm;
}

/** Longest silence between successful FUNVISIS fetches that its ~20-event file is still assumed to bridge. */
export const FUNVISIS_MAX_GAP_MS = 12 * 3_600_000;

/**
 * Time from which Vigía holds FUNVISIS's full list without holes: the oldest event of the first file it fetched,
 * reset to the fetch that ended any gap longer than FUNVISIS_MAX_GAP_MS (Vigía was off; the file only keeps the
 * last ~20 events, so small quakes in the gap may be missing). Conservative on purpose.
 */
export function funvisisHistoryFrom(store: Store): number | null {
	const first = store.db
		.query<{ t: number | null }, [string, string]>(
			`SELECT MIN(observed_at) AS t FROM obs WHERE source = ? AND fetched_at =
			 (SELECT MIN(fetched_at) FROM obs WHERE source = ?)`,
		)
		.get(FUNVISIS, FUNVISIS);
	let from = first?.t ?? null;
	if (from === null) return null;
	const runs = store.db
		.query<{ t: number }, [string]>(
			"SELECT finished_at AS t FROM runs WHERE source = ? AND ok = 1 ORDER BY finished_at",
		)
		.all(FUNVISIS);
	for (let i = 1; i < runs.length; i++) {
		const prev = runs[i - 1]?.t ?? 0;
		const cur = runs[i]?.t ?? 0;
		if (cur - prev > FUNVISIS_MAX_GAP_MS) from = Math.max(from, cur);
	}
	return from;
}

type Place = { inVenezuela: boolean; borderKm: number; country: string | null; placeEs: string };

function placeFields(o: StoredObservation<Place>) {
	const state = o.location?.state ?? null;
	return {
		zone: zoneOf(o.value.inVenezuela, o.value.borderKm),
		state,
		stateName: state ? (stateByIso(state)?.name ?? null) : null,
		country: o.value.country,
		borderKm: o.value.borderKm,
		placeEs: o.value.placeEs,
	};
}

export function quakesView(store: Store, now: number): QuakesView {
	const since = now - 30 * DAY;
	const usgsObs = store.latestPerSeries<Quake>(USGS, since, 1_000);
	const funObs = foldRevisions(store.latestPerSeries<FunvisisQuake>(FUNVISIS, since, 5_000));
	const usgs = usgsObs.map(usgsReading);
	const fun = funObs.map(funvisisReading);
	const pairs = matchEvents(usgs, fun);
	const pairOfU = new Map(pairs.map((p) => [p.u, p]));
	const matchedF = new Set(pairs.map((p) => p.f));

	const rows: QuakeRow[] = [];
	usgsObs.forEach((o, ui) => {
		const reading = usgs[ui] as QuakeReading;
		const pair = pairOfU.get(ui);
		const f = pair ? (fun[pair.f] ?? null) : null;
		const v = o.value;
		const maxMag = Math.max(reading.mag, f?.mag ?? Number.NEGATIVE_INFINITY);
		rows.push({
			id: f ? `${o.series}+${f.series}` : o.series,
			primary: USGS,
			at: reading.at,
			lat: reading.lat,
			lon: reading.lon,
			...placeFields(o),
			usgs: reading,
			funvisis: f,
			match: pair ? { dtS: round1(pair.dtS), distanceKm: round1(pair.km), magDiff: round1(pair.dm) } : null,
			maxMag,
			feltSize: maxMag >= FELT_SIZE_MAG || (v.felt ?? 0) > 0,
			felt: v.felt,
			cdi: v.cdi,
			mmi: v.mmi,
			alert: v.alert,
			tsunami: v.tsunami,
			feltReportUrl: `${reading.url}/tellus`,
		});
	});
	funObs.forEach((o, fi) => {
		if (matchedF.has(fi)) return;
		const reading = fun[fi] as QuakeReading;
		rows.push({
			id: o.series,
			primary: FUNVISIS,
			at: reading.at,
			lat: reading.lat,
			lon: reading.lon,
			...placeFields(o),
			usgs: null,
			funvisis: reading,
			match: null,
			maxMag: reading.mag,
			feltSize: reading.mag >= FELT_SIZE_MAG,
			felt: null,
			cdi: null,
			mmi: null,
			alert: null,
			tsunami: false,
			feltReportUrl: FUNVISIS_FELT_FORM,
		});
	});
	rows.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));

	const historyFrom = funvisisHistoryFrom(store);
	const windowOf = (ms: number): QuakeWindow => {
		const start = now - ms;
		const inWindow = rows.filter((r) => r.at >= start && r.at <= now);
		const close = inWindow.filter((r) => r.zone !== "far");
		return {
			venezuela: close.filter((r) => r.zone === "venezuela").length,
			near: close.filter((r) => r.zone === "near").length,
			feltSize: close.filter((r) => r.feltSize).length,
			inSequenceRegion: inWindow.filter(inSequenceRegion).length,
			funvisisComplete: historyFrom !== null && historyFrom <= start,
		};
	};
	const windows = { day: windowOf(DAY), week: windowOf(7 * DAY), month: windowOf(30 * DAY) };

	let strongestWeek: QuakeRow | null = null;
	for (const r of rows) {
		if (r.zone === "far" || r.at < now - 7 * DAY || r.at > now) continue;
		if (!strongestWeek || r.maxMag > strongestWeek.maxMag) strongestWeek = r;
	}

	const newestFetch = (list: readonly { fetchedAt: number }[]) =>
		list.length ? Math.max(...list.map((o) => o.fetchedAt)) : null;
	const first = DOUBLET.events[0];

	return {
		items: rows.slice(0, 150),
		windows,
		counts: {
			day: windows.day.venezuela + windows.day.near,
			week: windows.week.venezuela + windows.week.near,
			month: windows.month.venezuela + windows.month.near,
		},
		strongestWeek,
		reference: {
			titleEs: DOUBLET.titleEs,
			titleEn: DOUBLET.titleEn,
			events: DOUBLET.events.map((e) => ({ ...e })),
			daysSince: Math.floor((now - first.at) / DAY),
			sequence: {
				...DOUBLET.sequence,
				noteEs:
					"Zona de la secuencia definida por USGS (producto event-sequence). Estar dentro no prueba que un sismo sea réplica.",
			},
			checkedAt: DOUBLET.checkedAt,
		},
		coverage: {
			usgsCompletenessMag: USGS_COMPLETENESS_MAG,
			usgsNoteEs: `USGS registra de forma completa los sismos desde M${USGS_COMPLETENESS_MAG} aproximadamente en esta región; los menores casi solo aparecen en FUNVISIS.`,
			funvisisHistoryFrom: historyFrom,
			funvisisNoteEs:
				"FUNVISIS publica solo sus últimos 20 sismos (≈1,5 días). Vigía guarda el historial desde que empezó a consultarlo; antes de esa fecha faltan los sismos pequeños.",
		},
		matchRule: {
			...MATCH_RULE,
			noteEs: `Mismo sismo si USGS y FUNVISIS difieren en ≤${MATCH_RULE.maxSeconds} s, ≤${MATCH_RULE.maxKm} km y ≤${MATCH_RULE.maxMagDiff} de magnitud. Se muestran ambas magnitudes; no se promedian.`,
		},
		sources: [
			{
				feed: USGS,
				label: "USGS",
				url: "https://earthquake.usgs.gov/earthquakes/map/",
				newestFetchedAt: newestFetch(usgsObs),
				licence: "usgs-public-domain",
			},
			{
				feed: FUNVISIS,
				label: "FUNVISIS",
				url: FUNVISIS_HOME,
				newestFetchedAt: newestFetch(funObs),
				licence: "funvisis-attribution",
			},
		],
	};
}

export const quakesPanel: Panel<QuakesView> = {
	id: "quakes",
	sources: [USGS, FUNVISIS],
	compute: (store: Store, now: number) => quakesView(store, now),
};
