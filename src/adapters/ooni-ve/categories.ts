/**
 * Citizen Lab test-list category codes (used by OONI and by VE sin Filtro), with Spanish labels.
 * Source: https://github.com/citizenlab/test-lists/blob/master/lists/00-LEGEND-new_category_codes.csv
 */
export const CATEGORY_ES: Readonly<Record<string, string>> = {
	ALDR: "Alcohol y drogas",
	REL: "Religión",
	PORN: "Pornografía",
	PROV: "Vestimenta provocativa",
	POLR: "Crítica política",
	HUMR: "Derechos humanos",
	ENV: "Ambiente",
	MILX: "Grupos armados",
	HATE: "Discurso de odio",
	NEWS: "Noticias",
	XED: "Educación sexual",
	PUBH: "Salud pública",
	GMB: "Apuestas",
	ANON: "Anonimato y evasión de censura",
	DATE: "Citas",
	GRP: "Redes sociales",
	LGBT: "LGBTIQ+",
	FILE: "Intercambio de archivos",
	HACK: "Herramientas de hacking",
	COMT: "Herramientas de comunicación",
	MMED: "Multimedia",
	HOST: "Alojamiento y blogs",
	SRCH: "Buscadores",
	GAME: "Juegos",
	CULTR: "Cultura",
	ECON: "Economía",
	GOVT: "Gobierno",
	COMM: "Comercio electrónico",
	CTRL: "Contenido de control",
	IGO: "Organismos internacionales",
	MISC: "Otros",
};

export function categoryEs(code: string): string {
	if (code === "") return "Sin categoría";
	return CATEGORY_ES[code] ?? code;
}

/** Domains are compared without a leading "www." and in lower case (VE sin Filtro and OONI differ on "www."). */
export function domainKey(domain: string): string {
	return domain
		.trim()
		.toLowerCase()
		.replace(/^www\./, "");
}
