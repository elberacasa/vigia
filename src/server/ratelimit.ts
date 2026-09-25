import { isIP } from "node:net";
import { ipv6Hextets } from "../userfeeds/net.ts";

/**
 * The key a client is limited by. One host usually holds a whole IPv6 /64 and can rotate through it, so IPv6 is
 * keyed by its /64 prefix; IPv4 (also IPv4-mapped IPv6) by its address. Anything else (a fixed key like "all")
 * passes through unchanged (review 4 M9).
 */
export function clientKey(ip: string): string {
	const bare = ip.replace(/%.*$/, "");
	const kind = isIP(bare);
	if (kind === 4) return bare;
	if (kind !== 6) return ip;
	const h = ipv6Hextets(bare);
	if (!h) return ip;
	if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
		const [a = 0, b = 0] = [h[6], h[7]];
		return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
	}
	return `${h
		.slice(0, 4)
		.map((x) => x.toString(16))
		.join(":")}::/64`;
}

/** Token bucket per client key. Old buckets are swept, and the map is capped, so memory stays bounded. */
export class RateLimiter {
	readonly #buckets = new Map<string, { tokens: number; at: number }>();
	#lastSweep = 0;

	constructor(
		readonly capacity: number,
		readonly refillPerSecond: number,
		readonly now: () => number = Date.now,
		/** Most clients tracked at once; past it the least recently seen are forgotten. */
		readonly maxKeys = 50_000,
	) {}

	get size(): number {
		return this.#buckets.size;
	}

	take(rawKey: string, cost = 1): boolean {
		const key = clientKey(rawKey);
		const now = this.now();
		this.#sweep(now);
		const bucket = this.#buckets.get(key) ?? { tokens: this.capacity, at: now };
		const refilled = Math.min(
			this.capacity,
			bucket.tokens + ((now - bucket.at) / 1_000) * this.refillPerSecond,
		);
		const ok = refilled >= cost;
		// Delete then set keeps the map in least-recently-seen order for the cap below.
		this.#buckets.delete(key);
		this.#buckets.set(key, { tokens: ok ? refilled - cost : refilled, at: now });
		if (this.#buckets.size > this.maxKeys) {
			for (const oldest of this.#buckets.keys()) {
				this.#buckets.delete(oldest);
				if (this.#buckets.size <= this.maxKeys) break;
			}
		}
		return ok;
	}

	#sweep(now: number): void {
		if (now - this.#lastSweep < 60_000) return;
		this.#lastSweep = now;
		const full = (this.capacity / this.refillPerSecond) * 1_000;
		for (const [key, bucket] of this.#buckets) if (now - bucket.at > full) this.#buckets.delete(key);
	}
}

/**
 * Concurrent long-lived connections (the live-update stream): at most `perClient` per client key and `global` in
 * all. `open` answers a release function (idempotent) or null when either cap is full.
 */
export class ConnectionCap {
	readonly #perKey = new Map<string, number>();
	#total = 0;

	constructor(
		readonly perClient: number,
		readonly global: number,
	) {}

	get total(): number {
		return this.#total;
	}

	open(ip: string): (() => void) | null {
		const key = clientKey(ip);
		const mine = this.#perKey.get(key) ?? 0;
		if (mine >= this.perClient || this.#total >= this.global) return null;
		this.#perKey.set(key, mine + 1);
		this.#total++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#total--;
			const left = (this.#perKey.get(key) ?? 1) - 1;
			if (left <= 0) this.#perKey.delete(key);
			else this.#perKey.set(key, left);
		};
	}
}
