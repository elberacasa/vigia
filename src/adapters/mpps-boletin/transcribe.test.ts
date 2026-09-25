import { expect, test } from "bun:test";
import { readWeek, veNumber } from "./transcribe.ts";
import { WEEKS } from "./weeks.gen.ts";

/** Invented sentences in the bulletins' wording (not copied figures). */
const text = `La cobertura de notificación correspondiente a la SE 12 es del 40,59%.
Vigilancia de Dengue (SE 12): Se diagnosticaron 248 casos sospechosos, elevando el acumulado anual a 4.550 casos.
Malaria Durante la SE 12, con el registro de 9.000 muestras tomadas y el diagnóstico de 1.128 casos en el país.
Durante el año se han reportado un total de 25.000 casos, lo que representa un ascenso de 3,1% con respecto al período homólogo del año anterior (n=24.250).
Enfermedades Diarreicas Agudas. • Casos reportados: 10.608 • Variación semanal
respecto a la semana anterior, totalizando 41.333 casos notificados.
En la SE 12 de 2026 se registró un total de 2.021 casos notificados
han sido descartados 613 de 663 casos sospechosos, mientras que 50 casos se encuentran en investigación.
Del total de casos acumulado (06) hasta la SE 12 del 2026, han fallecido 02 lo que representa`;

test("reads each national figure from its sentence", () => {
	expect(readWeek(text, 12)).toEqual({
		coveragePct: 40.59,
		dengueWeek: 248,
		dengueYear: 4550,
		malariaWeek: 1128,
		malariaYear: 25000,
		malariaPrevYear: 24250,
		diarrhoeaWeek: 10608,
		respiratoryWeek: 41333,
		pneumoniaWeek: 2021,
		measlesSuspected: 663,
		measlesDiscarded: 613,
		measlesInvestigating: 50,
		yellowFeverCases: 6,
		yellowFeverDeaths: 2,
	});
});

test("a sentence about another week is not this week's figure; a missing sentence is null", () => {
	// SE 32's bulletin repeats SE 31's coverage sentence.
	const w = readWeek(text, 13);
	expect(w.coveragePct).toBeNull();
	expect(w.yellowFeverCases).toBeNull();
	expect(readWeek("nada", 1).dengueWeek).toBeNull();
	// Yellow fever counted "desde SE 23 2025" is another period.
	expect(readWeek("De total de casos acumulados (40) han fallecido 21", 20).yellowFeverCases).toBeNull();
});

test("Venezuelan separators", () => {
	expect(veNumber("1.378")).toBe(1378);
	expect(veNumber("49,83")).toBe(49.83);
	expect(veNumber("6")).toBe(6);
});

test("the transcribed file: one row per week of 2026, SE 1-36, spot-checked against the PDFs", () => {
	expect(WEEKS.map((w) => w.week)).toEqual(Array.from({ length: 36 }, (_, i) => i + 1));
	expect(new Set(WEEKS.map((w) => w.year))).toEqual(new Set([2026]));
	const se36 = WEEKS.find((w) => w.week === 36);
	// Read by a person from Boletin-Epidemiologico-SEM-36.pdf, pages 5, 13-17, 21.
	expect(se36).toMatchObject({
		coveragePct: 49.83,
		dengueWeek: 311,
		dengueYear: 11722,
		malariaWeek: 851,
		malariaYear: 69740,
		malariaPrevYear: 73157,
		diarrhoeaWeek: 18533,
		respiratoryWeek: 44967,
		pneumoniaWeek: 2341,
		measlesSuspected: 1819,
		measlesDiscarded: 1636,
		measlesInvestigating: 183,
		yellowFeverCases: 10,
		yellowFeverDeaths: 3,
	});
	for (const w of WEEKS) {
		expect(w.pdfUrl).toMatch(
			/^https:\/\/mpps\.gob\.ve\/wp-content\/uploads\/\d{4}\/\d{2}\/Boletin-Epidemiologico-SEM-\d{2}/,
		);
		for (const v of Object.values(w)) if (typeof v === "number") expect(v).toBeGreaterThanOrEqual(0);
		if (w.coveragePct !== null) expect(w.coveragePct).toBeLessThanOrEqual(100);
	}
	// The dengue running total never falls during the year.
	const dengue = WEEKS.flatMap((w) => (w.dengueYear === null ? [] : [w.dengueYear]));
	for (let i = 1; i < dengue.length; i++)
		expect(dengue[i] as number).toBeGreaterThanOrEqual(dengue[i - 1] as number);
});

test("inconsistencies inside the bulletins are kept as published, and known", () => {
	// SE 31: 1.135 discarded + 114 under investigation ≠ 1.465 suspected (as printed).
	const se31 = WEEKS.find((w) => w.week === 31);
	expect((se31?.measlesDiscarded ?? 0) + (se31?.measlesInvestigating ?? 0)).not.toBe(se31?.measlesSuspected);
	// SE 1: 1.388 cases in the week but 1.348 in the year (as printed).
	const se1 = WEEKS.find((w) => w.week === 1);
	expect(se1?.malariaWeek).toBe(1388);
	expect(se1?.malariaYear).toBe(1348);
});
