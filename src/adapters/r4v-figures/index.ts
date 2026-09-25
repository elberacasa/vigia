import { z } from "zod";
import type { Adapter, Licence, Observation } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";

/**
 * R4V (the Inter-Agency Coordination Platform for Refugees and Migrants from Venezuela, led by UNHCR and IOM): how
 * many Venezuelan refugees and migrants each host country reports, from its page "Refugiados y migrantes de
 * Venezuela". One request per run (the Spanish page, ~83 KB, 0.3 s, keyless; robots.txt allows it).
 *
 * What the page holds (verified 2026-09-24):
 * - The regional headline: "Personas venezolanas refugiadas y migrantes en América Latina y el Caribe 6.978.009 /
 *   Última actualización de agosto de 2026".
 * - A table (in the page's `drupal-settings-json`, `tables["r4v-table"].data`), one row per host country: the
 *   figure (`poblacion`), the previous one (`anterior`), the government body behind it, the date of the figure
 *   (`fecha`, "26-Apr" = April 2026) and when R4V published it ("Publicacion R4V", "26-May"). Countries update on
 *   their own schedules: Colombia's figure is from April 2026, Spain's from July 2024 (UNDESA).
 * - The headline is not the sum of the table (the table also lists the USA, Spain and others outside the region,
 *   and its rows are of different dates). Vigía shows both as published and never sums them itself.
 * - Quirk: the table's `fuente` column carries the publisher's name in English and `source` in Spanish (swapped
 *   against their labels). Country names can carry a trailing comma ("Bolivia (Estado Plurinacional de),").
 *
 * Figures are reported by governments and "may include a degree of estimation" (R4V's own caveat, shown in the UI).
 *
 * Licence: the site states none; R4V publishes its datasets on HDX under CC BY 4.0. Figures are reproduced with
 * attribution; the page's HTML is not redistributed (recorded fixtures stay internal).
 */

export const R4V_LICENCE: Licence = {
	id: "r4v-attribution",
	name: "Cifras publicadas por R4V (sin licencia en el sitio; sus datos en HDX son CC BY 4.0), con atribución",
	url: "https://data.humdata.org/organization/r4v",
	attribution:
		"Fuente: R4V, Plataforma de Coordinación Interagencial para Refugiados y Migrantes de Venezuela",
	commercial: "unclear",
};

export const R4V_PAGE = "https://www.r4v.info/es/refugiadosymigrantes";

export type R4vFigure = {
	/** People reported. */
	readonly people: number;
	/** The previous figure for the same country; null for the regional headline. */
	readonly previous: number | null;
	/** Country (or "Otros (Europa)") as R4V names it; null for the regional headline. */
	readonly countryEs: string | null;
	readonly countryEn: string | null;
	/** The body behind the figure (e.g. "Migración Colombia"). */
	readonly publisherEs: string | null;
	readonly publisherEn: string | null;
	/** "YYYY-MM": the month the figure refers to (for the headline, its "última actualización"). */
	readonly month: string;
	/** "YYYY-MM": when R4V published it; null for the headline. */
	readonly publishedMonth: string | null;
};

const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ES_MONTHS = [
	"enero",
	"febrero",
	"marzo",
	"abril",
	"mayo",
	"junio",
	"julio",
	"agosto",
	"septiembre",
	"octubre",
	"noviembre",
	"diciembre",
];

/** "26-Apr" → "2026-04"; null if it is not that shape. */
export function r4vMonth(text: string): string | null {
	const m = /^(\d{2})-([A-Z][a-z]{2})$/.exec(text.trim());
	if (!m) return null;
	const i = EN_MONTHS.indexOf(m[2] as string);
	return i < 0 ? null : `20${m[1]}-${String(i + 1).padStart(2, "0")}`;
}

export function monthStartMs(month: string): number {
	return Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1);
}

const clean = (s: string) =>
	s
		.replace(/\s+/g, " ")
		.replace(/[\s,]+$/, "")
		.trim();

const Row = z.object({
	pais: z.string().min(1),
	country: z.string().min(1),
	fuente: z.string(),
	source: z.string(),
	fecha: z.string(),
	"Publicacion R4V": z.string(),
	poblacion: z.number().int().nonnegative(),
	anterior: z.number().int().nonnegative().nullable().optional(),
});

const Settings = z.object({
	tables: z.object({ "r4v-table": z.object({ data: z.array(z.unknown()) }) }),
});

