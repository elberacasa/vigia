import { signal } from "@preact/signals";

/**
 * The page's side of "Mis alertas" (first load, small): the rules run on the server (src/alerts); this listens for
 * fired alerts on the live stream, keeps an unread count, shows them in the page, and, only when the reader opted in
 * on this device, as a browser notification while Vigía is open in this browser. No push service, no account.
 */

export interface AlertItem {
	id: string;
	ruleId: string;
	ruleName: string | null;
	kind: string;
	at: number;
	observedAt: number;
	title: { es: string; en: string };
	detail: { es: string; en: string };
	source: string;
	feed: string;
	sourceUrl: string;
	panel: string;
	state: string | null;
}

const SEEN_KEY = "vigia:alerts-seen";

export function read(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}
export function write(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// Storage off: lasts for this visit.
	}
}

/** Alerts that arrived (or were fetched) since the reader last opened the alert log, newest first. */
export const unreadAlerts = signal<AlertItem[]>([]);
/** Alerts shown as a toast right now (arrived on the stream during this visit). */
export const toasts = signal<AlertItem[]>([]);
/** Number of rules on the server, or null before the first fetch. */
export const ruleCount = signal<number | null>(null);

function seenAt(): number {
	const n = Number(read(SEEN_KEY));
	return Number.isFinite(n) ? n : 0;
}

/** The reader opened the alert log: everything up to now is read. */
export function markAlertsRead(): void {
	const newest = unreadAlerts.value[0]?.at ?? 0;
	write(SEEN_KEY, String(Math.max(seenAt(), newest, Date.now())));
	unreadAlerts.value = [];
}

export function dismissToast(id: string): void {
	toasts.value = toasts.value.filter((a) => a.id !== id);
}

function isAlert(x: unknown): x is AlertItem {
	if (!x || typeof x !== "object") return false;
	const a = x as Partial<AlertItem>;
	return (
		typeof a.id === "string" &&
		typeof a.at === "number" &&
		typeof a.observedAt === "number" &&
		typeof a.title?.es === "string" &&
		typeof a.panel === "string" &&
		typeof a.sourceUrl === "string"
	);
}

function receive(a: AlertItem): void {
	if (unreadAlerts.value.some((x) => x.id === a.id)) return;
	unreadAlerts.value = [a, ...unreadAlerts.value].slice(0, 50);
	// The toasts chunk (ui/custom/Toasts.tsx) shows it, and sends the browser notification when the reader opted in.
	toasts.value = [a, ...toasts.value.filter((x) => x.id !== a.id)].slice(0, 3);
}

addEventListener("vigia:stream", (e) => {
	const detail = (e as CustomEvent<{ type?: string; alert?: unknown }>).detail;
	if (detail?.type === "alert" && isAlert(detail.alert)) receive(detail.alert);
});

/** Once, after the first paint: how many rules exist and what fired since this device last looked. */
export async function startAlerts(): Promise<void> {
	try {
		const res = await fetch(`/api/alerts?since=${seenAt()}`, { headers: { accept: "application/json" } });
		if (!res.ok) return;
		const data = (await res.json()) as { ruleCount?: number; log?: unknown[] };
		ruleCount.value = typeof data.ruleCount === "number" ? data.ruleCount : null;
		const fresh = (data.log ?? []).filter(isAlert);
		const known = new Set(unreadAlerts.value.map((a) => a.id));
		unreadAlerts.value = [...unreadAlerts.value, ...fresh.filter((a) => !known.has(a.id))]
			.sort((a, b) => b.at - a.at)
			.slice(0, 50);
	} catch {
		// Offline: the stream will bring new ones when it reconnects.
	}
}
