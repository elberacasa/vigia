/**
 * Proof-of-work challenges, server side. A challenge is stateless until it is used: `c1.<issued>.<bits>.<random>.<mac>`,
 * signed with an HMAC key that lives only in memory and changes with the abuse-control salt (the previous key stays
 * valid for one challenge lifetime, so a rotation never fails a phone mid-solve). A used challenge is remembered
 * (in memory, until it expires) so it cannot be spent twice. The answer is checked with the native SHA-256.
 *
 * Nothing in a challenge says who asked for it: it is not bound to the address (a phone switching from Wi-Fi to
 * mobile data mid-solve would fail), only to its time and difficulty.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { leadingZeroBitsBytes, MAX_NONCE_LENGTH } from "./pow-solve.ts";
import { CROWD_RULES } from "./rules.ts";

export type Challenge = { challenge: string; difficulty: number; expiresAt: number };

export type ChallengeCheck =
	| { ok: true }
	| { ok: false; reason: "format" | "signature" | "expired" | "used" | "work" };

const FORMAT = /^c1\.([0-9a-z]{1,11})\.(\d{1,2})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/;
const NONCE = new RegExp(`^[0-9a-z]{1,${MAX_NONCE_LENGTH}}$`);

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

export class Challenges {
	#key: Buffer = randomBytes(32);
	#previous: { key: Buffer; until: number } | null = null;
	/** Challenges already spent, until they would have expired anyway. */
	readonly #spent = new Map<string, number>();
	/**
	 * Challenges issued at or before this time are refused: when the spent list is full, its earliest-issued entries
	 * are forgotten and the watermark moves past them, so a forgotten challenge can never be spent again.
	 */
	#watermark = Number.NEGATIVE_INFINITY;
	#lastSweep = 0;

	constructor(
		readonly now: () => number = Date.now,
		readonly ttlMs: number = CROWD_RULES.pow.ttlMs,
		readonly maxSpent: number = CROWD_RULES.maxTracked,
	) {}

	/** A new signing key; challenges signed with the old one stay valid for one lifetime. */
	rotate(): void {
		this.#previous = { key: this.#key, until: this.now() + this.ttlMs };
		this.#key = randomBytes(32);
	}

	#mac(key: Buffer, body: string): string {
		return b64url(createHmac("sha256", key).update(body).digest().subarray(0, 16));
	}

	issue(difficulty: number): Challenge {
		const issued = this.now();
		const body = `c1.${issued.toString(36)}.${difficulty}.${b64url(randomBytes(16))}`;
		return { challenge: `${body}.${this.#mac(this.#key, body)}`, difficulty, expiresAt: issued + this.ttlMs };
	}

	/** Checks a challenge and its nonce; on success the challenge is spent. */
	redeem(challenge: unknown, nonce: unknown): ChallengeCheck {
		const now = this.now();
		this.#sweep(now);
		if (typeof challenge !== "string" || typeof nonce !== "string" || !NONCE.test(nonce))
			return { ok: false, reason: "format" };
		const m = FORMAT.exec(challenge);
		if (!m) return { ok: false, reason: "format" };
		const body = challenge.slice(0, challenge.lastIndexOf("."));
		const mac = Buffer.from(m[4] as string, "base64url");
		const keys = [this.#key, ...(this.#previous && now <= this.#previous.until ? [this.#previous.key] : [])];
		const signed = keys.some((k) => {
			const want = Buffer.from(this.#mac(k, body), "base64url");
			return want.length === mac.length && timingSafeEqual(want, mac);
		});
		if (!signed) return { ok: false, reason: "signature" };
		const issued = Number.parseInt(m[1] as string, 36);
		// A challenge from the future is not one this server issued in this clock's lifetime.
		if (!Number.isFinite(issued) || issued > now || now - issued > this.ttlMs || issued <= this.#watermark)
			return { ok: false, reason: "expired" };
		if (this.#spent.has(challenge)) return { ok: false, reason: "used" };
		const difficulty = Number(m[2]);
		const digest = createHash("sha256").update(`${challenge}:${nonce}`).digest();
		if (leadingZeroBitsBytes(digest) < difficulty) return { ok: false, reason: "work" };
		this.#spent.set(challenge, issued + this.ttlMs);
		if (this.#spent.size > this.maxSpent) {
			// Full: forget the earliest issued, and refuse everything issued up to them from now on. An honest page
			// caught by this fetches a new challenge (403 pow); nobody is blocked for long.
			const byIssue = [...this.#spent.entries()].sort((a, b) => a[1] - b[1]);
			for (const [k, until] of byIssue.slice(0, Math.max(1, Math.floor(this.maxSpent / 10)))) {
				this.#spent.delete(k);
				this.#watermark = Math.max(this.#watermark, until - this.ttlMs);
			}
		}
		return { ok: true };
	}

	get spentCount(): number {
		return this.#spent.size;
	}

	#sweep(now: number): void {
		if (now - this.#lastSweep < 30_000) return;
		this.#lastSweep = now;
		for (const [k, until] of this.#spent) if (until < now) this.#spent.delete(k);
		if (this.#previous && now > this.#previous.until) this.#previous = null;
	}
}
