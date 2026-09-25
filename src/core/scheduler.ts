import type { BlobStore } from "./blobs.ts";
import { CircuitBreaker } from "./breaker.ts";
import type { Store } from "./store.ts";
import { type Adapter, type HttpLike, MissingKeyError, type Observation } from "./types.ts";

export interface SchedulerEvent {
	readonly type: "run";
	readonly source: string;
	readonly ok: boolean;
	readonly inserted: number;
	readonly series: readonly string[];
	readonly at: number;
}

export interface SchedulerOptions {
	readonly store: Store;
	readonly http: HttpLike;
	readonly key: (id: string) => string | undefined;
	/** Whether the user has this feed on. Defaults: on, except `optIn` feeds. */
	readonly enabled?: (adapter: Adapter) => boolean;
	/** Image store; adapters that declare a `blobs` policy get their own scope of it. */
	readonly blobs?: BlobStore;
	readonly now?: () => number;
	/** How many feeds may be fetching at once. */
	readonly concurrency?: number;
	readonly onEvent?: (event: SchedulerEvent) => void;
	readonly log?: (line: string) => void;
}

interface Slot {
	/** Swapped in place by `replace` (a run in flight keeps the adapter it started with). */
	adapter: Adapter;
	readonly breaker: CircuitBreaker;
	nextRunAt: number;
	running: boolean;
	lastError: string | null;
	lastAttemptAt: number | null;
}

export interface FeedRuntime {
	readonly nextRunAt: number;
	readonly running: boolean;
	readonly lastError: string | null;
	readonly lastAttemptAt: number | null;
	readonly consecutiveFailures: number;
	readonly breaker: "closed" | "open" | "half-open";
}

/**
 * Runs every adapter on its interval with jitter, at most `concurrency` at a time. A failing feed backs off
 * through its circuit breaker; nothing one feed does can stop another. Adapters missing a key are skipped
 * (they show as locked, not failing).
 */
export class Scheduler {
	readonly #slots = new Map<string, Slot>();
	readonly #options: SchedulerOptions;
	readonly #now: () => number;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#active = 0;
	#stopped = true;
	readonly #controller = new AbortController();

