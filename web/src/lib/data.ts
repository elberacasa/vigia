import { computed, signal } from "@preact/signals";
import { HEALTH_URL, HEAVY_PANELS_URL, LIGHT_PANELS_URL, META_URL } from "./first-requests.ts";

import type { FeedState } from "./fresh.ts";

/** Mirrors the server's FeedHealth / feed meta. Kept structural: the server is the source of truth. */
export type { FeedState };

export interface FeedMeta {
	id: string;
	layer: string;
	name: { es: string; en: string };
	provider: string;
	homepage: string;
	licence: { id: string; name: string; url: string; attribution: string; commercial: boolean | "unclear" };
	keys: string[];
	intervalMs: number;
	freshness: { fetchMs: number; dataMs: number | null };
	optIn: { es: string; en: string } | null;
	/** On by default, with a note on how Vigía reads it; absent in an older cached meta. */
	note?: { es: string; en: string } | null;
	// Sources atlas (src/sources/atlas.ts); optional so an older cached meta still renders.
	category?: string[];
	kind?: string;
	region?: string;
	country?: string;
	lang?: string | null;
	publisher?: string;
	added?: string | null;
	addedBy?: "run";
	stance?: string;
	panels?: string[];
}

export interface FeedHealth {
	id: string;
	state: FeedState;
	lastSuccessAt: number | null;
	lastAttemptAt: number | null;
	newestObservedAt: number | null;
	fetchAgeMs: number | null;
	dataAgeMs: number | null;
	lastError: string | null;
	consecutiveFailures: number;
	nextRunAt: number | null;
	successRate: number | null;
	medianLatencyMs: number | null;
}

/** /api/meta as sent: each licence once, keyed; a feed carries its licence's key (review 4 M7). */
export interface PackedMeta {
	version: string;
	feeds: (Omit<FeedMeta, "licence"> & { licence: string | null })[];
	licences: Record<string, FeedMeta["licence"]>;
}

const NO_LICENCE: FeedMeta["licence"] = { id: "", name: "", url: "", attribution: "", commercial: "unclear" };

/** The feeds with their licence objects back in place. */
export function unpackMeta(m: PackedMeta): FeedMeta[] {
	return m.feeds.map((f) => ({ ...f, licence: (f.licence !== null && m.licences[f.licence]) || NO_LICENCE }));
}

/** Server clock minus ours, so ages are right even if the phone's clock is wrong. */
export const skew = signal(0);
export const now = signal(Date.now());
export const meta = signal<FeedMeta[]>([]);
export const health = signal<FeedHealth[]>([]);
export const panels = signal<Record<string, unknown>>({});
export const connection = signal<"connecting" | "live" | "offline">("connecting");
export const version = signal("");

export const healthById = computed(() => new Map(health.value.map((h) => [h.id, h])));
export const metaById = computed(() => new Map(meta.value.map((m) => [m.id, m])));

const CACHE_KEY = "vigia:last-known:v1";

function serverNow(): number {
	return Date.now() + skew.value;
}

setInterval(() => {
	now.value = serverNow();
}, 1_000);

async function getJson<T>(path: string): Promise<T> {
	const res = await fetch(path, { headers: { accept: "application/json" } });
	if (!res.ok) throw new Error(`${path}: ${res.status}`);
	return (await res.json()) as T;
}

function remember(): void {
	try {
		localStorage.setItem(
			CACHE_KEY,
			JSON.stringify({ savedAt: serverNow(), panels: panels.value, health: health.value, meta: meta.value }),
		);
	} catch {
		// Storage full or disabled: the app still works online.
	}
}

/** Last-known values from a previous visit, shown with their real age while the server is unreachable. */
function restore(): void {
	try {
		const raw = localStorage.getItem(CACHE_KEY);
		if (!raw) return;
		const saved = JSON.parse(raw) as {
			panels: Record<string, unknown>;
			health: FeedHealth[];
			meta: FeedMeta[];
		};
		panels.value = saved.panels;
		health.value = saved.health;
		meta.value = saved.meta;
	} catch {
		// Corrupt cache: ignore.
	}
}

export async function refreshPanels(ids?: readonly string[]): Promise<void> {
	if (!ids) {
		const light = await getJson<{ now: number; panels: Record<string, unknown> }>(LIGHT_PANELS_URL);
		skew.value = light.now - Date.now();
		panels.value = { ...panels.value, ...light.panels };
		// Kept now, not only after the heavy lists: a visit cut short still leaves the first screen for next time.
		remember();
		const heavy = await getJson<{ panels: Record<string, unknown> }>(HEAVY_PANELS_URL);
		panels.value = { ...panels.value, ...heavy.panels };
	} else {
		const next = { ...panels.value };
		await Promise.all(
			ids.map(async (id) => {
				const res = await getJson<{ panel: unknown }>(`/api/panels/${encodeURIComponent(id)}`);
				next[id] = res.panel;
			}),
		);
		panels.value = next;
	}
	remember();
}

export async function refreshHealth(): Promise<void> {
	const res = await getJson<{ now: number; feeds: FeedHealth[] }>(HEALTH_URL);
	skew.value = res.now - Date.now();
	health.value = res.feeds;
}

/**
 * Panel refreshes are coalesced: 75 news feeds finishing within a minute cause one refetch of the news panel,
 * not 75 (measured: ~2.2 MB in two minutes before this).
 */
const pendingPanels = new Set<string>();
let panelTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePanels(): void {
	if (panelTimer) return;
	panelTimer = setTimeout(() => {
		panelTimer = null;
		const ids = [...pendingPanels];
		pendingPanels.clear();
		if (ids.length) void refreshPanels(ids).catch(() => {});
	}, 5_000);
}

let healthTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleHealth(): void {
	if (healthTimer) return;
	healthTimer = setTimeout(() => {
		healthTimer = null;
		void refreshHealth().catch(() => {});
	}, 400);
}

export async function start(): Promise<void> {
	restore();
	try {
		// In parallel: on a 400 ms round trip, every sequential request costs a visible half second.
		await Promise.all([
			getJson<PackedMeta>(META_URL).then((m) => {
				meta.value = unpackMeta(m);
				version.value = m.version;
			}),
			refreshPanels(),
			refreshHealth(),
		]);
	} catch {
		connection.value = "offline";
	}
	connect();
	// Health also changes without new data (ages, staleness): refresh every 30 s.
	setInterval(() => void refreshHealth().catch(() => {}), 30_000);
}

function connect(): void {
	const source = new EventSource("/api/stream");
	source.onopen = () => {
		const wasOffline = connection.value === "offline";
		connection.value = "live";
		if (wasOffline) void Promise.all([refreshPanels(), refreshHealth()]).catch(() => {});
	};
	// The browser retries by itself; until it reconnects, say plainly that what is on screen is not live.
	source.onerror = () => {
		connection.value = "offline";
	};
	source.onmessage = (event) => {
		const data = JSON.parse(event.data as string) as { type: string; panels: string[] };
		// Other events (a fired alert) go to whoever listens (lib/alerts.ts), without coupling this module to them.
		if (data.type !== "run") {
			dispatchEvent(new CustomEvent("vigia:stream", { detail: data }));
			return;
		}
		scheduleHealth();
		for (const id of data.panels) pendingPanels.add(id);
		schedulePanels();
	};
}
