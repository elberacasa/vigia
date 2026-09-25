/**
 * The fast layer's questions for one news item, and how their answers map to labels. One request per item: the
 * state is the item alone (never a batch of items: measured elsewhere, crowding shifts answers), and every question
 * is independent. Instructions are in English (Jev's strongest language); the item stays in Spanish.
 */
import type { Answer, Question } from "./judge.ts";

export interface NewsInput {
	readonly outlet: string;
	readonly region: string;
	readonly title: string;
	readonly summary: string;
}

export const TOPIC_DEFS = {
	electricidad:
		"the electricity supply in Venezuela: power outages, cuts, rationing, voltage drops, the power grid or Corpoelec",
	agua: "the water supply or water service",
	internet: "internet, telephone or telecom service, connectivity, or blocking of websites",
	protesta: "protests, marches, strikes, road blockades or cacerolazos",
	economia: "prices, the exchange rate, inflation, wages, business or economic data",
	sismo: "earthquakes or their aftermath, including reconstruction after an earthquake",
	lluvias: "rain, floods, landslides, storms or overflowing rivers",
	incendio: "fires (forest, urban or industrial)",
	salud: "health, hospitals, diseases or medicines",
	seguridad: "crime, violence, or police or military operations against crime",
	politica: "government, political parties, elections, officials, diplomacy or laws",
	petroleo: "oil, gas, PDVSA, refineries, or fuel supply and shortages",
	migracion: "migration, deportations, the Venezuelan diaspora or border crossings",
	derechos: "human rights, political prisoners, press freedom, or detentions of activists or journalists",
} as const;
export type AiTopic = keyof typeof TOPIC_DEFS;

export const EVENT_TYPES = {
	corte_luz: "It reports an actual power outage, electricity cut or rationing that people are experiencing.",
	falla_servicio:
		"It reports an actual failure of another public service: water, gas, internet, or fuel shortages and queues.",
	protesta: "It reports a protest, strike or road blockade taking place or being called.",
	desastre:
		"It reports a natural or accidental disaster or its immediate aftermath: earthquake, flood, landslide, fire, storm or explosion.",
	crimen: "It reports a crime or a violent incident.",
	politica:
		"It is political or government news: statements, decisions, elections, diplomacy, trials of politicians.",
	economia: "It is economic data or business news.",
	sociedad: "It is health, education, culture, sport, human-interest or other community news.",
	opinion: "It is opinion, analysis, an interview or an explainer without a new event.",
	otro: "None of the above, or the text is too vague to tell.",
} as const;
export type EventType = keyof typeof EVENT_TYPES;

/** Main places per state help the model map a town to its state (a lookup it could otherwise get wrong). */
export const STATE_OPTIONS: Record<string, string> = {
	"VE-A":
		"Distrito Capital: Caracas (Libertador municipality: Catia, El Valle, La Vega, 23 de Enero, Antímano, El Paraíso)",
	"VE-B": "Anzoátegui: Barcelona, Puerto La Cruz, Lechería, El Tigre, Anaco",
	"VE-C": "Apure: San Fernando de Apure, Guasdualito",
	"VE-D": "Aragua: Maracay, La Victoria, Turmero, Cagua, Las Tejerías",
	"VE-E": "Barinas: Barinas, Socopó",
	"VE-F": "Bolívar: Ciudad Bolívar, Ciudad Guayana (Puerto Ordaz, San Félix), Upata, El Callao, Tumeremo",
	"VE-G": "Carabobo: Valencia, Puerto Cabello, Guacara, Naguanagua, San Diego",
	"VE-H": "Cojedes: San Carlos, Tinaquillo",
	"VE-I": "Falcón: Coro, Punto Fijo, Paraguaná, Tucacas",
	"VE-J": "Guárico: San Juan de los Morros, Calabozo, Valle de la Pascua",
	"VE-K": "Lara: Barquisimeto, Cabudare, Carora, Duaca",
	"VE-L": "Mérida: Mérida, Ejido, El Vigía, Tovar",
	"VE-M":
		"Miranda: Los Teques, Petare, Chacao, Baruta, El Hatillo, Guarenas, Guatire, Ocumare del Tuy, Higuerote",
	"VE-N": "Monagas: Maturín, Punta de Mata, Caripe",
	"VE-O": "Nueva Esparta: Isla de Margarita, Porlamar, La Asunción, Coche",
	"VE-P": "Portuguesa: Guanare, Acarigua, Araure",
	"VE-R": "Sucre: Cumaná, Carúpano, Güiria, Irapa",
	"VE-S": "Táchira: San Cristóbal, San Antonio del Táchira, Ureña, Rubio",
	"VE-T": "Trujillo: Trujillo, Valera, Boconó",
	"VE-U": "Yaracuy: San Felipe, Nirgua, Aroa, Yaritagua",
	"VE-V": "Zulia: Maracaibo, San Francisco, Cabimas, Ciudad Ojeda, Machiques, Lake Maracaibo",
	"VE-W": "Dependencias Federales: Los Roques and other federal islands",
	"VE-X": "La Guaira (formerly Vargas): La Guaira, Maiquetía, Catia La Mar, Macuto",
	"VE-Y": "Delta Amacuro: Tucupita",
	"VE-Z": "Amazonas: Puerto Ayacucho",
	NACIONAL:
		"The event concerns the whole country or national institutions with no specific place (a national law, the central bank rate, a nationwide measure). Caracas as the seat of government does not count as a place.",
	VARIOS: "The event happens in several named states at once.",
	FUERA: "The event happens outside Venezuela.",
	DESCONOCIDO: "The text does not say where the event happens.",
};