	constructor(adapters: readonly Adapter[], options: SchedulerOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
		const now = this.#now();
		for (const adapter of adapters) {
			if (this.#slots.has(adapter.id)) throw new Error(`duplicate adapter id ${adapter.id}`);
			this.#slots.set(adapter.id, {
				adapter,
				breaker: new CircuitBreaker(),
				nextRunAt: now,
				running: false,
				lastError: null,
				lastAttemptAt: null,
			});
		}
	}

	isLocked(adapter: Adapter): boolean {
		return adapter.keys.some((k) => !this.#options.key(k));
	}

	isEnabled(adapter: Adapter): boolean {
		return this.#options.enabled ? this.#options.enabled(adapter) : adapter.optIn === undefined;
	}

	runtime(id: string): FeedRuntime | null {
		const slot = this.#slots.get(id);
		if (!slot) return null;
		return {
			nextRunAt: slot.nextRunAt,
			running: slot.running,
			lastError: slot.lastError,
			lastAttemptAt: slot.lastAttemptAt,
			consecutiveFailures: slot.breaker.consecutiveFailures,
			breaker: slot.breaker.state(this.#now()),
		};
	}

	start(): void {
		this.#stopped = false;
		this.#tick();
	}

	stop(): void {
		this.#stopped = true;
		this.#controller.abort();
		if (this.#timer) clearTimeout(this.#timer);
	}

	/** Runs in flight right now, of every feed ever scheduled (also one added later or removed meanwhile). */
	get activeRuns(): number {
		return this.#active;
	}

	/**
	 * Waits until no run is in flight, or until `deadline` (epoch ms). True when everything finished, so a graceful
	 * stop records every run, the user's own feeds included, before the database closes.
	 */
	async drain(deadline: number, pollMs = 25): Promise<boolean> {
		while (this.#active > 0) {
			if (Date.now() >= deadline) return false;
			await new Promise((resolve) => setTimeout(resolve, pollMs));
		}
		return true;
	}

	/** Schedules a feed added while running (a user's own feed); due at once. Ids stay unique. */
	add(adapter: Adapter): void {
		if (this.#slots.has(adapter.id)) throw new Error(`duplicate adapter id ${adapter.id}`);
		this.#slots.set(adapter.id, {
			adapter,
			breaker: new CircuitBreaker(),
			nextRunAt: this.#now(),
			running: false,
			lastError: null,
			lastAttemptAt: null,
		});
	}

	/**
	 * Swaps a feed's adapter (its settings changed) keeping its breaker, its schedule and any run in flight, so an edit
	 * neither resets a failing feed's back-off nor starts a second run. Adds it when it was not scheduled.
	 */
	replace(adapter: Adapter): void {
		const slot = this.#slots.get(adapter.id);
		if (!slot) {
			this.add(adapter);
			return;
		}
		// In place: a run in flight still holds this slot and must clear its own `running` flag.
		slot.adapter = adapter;
	}

	/** Stops scheduling a feed (a run already in flight finishes and is recorded). */
	remove(id: string): void {
		this.#slots.delete(id);
	}

	/** Run one feed now (e.g. right after its key is added). */
	trigger(id: string): void {
		const slot = this.#slots.get(id);
		if (!slot) return;
		slot.nextRunAt = this.#now();
		this.#tick();
	}

	#tick(): void {
		if (this.#stopped) return;
		if (this.#timer) clearTimeout(this.#timer);
		const now = this.#now();
		const limit = this.#options.concurrency ?? 6;
		const due = [...this.#slots.values()]
			.filter(
				(s) => !s.running && s.nextRunAt <= now && !this.isLocked(s.adapter) && this.isEnabled(s.adapter),
			)
			.sort((a, b) => a.nextRunAt - b.nextRunAt);
		for (const slot of due) {
			if (this.#active >= limit) break;
			void this.#run(slot);
		}
		let next = Number.POSITIVE_INFINITY;
		for (const s of this.#slots.values()) if (!s.running) next = Math.min(next, s.nextRunAt);
		const delay = Number.isFinite(next) ? Math.max(250, next - now) : 60_000;
		this.#timer = setTimeout(() => this.#tick(), Math.min(delay, 60_000));
	}

	/** Runs one adapter once; exported for tests and the CLI's `vigia fetch <id>`. */
	async runOnce(id: string): Promise<{ ok: boolean; inserted: number; error: string | null }> {
		const slot = this.#slots.get(id);
		if (!slot) throw new Error(`unknown adapter ${id}`);
		return this.#run(slot);
	}

	async #run(slot: Slot): Promise<{ ok: boolean; inserted: number; error: string | null }> {
		const { adapter, breaker } = slot;
		const { store, http, key } = this.#options;
		slot.running = true;
		this.#active++;
		const startedAt = this.#now();
		slot.lastAttemptAt = startedAt;
		let observations: Observation[] = [];
		let bytes = 0;
		let error: string | null = null;
		let inserted = 0;
		try {
			const blobs =
				adapter.blobs && this.#options.blobs ? this.#options.blobs.scope(adapter.id, adapter.blobs) : null;
			const raw = await adapter.fetch({
				http,
				key,
				now: this.#now,
				signal: this.#controller.signal,
				...(blobs ? { blobs } : {}),
				seen: (series: string, observedAt: number) => store.hasObservation(adapter.id, series, observedAt),
			});
			bytes = raw.reduce((sum, r) => sum + r.body.length, 0);
			observations = adapter.normalise(raw);
			for (const o of observations) {
				if (o.source !== adapter.id) throw new Error(`adapter ${adapter.id} emitted source ${o.source}`);
			}
			inserted = store.insert(observations);
			breaker.success();
			slot.lastError = null;
		} catch (e) {
			error = e instanceof MissingKeyError ? e.message : describe(e);
			// Cut short by our own stop (Ctrl+C): says nothing about the source, so it is neither a failure on the
			// status page after a restart nor a step towards its circuit breaker. Nothing is recorded.
			if (this.#stopped && this.#controller.signal.aborted) {
				slot.running = false;
				this.#active--;
				return { ok: false, inserted: 0, error: "cancelado al cerrar Vigía" };
			}
			slot.lastError = error;
			breaker.failure(this.#now());
			this.#options.log?.(`[${adapter.id}] ${error}`);
		}
		const finishedAt = this.#now();
		try {
			store.recordRun({
				source: adapter.id,
				startedAt,
				finishedAt,
				ok: error === null,
				error,
				bytes,
				received: observations.length,
				inserted,
			});
		} catch (e) {
			// The database is full or broken: say so, keep the process and every other feed alive.
			this.#options.log?.(`[${adapter.id}] no se pudo registrar la corrida: ${describe(e)}`);
		}
		const jitter = adapter.intervalMs * (Math.random() * 0.2 - 0.1);
		slot.nextRunAt = Math.round(
			Math.max(finishedAt + adapter.intervalMs + jitter, breaker.nextAllowedAt(finishedAt)),
		);
		slot.running = false;
		this.#active--;
		const series = [...new Set(observations.map((o) => o.series))];
		try {
			this.#options.onEvent?.({
				type: "run",
				source: adapter.id,
				ok: error === null,
				inserted,
				series: inserted > 0 ? series : [],
				at: finishedAt,
			});
		} catch (e) {
			this.#options.log?.(`[${adapter.id}] evento: ${describe(e)}`);
		}
		if (!this.#stopped) queueMicrotask(() => this.#tick());
		return { ok: error === null, inserted, error };
	}
}

function describe(error: unknown): string {
	if (error instanceof Error) {
		const text = `${error.name === "Error" ? "" : `${error.name}: `}${error.message}`;
		return text.length > 400 ? `${text.slice(0, 400)}…` : text;
	}
	return String(error).slice(0, 400);
}
