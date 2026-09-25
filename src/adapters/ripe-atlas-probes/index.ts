import { z } from "zod";
import type { Adapter, Licence, Observation } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { locate, stateByIso } from "../../geo/index.ts";

/**
 * RIPE Atlas probes hosted in Venezuela: how many are connected, per state, and how many connect/disconnect
 * events they logged per hour (built-in measurement 7000). A probe that drops off has usually lost power or its
 * uplink, so a burst of disconnects in one state is independent evidence of a cut, seen within minutes.
 *
 * Privacy (docs/ETHICS.md): probes are often in homes and their coordinates are only lightly fuzzed. This adapter
 * never stores a probe's id or position: it reduces them to counts per state inside `normalise`, and each count is
 * placed at the state's label point.
 *
 * Coverage (2026-09-24): 110 probes registered, 46 connected, 7 disconnected, spread over 26 ASNs with none on
 * CANTV or Movilnet, the largest networks; so this reflects private ISPs, mostly in the centre-north and the Andes.
 *
 * Series: `state:<ISO>:probes`, `country:VE:probes` (observed at fetch time; only states with active probes),
 * `state:<ISO>:connection-events`, `country:VE:connection-events` (hourly, observed at the hour's start; the
 * current hour is revised as events arrive).
 */

export const RIPE_ATLAS_LICENCE: Licence = {
	id: "ripe-atlas-terms",
	name: "Términos del servicio RIPE Atlas v3.4 (uso comercial solo con permiso)",
	url: "https://www.ripe.net/about-us/legal/ripe-atlas-service-terms-and-conditions/",
	attribution: "Datos: RIPE Atlas, RIPE NCC",
	commercial: false,
};

const API = "https://atlas.ripe.net/api/v2";
/** No number is published for anonymous use; "normal, non-excessive usage is generally not affected". */
const HOST_GAP_MS = 2_000;
const EVENTS_WINDOW_S = 26 * 3_600;
const HOUR_S = 3_600;

/** RIPE Atlas probe status ids. */
const CONNECTED = 1;
const DISCONNECTED = 2;

export type ProbeCounts = {
	/** Probes currently connected to the RIPE Atlas controllers. */
	readonly connected: number;
	/** Probes currently disconnected (not yet "abandoned"). */
	readonly disconnected: number;
	/** Of the disconnected, how many dropped in the last hour. */
	readonly droppedLastHour: number;
	/** National row only: active probes whose position is outside every state polygon or missing. */
	readonly unlocated: number;
};

export type ConnectionEvents = {
	readonly disconnects: number;
	readonly connects: number;
	/** Distinct probes with at least one disconnect in the hour. */
	readonly probesDisconnecting: number;
};

export type AtlasValue = ProbeCounts | ConnectionEvents;

const Probe = z.object({
	id: z.number().int(),
	status: z.object({ id: z.number().int(), name: z.string() }),
	status_since: z.number().int().nullable(),
	geometry: z.object({ coordinates: z.tuple([z.number(), z.number()]) }).nullable(),
});
const ProbeList = z.object({ count: z.number().int(), results: z.array(z.unknown()) });
const Event = z.object({
	timestamp: z.number().int(),
	prb_id: z.number().int(),
	event: z.enum(["connect", "disconnect"]),
});

export function probesUrl(): string {
	return `${API}/probes/?country_code=VE&page_size=500&fields=id,status,status_since,geometry`;
}

export function eventsUrl(ids: readonly number[], now: number): string {
	const stop = Math.floor(now / 1_000);
	const p = new URLSearchParams({
		start: String(stop - EVENTS_WINDOW_S),
		stop: String(stop),
		probe_ids: ids.join(","),
		format: "json",
	});
	return `${API}/measurements/7000/results/?${p}`;
}

/** Ids of probes that are connected or recently disconnected, read from the probe list (for the events call). */
export function activeProbeIds(body: string): number[] {
	const list = ProbeList.safeParse(JSON.parse(body));
	if (!list.success) return [];
	const ids: number[] = [];
	for (const item of list.data.results) {
		const p = Probe.safeParse(item);
		if (p.success && (p.data.status.id === CONNECTED || p.data.status.id === DISCONNECTED))
			ids.push(p.data.id);
	}
	return ids.sort((a, b) => a - b);
}

const PAGE = "https://atlas.ripe.net/probes/?country_code=VE";

function statePoint(iso: string): Observation["location"] {
	const s = stateByIso(iso);
	return s ? { lat: s.label.lat, lon: s.label.lon, state: s.iso, place: s.name } : undefined;
}

