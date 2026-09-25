/**
 * Topic rules: readable, editable keyword patterns over normalised text (no accents, lowercase). An item may
 * have several topics. These are what the core uses without any model; the AI section can do better and is
 * measured against the same labels.
 */
import { normalize } from "./text.ts";

export type Topic =
	| "electricidad"
	| "agua"
	| "internet"
	| "protesta"
	| "economia"
	| "sismo"
	| "lluvias"
	| "incendio"
	| "salud"
	| "seguridad"
	| "politica"
	| "petroleo"
	| "migracion"
	| "derechos";

export const TOPIC_LABELS: Record<Topic, { es: string; en: string }> = {
	electricidad: { es: "Electricidad", en: "Electricity" },
	agua: { es: "Agua", en: "Water" },
	internet: { es: "Internet y telecom", en: "Internet and telecom" },
	protesta: { es: "Protestas", en: "Protests" },
	economia: { es: "Economía", en: "Economy" },
	sismo: { es: "Sismos", en: "Earthquakes" },
	lluvias: { es: "Lluvias", en: "Rain and floods" },
	incendio: { es: "Incendios", en: "Fires" },
	salud: { es: "Salud", en: "Health" },
	seguridad: { es: "Seguridad", en: "Security" },
	politica: { es: "Política", en: "Politics" },
	petroleo: { es: "Petróleo y combustible", en: "Oil and fuel" },
	migracion: { es: "Migración", en: "Migration" },
	derechos: { es: "Derechos humanos", en: "Human rights" },
};

/** Word-boundary patterns on normalised text. Keep each list short, specific, and tested. */
export const TOPIC_RULES: Record<Topic, readonly string[]> = {
	electricidad: [
		"apagon(es)?",
		"sin luz",
		"sin (servicio )?electric(o|idad)",
		"cortes? (de luz|electricos?|de energia)",
		"fallas? electricas?",
		"racionamiento electrico",
		"racionamientos? de (luz|energia)",
		"corpoelec",
		"bajones? de (luz|voltaje)",
		"(servicio|suministro) electrico",
		"sistema electrico",
		"interrupcion(es)? (del servicio )?electric(a|as|o)",
	],
	agua: [
		"sin agua",
		"(servicio|suministro) de agua",
		"hidro(capital|lago|centro|ven|andes|falcon|lara|oriente|paez|caribe|suroeste|bolivar)",
		"camiones? cisternas?",
		"agua potable",
	],
	internet: [
		"sin internet",
		"(caida|falla|fallas) (del|de) internet",
		"cantv",
		"movilnet",
		"digitel",
		"movistar",
		"conatel",
		"conectividad",
		"bloque(o|a|an|ado|ados) (de|a) (sitios|paginas|portales|medios)",
		"bloqueos? (web|digitales?)",
		"fibra optica",
	],
	protesta: [
		"protest(a|an|as|aron|ando)",
		"manifesta(cion|ciones|ntes)",
		"marchas?",
		"trancan",
		"trancaron",
		"cacerolazos?",
		"plantones?",
		"huelgas?",
		"paro (de|nacional|indefinido)",
	],
	economia: [
		"dolar(es)?",
		"bcv",
		"inflacion",
		"tipo de cambio",
		"bolivares",
		"salario(s)? minimo",
		"canasta (basica|alimentaria)",
		"precios?",
		"devaluacion",
		"divisas",
	],
	sismo: [
		"sismos?",
		"temblor(es)?",
		"terremotos?",
		"funvisis",
		"replicas? (sismicas?)?",
		"movimiento telurico",
	],
	lluvias: [
		"lluvias?",
		"inundacion(es)?",
		"inundad[oa]s?",
		"deslaves?",
		"desbordamiento",
		"desbord(o|a|e) (el|la|del|rio|quebrada)",
		"vaguada",
		"onda tropical",
		"crecidas?",
		"tormentas?",
		"aguaceros?",
	],
	incendio: ["incendios?", "quemas?", "conato de incendio", "incendio forestal"],
	salud: [
		"hospital(es)?",
		"dengue",
		"malaria",
		"paludismo",
		"vacunas?",
		"vacunacion",
		"brotes?",
		"epidemi(a|as)",
		"medicinas?",
		"medicamentos?",
		"pacientes?",
	],
	seguridad: [
		"homicidios?",
		"asesinad[oa]s?",
		"asesinato",
		"enfrentamiento",
		"secuestr(o|os|ado|ada)",
		"robo",
		"atraco",
		"tiroteo",
		"abatid[oa]s?",
		"bandas? (criminales?|armadas?)",
	],
	politica: [
		"gobierno",
		"asamblea nacional",
		"cne",
		"elecciones",
		"electoral",
		"president(e|a|encia)",
		"ministr(o|a)",
		"oposicion",
		"diputad(o|a|os|as)",
		"sancion(es)?",
	],
	petroleo: [
		"pdvsa",
		"petrole(o|ra|ras)",
		"crudo",
		"barriles",
		"refineri(a|as)",
		"gasolina",
		"combustible",
		"diesel",
		"gas domestico",
		"bombonas?",
		"chevron",
	],
	migracion: [
		"migra(ntes|cion|torio)",
		"diaspora",
		"deportad[oa]s",
		"vuelta a la patria",
		"frontera",
		"refugiad[oa]s",
	],
	derechos: [
		"presos? politicos?",
		"foro penal",
		"detencion(es)? arbitrarias?",
		"libertad de (expresion|prensa)",
		"periodistas? (detenid|agredid|amenazad)",
		"desaparicion forzada",
		"torturas?",
		"derechos humanos",
	],
};

const COMPILED = (Object.entries(TOPIC_RULES) as [Topic, readonly string[]][]).map(
	([topic, patterns]) => [topic, new RegExp(`(^| )(${patterns.join("|")})( |$)`)] as const,
);

export function topics(text: string): Topic[] {
	const n = normalize(text);
	return COMPILED.filter(([, re]) => re.test(n)).map(([topic]) => topic);
}
