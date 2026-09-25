import type { Licence } from "../core/types.ts";

/** Licences shared by several sources. Source-specific ones live next to their adapter. */
export const PUBLIC_DOMAIN_USGS: Licence = {
	id: "usgs-public-domain",
	name: "Dominio público (USGS)",
	url: "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits",
	attribution: "Datos: U.S. Geological Survey",
	commercial: true,
};

export const PUBLIC_DOMAIN_NOAA: Licence = {
	id: "noaa-public-domain",
	name: "Dominio público (NOAA)",
	url: "https://www.noaa.gov/information-technology/open-data-dissemination",
	attribution: "Imágenes: NOAA/NESDIS STAR",
	commercial: true,
};
