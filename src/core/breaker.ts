/**
 * A circuit breaker per feed. After `threshold` consecutive failures the circuit opens and the feed is not
 * called until the cooldown passes; the cooldown doubles on each failed probe up to `maxCooldownMs`.
 * One success closes it. Pure state machine: time is passed in, so it is trivially testable.
 */
export type BreakerState = "closed" | "open" | "half-open";

export interface BreakerOptions {
	readonly threshold: number;
	readonly baseCooldownMs: number;
	readonly maxCooldownMs: number;
}

export const DEFAULT_BREAKER: BreakerOptions = {
	threshold: 3,
	baseCooldownMs: 2 * 60_000,
	maxCooldownMs: 60 * 60_000,
};

export class CircuitBreaker {
	#failures = 0;
	#openedAt: number | null = null;
	#trips = 0;

	constructor(readonly options: BreakerOptions = DEFAULT_BREAKER) {}

	get consecutiveFailures(): number {
		return this.#failures;
	}

	cooldownMs(): number {
		const { baseCooldownMs, maxCooldownMs } = this.options;
		return Math.min(maxCooldownMs, baseCooldownMs * 2 ** Math.max(0, this.#trips - 1));
	}

	state(now: number): BreakerState {
		if (this.#openedAt === null) return "closed";
		return now - this.#openedAt >= this.cooldownMs() ? "half-open" : "open";
	}

	/** When the next call is allowed (now if closed or half-open). */
	nextAllowedAt(now: number): number {
		if (this.#openedAt === null) return now;
		return Math.max(now, this.#openedAt + this.cooldownMs());
	}

	canCall(now: number): boolean {
		return this.state(now) !== "open";
	}

	success(): void {
		this.#failures = 0;
		this.#openedAt = null;
		this.#trips = 0;
	}

	failure(now: number): void {
		this.#failures++;
		const wasProbing = this.#openedAt !== null;
		if (wasProbing || this.#failures >= this.options.threshold) {
			this.#trips++;
			this.#openedAt = now;
		}
	}
}
