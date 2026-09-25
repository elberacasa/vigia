import type { HttpLike } from "../core/types.ts";

/** What the setup guide knows about a key: why, what it costs, how to get it, how to check it. */
export interface KeySpec {
	readonly id: string;
	readonly provider: string;
	readonly name: { readonly es: string; readonly en: string };
	/** "free-no-card" is the only acceptable cost for anything the core needs (rule zero). */
	readonly cost: "free-no-card" | "free-card" | "paid";
	readonly signupUrl: string;
	/** What the key unlocks, in words (a key can improve a feed or enable an AI feature, not only unlock a feed). */
	readonly unlocks: { readonly es: string; readonly en: string };
	/** Rough minutes to obtain, measured by following the steps. */
	readonly minutes: number;
	readonly steps: { readonly es: readonly string[]; readonly en: readonly string[] };
	/** One harmless request that proves the key works. Resolves to null when valid, or a user-facing reason. */
	validate(key: string, http: HttpLike): Promise<string | null>;
}
