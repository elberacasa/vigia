import {
	type Bulletin,
	epiWeek,
	isoDay,
	MPPS_LICENCE,
	MPPS_LIST,
	mppsBoletin,
	weekEndMs,
} from "../adapters/mpps-boletin/index.ts";
import { TRANSCRIBED_AT, type TranscribedWeek, WEEKS } from "../adapters/mpps-boletin/weeks.gen.ts";
import { FTS_LICENCE, ochaFts, type PlanFunding } from "../adapters/ocha-fts/index.ts";
import { R4V_LICENCE, R4V_PAGE, type R4vFigure, r4vFigures } from "../adapters/r4v-figures/index.ts";
import { RELIEFWEB_LICENCE, type ReliefItem, RW_COUNTRY } from "../adapters/reliefweb-ve/index.ts";
import {
	type Stock,
	UNHCR_LICENCE,
	UNHCR_PAGE,
	unhcrPopulation,
} from "../adapters/unhcr-population/index.ts";
import { GHO_INDICATORS, type GhoValue, WHO_LICENCE } from "../adapters/who-gho/index.ts";
import type { Store, StoredObservation } from "../core/store.ts";
import type { Panel } from "../server/panels.ts";
import { latestRevisions } from "./markets.ts";
import { OVV_ATTRIBUTION, OVV_CHECKED_ON, OVV_HOME, OVV_YEARS, type OvvYear } from "./security-ovv.ts";

/**
 * "Salud, migración y ayuda": the humanitarian picture in four parts, every figure with its source and date, and
 * every rule stated. Aggregates only; no person, incident or address.
 *
 * - Salud: the MPPS weekly bulletin's national figures (transcribed from its PDFs, one row per week), the newest
 *   week the ministry has listed, and the yearly figures Venezuela reports to WHO next to WHO's estimate.
 * - Migración: R4V's figures by host country (as each government reported them) and UNHCR's year-end stocks. They
 *   count different things (R4V: all Venezuelans reported by host governments; UNHCR: refugees, asylum seekers and
 *   others in need of international protection), so they are shown side by side and never combined.
 * - Ayuda: OCHA FTS requirements against funding for the Humanitarian Response Plan and the regional RMRP;
 *   ReliefWeb's newest reports and disasters.
 * - Seguridad: the OVV's national annual violent-death figures, with the absence of an official series stated.
 *
 * Rules (all in this file, tested): % funded = funded ÷ current requirements × 100; gap = requirements − funded
 * (0 when funding exceeds it). UNHCR "displaced abroad" = refugees + asylum seekers + other people in need of
 * international protection, with "-" (not reported) counted as no data, not as 0; a year with all three missing
 * has no total. Weekly changes compare a week with the previous week in the same bulletin series; a missing week
 * gives no change.
 */

const DAY = 86_400_000;
const YEAR = 366 * DAY;

export type WeekPoint = { week: number; value: number | null };

export type HealthFigure = {
	id: string;
	labelEs: string;
	labelEn: string;
	/** This week's cases (or %), from the newest transcribed bulletin; null when that bulletin did not state it. */
	week: number | null;
	/** The previous week's, for the change. */
	previous: number | null;
	/** Year to date, and the same period a year earlier, when the bulletin gives them. */
	yearToDate: number | null;
	previousYearToDate: number | null;
	/** Every transcribed week of the year, oldest first (null where the bulletin did not state it). */
	weeks: WeekPoint[];
	/**
	 * Why a figure is not shown although the bulletin prints it (review 4, L10): a week larger than its year to date
	 * (the week-1 malaria figures, 1.388 against 1.348), a year to date lower than the week before's, or a weekly
	 * change across a coverage shift of more than COVERAGE_SHIFT_PTS points (more centres reporting is not more cases).
	 */
	notes: { es: string; en: string }[];
};

/** A weekly change is not shown when the share of reporting centres moved more than this (percentage points). */
export const COVERAGE_SHIFT_PTS = 5;

