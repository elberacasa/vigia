import {
	CLOUDFLARE_RADAR_LICENCE,
	type CloudflareRadar,
	cloudflareRadar,
	RADAR_HOME,
	type RadarAnomaly,
	type RadarOutage,
	type RadarTraffic,
	WINDOWS,
} from "../adapters/cloudflare-radar/index.ts";
import type { Store } from "../core/store.ts";
import { stateByIso } from "../geo/index.ts";
import type { RadarInput } from "../intel/signals.ts";
import { tagPlaces } from "../news/places.ts";
import type { Panel } from "../server/panels.ts";

/**
 * "¿Qué ve Cloudflare en Venezuela?" The Cloudflare Radar feed (locked until the user adds Cloudflare's free token):
 * the country's hourly traffic curve with the newest hour against the median of the same hour on the six days
 * before (calculado por Vigía), Cloudflare's outage notes of the last 30 days and its traffic anomalies of the last
 * 7 days (verified and not, labelled). Also turns the notes and verified anomalies into join-only incident evidence.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const CAUSES_ES: Readonly<Record<string, string>> = {
	POWER_OUTAGE: "corte eléctrico",
	CABLE_CUT: "cable cortado",
	GOVERNMENT_DIRECTED: "ordenado por el gobierno",
	TECHNICAL_PROBLEM: "problema técnico",
	WEATHER: "clima",
	MILITARY_ACTION: "acción militar",
	MAINTENANCE: "mantenimiento",
	EARTHQUAKE: "sismo",
	FIRE: "incendio",
	UNKNOWN: "causa desconocida",
};

export const TRAFFIC_METHOD =
	"calculado por Vigía: el tráfico de la hora más reciente dividido entre la mediana de la misma hora (UTC) en los 6 días anteriores, sobre la curva de Cloudflare normalizada 0–1 en 7 días";

export type RadarView = {
	now: number;
	feed: string;
	attribution: string;
	licence: string;
	sourceUrl: string;
	label: string;
	/** The newest traffic curve, or null (no token, or nothing stored yet). */
	traffic: {
		points: [number, number][];
		observedAt: number;
		fetchedAt: number;
		stale: boolean;
		/** Newest hour ÷ median of the same hour on the 6 days before, % (null with fewer than 3 such days). */
		pctOfUsual: number | null;
		usualDays: number;
		method: string;
		normalization: string;
	} | null;
	/** Outage notes of the last 30 days, newest first. */
	outages: (RadarOutage & { causeEs: string | null; states: string[] | "all" | null; ongoing: boolean })[];
	/** Anomalies of the last 7 days, newest first. */
	anomalies: (RadarAnomaly & { ongoing: boolean })[];
};

/** Median of the same UTC hour on the six days before the newest point, and the newest point as % of it. */
export function trafficVsUsual(points: readonly [number, number][]): { pct: number | null; days: number } {
	const newest = points.at(-1);
	if (!newest) return { pct: null, days: 0 };
	const byTime = new Map(points.map(([t, v]) => [t, v]));
	const same: number[] = [];
	for (let d = 1; d <= 6; d++) {
		const v = byTime.get(newest[0] - d * DAY);
		if (v !== undefined) same.push(v);
	}
	if (same.length < 3) return { pct: null, days: same.length };
	same.sort((a, b) => a - b);
	const mid = same.length / 2;
	const median =
		same.length % 2 ? (same[Math.floor(mid)] ?? 0) : ((same[mid - 1] ?? 0) + (same[mid] ?? 0)) / 2;
	if (median <= 0) return { pct: null, days: same.length };
	return { pct: Math.round((newest[1] / median) * 1000) / 10, days: same.length };
}

/**
 * The states an outage note concerns: those named in its scope or description (keyword gazetteer at the news panel's
 * threshold), or "all" when Cloudflare calls it nationwide. A note about one network that names no state concerns no
 * state here: an ISP may be regional, and fanning it out would add Cloudflare to every state's incident.
 */
export function outageStates(
	o: Pick<RadarOutage, "scope" | "description" | "outageType">,
): string[] | "all" | null {
	const text = [o.scope, o.description].filter((t): t is string => !!t).join(". ");
	const named = new Set(
		tagPlaces(text, { venezuelanOutlet: true })
			.mentions.filter((m) => m.confidence >= 0.7 && stateByIso(m.state))
			.map((m) => m.state),
	);
	if (named.size > 0) return [...named].sort();
	if (o.outageType === "NATIONWIDE") return "all";
	return null;
}

type Row = { series: string; observedAt: number; fetchedAt: number; value: CloudflareRadar };

/**
 * Join-only incident inputs (pure): every outage note that can be placed, and every verified anomaly of the whole
 * country (type LOCATION). Unverified anomalies and anomalies of a single network (type AS) are never evidence.
 */
