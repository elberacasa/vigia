/**
 * Figures that exist only in official documents or in publications Vigía cannot read automatically, entered here by
 * hand, each with the document it comes from, the date it was published and the date someone checked it. Tested in
 * pocket.test.ts. An entry is added only after its document was opened and read; nothing here is estimated.
 */

export type PublishedFigure = {
	id: string;
	labelEs: string;
	labelEn: string;
	/** Bolívares per month. */
	vesMonthly: number;
	/** Who publishes it and in what. */
	publisherEs: string;
	publisherEn: string;
	/** "official": a State publication; "independent": a named non-governmental publisher. */
	kind: "official" | "independent";
	/** The instrument, as it names itself. */
	instrument: string;
	/** In force from (YYYY-MM-DD, Caracas). */
	inForceFrom: string;
	publishedOn: string;
	sourceUrl: string;
	documentUrl: string;
	/** When the document was last opened and the figure read from it. */
	checkedOn: string;
	/** Why Vigía believes it is still the figure in force, with dated links. */
	currentEs: string;
	currentEn: string;
	evidence: { label: string; url: string; date: string }[];
};

/**
 * The national minimum wage: Bs 130 a month since 15 March 2022. Read on 2026-09-24 in the PDF of Gaceta Oficial
 * N° 6.691 Extraordinario (Decreto N° 4.653, art. 1: "CIENTO TREINTA BOLÍVARES SIN CÉNTIMOS (Bs. 130,00)
 * mensuales", "a partir del 15 de marzo de 2022"). A search for "salario" in the official index found no later decree; press
 * reports of 24 Sept 2026 describe the wage as frozen at Bs 130 since 2022.
 */
export const MINIMUM_WAGE: PublishedFigure = {
	id: "salario-minimo",
	labelEs: "Salario mínimo nacional",
	labelEn: "National minimum wage",
	vesMonthly: 130,
	publisherEs: "Presidencia de la República, en Gaceta Oficial",
	publisherEn: "Presidency of the Republic, in the Official Gazette",
	kind: "official",
	instrument: "Decreto N° 4.653 (Gaceta Oficial N° 6.691 Extraordinario)",
	inForceFrom: "2022-03-15",
	publishedOn: "2022-03-15",
	sourceUrl: "http://www.gacetaoficial.gob.ve/gacetas/6691",
	documentUrl: "http://www.gacetaoficial.gob.ve/storage/2022/T028700038197-0-6.691_15-03-2022-000.pdf",
	checkedOn: "2026-09-24",
	currentEs:
		"Una búsqueda de «salario» en el índice oficial de la Gaceta (24/09/2026) no halló un decreto posterior, y la prensa del 24 de septiembre de 2026 lo describe congelado en Bs 130 desde 2022. Los bonos (ingreso mínimo integral, cestaticket) se anuncian aparte y no están aquí.",
	currentEn:
		"A search for “salario” in the Gazette's official index (2026-09-24) found no later decree, and the press of 24 September 2026 describes it as frozen at Bs 130 since 2022. Bonuses (ingreso mínimo integral, cestaticket) are announced separately and are not included.",
	evidence: [
		{
			label: "La Verdad: jubilados y pensionados, salario congelado en 130 bolívares desde 2022",
			url: "https://laverdad.com/jubilados-y-pensionados-denuncian-que-el-salario-en-el-pais-es-algo-simbolico/",
			date: "2026-09-24",
		},
		{
			label: "El Tiempo (Anzoátegui): salario «estancado en 130 bolívares» desde hace más de cuatro años",
			url: "https://eltiempove.com/en-carupano-se-unieron-a-la-jornada-nacional-de-protesta-por-salarios-dignos/",
			date: "2026-09-24",
		},
	],
};

export type Pending = {
	id: string;
	labelEs: string;
	labelEn: string;
	whyEs: string;
	whyEn: string;
	checkedOn: string;
};

/** What a Venezuelan would also want here and why it is not shown yet (checked 2026-09-24). */
export const PENDING: readonly Pending[] = [
	{
		id: "bonos",
		labelEs: "Ingreso mínimo integral y bonos",
		labelEn: "Ingreso mínimo integral and bonuses",
		whyEs:
			"Se anuncian por el Canal Patria Digital y en actos públicos, no en el índice de la Gaceta, y los montos varían por nómina. Vigía no los muestra sin un documento oficial con fecha.",
		whyEn:
			"They are announced on the Patria Digital channel and at public events, not in the Gazette index, and amounts vary by payroll. Vigía does not show them without a dated official document.",
		checkedOn: "2026-09-24",
	},
	{
		id: "canasta",
		labelEs: "Canasta alimentaria (CENDAS-FVM)",
		labelEn: "Food basket (CENDAS-FVM)",
		whyEs:
			"El sitio de CENDAS-FVM no respondió desde fuera de Venezuela (conexión TLS cortada). Cuando pueda leerse su publicación mensual, se anotará aquí con enlace y mes, como «cifra publicada por CENDAS-FVM».",
		whyEn:
			"CENDAS-FVM's site did not answer from outside Venezuela (TLS connection cut). Once its monthly publication can be read, it will be entered here with a link and month, as a “figure published by CENDAS-FVM”.",
		checkedOn: "2026-09-24",
	},
	{
		id: "ovf",
		labelEs: "Inflación independiente (Observatorio Venezolano de Finanzas)",
		labelEn: "Independent inflation (Venezuelan Finance Observatory)",
		whyEs:
			"Ninguno de sus dominios conocidos resolvió; publica en redes sociales. La inflación oficial del BCV está en el panel Dólar.",
		whyEn:
			"None of its known domains resolved; it publishes on social media. The BCV's official inflation is in the Dollar panel.",
		checkedOn: "2026-09-24",
	},
];