export type HumanitarianView = {
	health: {
		bulletin: {
			year: number;
			week: number;
			from: string;
			to: string;
			pdfUrl: string;
			observedAt: number;
		} | null;
		/** The newest week the MPPS has listed (from the live adapter); null when never read. */
		listed: {
			year: number;
			week: number;
			from: string;
			to: string;
			pdfUrl: string;
			observedAt: number;
		} | null;
		/** Listed weeks newer than the newest transcribed one. */
		untranscribed: number;
		transcribedAt: string;
		coveragePct: number | null;
		figures: HealthFigure[];
		measles: { suspected: number; discarded: number; investigating: number; consistent: boolean } | null;
		yellowFever: { cases: number; deaths: number } | null;
		/** The newest listed week ended longer ago than the adapter's budget. */
		stale: boolean;
		who: {
			id: string;
			labelEs: string;
			labelEn: string;
			unit: string;
			year: number;
			value: number;
			low: number | null;
			high: number | null;
			updated: string | null;
			basis: string;
			sourceUrl: string;
			observedAt: number;
		}[];
		/** Malaria: the country's reported figure and WHO's estimate for the same year, side by side. */
		malaria: {
			year: number;
			reported: number;
			estimated: number;
			low: number | null;
			high: number | null;
		} | null;
	};
	migration: {
		r4v: {
			total: { people: number; month: string; observedAt: number } | null;
			countries: {
				id: string;
				countryEs: string;
				countryEn: string;
				people: number;
				previous: number | null;
				month: string;
				publishedMonth: string | null;
				publisherEs: string | null;
				publisherEn: string | null;
			}[];
			stale: boolean;
		};
		unhcr: {
			year: number | null;
			observedAt: number | null;
			abroad: {
				refugees: number | null;
				asylumSeekers: number | null;
				otherInNeed: number | null;
				total: number | null;
			} | null;
			/** Total displaced abroad per year, oldest first. */
			abroadByYear: { year: number; total: number | null }[];
			hosted: {
				year: number;
				refugees: number | null;
				asylumSeekers: number | null;
				total: number | null;
			} | null;
			/** Host countries in the newest year, by total, largest first (top 8). */
			top: { country: string; name: string; total: number }[];
			stale: boolean;
		};
	};
	aid: {
		plans: {
			code: string;
			name: string;
			year: number;
			kind: "hrp" | "rmrp";
			requirementsUsd: number;
			originalRequirementsUsd: number | null;
			fundedUsd: number;
			pctFunded: number | null;
			gapUsd: number;
			sourceUrl: string;
			observedAt: number;
		}[];
		/** Funding of the current HRP as read each day, oldest first (the curve Vigía has recorded). */
		hrpCurve: { at: number; pct: number }[];
		disasters: { title: string; url: string; glide: string | null; observedAt: number }[];
		reports: { title: string; url: string; orgs: string[]; observedAt: number }[];
		stale: boolean;
	};
	security: {
		years: OvvYear[];
		checkedOn: string;
		sourceUrl: string;
	};
	rules: { es: string; en: string };
	attributions: { feed: string; text: string; licenceUrl: string }[];
};

/** funded ÷ requirements × 100; null when there are no requirements. */
export function pctFunded(fundedUsd: number, requirementsUsd: number): number | null {
	return requirementsUsd > 0 ? (fundedUsd / requirementsUsd) * 100 : null;
}

