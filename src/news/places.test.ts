import { describe, expect, test } from "bun:test";
import { tagPlaces } from "./places.ts";

const ve = { venezuelanOutlet: true };
const primary = (text: string, opts = ve) => tagPlaces(text, opts).primaryState;

describe("keyword place tagger", () => {
	test("unambiguous cities", () => {
		expect(primary("Racionamiento eléctrico en Barquisimeto, Cabudare y Carora")).toBe("VE-K");
		expect(primary("Zulia: 14 horas sin luz en Cabimas")).toBe("VE-V");
	});
	test("ambiguous names resolve by context", () => {
		const r = tagPlaces("Apagón deja sin luz a Maracaibo y San Francisco", ve);
		expect(r.mentions.find((m) => m.term === "san francisco")).toMatchObject({
			state: "VE-V",
			how: "context",
		});
	});
	test("explicit cues: estado, municipio … de <estado>, datelines", () => {
		expect(primary("Reportan fuerte sismo en Carúpano, estado Sucre")).toBe("VE-R");
		expect(primary("Protestas en el municipio Sucre de Miranda por falta de agua")).toBe("VE-M");
		expect(primary("Bolívar: mineros denuncian desalojo en El Callao")).toBe("VE-F");
		expect(primary("Guayana: trabajadores de Sidor exigen salarios")).toBe("VE-F");
	});
	test("bare state names, except the ones that are people or money", () => {
		expect(primary("Incendio forestal en el Parque Nacional Henri Pittier, Aragua")).toBe("VE-D");
		expect(primary("Simón Bolívar y la independencia: 200 años")).toBeNull();
		expect(primary("El dólar oficial cierra en 855 bolívares")).toBeNull();
		expect(primary("Homenaje a Sucre en su natalicio")).toBeNull();
	});
	test("common words and non-location phrases are not places", () => {
		expect(primary("Libertad de expresión bajo ataque, denuncia el SNTP")).toBeNull();
		expect(primary("Venezuela reclama la Guayana Esequiba ante la CIJ")).toBeNull();
		expect(tagPlaces("Concentración en la Plaza Bolívar de Chacao", ve).mentions.map((m) => m.place)).toEqual(
			["Chacao"],
		);
	});
	test("foreign homonyms", () => {
		expect(primary("Delcy Rodríguez viaja a Barcelona, España")).toBeNull();
		expect(primary("Valencia sin agua: Hidrocentro anuncia cortes")).toBe("VE-G");
		// International outlets need a cue for Mérida/Valencia.
		expect(primary("Fiestas en Valencia", { venezuelanOutlet: false })).toBeNull();
	});
	test("generic sector names need context", () => {
		expect(tagPlaces("Nuevo horario en el parque", ve).mentions).toEqual([]);
	});
	test("confidence is below 1 and honest about the method", () => {
		for (const m of tagPlaces("Caracas: cortes de luz en Chacao y Baruta", ve).mentions) {
			expect(m.confidence).toBeLessThan(1);
			expect(["unambiguous", "cue", "context", "outlet-local"]).toContain(m.how);
		}
	});
});

test("a prócer-named state inside a list of places counts", () => {
	const r = tagPlaces("Fuerte aguacero en Caracas y Miranda", { venezuelanOutlet: true });
	expect(r.mentions.map((m) => m.state).sort()).toEqual(["VE-A", "VE-M"]);
	expect(tagPlaces("Miranda y la independencia", { venezuelanOutlet: true }).mentions).toEqual([]);
});

test("place names that are ordinary phrases need a cue ('la Guardia Revolucionaria' is not La Guardia, Nueva Esparta)", () => {
	expect(
		tagPlaces("Colombia rompe relaciones con Irán y declara terrorista a la Guardia Revolucionaria", {
			venezuelanOutlet: true,
		}).mentions,
	).toEqual([]);
	expect(
		tagPlaces("Cortes de luz en el municipio La Guardia", { venezuelanOutlet: true }).mentions.length,
	).toBeLessThanOrEqual(1);
});

test("dates and figures are not places: 'el 23 de septiembre' is not the parish 23 de Enero ('El 23')", () => {
	const terms = (text: string) => tagPlaces(text, { venezuelanOutlet: true }).mentions.map((m) => m.term);
	// Found on the 2026-09-29 sample: dates in summaries linked stories to Caracas' 23 de Enero.
	expect(terms("El presidente de la FMV habló el 23 de septiembre sobre los hospitales")).toEqual([]);
	expect(terms("Así fue la nevada en Pico Espejo el 23 de agosto")).not.toContain("el 23");
	expect(terms("La tasa subió el 23 % en un mes")).toEqual([]);
	expect(terms("desde el 23 de enero de 1958")).toEqual([]);
	expect(terms("el pasado 24 de julio")).toEqual([]);
	// The parish by its full name still counts, with or without "el" before it.
	expect(terms("Inspeccionan obras en la parroquia 23 de Enero de Caracas")).toContain("23 de enero");
	expect(terms("Avanza la recuperación de espacios públicos en el 23 de Enero")).toEqual(["23 de enero"]);
	// A date-shaped sector needs a place word before it.
	expect(terms("sector 7 de Septiembre de Caracas")).toContain("7 de septiembre");
	expect(terms("el 7 de septiembre en Caracas")).not.toContain("7 de septiembre");
});

// Whole-release review, M4: measured on 12,245 real headlines, these linked a person, a phrase or a gang to a place
// (Rubio 54, del Zulia 50, García 15, las mesas 10…); after the rule, 0.
test("surnames, ordinary phrases and other names are not places; a cue or a real place still is", () => {
	const where = (t: string) => tagPlaces(t).mentions.map((m) => `${m.term}→${m.state}`);
	for (const t of [
		"Marco Rubio se reúne con la oposición venezolana",
		"Rubio: Trump y Delcy hablaron de elecciones en Venezuela",
		"Gabriel García Márquez y la literatura",
		"Gómez: Violencia y nuevas políticas en Colombia frenan flujo fronterizo",
		"Detenidos miembros del Tren de Aragua en Chile",
		"Las mesas de diálogo se reanudan en Doha",
		"El consejo de ministros aprobó el presupuesto",
		"Los obispos piden diálogo",
		"Los Padres de San Diego ganan la serie",
	])
		expect({ t, where: where(t) }).toEqual({ t, where: [] });
	expect(where("La Universidad del Zulia suspende clases")).toEqual(["zulia→VE-V"]);
	expect(where("San Carlos del Zulia sin luz desde anoche")).toEqual(["san carlos del zulia→VE-V"]);
	expect(where("Tormenta en Aragua deja árboles caídos")).toEqual(["aragua→VE-D"]);
	expect(where("Apagón en el municipio García, Nueva Esparta")).toContain("municipio garcia→VE-O");
});
