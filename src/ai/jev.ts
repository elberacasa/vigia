import { z } from "zod";
import type { Store } from "../core/store.ts";
import { canonicalJson } from "../core/store.ts";
import type { HttpLike, Json } from "../core/types.ts";
import type { Answer, FastJudge, Judgement, Question } from "./judge.ts";
import type { Ledger } from "./ledger.ts";

/** Pinned: thresholds are tuned against this version. Move on purpose, re-measuring (docs/AI.md). */
export const JEV_MODEL = "jev-1.13.0";
/** US$ per input token (docs.typesafe.ai/models, 2026-09-24: $0.042 per million; output free). */
export const JEV_PRICE_PER_TOKEN = 0.042 / 1_000_000;
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

const AnswerSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }),
	z.object({
		type: z.literal("choice"),
		choice: z.string(),
		probabilities: z.record(z.string(), z.number()),
		confidence: z.number(),
	}),
	z.object({
		type: z.literal("score"),
		score: z.number(),
		probabilities: z.record(z.string(), z.number()),
		confidence: z.number(),
	}),
]);
const ResponseSchema = z.object({
	model: z.string(),
	answers: z.record(z.string(), AnswerSchema),
	usage: z.object({
		input_tokens: z.number().int().nonnegative(),
		output_tokens: z.number().int().nonnegative(),
	}),
});

/** Rough token estimate for the budget check before a request (≈ 3.5 characters per token for Spanish JSON). */
export function estimateTokens(body: string): number {
	return Math.ceil(body.length / 3.5);
}

export class JevJudge implements FastJudge {
	readonly id = "jev";
	constructor(
		readonly key: () => string | undefined,
		readonly http: HttpLike,
		readonly ledger: Ledger,
		readonly store: Store,
		readonly model: string = JEV_MODEL,
	) {}

	async evaluate(
		state: unknown,
		questions: Readonly<Record<string, Question>>,
		purpose: string,
	): Promise<Judgement> {
		const body = JSON.stringify({ model: this.model, state, questions });
		const cacheKey = Bun.hash(
			canonicalJson({ model: this.model, state, questions } as unknown as Json),
		).toString(36);
		const hit = this.store.db
			.query<{ response: string }, [string]>("SELECT response FROM ai_cache WHERE key = ?")
			.get(cacheKey);
		if (hit) {
			const parsed = ResponseSchema.parse(JSON.parse(hit.response));
			return { model: parsed.model, answers: parsed.answers as Record<string, Answer>, cached: true };
		}
		const key = this.key();
		if (!key) throw new Error("Falta la clave de TypeSafe (Jev).");
		const reservation = this.ledger.reserve({
			provider: "typesafe",
			model: this.model,
			purpose,
			estimateUsd: estimateTokens(body) * JEV_PRICE_PER_TOKEN,
		});
		const raw = await this.http.request(ENDPOINT, {
			method: "POST",
			headers: {
				authorization: `Bearer ${key}`,
				"content-type": "application/json",
				accept: "application/json",
			},
			body,
			timeoutMs: 60_000,
			hostGapMs: 60,
			// No transport retries on a paid call: a timed-out request may have been billed; the reservation covers
			// one attempt, and the caller decides whether to try again (with a new reservation).
			retries: 0,
		});
		const parsed = ResponseSchema.parse(JSON.parse(raw.body));
		this.ledger.settle(reservation, {
			model: parsed.model,
			inputTokens: parsed.usage.input_tokens,
			outputTokens: parsed.usage.output_tokens,
			costUsd: parsed.usage.input_tokens * JEV_PRICE_PER_TOKEN,
		});
		// Thresholds and the measured accuracy are pinned to one model version: a silent server-side upgrade is
		// billed (settled above) but not used or cached.
		if (parsed.model !== this.model) {
			throw new Error(`Jev respondió con ${parsed.model}; Vigía está calibrado para ${this.model}.`);
		}
		this.store.db.run("INSERT OR REPLACE INTO ai_cache (key, model, at, response) VALUES (?, ?, ?, ?)", [
			cacheKey,
			parsed.model,
			Date.now(),
			raw.body,
		]);
		return { model: parsed.model, answers: parsed.answers as Record<string, Answer>, cached: false };
	}
}