export function radarInputs(rows: readonly Row[], now: number): RadarInput[] {
	const out: RadarInput[] = [];
	for (const r of rows) {
		const v = r.value;
		if (v.kind === "outage") {
			const states = outageStates(v);
			if (!states) continue;
			const at = Date.parse(v.startDate);
			const cause = v.cause ? (CAUSES_ES[v.cause] ?? v.cause.toLowerCase()) : null;
			const where =
				states === "all" ? "todo el país" : states.map((s) => stateByIso(s)?.name ?? s).join(", ");
			out.push({
				series: r.series,
				observedAt: r.observedAt,
				kind: "outage",
				states,
				speaks: v.cause === "POWER_OUTAGE" ? "power" : "internet",
				at,
				lastAt: v.endDate ? Date.parse(v.endDate) : Math.min(now, r.fetchedAt),
				fetchedAt: r.fetchedAt,
				es: `Cloudflare Radar: corte de internet en ${where}${cause ? ` (${cause}, según Cloudflare)` : ""}${v.endDate ? "" : ", sin fin anunciado"}`,
				en: `Cloudflare Radar: internet outage in ${states === "all" ? "the whole country" : where}${v.cause ? ` (${v.cause.toLowerCase().replaceAll("_", " ")}, per Cloudflare)` : ""}${v.endDate ? "" : ", no end announced"}`,
				url: v.linkedUrl ?? RADAR_HOME,
			});
		} else if (v.kind === "anomaly" && v.status === "VERIFIED" && v.type === "LOCATION") {
			out.push({
				series: r.series,
				observedAt: r.observedAt,
				kind: "anomaly",
				states: "all",
				speaks: "connectivity",
				at: Date.parse(v.startDate),
				lastAt: v.endDate ? Date.parse(v.endDate) : Math.min(now, r.fetchedAt),
				fetchedAt: r.fetchedAt,
				es: "Cloudflare Radar: anomalía de tráfico verificada en todo el país",
				en: "Cloudflare Radar: verified traffic anomaly across the country",
				url: RADAR_HOME,
			});
		}
	}
	return out;
}

export function radarView(store: Store, now: number): RadarView {
	const rows = store.latestPerSeries<CloudflareRadar>(cloudflareRadar.id, now - WINDOWS.outagesMs, 1_000);
	const traffic = store.latest<CloudflareRadar>(cloudflareRadar.id, "traffic:VE");
	const t = traffic && traffic.value.kind === "traffic" ? (traffic.value as RadarTraffic) : null;
	const vs = t ? trafficVsUsual(t.points) : null;
	const budget = cloudflareRadar.freshness.dataMs ?? 3 * HOUR;
	const outages = rows
		.filter((r) => r.value.kind === "outage")
		.map((r) => {
			const o = r.value as RadarOutage;
			return {
				...o,
				causeEs: o.cause ? (CAUSES_ES[o.cause] ?? null) : null,
				states: outageStates(o),
				ongoing: o.endDate === null,
			};
		})
		.sort((a, b) => b.startDate.localeCompare(a.startDate));
	const anomalies = rows
		.filter((r) => r.value.kind === "anomaly" && r.observedAt >= now - WINDOWS.anomaliesMs)
		.map((r) => ({ ...(r.value as RadarAnomaly), ongoing: (r.value as RadarAnomaly).endDate === null }))
		.sort((a, b) => b.startDate.localeCompare(a.startDate));
	return {
		now,
		feed: cloudflareRadar.id,
		attribution: CLOUDFLARE_RADAR_LICENCE.attribution,
		licence: CLOUDFLARE_RADAR_LICENCE.name,
		sourceUrl: RADAR_HOME,
		label: "Tráfico de internet de Venezuela visto por Cloudflare (índice 0–1 en 7 días, no un volumen)",
		traffic:
			t && traffic
				? {
						points: t.points,
						observedAt: traffic.observedAt,
						fetchedAt: traffic.fetchedAt,
						stale: now - traffic.observedAt > budget,
						pctOfUsual: vs?.pct ?? null,
						usualDays: vs?.days ?? 0,
						method: TRAFFIC_METHOD,
						normalization: t.normalization,
					}
				: null,
		outages,
		anomalies,
	};
}

export const radarPanel: Panel<RadarView> = {
	id: "radar",
	onDemand: true,
	sources: [cloudflareRadar.id],
	compute: (store, now) => radarView(store, now),
};

/** The stored rows the incident correlator reads (last 30 days). */
export function radarRows(store: Store, now: number): Row[] {
	return store
		.latestPerSeries<CloudflareRadar>(cloudflareRadar.id, now - WINDOWS.outagesMs, 1_000)
		.filter((r) => r.value.kind !== "traffic");
}
