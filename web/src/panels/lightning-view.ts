/*
 * The lightning view as the server sends it (src/panels/lightning.ts; the server is the source of truth) and the
 * pure helpers the panel and the map layer draw from. Every count is the server's; here only positions and scales.
 */

export type SeriesPoint = { windowStart: number; venezuela: number; catatumbo: number; complete: boolean };

export type StateLightning = {
	iso: string;
	name: string;
	lastHour: number;
	last24h: number;
	density24h: number;
};

export interface LightningView {
	now: number;
	label: string;
	densityLabel: string;
	lastHour: {
		from: number;
		to: number;
		venezuela: number;
		catatumbo: number;
		lake: number;
		complete: boolean;
	} | null;
	last24h: {
		venezuela: number;
		catatumbo: number;
		windowsRead: number;
		windowsExpected: number;
		incomplete: number;
	};
	series24h: SeriesPoint[];
	states: StateLightning[];
	cellsLastHour: [number, number, number][];
	newest: { windowStart: number; fetchedAt: number } | null;
	stale: boolean;
	feed: string;
	sourceUrl: string;
	attribution: string;
}

export const WINDOW_MS = 15 * 60_000;
const DAY = 24 * 3_600_000;

/** A 15-minute slot of the last 24 hours: read (with its counts) or not read. */
export type Slot = { start: number; point: SeriesPoint | null };

/**
 * The 96 slots of the 24 hours ending at the newest window (or at `now` when nothing was read), oldest first, each
 * with the window the server read for it, or null: an unread window is shown as a gap, never as zero.
 */
export function slots(series: readonly SeriesPoint[], now: number): Slot[] {
	const newest = series.at(-1)?.windowStart;
	const end = newest ?? Math.floor(now / WINDOW_MS) * WINDOW_MS;
	const n = DAY / WINDOW_MS;
	const first = end - (n - 1) * WINDOW_MS;
	const by = new Map(series.map((p) => [p.windowStart, p]));
	return Array.from({ length: n }, (_, i) => {
		const start = first + i * WINDOW_MS;
		return { start, point: by.get(start) ?? null };
	});
}

/** Bar height as a fraction of the tallest read window (square root: one storm does not flatten the rest). */
export function barHeight(n: number, max: number): number {
	if (n <= 0 || max <= 0) return 0;
	return Math.sqrt(n / max);
}

/** Map cells: centre and relative intensity (square root of n over the busiest cell), largest drawn last. */
export function cellIntensities(cells: readonly (readonly [number, number, number])[]): {
	lat: number;
	lon: number;
	n: number;
	w: number;
}[] {
	const max = cells.reduce((m, c) => Math.max(m, c[2]), 0);
	if (max <= 0) return [];
	return cells
		.filter((c) => c[2] > 0)
		.map(([lat, lon, n]) => ({ lat, lon, n, w: Math.sqrt(n / max) }))
		.sort((a, b) => a.n - b.n);
}

/**
 * The coverage of the last 24 h in one verdict: "complete" only when every expected window was read whole;
 * "partial" when windows are missing or some were read without all their files.
 */
export function coverage(v: LightningView["last24h"]): "complete" | "partial" | "none" {
	if (v.windowsRead === 0) return "none";
	return v.windowsRead >= v.windowsExpected && v.incomplete === 0 ? "complete" : "partial";
}