/** Sum of the parts that are reported; null when none is. */
export function sumReported(...parts: (number | null)[]): number | null {
	const known = parts.filter((p): p is number => p !== null);
	return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

type FigureSpec = {
	id: string;
	labelEs: string;
	labelEn: string;
	week: (w: TranscribedWeek) => number | null;
	year?: (w: TranscribedWeek) => number | null;
	prevYear?: (w: TranscribedWeek) => number | null;
};

const FIGURES: readonly FigureSpec[] = [
	{
		id: "malaria",
		labelEs: "Malaria (casos confirmados)",
		labelEn: "Malaria (confirmed cases)",
		week: (w) => w.malariaWeek,
		year: (w) => w.malariaYear,
		prevYear: (w) => w.malariaPrevYear,
	},
	{
		id: "dengue",
		labelEs: "Dengue (casos sospechosos)",
		labelEn: "Dengue (suspected cases)",
		week: (w) => w.dengueWeek,
		year: (w) => w.dengueYear,
	},
	{
		id: "diarrhoea",
		labelEs: "Diarrea aguda (casos)",
		labelEn: "Acute diarrhoea (cases)",
		week: (w) => w.diarrhoeaWeek,
	},
	{
		id: "respiratory",
		labelEs: "Infección respiratoria aguda (casos)",
		labelEn: "Acute respiratory infection (cases)",
		week: (w) => w.respiratoryWeek,
	},
	{
		id: "pneumonia",
		labelEs: "Neumonía (casos)",
		labelEn: "Pneumonia (cases)",
		week: (w) => w.pneumoniaWeek,
	},
];

/** The transcribed weeks of one year, one per week (the first transcription of a week wins), ascending. */
export function weeksOf(rows: readonly TranscribedWeek[], year: number): TranscribedWeek[] {
	const by = new Map<number, TranscribedWeek>();
	for (const r of rows) if (r.year === year && !by.has(r.week)) by.set(r.week, r);
	return [...by.values()].sort((a, b) => a.week - b.week);
}

export function healthFigures(rows: readonly TranscribedWeek[]): HealthFigure[] {
	const newest = rows.at(-1);
	if (!newest) return [];
	const year = weeksOf(rows, newest.year);
	const latest = year.at(-1) as TranscribedWeek;
	const before = year.find((w) => w.week === latest.week - 1);
	const es = (n: number) => n.toLocaleString("es-VE");
	const en = (n: number) => n.toLocaleString("en-US");
	const shift =
		before && latest.coveragePct !== null && before.coveragePct !== null
			? Math.abs(latest.coveragePct - before.coveragePct)
			: 0;
	const shifted = before && shift > COVERAGE_SHIFT_PTS ? before : null;
	return FIGURES.map((f) => {
		const notes: { es: string; en: string }[] = [];
		const week = f.week(latest);
		let yearToDate = f.year?.(latest) ?? null;
		const priorYear = before ? (f.year?.(before) ?? null) : null;
		if (yearToDate !== null && week !== null && week > yearToDate) {
			notes.push({
				es: `El boletín da más casos en la semana (${es(week)}) que en el año (${es(yearToDate)}): el acumulado no se muestra.`,
				en: `The bulletin gives more cases in the week (${en(week)}) than in the year (${en(yearToDate)}): the year to date is not shown.`,
			});
			yearToDate = null;
		} else if (yearToDate !== null && priorYear !== null && yearToDate < priorYear) {
			notes.push({
				es: `El acumulado del año (${es(yearToDate)}) es menor que el de la semana anterior (${es(priorYear)}): no se muestra.`,
				en: `The year to date (${en(yearToDate)}) is lower than the week before's (${en(priorYear)}): not shown.`,
			});
			yearToDate = null;
		}
		if (shifted && week !== null && f.week(shifted) !== null)
			notes.push({
				es: `Sin cambio semanal: la cobertura pasó de ${es(shifted.coveragePct ?? 0)} % a ${es(latest.coveragePct ?? 0)} % de los centros.`,
				en: `No weekly change: coverage moved from ${en(shifted.coveragePct ?? 0)}% to ${en(latest.coveragePct ?? 0)}% of centres.`,
			});
		return {
			id: f.id,
			labelEs: f.labelEs,
			labelEn: f.labelEn,
			week,
			previous: before && !shifted ? f.week(before) : null,
			yearToDate,
			previousYearToDate: yearToDate === null ? null : (f.prevYear?.(latest) ?? null),
			weeks: year.map((w) => ({ week: w.week, value: f.week(w) })),
			notes,
		};
	});
}

function healthView(store: Store, now: number): HumanitarianView["health"] {
	const sorted = [...WEEKS].sort((a, b) => a.year - b.year || a.week - b.week);
	const newest = sorted.at(-1);
	const bulletin = newest
		? {
				year: newest.year,
				week: newest.week,
				from: isoDay(epiWeek(newest.year, newest.week).from),
				to: isoDay(epiWeek(newest.year, newest.week).to),
				pdfUrl: newest.pdfUrl,
				observedAt: weekEndMs(newest.year, newest.week),
			}
		: null;
	const listedRows = store
		.latestPerSeries<Bulletin>("mpps-boletin", now - 2 * YEAR)
		.filter((o) => o.series.startsWith("bulletin:"))
		.sort((a, b) => a.observedAt - b.observedAt);
	const top = listedRows.at(-1);
	const listed = top ? { ...top.value, observedAt: top.observedAt } : null;
	const untranscribed = bulletin
		? listedRows.filter((o) => o.observedAt > bulletin.observedAt).length
		: listedRows.length;
	const latest = newest;
	const measles =
		latest &&
		latest.measlesSuspected !== null &&
		latest.measlesDiscarded !== null &&
		latest.measlesInvestigating !== null
			? {
					suspected: latest.measlesSuspected,
					discarded: latest.measlesDiscarded,
					investigating: latest.measlesInvestigating,
					consistent: latest.measlesDiscarded + latest.measlesInvestigating === latest.measlesSuspected,
				}
			: null;
	const who = GHO_INDICATORS.flatMap((ind) => {
		const rows = latestRevisions(store.history<GhoValue>("who-gho", ind.series, now - 15 * YEAR, now), (o) =>
			String(o.value.year),
		);
		const o = rows.at(-1);
		if (!o) return [];
		return [
			{
				id: ind.series,
				labelEs: ind.labelEs,
				labelEn: ind.labelEn,
				unit: ind.unit,
				year: o.value.year,
				value: o.value.value,
				low: o.value.low,
				high: o.value.high,
				updated: o.value.updated,
				basis: o.basis,
				sourceUrl: o.sourceUrl,
				observedAt: o.observedAt,
			},
		];
	});
	const reported = latestRevisions(
		store.history<GhoValue>("who-gho", "malaria-reported", now - 15 * YEAR, now),
		(o) => String(o.value.year),
	);
	const estimated = latestRevisions(
		store.history<GhoValue>("who-gho", "malaria-estimated", now - 15 * YEAR, now),
		(o) => String(o.value.year),
	);
	// The newest year both have: a reported and an estimated figure are only comparable for the same year.
	let malaria: HumanitarianView["health"]["malaria"] = null;
	for (let i = reported.length - 1; i >= 0 && !malaria; i--) {
		const r = reported[i] as StoredObservation<GhoValue>;
		const e = estimated.find((x) => x.value.year === r.value.year);
		if (e)
			malaria = {
				year: r.value.year,
				reported: r.value.value,
				estimated: e.value.value,
				low: e.value.low,
				high: e.value.high,
			};
	}
	return {
		bulletin,
		listed,
		untranscribed,
		transcribedAt: TRANSCRIBED_AT,
		coveragePct: latest?.coveragePct ?? null,
		figures: healthFigures(sorted),
		measles,
		yellowFever:
			latest && latest.yellowFeverCases !== null && latest.yellowFeverDeaths !== null
				? { cases: latest.yellowFeverCases, deaths: latest.yellowFeverDeaths }
				: null,
		stale: !listed || now - listed.observedAt > (mppsBoletin.freshness.dataMs ?? 28 * DAY),
		who,
		malaria,
	};
}

function r4vView(store: Store, now: number): HumanitarianView["migration"]["r4v"] {
	const rows = store.latestPerSeries<R4vFigure>("r4v-figures", now - 5 * YEAR);
	const t = rows.find((o) => o.series === "total-lac");
	const countries = rows
		.filter((o) => o.series.startsWith("country:") && o.value.countryEs && o.value.countryEn)
		.map((o) => ({
			id: o.series.slice(8),
			countryEs: o.value.countryEs as string,
			countryEn: o.value.countryEn as string,
			people: o.value.people,
			previous: o.value.previous,
			month: o.value.month,
			publishedMonth: o.value.publishedMonth,
			publisherEs: o.value.publisherEs,
			publisherEn: o.value.publisherEn,
		}))
		.sort((a, b) => b.people - a.people || a.countryEs.localeCompare(b.countryEs));
	return {
		total: t ? { people: t.value.people, month: t.value.month, observedAt: t.observedAt } : null,
		countries,
		stale: !t || now - t.observedAt > (r4vFigures.freshness.dataMs ?? 155 * DAY),
	};
}

function unhcrView(store: Store, now: number): HumanitarianView["migration"]["unhcr"] {
	const byYear = (series: string) =>
		latestRevisions(store.history<Stock>("unhcr-population", series, now - 15 * YEAR, now), (o) =>
			String(o.value.year),
		);
	const abroad = byYear("abroad");
	const hosted = byYear("hosted");
	const a = abroad.at(-1);
	const h = hosted.at(-1);
	const year = a?.value.year ?? null;
	const top: HumanitarianView["migration"]["unhcr"]["top"] = [];
	if (year !== null) {
		for (const o of store.latestPerSeries<Stock>("unhcr-population", yearEndOf(year), 500)) {
			if (!o.series.startsWith("abroad:") || o.value.year !== year || !o.value.country) continue;
			const total = sumReported(o.value.refugees, o.value.asylumSeekers, o.value.otherInNeed);
			if (total) top.push({ country: o.value.country, name: o.value.countryName ?? o.value.country, total });
		}
		top.sort((x, y) => y.total - x.total || x.name.localeCompare(y.name));
	}
	return {
		year,
		observedAt: a?.observedAt ?? null,
		abroad: a
			? {
					refugees: a.value.refugees,
					asylumSeekers: a.value.asylumSeekers,
					otherInNeed: a.value.otherInNeed,
					total: sumReported(a.value.refugees, a.value.asylumSeekers, a.value.otherInNeed),
				}
			: null,
		abroadByYear: abroad.map((o) => ({
			year: o.value.year,
			total: sumReported(o.value.refugees, o.value.asylumSeekers, o.value.otherInNeed),
		})),
		hosted: h
			? {
					year: h.value.year,
					refugees: h.value.refugees,
					asylumSeekers: h.value.asylumSeekers,
					total: sumReported(h.value.refugees, h.value.asylumSeekers, h.value.otherInNeed),
				}
			: null,
		top: top.slice(0, 8),
		stale: !a || now - a.observedAt > (unhcrPopulation.freshness.dataMs ?? 610 * DAY),
	};
}

const yearEndOf = (year: number) => Date.UTC(year, 11, 31);

function aidView(store: Store, now: number): HumanitarianView["aid"] {
	const plans = store
		.latestPerSeries<PlanFunding>("ocha-fts", now - 30 * DAY)
		.filter((o) => o.series.startsWith("plan:"))
		.map((o) => ({
			code: o.value.code,
			name: o.value.name,
			year: o.value.year,
			kind: o.value.kind,
			requirementsUsd: o.value.requirementsUsd,
			originalRequirementsUsd: o.value.originalRequirementsUsd,
			fundedUsd: o.value.fundedUsd,
			pctFunded: pctFunded(o.value.fundedUsd, o.value.requirementsUsd),
			gapUsd: Math.max(0, o.value.requirementsUsd - o.value.fundedUsd),
			sourceUrl: o.sourceUrl,
			observedAt: o.observedAt,
		}))
		// Current year first, the HRP before the RMRP, then older years.
		.sort((a, b) => b.year - a.year || (a.kind === "hrp" ? -1 : 1) - (b.kind === "hrp" ? -1 : 1));
	const current = plans.find((p) => p.kind === "hrp");
	const hrpCurve = current
		? store.history<PlanFunding>("ocha-fts", `plan:${current.code}`, now - YEAR, now).flatMap((o) => {
				const pct = pctFunded(o.value.fundedUsd, o.value.requirementsUsd);
				return pct === null ? [] : [{ at: o.observedAt, pct }];
			})
		: [];
	const relief = store.latestPerSeries<ReliefItem>("reliefweb-ve", now - 3 * YEAR, 400);
	const newest = plans.reduce((m, p) => Math.max(m, p.observedAt), 0);
	return {
		plans,
		hrpCurve,
		disasters: relief
			.filter((o) => o.value.kind === "disaster")
			.slice(0, 5)
			.map((o) => ({
				title: o.value.title,
				url: o.value.url,
				glide: o.value.glide,
				observedAt: o.observedAt,
			})),
		reports: relief
			.filter((o) => o.value.kind === "report")
			.slice(0, 8)
			.map((o) => ({ title: o.value.title, url: o.value.url, orgs: o.value.orgs, observedAt: o.observedAt })),
		stale: !newest || now - newest > (ochaFts.freshness.dataMs ?? 3 * DAY),
	};
}

export function humanitarianView(store: Store, now: number): HumanitarianView {
	return {
		health: healthView(store, now),
		migration: { r4v: r4vView(store, now), unhcr: unhcrView(store, now) },
		aid: aidView(store, now),
		security: { years: [...OVV_YEARS], checkedOn: OVV_CHECKED_ON, sourceUrl: OVV_HOME },
		rules: {
			es: "Cifras calculadas por Vigía con reglas fijas: % financiado = financiado ÷ requerimiento actual × 100; brecha = requerimiento − financiado. «Desplazados en el exterior» (ACNUR) = refugiados + solicitantes de asilo + otras personas con necesidad de protección internacional; una categoría sin dato («-») no cuenta como 0. El cambio semanal compara con la semana anterior del mismo boletín. R4V y ACNUR cuentan cosas distintas y no se suman ni se promedian.",
			en: 'Figures computed by Vigía with fixed rules: % funded = funded ÷ current requirements × 100; gap = requirements − funded. "Displaced abroad" (UNHCR) = refugees + asylum seekers + other people in need of international protection; a category with no data ("-") does not count as 0. The weekly change compares with the previous week of the same bulletin. R4V and UNHCR count different things and are never added or averaged.',
		},
		attributions: [
			{ feed: "mpps-boletin", text: MPPS_LICENCE.attribution, licenceUrl: MPPS_LIST },
			{ feed: "who-gho", text: WHO_LICENCE.attribution, licenceUrl: WHO_LICENCE.url },
			{ feed: "r4v-figures", text: R4V_LICENCE.attribution, licenceUrl: R4V_PAGE },
			{ feed: "unhcr-population", text: UNHCR_LICENCE.attribution, licenceUrl: UNHCR_PAGE },
			{ feed: "ocha-fts", text: FTS_LICENCE.attribution, licenceUrl: FTS_LICENCE.url },
			{ feed: "reliefweb-ve", text: RELIEFWEB_LICENCE.attribution, licenceUrl: RW_COUNTRY },
			{ feed: "ovv", text: OVV_ATTRIBUTION, licenceUrl: OVV_HOME },
		],
	};
}

export const humanitarianPanel: Panel<HumanitarianView> = {
	id: "humanitarian",
	sources: ["mpps-boletin", "who-gho", "r4v-figures", "unhcr-population", "ocha-fts", "reliefweb-ve"],
	compute: (store: Store, now: number) => humanitarianView(store, now),
};
