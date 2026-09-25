import { signal } from "@preact/signals";
import { clock, stamp } from "../lib/format.ts";

/** Mirrors src/server/history.ts. The server replays the rules; the client only shows the answer. */
export type HistoryStep = "1h" | "6h" | "1d";
export type LevelCode = "n" | "d" | "s" | "x";
export interface StepCounts {
	normal: number;
	drop: number;
	severe: number;
	noData: number;
}
export interface ConnectivityHistory {
	layer: "connectivity";
	from: number;
	to: number;
	stepMs: number;
	step: HistoryStep;
	times: number[];
	states: Record<string, string>;
	counts: StepCounts[];
	firstJudgedAt: number | null;
	computedAt: number;
	rule: { es: string; en: string };
	feed: string;
	attribution: string;
	licence: string;
	sourceUrl: string;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The three ranges the slider offers: 48 bars of an hour, 28 of six hours, 30 of a day. */
export const RANGES: Record<HistoryStep, { spanMs: number; es: string; en: string }> = {
	"1h": { spanMs: 48 * HOUR, es: "48 h", en: "48 h" },
	"6h": { spanMs: 7 * DAY, es: "7 d", en: "7 d" },
	"1d": { spanMs: 30 * DAY, es: "30 d", en: "30 d" },
};

export const historyStep = signal<HistoryStep>("1h");
export const history = signal<ConnectivityHistory | null>(null);
/** "busy": the server is still computing the replay (503 twice); the slider says so and the user can retry. */
export const historyState = signal<"idle" | "loading" | "ok" | "error" | "busy">("idle");

/** Wait before the one retry after a 503: the server's Retry-After (seconds), clamped to 1–30 s; 5 s without it. */
export function retryDelayMs(header: string | null): number {
	const s = header !== null && /^\d+$/.test(header.trim()) ? Number(header) : 5;
	return Math.min(30, Math.max(1, s)) * 1_000;
}

/** Replaceable in tests. Resolves after `ms`, or at once when the load is aborted. */
export const historyRetry = {
	sleep: (ms: number, signal: AbortSignal) =>
		new Promise<void>((resolve) => {
			const id = setTimeout(resolve, ms);
			signal.addEventListener("abort", () => {
				clearTimeout(id);
				resolve();
			});
		}),
};

let inflight: AbortController | null = null;
let loadedKey = "";

/** Loads (or refreshes) the replay for a step; `now` rounds the cache key so refreshes happen at most every 5 min. */
export async function loadHistory(step: HistoryStep, now: number, force = false): Promise<void> {
	const key = `${step}|${Math.floor(now / (5 * 60_000))}`;
	if (!force && key === loadedKey && history.value?.step === step) return;
	inflight?.abort();
	const ctrl = new AbortController();
	inflight = ctrl;
	historyState.value = "loading";
	try {
		const from = now - RANGES[step].spanMs;
		const get = () =>
			fetch(`/api/history/connectivity?step=${step}&from=${Math.floor(from)}`, {
				headers: { accept: "application/json" },
				signal: ctrl.signal,
			});
		let res = await get();
		// 503: the server is computing the replay (it keeps what it finished). One retry after its Retry-After.
		if (res.status === 503) {
			await historyRetry.sleep(retryDelayMs(res.headers.get("retry-after")), ctrl.signal);
			if (ctrl.signal.aborted) return;
			res = await get();
			if (res.status === 503) {
				if (!ctrl.signal.aborted) historyState.value = "busy";
				return;
			}
		}
		if (!res.ok) throw new Error(String(res.status));
		const body = (await res.json()) as ConnectivityHistory;
		if (ctrl.signal.aborted) return;
		history.value = body;
		loadedKey = key;
		historyState.value = "ok";
	} catch (error) {
		if (ctrl.signal.aborted) return;
		historyState.value = "error";
		console.warn("[history]", error instanceof Error ? error.message : error);
	}
}

/** The step that covers `t` for a range, so a ?t= link from last week opens on the 7-day range. */
export function stepFor(t: number, now: number): HistoryStep {
	const age = now - t;
	return age <= RANGES["1h"].spanMs ? "1h" : age <= RANGES["6h"].spanMs ? "6h" : "1d";
}

/** Index of the step containing `t`, or -1. */
export function indexAt(h: ConnectivityHistory, t: number): number {
	for (let i = h.times.length - 1; i >= 0; i--) {
		const start = h.times[i] as number;
		if (t >= start && t < start + h.stepMs) return i;
	}
	return -1;
}

/** "23 sept, 18:00–19:00" / "23 sept, 12:00–18:00" / "23 sept": the step being viewed, in Caracas time. */
export function stepLabel(start: number, stepMs: number, l: "es" | "en"): string {
	if (stepMs >= 24 * HOUR) return stamp(start, l).split(",")[0] ?? "";
	return `${stamp(start, l)}–${clock(start + stepMs, l)}`;
}

/** "2026-09-24T14:00-04:00": Caracas wall time (fixed UTC−4, no DST), readable in a forwarded link. */
export function isoCaracas(t: number): string {
	const d = new Date(t - 4 * HOUR);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}-04:00`;
}

/**
 * A `?t=` value as UTC ms, read as Caracas wall time when it carries no zone: "2026-09-24" is Caracas midnight
 * (04:00 UTC), not UTC midnight (20:00 the day before in Caracas); "2026-09-24T18:00" is 18:00 in Caracas.
 */
export function parseViewTime(raw: string | null): number | null {
	if (!raw) return null;
	const s = raw.trim();
	const zoned = /^\d{4}-\d{2}-\d{2}$/.test(s)
		? `${s}T00:00-04:00`
		: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)
			? `${s}-04:00`
			: s;
	const t = Date.parse(zoned);
	return Number.isFinite(t) ? t : null;
}
