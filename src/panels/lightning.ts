import { goesGlm, type LightningWindow, WINDOW_MS } from "../adapters/goes-glm/index.ts";
import type { Store } from "../core/store.ts";
import { stateByIso } from "../geo/index.ts";
import type { Panel } from "../server/panels.ts";

/**
 * "¿Dónde están cayendo rayos?" Lightning flashes detected by GOES-19's GLM over Venezuela, from the 15-minute windows
 * the `goes-glm` adapter stores: the last hour (the four newest windows, when they are consecutive), the last 24
 * hours as a series, each state's count and density, the Catatumbo area, and the last hour's 0.25° grid for the map.
 * Every figure is a count of good-quality flashes GLM detected, not of all lightning; densities are computed here and
 * labelled as such.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WINDOWS_PER_HOUR = HOUR / WINDOW_MS;

export const LABEL =
	"Destellos de rayo detectados por el satélite GOES-19 (GLM, NOAA), solo los de buena calidad";
export const DENSITY_LABEL =
	"calculado por Vigía: destellos ÷ (superficie del estado en miles de km²) ÷ horas leídas";

export type SeriesPoint = { windowStart: number; venezuela: number; catatumbo: number; complete: boolean };

export type StateLightning = {
	iso: string;
	name: string;
	lastHour: number;
	last24h: number;
	/** Flashes per 1,000 km² per hour over the windows read in the last 24 h. */
	density24h: number;
};

export type LightningView = {
	now: number;
	label: string;
	densityLabel: string;
	/** The four newest windows, when they are consecutive and the newest is within the freshness budget. */
	lastHour: {
		from: number;
		to: number;
		venezuela: number;
		catatumbo: number;
		lake: number;
		/** All four windows had all their files. */
		complete: boolean;
	} | null;
	last24h: {
		venezuela: number;
		catatumbo: number;
		windowsRead: number;
		windowsExpected: number;
		incomplete: number;
	};
	/** 15-minute windows of the last 24 hours, oldest first. */
	series24h: SeriesPoint[];
	/** States with any flash in the last 24 h, busiest last hour first. */
	states: StateLightning[];
	/** [lat, lon, n] per 0.25° cell over the region in the last hour (sea and neighbours included). */
	cellsLastHour: [number, number, number][];
	newest: { windowStart: number; fetchedAt: number } | null;
	stale: boolean;
	feed: string;
	sourceUrl: string;
	attribution: string;
};

type Row = { observedAt: number; fetchedAt: number; value: LightningWindow };

/** The newest stored revision per window, oldest first. */
function perWindow(rows: readonly Row[]): Row[] {
	const by = new Map<number, Row>();
	for (const r of rows) by.set(r.observedAt, r);
	return [...by.values()].sort((a, b) => a.observedAt - b.observedAt);
}

export function lightningView(
	rows: readonly Row[],
	now: number,
): Omit<LightningView, "feed" | "sourceUrl" | "attribution"> {
	const windows = perWindow(rows).filter((r) => r.observedAt <= now && r.observedAt > now - DAY);
	const newest = windows.at(-1) ?? null;
	const budget = goesGlm.freshness.dataMs ?? HOUR;
	const stale = !newest || now - newest.observedAt > budget;
	const hour = windows.slice(-WINDOWS_PER_HOUR);
	const consecutive =
		hour.length === WINDOWS_PER_HOUR &&
		hour.every((r, i) => i === 0 || r.observedAt - (hour[i - 1]?.observedAt ?? 0) === WINDOW_MS);
	const sum = (rs: readonly Row[], pick: (v: LightningWindow) => number) =>
		rs.reduce((n, r) => n + pick(r.value), 0);

	const perState = new Map<string, { hour: number; day: number }>();
	for (const r of windows) {
		const inHour = consecutive && !stale && hour.includes(r);
		for (const [iso, n] of Object.entries(r.value.byState)) {
			const s = perState.get(iso) ?? { hour: 0, day: 0 };
			s.day += n;
			if (inHour) s.hour += n;
			perState.set(iso, s);
		}
	}
	const hoursRead = windows.length / WINDOWS_PER_HOUR;
	const states: StateLightning[] = [...perState]
		.map(([iso, s]) => {
			const info = stateByIso(iso);
			const area = info?.areaKm2 ?? 0;
			return {
				iso,
				name: info?.name ?? iso,
				lastHour: s.hour,
				last24h: s.day,
				density24h: area > 0 && hoursRead > 0 ? s.day / (area / 1_000) / hoursRead : 0,
			};
		})
		.sort((a, b) => b.lastHour - a.lastHour || b.last24h - a.last24h || a.iso.localeCompare(b.iso));

	const cells = new Map<string, [number, number, number]>();
	if (consecutive && !stale) {
		for (const r of hour) {
			for (const [lat, lon, n] of r.value.cells) {
				const k = `${lat},${lon}`;
				const c = cells.get(k) ?? [lat, lon, 0];
				c[2] += n;
				cells.set(k, c);
			}
		}
	}

	return {
		now,
		label: LABEL,
		densityLabel: DENSITY_LABEL,
		lastHour:
			consecutive && !stale
				? {
						from: hour[0]?.observedAt ?? 0,
						to: (hour.at(-1)?.observedAt ?? 0) + WINDOW_MS,
						venezuela: sum(hour, (v) => v.venezuela),
						catatumbo: sum(hour, (v) => v.catatumbo),
						lake: sum(hour, (v) => v.lake),
						complete: hour.every((r) => r.value.complete),
					}
				: null,
		last24h: {
			venezuela: sum(windows, (v) => v.venezuela),
			catatumbo: sum(windows, (v) => v.catatumbo),
			windowsRead: windows.length,
			windowsExpected: DAY / WINDOW_MS,
			incomplete: windows.filter((r) => !r.value.complete).length,
		},
		series24h: windows.map((r) => ({
			windowStart: r.observedAt,
			venezuela: r.value.venezuela,
			catatumbo: r.value.catatumbo,
			complete: r.value.complete,
		})),
		states,
		cellsLastHour: [...cells.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]),
		newest: newest ? { windowStart: newest.observedAt, fetchedAt: newest.fetchedAt } : null,
		stale,
	};
}

export function lightningPanelView(store: Store, now: number): LightningView {
	const rows = store.history<LightningWindow>(goesGlm.id, "window", now - DAY, now, 1_000);
	return {
		...lightningView(rows, now),
		feed: goesGlm.id,
		sourceUrl: goesGlm.homepage,
		attribution: goesGlm.licence.attribution,
	};
}

export const lightningPanel: Panel<LightningView> = {
	id: "lightning",
	onDemand: true,
	sources: [goesGlm.id],
	compute: (store: Store, now: number) => lightningPanelView(store, now),
};
