import { expect, test } from "bun:test";
import { CircuitBreaker } from "./breaker.ts";

const opts = { threshold: 3, baseCooldownMs: 1_000, maxCooldownMs: 4_000 };

test("opens after the threshold and half-opens after the cooldown", () => {
	const b = new CircuitBreaker(opts);
	b.failure(0);
	b.failure(0);
	expect(b.state(0)).toBe("closed");
	b.failure(0);
	expect(b.state(500)).toBe("open");
	expect(b.canCall(500)).toBe(false);
	expect(b.state(1_000)).toBe("half-open");
	expect(b.nextAllowedAt(200)).toBe(1_000);
});

test("a failed probe doubles the cooldown up to the cap; success resets", () => {
	const b = new CircuitBreaker(opts);
	for (let i = 0; i < 3; i++) b.failure(0);
	b.failure(1_000);
	expect(b.cooldownMs()).toBe(2_000);
	b.failure(3_000);
	b.failure(7_000);
	b.failure(11_000);
	expect(b.cooldownMs()).toBe(4_000);
	b.success();
	expect(b.state(11_001)).toBe("closed");
	expect(b.consecutiveFailures).toBe(0);
});