/** The table rows embedded in the page. */
export function tableRows(html: string): unknown[] {
	const m =
		/<script type="application\/json" data-drupal-selector="drupal-settings-json">([\s\S]*?)<\/script>/.exec(
			html,
		);
	if (!m) throw new SchemaError("R4V: la página ya no trae drupal-settings-json");
	let json: unknown;
	try {
		json = JSON.parse(m[1] as string);
	} catch {
		throw new SchemaError("R4V: drupal-settings-json no es JSON");
	}
	const s = Settings.safeParse(json);
	if (!s.success) throw new SchemaError("R4V: la tabla r4v-table no está en la página");
	return s.data.tables["r4v-table"].data;
}

/** The regional headline and its "última actualización" month, from the page text. */
export function headline(html: string): { people: number; month: string } | null {
	const text = html
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/\s+/g, " ");
	const m =
		/refugiadas y migrantes en América Latina y el Caribe\s+(\d{1,3}(?:\.\d{3})+)\s+Última actualización de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i.exec(
			text,
		);
	if (!m) return null;
	const month = ES_MONTHS.indexOf((m[2] as string).toLowerCase());
	if (month < 0) return null;
	return {
		people: Number((m[1] as string).replace(/\./g, "")),
		month: `${m[3]}-${String(month + 1).padStart(2, "0")}`,
	};
}

export function slug(s: string): string {
	return s
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

export const r4vFigures: Adapter<R4vFigure> = {
	id: "r4v-figures",
	layer: "society",
	name: {
		es: "Refugiados y migrantes venezolanos por país de acogida (R4V)",
		en: "Venezuelan refugees and migrants by host country (R4V)",
	},
	provider: "R4V (ACNUR y OIM)",
	homepage: R4V_PAGE,
	licence: R4V_LICENCE,
	keys: [],
	// R4V updates the page a few times a year (February, May, August, November in 2025–26): daily is plenty.
	intervalMs: 24 * 3_600_000,
	// The headline's month (August 2026) is the observed date; the next update comes ~3 months later, so up to
	// ~4 months old when on time. Stale past 5 months.
	freshness: { fetchMs: 4 * 86_400_000, dataMs: 155 * 86_400_000 },

	async fetch(ctx) {
		return [
			await ctx.http.request(R4V_PAGE, {
				headers: { accept: "text/html" },
				hostGapMs: 3_000,
				maxBytes: 3 * 1024 * 1024,
				signal: ctx.signal,
			}),
		];
	},

	normalise(raws) {
		const raw = raws[0];
		if (!raw) throw new SchemaError("R4V: sin respuesta");
		const base = {
			source: "r4v-figures",
			sourceUrl: R4V_PAGE,
			fetchedAt: raw.fetchedAt,
			licence: R4V_LICENCE.id,
			confidence: 1,
			basis: "official" as const,
		};
		const out: Observation<R4vFigure>[] = [];
		const head = headline(raw.body);
		if (head && monthStartMs(head.month) <= raw.fetchedAt) {
			out.push({
				...base,
				series: "total-lac",
				observedAt: monthStartMs(head.month),
				value: {
					people: head.people,
					previous: null,
					countryEs: null,
					countryEn: null,
					publisherEs: null,
					publisherEn: null,
					month: head.month,
					publishedMonth: null,
				},
			});
		}
		for (const it of tableRows(raw.body)) {
			const p = Row.safeParse(it);
			if (!p.success) continue;
			const r = p.data;
			const month = r4vMonth(r.fecha);
			const published = r4vMonth(r["Publicacion R4V"]);
			if (!month) continue;
			const observedAt = monthStartMs(month);
			if (observedAt > raw.fetchedAt) continue;
			out.push({
				...base,
				series: `country:${slug(clean(r.country))}`,
				observedAt,
				value: {
					people: r.poblacion,
					previous: r.anterior ?? null,
					countryEs: clean(r.pais),
					countryEn: clean(r.country),
					// Swapped at the source: `source` holds the Spanish name, `fuente` the English one.
					publisherEs: clean(r.source) || null,
					publisherEn: clean(r.fuente) || null,
					month,
					publishedMonth: published,
				},
			});
		}
		if (out.length === 0) throw new SchemaError("R4V: ni el total ni la tabla por país");
		return out;
	},
};
