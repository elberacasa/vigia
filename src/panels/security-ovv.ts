/**
 * Violent deaths in Venezuela by year, as the Observatorio Venezolano de Violencia (OVV, with LACSO) published them
 * in its national annual reports. The reports are web posts and PDFs with no machine-readable series, so the
 * figures are transcribed here by hand from each report, with its link and publication date, and tested
 * (components add up to the published total). Aggregates only: no incident, place or person.
 *
 * What was checked on 2026-09-24:
 * - The OVV's newest national annual report is 2023 (published 28 December 2023). No national report for 2024 or
 *   2025 is on its site (the WordPress media and news listings end there; regional notes continue into 2025).
 * - OVV's "muertes violentas" is homicides by civilians + deaths from police/military intervention ("resistencia
 *   a la autoridad") + deaths "en averiguación" (violent deaths whose cause is under investigation). 2021's report
 *   also added disappearances to a larger total (11,081; rate 40.9); the 2022 report restated 2021 without them
 *   (9,447; 34.9), which is the comparable figure kept here.
 * - Rates are the OVV's own, each on the population the OVV assumed that year (26.55 million for 2022, 26 million
 *   for 2023); Vigía does not recompute them.
 * - No official national homicide series was found published by the Venezuelan state for these years; the panel
 *   says so rather than showing a single figure as if it were uncontested.
 *
 * Licence: the reports carry no licence; figures are cited with attribution and a link to each report.
 */

export type OvvYear = {
	readonly year: number;
	/** Homicides + intervention deaths + deaths under investigation. */
	readonly violentDeaths: number;
	readonly homicides: number;
	readonly interventionDeaths: number;
	readonly underInvestigation: number;
	/** Violent deaths per 100,000 inhabitants, as the OVV published it. */
	readonly ratePer100k: number;
	/** Population the OVV assumed, when the report states it. */
	readonly population: number | null;
	readonly publishedOn: string;
	readonly url: string;
	readonly noteEs: string | null;
	readonly noteEn: string | null;
};

export const OVV_HOME = "https://observatoriodeviolencia.org.ve/informes/informe-anual-de-violencia/";
export const OVV_CHECKED_ON = "2026-09-24";
export const OVV_ATTRIBUTION =
	"Fuente: Observatorio Venezolano de Violencia (OVV) y LACSO, Informe Anual de Violencia";

export const OVV_YEARS: readonly OvvYear[] = [
	{
		year: 2021,
		violentDeaths: 9_447,
		homicides: 3_112,
		interventionDeaths: 2_332,
		underInvestigation: 4_003,
		ratePer100k: 34.9,
		population: null,
		publishedOn: "2021-12-28",
		url: "https://observatoriodeviolencia.org.ve/news/informe-anual-de-violencia-2021/",
		noteEs:
			"Componentes del informe 2021; total y tasa sin desapariciones como los reexpresó el informe 2022 (con 1.634 desapariciones el informe 2021 daba 11.081 y 40,9).",
		noteEn:
			"Components from the 2021 report; total and rate without disappearances as restated in the 2022 report (with 1,634 disappearances the 2021 report gave 11,081 and 40.9).",
	},
	{
		year: 2022,
		violentDeaths: 9_367,
		homicides: 2_328,
		interventionDeaths: 1_240,
		underInvestigation: 5_799,
		ratePer100k: 35.3,
		population: 26_550_000,
		publishedOn: "2022-12-29",
		url: "https://observatoriodeviolencia.org.ve/news/informe-anual-de-violencia-2022/",
		noteEs: "El informe cuenta además 1.370 denuncias de desaparición, fuera de este total.",
		noteEn: "The report also counts 1,370 reported disappearances, outside this total.",
	},
	{
		year: 2023,
		violentDeaths: 6_973,
		homicides: 1_956,
		interventionDeaths: 953,
		underInvestigation: 4_064,
		ratePer100k: 26.8,
		population: 26_000_000,
		publishedOn: "2023-12-28",
		url: "https://observatoriodeviolencia.org.ve/news/informe-anual-de-violencia-2023/",
		noteEs: null,
		noteEn: null,
	},
];
