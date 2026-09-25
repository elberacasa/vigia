/**
 * Freshness, decided once. Every surface that says "en vivo", "al día", "sin caídas" or prints a figure as current
 * asks here, so the header, the logo, the status bar, the panel badges and bands, the Ahora line and the share cards
 * can never disagree. The server's feed state is the only clock: it already measures each feed against its own
 * budget (src/core/health.ts), so nothing here invents a second threshold.
 *
 * Pure functions over plain data (no signals), so the terminal report can use them too and tests need no DOM.
 */
import { ago, type Lang } from "./format.ts";

/** Mirrors the server's FeedState (src/core/health.ts). */
export type FeedState = "ok" | "stale" | "degraded" | "failing" | "locked" | "off" | "pending";

/** The pieces of a feed's health this needs. */
export interface HealthLite {
	id: string;
	state: FeedState;
	lastSuccessAt: number | null;
	newestObservedAt?: number | null;
	nextRunAt?: number | null;
}

/** The pieces of a feed's metadata this needs. */
export interface MetaLite {
	provider: string;
	freshness: { dataMs: number | null };
}

export type HealthMap = ReadonlyMap<string, HealthLite>;

/**
 * Data within its budget. "degraded" counts: the last attempt failed but the data on screen is still inside the
 * feed's budget (the server's rule), so calling it late would understate what is known.
 */
export function isLive(state: FeedState | undefined): boolean {
	return state === "ok" || state === "degraded";
}

/** Past its budget (stale) or unreachable past it (failing). Pending, locked and off are neither live nor late. */
export function isLate(state: FeedState | undefined): boolean {
	return state === "stale" || state === "failing";
}

/** Counts a feed toward "fuentes": everything the user has not turned off and that does not need a missing key. */
export function isEnabled(state: FeedState | undefined): boolean {
	return state !== "off" && state !== "locked";
}

export interface FeedCounts {
	/** Feeds that count: not off, not locked. The denominator of every "N de M". */
	enabled: number;
	/** ok + degraded: data within budget. */
	live: number;
	/** stale: reachable, but the data is past its budget. */
	late: number;
	/** failing: unreachable past its budget, or never reached. */
	down: number;
	/** pending: enabled but has not run yet. */
	waiting: number;
}

/** The one feed count: header (phones), logo meter and status bar all read this. */
export function feedCounts(rows: readonly Pick<HealthLite, "state">[]): FeedCounts {
	const c: FeedCounts = { enabled: 0, live: 0, late: 0, down: 0, waiting: 0 };
	for (const r of rows) {
		if (!isEnabled(r.state)) continue;
		c.enabled++;
		if (isLive(r.state)) c.live++;
		else if (r.state === "stale") c.late++;
		else if (r.state === "failing") c.down++;
		else c.waiting++;
	}
	return c;
}

/**
 * A group of feeds behind one claim: current when any of them is live (a second source keeps a claim current).
 * `lastAt` is the newest good fetch among them, for "dato de hace X". Unknown feeds (no health row yet, e.g. the
 * first paint) are neither: with no rows at all the claim is treated as current, so the page does not blank itself
 * before /api/health arrives.
 */
export function groupFreshness(
	feeds: readonly string[],
	health: HealthMap,
): { stale: boolean; lastAt: number | null } {
	const rows = feeds.map((id) => health.get(id)).filter((h) => h !== undefined && isEnabled(h.state));
	if (!rows.length) return { stale: false, lastAt: null };
	const stale = !rows.some((h) => isLive(h?.state));
	const lastAt = Math.max(0, ...rows.map((h) => h?.lastSuccessAt ?? 0)) || null;
	return { stale, lastAt };
}

export type BadgeTone = "ok" | "late" | "old" | "muted";

export interface PanelFreshness {
	/** The header badge. */
	badge: { text: string; tone: BadgeTone };
	/** The band under the header, or null when every usable feed is live. Same verdict as the badge, more words. */
	band: { text: string; tone: "warn" | "alert" } | null;
	/** Worst usable state, for the panel's own class. */
	state: FeedState;
	/** No feed has ever answered ("Esperando datos"): a panel whose body shows transcribed data may say so instead. */
	waiting?: true;
}

const RANK: Record<FeedState, number> = {
	failing: 5,
	stale: 4,
	degraded: 3,
	pending: 2,
	locked: 1,
	off: 1,
	ok: 0,
};

/** "en 2 min" / "in 2 min". */
function until(ms: number, es: boolean): string {
	const min = Math.max(1, Math.round(ms / 60_000));
	const text = min < 90 ? `${min} min` : `${Math.round(min / 60)} h`;
	return es ? `en ${text}` : `in ${text}`;
}

/**
 * The panel's badge and band from ONE verdict over its feeds (review 3, M9: they used different thresholds):
 * - every usable feed live → neutral badge with the age of the primary feed's newest datum;
 * - some late → "Parcial" badge, band "2 de 3 fuentes al día · con retraso: X" (provider names once each);
 * - all late → "Desactualizado" badge and band with the last datum's age;
 * - all unreachable → "Sin conexión" badge and an alert band.
 * Event feeds (no data budget, silence is normal) and sources that publish ahead say when they were last checked.
 */