export const SEVERITY_LEVELS = [
	"No harm or disruption to people: information, politics, culture, economic data or opinion.",
	"Minor or local disruption: a street or neighbourhood without a service for hours, a small protest, a felt earthquake without damage.",
	"Serious disruption or harm to many people: a city or several areas without power for hours, flooding with families affected or evacuated, injuries, an earthquake with damage.",
	"Deaths, or a major emergency affecting a large population.",
] as const;

export function newsState(item: NewsInput): Record<string, string> {
	const region =
		item.region === "international"
			? "international news outlet"
			: item.region === "national"
				? "Venezuelan national outlet"
				: item.region === "diaspora"
					? "Venezuelan diaspora outlet"
					: `Venezuelan regional outlet (${STATE_OPTIONS[item.region]?.split(":")[0] ?? item.region})`;
	return {
		outlet: `${item.outlet} (${region})`,
		headline: item.title,
		summary: item.summary || "(no summary)",
	};
}

export function newsQuestions(): Record<string, Question> {
	const q: Record<string, Question> = {
		about_venezuela: {
			type: "noul",
			instructions:
				"The news item in `headline` and `summary` is in Spanish. Does it report something happening in Venezuela, or directly about Venezuela, its government, its economy or Venezuelan people (including Venezuelan migrants abroad)?",
			criteria: {
				true: "It is about Venezuela or Venezuelans.",
				false:
					"It is foreign news with no Venezuelan angle (another country's politics, world sport, celebrities).",
			},
		},
		event_type: {
			type: "choice",
			instructions: "The news item in `headline` and `summary` is in Spanish. What kind of news is it?",
			criteria: EVENT_TYPES,
		},
		blackout: {
			type: "noul",
			instructions:
				"The news item in `headline` and `summary` is in Spanish. Does it report an actual loss of electricity (apagón, corte de luz, racionamiento, 'sin luz', falla eléctrica) affecting people in Venezuela?",
			criteria: {
				true: "It reports that people or places in Venezuela are, were, or will be without electricity.",
				false:
					"No outage is reported: it discusses the electric system, investment, tariffs or plans without an outage, or the outage is outside Venezuela.",
			},
		},
		severity: {
			type: "score",
			instructions:
				"The news item in `headline` and `summary` is in Spanish. How much harm or disruption to people does it report?",
			criteria: SEVERITY_LEVELS,
		},
		state: {
			type: "choice",
			instructions:
				"The news item in `headline` and `summary` is in Spanish. In which Venezuelan state does the reported event happen? Choose by the places named in the text; do not assume the outlet's own region.",
			criteria: STATE_OPTIONS,
		},
	};
	for (const [topic, def] of Object.entries(TOPIC_DEFS)) {
		q[`topic_${topic}`] = {
			type: "noul",
			instructions: `The news item in \`headline\` and \`summary\` is in Spanish. Is it substantially about ${def}?`,
			criteria: {
				true: `Yes: ${def} is a main subject of the item.`,
				false: "No, or it is only mentioned in passing.",
			},
		};
	}
	return q;
}

export interface NewsLabels {
	about_venezuela: number;
	topics: Partial<Record<AiTopic, number>>;
	event_type: { choice: string; confidence: number; probabilities: Record<string, number> };
	blackout: number;
	severity: { score: number; confidence: number };
	state: { choice: string; confidence: number; probabilities: Record<string, number> };
}

export function toLabels(answers: Readonly<Record<string, Answer>>): NewsLabels {
	const noul = (id: string) => {
		const a = answers[id];
		return a?.type === "noul" ? a.noul : Number.NaN;
	};
	const choice = (id: string) => {
		const a = answers[id];
		return a?.type === "choice"
			? { choice: a.choice, confidence: a.confidence, probabilities: { ...a.probabilities } }
			: { choice: "", confidence: 0, probabilities: {} };
	};
	const sev = answers.severity;
	const topics: Partial<Record<AiTopic, number>> = {};
	for (const t of Object.keys(TOPIC_DEFS) as AiTopic[]) topics[t] = noul(`topic_${t}`);
	return {
		about_venezuela: noul("about_venezuela"),
		topics,
		event_type: choice("event_type"),
		blackout: noul("blackout"),
		severity:
			sev?.type === "score"
				? { score: sev.score, confidence: sev.confidence }
				: { score: Number.NaN, confidence: 0 },
		state: choice("state"),
	};
}
