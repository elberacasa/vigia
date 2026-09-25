import type { Store } from "../core/store.ts";
import type { Json } from "../core/types.ts";

/**
 * A panel turns stored observations into the view model one UI panel renders. All arithmetic happens here, in
 * tested code; the browser only formats. Each panel names its sources so it is recomputed when they change.
 */
export interface Panel<V extends Json = Json> {
	readonly id: string;
	readonly sources: readonly string[];
	/** `read` gives another panel's cached view (the brief reuses the others instead of recomputing them). */
	compute(store: Store, now: number, read?: PanelReader): V;
}

export type PanelReader = (id: string) => Json | undefined;

/**
 * Caches each panel until one of its sources inserts new data (or `maxAgeMs` passes). A panel that throws (a bad
 * stored row, a bug) serves its last good value marked `panelFailedAt`, and is not retried or logged again until
 * the cache would have expired anyway.
 */
export class PanelCache {
	readonly #values = new Map<string, { value: Json | undefined; at: number }>();
	readonly #lastGood = new Map<string, Json>();
	readonly #read: PanelReader = (id) => this.get(id);

	constructor(
		readonly panels: readonly Panel[],
		readonly store: Store,
		readonly now: () => number = Date.now,
		readonly maxAgeMs = 60_000,
	) {}

	invalidate(source: string): string[] {
		const hit: string[] = [];
		for (const panel of this.panels) {
			if (panel.sources.includes(source)) {
				this.#values.delete(panel.id);
				hit.push(panel.id);
			}
		}
		return hit;
	}

	get(id: string): Json | undefined {
		const panel = this.panels.find((p) => p.id === id);
		if (!panel) return undefined;
		const now = this.now();
		const cached = this.#values.get(id);
		if (cached && now - cached.at < this.maxAgeMs) return cached.value;
		try {
			const value = panel.compute(this.store, now, this.#read);
			this.#values.set(id, { value, at: now });
			this.#lastGood.set(id, value);
			return value;
		} catch (error) {
			// One panel failing must not blank the others: serve its last good value, marked, and cache the failure.
			console.error(`[panel ${id}]`, error instanceof Error ? error.message : error);
			const good = this.#lastGood.get(id);
			const value =
				good && typeof good === "object" && !Array.isArray(good) ? { ...good, panelFailedAt: now } : good;
			this.#values.set(id, { value, at: now });
			return value;
		}
	}

	/** Every panel, or only those in `only`, never those in `except` (excluded panels are not computed). */
	all(only?: ReadonlySet<string>, except?: ReadonlySet<string>): Record<string, Json> {
		const out: Record<string, Json> = {};
		for (const panel of this.panels) {
			if ((only && !only.has(panel.id)) || except?.has(panel.id)) continue;
			const value = this.get(panel.id);
			if (value !== undefined) out[panel.id] = value;
		}
		return out;
	}
}