export function panelFreshness(
	feeds: readonly string[],
	health: HealthMap,
	meta: ReadonlyMap<string, MetaLite>,
	now: number,
	lang: Lang,
): PanelFreshness {
	const es = lang === "es";
	const all = feeds.map((id) => ({ id, h: health.get(id), m: meta.get(id) }));
	const usable = all.filter((r) => isEnabled(r.h?.state ?? "pending"));
	const pool = usable.length ? usable : all;
	const state = pool.reduce<FeedState>((w, r) => {
		const s = r.h?.state ?? "pending";
		return RANK[s] > RANK[w] ? s : w;
	}, "ok");

	if (!usable.length) {
		const off = all.some((r) => r.h?.state === "off") && !all.some((r) => r.h?.state === "locked");
		return {
			badge: { text: off ? (es ? "Apagada" : "Off") : es ? "Necesita clave" : "Needs a key", tone: "muted" },
			band: null,
			state,
		};
	}

	// The age shown: the primary feed's, or the first usable feed that has ever succeeded.
	const primary = usable.find((r) => r.h?.lastSuccessAt) ?? null;
	const age = (() => {
		if (!primary?.h?.lastSuccessAt) return null;
		const newest = primary.h.newestObservedAt ?? null;
		const future = newest !== null && newest > now;
		const eventFeed = primary.m?.freshness.dataMs === null || future;
		const at = eventFeed ? primary.h.lastSuccessAt : (newest ?? primary.h.lastSuccessAt);
		return { text: ago(now - at, lang), eventFeed };
	})();

	if (!age) {
		const failing = usable.some((r) => r.h?.state === "failing");
		return {
			badge: failing
				? { text: es ? "Sin conexión" : "Unreachable", tone: "old" }
				: { text: es ? "Esperando datos" : "Waiting for data", tone: "muted" },
			band: null,
			state,
			...(failing ? {} : { waiting: true as const }),
		};
	}

	const late = usable.filter((r) => isLate(r.h?.state));
	const live = usable.filter((r) => isLive(r.h?.state));
	const names = (rows: typeof usable) => [...new Set(rows.map((r) => r.m?.provider ?? r.id))].join(", ");
	const ageText = age.eventFeed ? (es ? `revisado ${age.text}` : `checked ${age.text}`) : age.text;

	if (!late.length) return { badge: { text: ageText, tone: "ok" }, band: null, state };

	if (live.length) {
		return {
			badge: { text: es ? `Parcial · ${age.text}` : `Partial · ${age.text}`, tone: "late" },
			band: {
				text: es
					? `${live.length} de ${usable.length} fuentes al día · con retraso: ${names(late)}`
					: `${live.length} of ${usable.length} sources current · delayed: ${names(late)}`,
				tone: "warn",
			},
			state,
		};
	}

	const first = late[0]?.h;
	const lastAt = first ? (first.newestObservedAt ?? first.lastSuccessAt) : null;
	const lastAge = lastAt !== null && lastAt <= now ? ago(now - lastAt, lang) : age.text;
	const next = first?.nextRunAt ?? null;
	const retry =
		next && next > now ? ` · ${es ? "próximo intento" : "next try"} ${until(next - now, es)}` : "";
	if (late.every((r) => r.h?.state === "failing")) {
		return {
			badge: { text: es ? `Sin conexión · dato ${lastAge}` : `Unreachable · data ${lastAge}`, tone: "old" },
			band: {
				text: es
					? `Sin conexión con ${names(late)}: se muestra el último dato, de ${lastAge}${retry}`
					: `${names(late)} unreachable: showing the last data, from ${lastAge}${retry}`,
				tone: "alert",
			},
			state,
		};
	}
	return {
		badge: { text: es ? `Desactualizado · ${lastAge}` : `Out of date · ${lastAge}`, tone: "old" },
		band: {
			text: es
				? `Desactualizado: último dato ${lastAge}${retry}`
				: `Out of date: latest data ${lastAge}${retry}`,
			tone: "warn",
		},
		state,
	};
}

/** Minimal connectivity shape for the internet word. */
export interface InternetSummaryLite {
	summary: { states: { normal: number; drop: number; severe: number; noData: number }; allClear: boolean };
}

/**
 * What the layer list, the phone summary and anything else short say about internet by state. "Sin caídas" only
 * when the server says the country is clear (≥ 20 states with fresh data, none dropping) AND the IODA feed is live;
 * otherwise the drops that are known, with coverage, or plainly "sin datos".
 */
export function internetWord(
	c: InternetSummaryLite | undefined,
	iodaLive: boolean,
	lang: Lang,
): { short: string; long: string; tone: "normal" | "warn" | "alert" | "muted" } | null {
	if (!c) return null;
	const es = lang === "es";
	const s = c.summary.states;
	const affected = s.drop + s.severe;
	const withData = s.normal + affected;
	const total = withData + s.noData;
	if (!iodaLive || withData === 0) {
		return {
			short: es ? "sin datos" : "no data",
			long: es ? "Sin datos recientes de IODA por estado" : "No recent IODA data by state",
			tone: "muted",
		};
	}
	const coverage =
		withData < total
			? es
				? ` · ${withData} de ${total} con datos`
				: ` · ${withData} of ${total} with data`
			: "";
	if (affected > 0) {
		return {
			short: es
				? `${affected} ${affected === 1 ? "caída" : "caídas"}`
				: `${affected} ${affected === 1 ? "drop" : "drops"}`,
			long: es
				? `${affected} ${affected === 1 ? "estado" : "estados"} con caída de señal${coverage}`
				: `${affected} ${affected === 1 ? "state" : "states"} with a signal drop${coverage}`,
			tone: s.severe ? "alert" : "warn",
		};
	}
	if (c.summary.allClear) {
		return {
			short: es ? "sin caídas" : "no drops",
			long: es ? `Sin caídas de señal en los estados${coverage}` : `No signal drops in the states${coverage}`,
			tone: "normal",
		};
	}
	return {
		short: es ? `${withData} de ${total} con datos` : `${withData} of ${total} with data`,
		long: es
			? `Datos suficientes solo en ${withData} de ${total} estados; ninguno con caída entre ellos`
			: `Enough data in only ${withData} of ${total} states; none dropping among them`,
		tone: "muted",
	};
}
