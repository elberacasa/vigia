import { signal } from "@preact/signals";

/* News topics (keyword-assigned by the server), shared by the map's headline layer and the news panel. */

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

export const TOPICS: Record<Topic, { es: string; en: string }> = {
	electricidad: { es: "Electricidad", en: "Electricity" },
	agua: { es: "Agua", en: "Water" },
	internet: { es: "Internet", en: "Internet" },
	protesta: { es: "Protestas", en: "Protests" },
	economia: { es: "Economía", en: "Economy" },
	sismo: { es: "Sismos", en: "Quakes" },
	lluvias: { es: "Lluvias", en: "Rain" },
	incendio: { es: "Incendios", en: "Fires" },
	salud: { es: "Salud", en: "Health" },
	seguridad: { es: "Seguridad", en: "Security" },
	politica: { es: "Política", en: "Politics" },
	petroleo: { es: "Petróleo", en: "Oil" },
	migracion: { es: "Migración", en: "Migration" },
	derechos: { es: "DD. HH.", en: "Rights" },
};

/** Topic filter shared by the news panel and the map's headline layer (null: all). */
export const newsTopic = signal<Topic | null>(null);
