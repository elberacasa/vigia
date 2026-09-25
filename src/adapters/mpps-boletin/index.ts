import type { Adapter, Licence, Observation } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";

/**
 * The Ministerio del Poder Popular para la Salud (MPPS) publishes a national "Boletín Epidemiológico" every
 * epidemiological week again in 2026 (after years without one), as PDFs listed on one page:
 * https://mpps.gob.ve/boletines-epidemiologicos/ ("BOLETÍN EPIDEMIOLÓGICO SE36 | 06 al 12 septiembre de 2026").
 *
 * This adapter reads that list (one request, ~95 KB, 0.9 s, keyless; verified 2026-09-24): which weeks are
 * published and where each PDF is. The figures inside the PDFs (dengue, malaria, diarrhoea, respiratory
 * infections, measles surveillance, yellow fever, reporting coverage) are transcribed at development time by
 * scripts/health/mpps-transcribe.ts into weeks.gen.ts, tested, with each week's PDF as its source; the running app
 * never parses PDFs. The panel compares the two: when the ministry has published a week Vigía has not transcribed,
 * it says so instead of presenting the older week as the newest.
 *
 * Week dates: the bulletins use the standard epidemiological calendar (weeks Sunday to Saturday; week 1 is the
 * first such week with at least four days in the year; 2026's SE 1 is 4–10 January). The list's own date ranges
 * have typos ("26 al 29 de marzo", "05 julio al 11 2026"), so dates are computed from the week number and the year
 * the list gives; the computed ranges match every well-formed range on the list (tested).
 *
 * Measured quirks: one week is published in a few days to three weeks; some files carry suffixes
 * ("SEM-21-MM.pdf", "SEM-17-MMC.pdf"); weeks can be re-uploaded later under a newer upload month.
 *
 * Licence: none stated (an official publication of the Venezuelan state); figures reproduced with attribution.
 */

export const MPPS_LICENCE: Licence = {
	id: "mpps-attribution",
	name: "Publicación oficial del MPPS, sin licencia publicada (cifras con atribución)",
	url: "https://mpps.gob.ve/boletines-epidemiologicos/",
	attribution: "Fuente: Ministerio del Poder Popular para la Salud, Boletín Epidemiológico",
	commercial: "unclear",
};

export const MPPS_LIST = "https://mpps.gob.ve/boletines-epidemiologicos/";
const DAY = 86_400_000;
const CARACAS_OFFSET_MS = 4 * 3_600_000;

export type Bulletin = {
	readonly year: number;
	readonly week: number;
	readonly pdfUrl: string;
	/** "YYYY-MM-DD", Sunday and Saturday of the week (computed from the epidemiological calendar). */
	readonly from: string;
	readonly to: string;
};

/** First day (Sunday, "YYYY-MM-DD") of epidemiological week 1 of `year`: the first Sunday-to-Saturday week with at
 *  least four days in the year. */
export function epiYearStart(year: number): number {
	const jan1 = Date.UTC(year, 0, 1);
	const dow = new Date(jan1).getUTCDay();
	return dow <= 3 ? jan1 - dow * DAY : jan1 + (7 - dow) * DAY;
}

/** Sunday and Saturday of an epidemiological week, as UTC-midnight epoch ms of those calendar days. */
export function epiWeek(year: number, week: number): { from: number; to: number } {
	const from = epiYearStart(year) + (week - 1) * 7 * DAY;
	return { from, to: from + 6 * DAY };
}

export const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The end of an epidemiological week: 24:00 of its Saturday in Caracas (UTC−4), minus 1 ms. */
export function weekEndMs(year: number, week: number): number {
	return epiWeek(year, week).to + DAY + CARACAS_OFFSET_MS - 1;
}

/** Weeks per epidemiological year: 53 when the next year's week 1 starts 53 weeks later. */
export function weeksInYear(year: number): number {
	return Math.round((epiYearStart(year + 1) - epiYearStart(year)) / (7 * DAY));
}

/**
 * The list: every "<a href="…SEM-NN….pdf">BOLETÍN EPIDEMIOLÓGICO SENN</a> <range> de YYYY" entry. An entry whose
 * link and label disagree on the week, or with no year, is skipped.
 */
export function parseList(html: string): { year: number; week: number; pdfUrl: string; rangeText: string }[] {
	const out: { year: number; week: number; pdfUrl: string; rangeText: string }[] = [];
	const re =
		/<a href="(https:\/\/mpps\.gob\.ve\/wp-content\/uploads\/\d{4}\/\d{2}\/Boletin-Epidemiologico-SEM-(\d{1,2})[^"]*\.pdf)"[^>]*>\s*BOLET[ÍI]N EPIDEMIOL[ÓO]GICO SE ?(\d{1,2})\s*<\/a>([^<]*)/gi;
	for (const m of html.matchAll(re)) {
		const week = Number(m[2]);
		const rangeText = (m[4] ?? "")
			.replace(/&nbsp;/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		const year = Number(/(\d{4})\s*$/.exec(rangeText)?.[1]);
		if (week !== Number(m[3]) || !Number.isInteger(year) || year < 2000) continue;
		if (week < 1 || week > weeksInYear(year)) continue;
		out.push({ year, week, pdfUrl: m[1] as string, rangeText });
	}
	return out;
}

export const mppsBoletin: Adapter<Bulletin> = {
	id: "mpps-boletin",
	layer: "society",
	name: {
		es: "Boletín Epidemiológico semanal del MPPS",
		en: "MPPS weekly epidemiological bulletin",
	},
	provider: "Ministerio del Poder Popular para la Salud",
	homepage: MPPS_LIST,
	licence: MPPS_LICENCE,
	keys: [],
	// One bulletin a week, uploaded on no fixed day: twice a day is enough to notice a new one.
	intervalMs: 12 * 3_600_000,
	// The newest week ended 12 days before it was listed (SE 36, 12 September, listed by 24 September); a gap of
	// three weeks has happened. Stale when the newest listed week ended more than 28 days ago.
	freshness: { fetchMs: 3 * DAY, dataMs: 28 * DAY },

	async fetch(ctx) {
		return [
			await ctx.http.request(MPPS_LIST, {
				headers: { accept: "text/html" },
				hostGapMs: 3_000,
				maxBytes: 3 * 1024 * 1024,
				timeoutMs: 30_000,
				signal: ctx.signal,
			}),
		];
	},

	normalise(raws) {
		const raw = raws[0];
		if (!raw) throw new SchemaError("MPPS: sin respuesta");
		const entries = parseList(raw.body);
		if (entries.length === 0) throw new SchemaError("MPPS: la página ya no lista boletines");
		const seen = new Set<string>();
		const out: Observation<Bulletin>[] = [];
		for (const e of entries) {
			const key = `${e.year}-${String(e.week).padStart(2, "0")}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const observedAt = weekEndMs(e.year, e.week);
			if (observedAt > raw.fetchedAt) continue;
			const w = epiWeek(e.year, e.week);
			out.push({
				source: "mpps-boletin",
				series: `bulletin:${key}`,
				sourceUrl: e.pdfUrl,
				fetchedAt: raw.fetchedAt,
				observedAt,
				licence: MPPS_LICENCE.id,
				value: { year: e.year, week: e.week, pdfUrl: e.pdfUrl, from: isoDay(w.from), to: isoDay(w.to) },
				confidence: 1,
				basis: "official",
			});
		}
		return out;
	},
};