export const ripeAtlasProbes: Adapter<AtlasValue> = {
	id: "ripe-atlas-probes",
	layer: "internet",
	name: { es: "Sondas RIPE Atlas", en: "RIPE Atlas probes" },
	provider: "RIPE NCC",
	homepage: PAGE,
	licence: RIPE_ATLAS_LICENCE,
	keys: [],
	intervalMs: 10 * 60_000,
	freshness: { fetchMs: 30 * 60_000, dataMs: 30 * 60_000 },

	async fetch(ctx) {
		const options = {
			headers: { accept: "application/json" },
			hostGapMs: HOST_GAP_MS,
			maxBytes: 4 * 1024 * 1024,
			signal: ctx.signal,
		};
		const probes = await ctx.http.request(probesUrl(), options);
		let ids: number[] = [];
		try {
			ids = activeProbeIds(probes.body);
		} catch {
			return [probes]; // normalise reports the broken body
		}
		if (ids.length === 0) return [probes];
		return [probes, await ctx.http.request(eventsUrl(ids, ctx.now()), options)];
	},

	normalise(raws) {
		const [probesRaw, eventsRaw] = raws;
		if (!probesRaw) throw new SchemaError("RIPE Atlas: sin respuesta");
		let json: unknown;
		try {
			json = JSON.parse(probesRaw.body);
		} catch {
			throw new SchemaError("RIPE Atlas probes: respuesta no es JSON");
		}
		const list = ProbeList.safeParse(json);
		if (!list.success) throw new SchemaError(`RIPE Atlas probes: ${list.error.message}`);

		const fetchedAt = probesRaw.fetchedAt;
		const stateOf = new Map<number, string | null>();
		type Mutable = { connected: number; disconnected: number; droppedLastHour: number; unlocated: number };
		const perState = new Map<string, Mutable>();
		const national: Mutable = { connected: 0, disconnected: 0, droppedLastHour: 0, unlocated: 0 };
		for (const item of list.data.results) {
			const parsed = Probe.safeParse(item);
			if (!parsed.success) continue;
			const p = parsed.data;
			const coords = p.geometry?.coordinates;
			const iso = coords ? (locate(coords[1], coords[0]).state?.iso ?? null) : null;
			stateOf.set(p.id, iso);
			if (p.status.id !== CONNECTED && p.status.id !== DISCONNECTED) continue;
			const rows = [national];
			if (iso) {
				let row = perState.get(iso);
				if (!row) {
					row = { connected: 0, disconnected: 0, droppedLastHour: 0, unlocated: 0 };
					perState.set(iso, row);
				}
				rows.push(row);
			} else national.unlocated++;
			const recent =
				p.status.id === DISCONNECTED &&
				p.status_since !== null &&
				fetchedAt - p.status_since * 1_000 <= 3_600_000;
			for (const row of rows) {
				if (p.status.id === CONNECTED) row.connected++;
				else row.disconnected++;
				if (recent) row.droppedLastHour++;
			}
		}

		const out: Observation<AtlasValue>[] = [];
		const base = {
			source: "ripe-atlas-probes",
			sourceUrl: PAGE,
			licence: RIPE_ATLAS_LICENCE.id,
			confidence: 1,
			basis: "measurement" as const,
		};
		out.push({
			...base,
			series: "country:VE:probes",
			fetchedAt,
			observedAt: fetchedAt,
			value: { ...national },
		});
		for (const [iso, row] of [...perState].sort(([a], [b]) => a.localeCompare(b))) {
			const location = statePoint(iso);
			out.push({
				...base,
				series: `state:${iso}:probes`,
				fetchedAt,
				observedAt: fetchedAt,
				value: { ...row, unlocated: 0 },
				...(location ? { location } : {}),
			});
		}

		if (!eventsRaw) return out;
		let events: unknown;
		try {
			events = JSON.parse(eventsRaw.body);
		} catch {
			throw new SchemaError("RIPE Atlas msm 7000: respuesta no es JSON");
		}
		if (!Array.isArray(events)) throw new SchemaError("RIPE Atlas msm 7000: se esperaba una lista");
		type Hour = { disconnects: number; connects: number; probes: Set<number> };
		const hours = new Map<string, Hour>();
		const bump = (key: string, e: z.infer<typeof Event>) => {
			let h = hours.get(key);
			if (!h) {
				h = { disconnects: 0, connects: 0, probes: new Set() };
				hours.set(key, h);
			}
			if (e.event === "disconnect") {
				h.disconnects++;
				h.probes.add(e.prb_id);
			} else h.connects++;
		};
		for (const item of events) {
			const parsed = Event.safeParse(item);
			if (!parsed.success) continue;
			const e = parsed.data;
			if (e.timestamp * 1_000 > eventsRaw.fetchedAt) continue;
			const hour = Math.floor(e.timestamp / HOUR_S) * HOUR_S;
			bump(`country:VE|${hour}`, e);
			const iso = stateOf.get(e.prb_id);
			if (iso) bump(`state:${iso}|${hour}`, e);
		}
		for (const [key, h] of [...hours].sort(([a], [b]) => a.localeCompare(b))) {
			const [prefix = "", hour = "0"] = key.split("|");
			const iso = prefix.startsWith("state:") ? prefix.slice("state:".length) : null;
			const location = iso ? statePoint(iso) : undefined;
			out.push({
				...base,
				series: `${prefix}:connection-events`,
				fetchedAt: eventsRaw.fetchedAt,
				observedAt: Number(hour) * 1_000,
				value: { disconnects: h.disconnects, connects: h.connects, probesDisconnecting: h.probes.size },
				...(location ? { location } : {}),
			});
		}
		return out;
	},
};
