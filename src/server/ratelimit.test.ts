import { expect, test } from "bun:test";
import { ConnectionCap, clientKey, RateLimiter } from "./ratelimit.ts";

test("client key: IPv6 by /64, IPv4 (also IPv4-mapped) by address (review 4 M9)", () => {
	expect(clientKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
	expect(clientKey("2001:0db8:0001:0002:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
	expect(clientKey("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
	expect(clientKey("203.0.113.9")).toBe("203.0.113.9");
	expect(clientKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
	expect(clientKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
	expect(clientKey("all")).toBe("all");
});

test("rotating addresses inside one IPv6 /64 does not escape the per-client bucket", () => {
	const limiter = new RateLimiter(3, 0, () => 0);
	const allowed = Array.from({ length: 10 }, (_, i) => limiter.take(`2001:db8:5:6::${(i + 1).toString(16)}`));
	expect(allowed.filter(Boolean)).toHaveLength(3);
	// Another /64 has its own bucket.
	expect(limiter.take("2001:db8:5:7::1")).toBe(true);
});

test("the bucket map is bounded between sweeps", () => {
	const limiter = new RateLimiter(3, 0.001, () => 0, 100);
	for (let i = 0; i < 1_000; i++) limiter.take(`198.51.${i >> 8}.${i & 255}`);
	expect(limiter.size).toBeLessThanOrEqual(100);
});

test("connection cap: per client (by /64) and global, released exactly once", () => {
	const cap = new ConnectionCap(2, 3);
	const a1 = cap.open("2001:db8::1");
	const a2 = cap.open("2001:db8::2");
	expect(a1 && a2).toBeTruthy();
	expect(cap.open("2001:db8::3")).toBeNull(); // same /64: per-client cap
	const b = cap.open("203.0.113.1");
	expect(b).not.toBeNull();
	expect(cap.open("203.0.113.2")).toBeNull(); // global cap
	a1?.();
	a1?.(); // idempotent
	expect(cap.total).toBe(2);
	expect(cap.open("203.0.113.2")).not.toBeNull();
	expect(cap.open("203.0.113.3")).toBeNull();
});
