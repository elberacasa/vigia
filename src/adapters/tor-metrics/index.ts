import type { Adapter, Licence, Observation, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";

/**
 * Tor Metrics: estimated daily Tor users connecting from Venezuela, directly (relay users) and through bridges
 * (the censorship-resistant entry points). Demand for circumvention often jumps when a block starts, so this is
 * the "how many people are going around the blocks" signal.
 *
 * Direct users come with Tor Metrics' own expected range (`lower`, `upper`, from `events=on`): the censorship
 * detector the Tor Project publishes, which flags a day whose count falls outside the range predicted from the
 * other countries' trends. We show their range and their verdict, never our own model. Bridge users have no
 * published range; the panel applies a stated rolling rule to them.
 *
 * Quirks (verified 2026-09-24): CSV with `#` comment lines, then a header; newest day lags 2 days; `lower` and
 * `upper` can be empty on the newest days; `frac` is the percent of the network that reported (low frac, noisy
 * estimate). Dates are UTC days. One request per series every 6 h (the data is daily).
 *
 * Licence: data CC0 1.0 (metrics.torproject.org/about.html); graphs CC BY 3.0 US (we draw our own).
 */

export const TOR_LICENCE: Licence = {
	id: "cc0-tor-metrics",
	name: "CC0 1.0 (Tor Metrics)",
	url: "https://metrics.torproject.org/about.html",
	attribution: "Datos: Tor Metrics, The Tor Project",
	commercial: true,
};

const SITE = "https://metrics.torproject.org";
const DAY = 86_400_000;
/** 90 days on screen plus 28 days of lead for the bridge rule. */
export const WINDOW_DAYS = 120;

export type TorDay = {
	readonly kind: "relay" | "bridge";
	/** Estimated mean daily users. */
	readonly users: number;
	/** Tor Metrics' expected range (relay users only; null when not yet published). */
	readonly lower: number | null;
	readonly upper: number | null;
	/** Percent of relays/bridges that reported; below ~50 the estimate is noisy. */
	readonly frac: number | null;
};

function day(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

export function relayUrl(now: number): string {
	return `${SITE}/userstats-relay-country.csv?start=${day(now - WINDOW_DAYS * DAY)}&end=${day(now)}&country=ve&events=on`;
}

export function bridgeUrl(now: number): string {
	return `${SITE}/userstats-bridge-country.csv?start=${day(now - WINDOW_DAYS * DAY)}&end=${day(now)}&country=ve`;
}

/** Parses Tor Metrics CSV: skips `#` comments, maps the header row to column indexes. */
export function parseCsv(body: string, what: string): Record<string, string>[] {
	const lines = body.split(/\r?\n/).filter((l) => l.trim() !== "" && !l.startsWith("#"));
	const header = lines.shift()?.split(",");
	if (!header?.includes("date") || !header.includes("users") || !header.includes("country"))
		throw new SchemaError(`Tor Metrics ${what}: sin cabecera date,country,users`);
	return lines.map((line) => {
		const cells = line.split(",");
		const row: Record<string, string> = {};
		header.forEach((name, i) => {
			row[name] = cells[i] ?? "";
		});
		return row;
	});
}

const numOrNull = (s: string | undefined): number | null => {
	if (s === undefined || s.trim() === "") return null;
	const n = Number(s);
	return Number.isFinite(n) && n >= 0 ? n : null;
};

function normaliseOne(raw: RawResponse | undefined, kind: TorDay["kind"]): Observation<TorDay>[] {
	if (!raw) throw new SchemaError(`Tor Metrics: falta la serie ${kind}`);
	if (!raw.contentType.includes("csv") && raw.body.trimStart().startsWith("<"))
		throw new SchemaError(`Tor Metrics ${kind}: respuesta HTML, no CSV`);
	const out: Observation<TorDay>[] = [];
	const page = `${SITE}/userstats-${kind}-country.html?graph=userstats-${kind}-country&country=ve`;
	for (const row of parseCsv(raw.body, kind)) {
		if (row.country !== "ve" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date ?? "")) continue;
		const t = Date.parse(`${row.date}T00:00:00Z`);
		const users = numOrNull(row.users);
		if (!Number.isFinite(t) || users === null || t > raw.fetchedAt) continue;
		const lower = kind === "relay" ? numOrNull(row.lower) : null;
		const upper = kind === "relay" ? numOrNull(row.upper) : null;
		out.push({
			source: "tor-metrics",
			series: `country:VE:tor-${kind}`,
			sourceUrl: page,
			fetchedAt: raw.fetchedAt,
			observedAt: t,
			licence: TOR_LICENCE.id,
			value: {
				kind,
				users,
				// A range is only meaningful whole and ordered.
				lower: lower !== null && upper !== null && lower <= upper ? lower : null,
				upper: lower !== null && upper !== null && lower <= upper ? upper : null,
				frac: numOrNull(row.frac),
			},
			// An estimate from relay/bridge reports, not a count of people.
			confidence: 0.8,
			basis: "measurement",
		});
	}
	return out;
}

export const torMetrics: Adapter<TorDay> = {
	id: "tor-metrics",
	layer: "internet",
	name: { es: "Usuarios de Tor en Venezuela (Tor Metrics)", en: "Tor users in Venezuela (Tor Metrics)" },
	provider: "The Tor Project (Tor Metrics)",
	homepage: `${SITE}/userstats-relay-country.html?graph=userstats-relay-country&country=ve&events=on`,
	licence: TOR_LICENCE,
	keys: [],
	intervalMs: 6 * 3_600_000,
	// Daily data published with a ~2-day lag: stale when no fetch for a day or the newest day is 5 days old.
	freshness: { fetchMs: 24 * 3_600_000, dataMs: 5 * DAY },

	async fetch(ctx) {
		const now = ctx.now();
		const options = {
			headers: { accept: "text/csv" },
			hostGapMs: 5_000,
			timeoutMs: 60_000,
			maxBytes: 2 * 1024 * 1024,
			signal: ctx.signal,
		};
		const relay = await ctx.http.request(relayUrl(now), options);
		const bridge = await ctx.http.request(bridgeUrl(now), options);
		return [relay, bridge];
	},

	normalise(raws) {
		const [relay, bridge] = raws;
		const out = [...normaliseOne(relay, "relay"), ...normaliseOne(bridge, "bridge")];
		if (out.length === 0) throw new SchemaError("Tor Metrics: ninguna fila para Venezuela");
		return out;
	},
};
