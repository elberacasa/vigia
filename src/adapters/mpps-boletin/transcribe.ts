/**
 * Reads the national figures out of the text of an MPPS "Boletín Epidemiológico" (the PDF converted to text by
 * `pdftotext`, whitespace collapsed). Used at development time by scripts/health/mpps-transcribe.ts to write
 * weeks.gen.ts; the running app never parses PDFs.
 *
 * Each figure comes from one sentence the bulletins repeat every week, matched with a pattern that tolerates the
 * variants measured across SE 1–36 of 2026 (e.g. "casos sospechosos" / "casos probables", "diagnóstico de" /
 * "se diagnosticaron de"). A sentence that does not match gives null: a figure is never guessed or carried over.
 * Only national aggregates are read; the bulletins' case tables with parish, age and sex are never touched.
 */

export type WeekFigures = {
	/** Share of reporting units that sent their weekly report, %. */
	readonly coveragePct: number | null;
	/** Dengue: suspected (or probable) cases notified this week, and the year's running total. */
	readonly dengueWeek: number | null;
	readonly dengueYear: number | null;
	/** Malaria: confirmed cases diagnosed this week; year to date; the same period a year earlier. */
	readonly malariaWeek: number | null;
	readonly malariaYear: number | null;
	readonly malariaPrevYear: number | null;
	/** Acute diarrhoeal disease, acute respiratory infections, pneumonia: cases notified this week. */
	readonly diarrhoeaWeek: number | null;
	readonly respiratoryWeek: number | null;
	readonly pneumoniaWeek: number | null;
	/** Measles/rubella suspected cases this year: notified, discarded, under investigation. */
	readonly measlesSuspected: number | null;
	readonly measlesDiscarded: number | null;
	readonly measlesInvestigating: number | null;
	/** Yellow fever: confirmed human cases and deaths accumulated in the year up to this week. */
	readonly yellowFeverCases: number | null;
	readonly yellowFeverDeaths: number | null;
};

/** "1.378" → 1378; "49,83" → 49.83 (Venezuelan separators). */
export function veNumber(text: string): number {
	return Number(text.replace(/\./g, "").replace(",", "."));
}

function one(text: string, re: RegExp, group = 1): number | null {
	const m = re.exec(text);
	const g = m?.[group];
	if (g === undefined) return null;
	const n = veNumber(g);
	return Number.isFinite(n) ? n : null;
}

const N = String.raw`(\d{1,3}(?:\.\d{3})*|\d+)`;

/**
 * The share of reporting units, only when the sentence names this bulletin's own week: SE 32's bulletin repeats SE
 * 31's sentence ("correspondiente a la SE 31 es del 58,74%"), and that figure is not SE 32's.
 */
function coverage(t: string, week: number): number | null {
	const m =
		/cobertura de notificaci[óo]n correspond(?:e|iente) a (?:la )?(?:SE|Semana Epidemiol[óo]gica) ?N?°? ?(\d+) es del? (\d+(?:,\d+)?) ?%/.exec(
			t,
		);
	if (!m || Number(m[1]) !== week) return null;
	return veNumber(m[2] as string);
}

/**
 * Yellow fever cases and deaths accumulated in the bulletin's year, only when the sentence says so ("Del total de
 * casos acumulado (10) hasta la SE 36 del 2026, han fallecido 03"). SE 18–26 counted from SE 23 of 2025 instead
 * ("desde SE 23 2025": 40 cases, 21 deaths); that is another period and is not read as the year's.
 */
function yellowFever(t: string, week: number): { cases: number; deaths: number } | null {
	const m =
		/De(?:l)? total de casos acumulados? \((\d+)\) hasta la SE ?(\d+) del (\d{4}),? han fallecido (\d+)/.exec(
			t,
		);
	if (!m || Number(m[2]) !== week) return null;
	return { cases: Number(m[1]), deaths: Number(m[4]) };
}

export function flatten(text: string): string {
	return text.replace(/\s+/g, " ");
}

export function readWeek(raw: string, week: number): WeekFigures {
	const t = flatten(raw);
	const dengue = new RegExp(
		`Se diagnosticaron ${N} casos (?:sospechosos|probables),? elevando el acumulado anual a ${N} casos`,
	);
	const malariaYear = new RegExp(
		String.raw`se han reportado un total de ${N} casos, lo que representa un[a]? (?:aumento|ascenso|descenso|disminuci[óo]n|incremento) de [\d.,]+ ?% con respecto al per[íi]odo hom[óo]logo del a[ñn]o anterior \(n ?= ?${N}\)`,
	);
	const measles = new RegExp(
		`descartad[oa]s ${N} de ${N} casos sospechosos,? mientras que ${N} casos? se encuentra`,
	);
	const yf = yellowFever(t, week);
	return {
		coveragePct: coverage(t, week),
		dengueWeek: one(t, dengue, 1),
		dengueYear: one(t, dengue, 2),
		malariaWeek: one(
			t,
			new RegExp(
				`(?:diagn[óo]stico de|se diagnosticaron de|se diagnosticaron) ${N} casos(?: nuevos)? en el pa[íi]s`,
			),
		),
		malariaYear: one(t, malariaYear, 1),
		malariaPrevYear: one(t, malariaYear, 2),
		diarrhoeaWeek: one(
			t,
			new RegExp(
				String.raw`(?:Enfermedades Diarreicas Agudas|S[íi]ndrome Diarreico Agudo)\.? [•\s]*Casos reportados: ${N}`,
				"i",
			),
		),
		respiratoryWeek: one(t, new RegExp(`totalizando ${N} casos notificados`)),
		pneumoniaWeek: one(t, new RegExp(`se registr[óo] un total de ${N} casos notificados`)),
		measlesSuspected: one(t, measles, 2),
		measlesDiscarded: one(t, measles, 1),
		measlesInvestigating: one(t, measles, 3),
		yellowFeverCases: yf?.cases ?? null,
		yellowFeverDeaths: yf?.deaths ?? null,
	};
}
