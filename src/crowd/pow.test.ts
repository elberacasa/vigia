import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Challenges } from "./challenge.ts";
import { leadingZeroBits, leadingZeroBitsBytes, sha256Hex, solve } from "./pow-solve.ts";

const native = (text: string) => createHash("sha256").update(text).digest("hex");

describe("the client's SHA-256 (pure TypeScript)", () => {
	test("equals the native hash for every length across the block boundaries", () => {
		for (let n = 0; n <= 200; n++) {
			const text = "c1.abc:".repeat(40).slice(0, n);
			expect(sha256Hex(text)).toBe(native(text));
		}
		expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});

	test("refuses non-ASCII input rather than hashing something else", () => {
		expect(() => sha256Hex("señal")).toThrow();
	});

	test("leading zero bits, as words and as bytes", () => {
		expect(leadingZeroBits([0, 0x0fffffff])).toBe(36);
		expect(leadingZeroBits([0x80000000])).toBe(0);
		expect(leadingZeroBitsBytes([0, 0, 0x10, 0xff])).toBe(19);
		expect(leadingZeroBitsBytes([0xff])).toBe(0);
	});
});

describe("solving and checking", () => {
	test("the solver's nonce meets the difficulty by the server's native hash, for challenges of every length", () => {
		for (const challenge of ["x", "c1.a".repeat(15), "c1.b".repeat(16), "c1.c".repeat(40)]) {
			const found = solve(challenge, 10);
			expect(found).not.toBeNull();
			const digest = createHash("sha256").update(`${challenge}:${found?.nonce}`).digest();
			expect(leadingZeroBitsBytes(digest)).toBeGreaterThanOrEqual(10);
		}
	});

	test("maxAttempts stops the search", () => {
		expect(solve("c1.x", 40, { maxAttempts: 100 })).toBeNull();
	});

	test("a solved challenge is accepted once; replay, tampering, forgery, expiry and too little work are refused", () => {
		let now = Date.UTC(2026, 8, 28, 12);
		const c = new Challenges(() => now);
		const issued = c.issue(8);
		const nonce = solve(issued.challenge, 8)?.nonce ?? "";
		expect(c.redeem(issued.challenge, nonce)).toEqual({ ok: true });
		expect(c.redeem(issued.challenge, nonce)).toEqual({ ok: false, reason: "used" });

		// Lowering the difficulty inside the token breaks its signature.
		const other = c.issue(12);
		const easier = other.challenge.replace(".12.", ".1.");
		expect(c.redeem(easier, solve(easier, 1)?.nonce)).toEqual({ ok: false, reason: "signature" });
		// Another server's (or a made-up) key.
		const foreign = new Challenges(() => now).issue(1);
		expect(c.redeem(foreign.challenge, solve(foreign.challenge, 1)?.nonce)).toEqual({
			ok: false,
			reason: "signature",
		});
		// Too little work: a nonce that does not meet 12 bits (search for one that fails).
		let bad = 0;
		while (leadingZeroBitsBytes(createHash("sha256").update(`${other.challenge}:${bad}`).digest()) >= 12)
			bad++;
		expect(c.redeem(other.challenge, String(bad))).toEqual({ ok: false, reason: "work" });
		// Malformed inputs.
		expect(c.redeem(123, "1")).toEqual({ ok: false, reason: "format" });
		expect(c.redeem(other.challenge, "UPPER")).toEqual({ ok: false, reason: "format" });
		expect(c.redeem(other.challenge, "1".repeat(17))).toEqual({ ok: false, reason: "format" });
		// Expired after its lifetime.
		const late = c.issue(4);
		const lateNonce = solve(late.challenge, 4)?.nonce;
		now += c.ttlMs + 1;
		expect(c.redeem(late.challenge, lateNonce)).toEqual({ ok: false, reason: "expired" });
	});

	test("a key rotation keeps challenges already handed out valid for one lifetime, then not", () => {
		let now = Date.UTC(2026, 8, 28, 12);
		const c = new Challenges(() => now);
		const a = c.issue(4);
		const b = c.issue(4);
		c.rotate();
		expect(c.redeem(a.challenge, solve(a.challenge, 4)?.nonce)).toEqual({ ok: true });
		now += c.ttlMs + 1;
		// Past the old key's grace (and past b's own lifetime): refused.
		expect(c.redeem(b.challenge, solve(b.challenge, 4)?.nonce).ok).toBe(false);
	});

	test("the spent list is bounded: past its cap the earliest are forgotten, and everything issued up to them is refused", () => {
		let now = Date.UTC(2026, 8, 28, 12);
		const c = new Challenges(() => now, 600_000, 2);
		const ids = [0, 1, 2, 3].map(() => {
			now += 1_000;
			return c.issue(1);
		});
		const redeem = (i: number) => c.redeem(ids[i]?.challenge, solve(ids[i]?.challenge ?? "", 1)?.nonce);
		expect(redeem(1).ok).toBe(true);
		expect(redeem(2).ok).toBe(true);
		// A third fills it: the earliest issued (1) is forgotten, and the watermark refuses it and anything older (0).
		expect(redeem(3).ok).toBe(true);
		expect(c.spentCount).toBe(2);
		expect(redeem(1)).toEqual({ ok: false, reason: "expired" });
		expect(redeem(0)).toEqual({ ok: false, reason: "expired" });
		expect(redeem(2)).toEqual({ ok: false, reason: "used" });
		// Nobody is blocked: a new challenge works.
		const fresh = c.issue(1);
		expect(c.redeem(fresh.challenge, solve(fresh.challenge, 1)?.nonce).ok).toBe(true);
	});
});
