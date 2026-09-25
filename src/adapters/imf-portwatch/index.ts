import { z } from "zod";
import type { Adapter, Licence, Observation, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { utcDateToMs } from "../../formats/time.ts";

/**
 * IMF PortWatch: daily port calls and estimated trade volumes at Venezuela's 18 ports and terminals, computed by the
 * IMF from ships' AIS positions (Arslanalp, Koepke and Verschuur, IMF WP/21/225). Aggregate counts only: no vessel
 * names, positions or tracks are requested or stored.
 *
 * What the numbers are, in the IMF's words: a port call is a ship entering the port boundary (stops under 5 hours
 * with no draught change are excluded as transit); import/export tonnes are an estimate from each ship's draught
 * change times its deadweight. Ships that switch AIS off are not counted, so for Venezuela, where tankers are
 * known to sail dark, every figure is a floor, not a total. The panel says so.
 *
 * Two requests per run to the IMF's public ArcGIS feature service (no key):
 *  1. `outStatistics` grouped by date: national daily sums for ~400 days (one row per day, ~39 KB, ~1 s);
 *  2. the per-port rows of the last 21 days (18 ports × 21 days, ~70 KB), for the "which ports" list.
 * Verified 2026-09-24: newest date 2026-09-18 (the IMF updates weekly; dates are UTC days); 18 port rows per day.
 *
 * Licence: IMF terms (item licence field → imf.org/external/terms.htm): reuse and redistribution allowed with
 * attribution ("Source: International Monetary Fund, PortWatch"); commercial reuse needs the IMF's permission;
 * transformations must be stated (our weekly sums are).
 */

export const PORTWATCH_LICENCE: Licence = {
	id: "imf-portwatch-terms",
	name: "Términos del FMI (reutilización con atribución; uso comercial con permiso)",
	url: "https://www.imf.org/en/about/copyright-and-terms",
	attribution: "Fuente: Fondo Monetario Internacional, PortWatch (sumas semanales calculadas por Vigía)",
	commercial: false,
};

export const PORTWATCH_HOME = "https://portwatch.imf.org/";
const SERVICE =
	"https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Ports_Data/FeatureServer/0/query";
const DAY = 86_400_000;
export const NATIONAL_DAYS = 400;
export const PORT_DAYS = 21;

export type PortDay = {
	/** UTC day, "YYYY-MM-DD". */
	readonly date: string;
	/** Ships entering the port boundary that day (all types). */
	readonly portCalls: number;
	readonly tankerCalls: number;
	/** IMF estimate, metric tonnes. */
	readonly importT: number;
	readonly exportT: number;
	/** National rows: how many port rows the day summed (18 when complete). Port rows: the port's id and name. */
	readonly ports?: number;
	readonly portId?: string;
	readonly name?: string;
};

const STATS = [
	["sum", "portcalls", "calls"],
	["sum", "portcalls_tanker", "tanker"],
	["sum", "import", "imp"],
	["sum", "export", "exp"],
	["count", "portid", "ports"],
].map(([statisticType, onStatisticField, outStatisticFieldName]) => ({
	statisticType,
	onStatisticField,
	outStatisticFieldName,
}));

function since(now: number, days: number): string {
	return new Date(now - days * DAY).toISOString().slice(0, 10);
}

export function nationalUrl(now: number): string {
	const q = new URLSearchParams({
		where: `ISO3='VEN' AND date >= DATE '${since(now, NATIONAL_DAYS)}'`,
		outStatistics: JSON.stringify(STATS),
		groupByFieldsForStatistics: "date",
		orderByFields: "date DESC",
		f: "json",
	});
	return `${SERVICE}?${q}`;
}

export function portsUrl(now: number): string {
	const q = new URLSearchParams({
		where: `ISO3='VEN' AND date >= DATE '${since(now, PORT_DAYS)}'`,
		outFields: "date,portid,portname,portcalls,portcalls_tanker,import,export",
		orderByFields: "date DESC,portid",
		returnGeometry: "false",
		resultRecordCount: "1000",
		f: "json",
	});
	return `${SERVICE}?${q}`;
}

const Count = z.number().int().nonnegative();
const Tonnes = z.number().nonnegative().finite();
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const NationalRow = z.object({
	attributes: z.object({ date: Day, calls: Count, tanker: Count, imp: Tonnes, exp: Tonnes, ports: Count }),
});
const PortRow = z.object({
	attributes: z.object({
		date: Day,
		portid: z.string().min(1).max(40),
		portname: z.string().min(1).max(120),
		portcalls: Count,
		portcalls_tanker: Count,
		import: Tonnes,
		export: Tonnes,
	}),
});
const Envelope = z.object({ features: z.array(z.unknown()), exceededTransferLimit: z.boolean().optional() });
const ErrorBody = z.object({ error: z.object({ message: z.string() }) });

function envelope(raw: RawResponse): z.infer<typeof Envelope> {
	let body: unknown;
	try {
		body = JSON.parse(raw.body);
	} catch {
		throw new SchemaError("PortWatch: la respuesta no es JSON");
	}
	const error = ErrorBody.safeParse(body);
	if (error.success) throw new SchemaError(`PortWatch: ${error.data.error.message.slice(0, 120)}`);
	const env = Envelope.safeParse(body);
	if (!env.success) throw new SchemaError("PortWatch: falta la lista «features»");
	return env.data;
}

export const imfPortwatch: Adapter<PortDay> = {
	id: "imf-portwatch",
	layer: "money",
	name: {
		es: "Puertos de Venezuela: llamadas de buques (FMI PortWatch, AIS)",
		en: "Venezuela's ports: ship calls (IMF PortWatch, AIS)",
	},
	provider: "FMI PortWatch",
	homepage: PORTWATCH_HOME,
	licence: PORTWATCH_LICENCE,
	keys: [],
	// Updated weekly; checking every 6 h costs ~110 KB a run.
	intervalMs: 6 * 3_600_000,
	// Weekly updates with a ~6-day lag: the newest day is up to ~13 days old on time. Stale past 16 days.
	freshness: { fetchMs: 24 * 3_600_000, dataMs: 16 * DAY },

	async fetch(ctx) {
		const opts = { headers: { accept: "application/json" }, hostGapMs: 2_000, maxBytes: 4 * 1024 * 1024 };
		return [
			await ctx.http.request(nationalUrl(ctx.now()), { ...opts, signal: ctx.signal }),
			await ctx.http.request(portsUrl(ctx.now()), { ...opts, signal: ctx.signal }),
		];
	},

	normalise(raws) {
		if (raws.length === 0) throw new SchemaError("no response");
		const out: Observation<PortDay>[] = [];
		const base = (raw: RawResponse, observedAt: number) => ({
			source: "imf-portwatch",
			sourceUrl: PORTWATCH_HOME,
			fetchedAt: raw.fetchedAt,
			observedAt,
			licence: PORTWATCH_LICENCE.id,
			// Counts are the IMF's reading of AIS (a floor); tonnes are a model estimate.
			confidence: 0.7,
			basis: "measurement" as const,
		});
		for (const raw of raws) {
			const env = envelope(raw);
			const national = raw.url.includes("outStatistics");
			if (!national && env.exceededTransferLimit) {
				throw new SchemaError("PortWatch: respuesta por puerto truncada (más de 1000 filas)");
			}
			const before = out.length;
			for (const item of env.features) {
				if (national) {
					const row = NationalRow.safeParse(item);
					if (!row.success) continue;
					const a = row.data.attributes;
					const observedAt = utcDateToMs(a.date);
					if (observedAt === null || observedAt > raw.fetchedAt) continue;
					out.push({
						...base(raw, observedAt),
						series: "ve",
						value: {
							date: a.date,
							portCalls: a.calls,
							tankerCalls: a.tanker,
							importT: Math.round(a.imp),
							exportT: Math.round(a.exp),
							ports: a.ports,
						},
					});
				} else {
					const row = PortRow.safeParse(item);
					if (!row.success) continue;
					const a = row.data.attributes;
					const observedAt = utcDateToMs(a.date);
					if (observedAt === null || observedAt > raw.fetchedAt) continue;
					out.push({
						...base(raw, observedAt),
						series: `port:${a.portid}`,
						value: {
							date: a.date,
							portCalls: a.portcalls,
							tankerCalls: a.portcalls_tanker,
							importT: Math.round(a.import),
							exportT: Math.round(a.export),
							portId: a.portid,
							name: a.portname,
						},
					});
				}
			}
			if (env.features.length > 0 && out.length === before) {
				throw new SchemaError("PortWatch: ninguna fila válida");
			}
		}
		if (!out.some((o) => o.series === "ve"))
			throw new SchemaError("PortWatch: faltan los totales nacionales");
		return out;
	},
};
