import type { Store } from "../core/store.ts";

/**
 * Every paid AI request goes through here: recorded (tokens, cost, purpose) and refused when it would pass the
 * user's hard budget. The budget is checked before the request, from the ledger itself, so a restart or a crash
 * cannot reset it.
 */
export class BudgetExceededError extends Error {
	override readonly name = "BudgetExceededError";
}

export interface LedgerEntry {
	readonly provider: string;
	readonly model: string;
	readonly purpose: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly costUsd: number;
}

export class Ledger {
	constructor(
		readonly store: Store,
		/** Total USD allowed per provider (all time). 0 blocks every paid request. */
		readonly budgetUsd: (provider: string) => number,
		readonly now: () => number = Date.now,
	) {}

	spent(provider: string): number {
		const row = this.store.db
			.query<{ s: number | null }, [string]>("SELECT SUM(cost_usd) AS s FROM ai_ledger WHERE provider = ?")
			.get(provider);
		return row?.s ?? 0;
	}

	/** Throws when spending `estimateUsd` more would pass the budget. */
	check(provider: string, estimateUsd: number): void {
		const budget = this.budgetUsd(provider);
		const spent = this.spent(provider);
		if (spent + estimateUsd > budget) {
			throw new BudgetExceededError(
				`Presupuesto de ${provider} agotado: gastado US$${spent.toFixed(4)} de US$${budget.toFixed(2)}.`,
			);
		}
	}

	/**
	 * Books the worst-case cost before a paid call, in the same synchronous step as the budget check, so concurrent
	 * requests cannot all pass the check and then overspend together. Returns the ledger row id to settle.
	 * If the call fails, the reservation stays booked: a timed-out or unparseable call may still have been billed.
	 */
	reserve(entry: { provider: string; model: string; purpose: string; estimateUsd: number }): number {
		this.check(entry.provider, entry.estimateUsd);
		const result = this.store.db.run(
			"INSERT INTO ai_ledger (at, provider, model, purpose, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, 0, 0, ?)",
			[this.now(), entry.provider, entry.model, `${entry.purpose} (reservado)`, entry.estimateUsd],
		);
		return Number(result.lastInsertRowid);
	}

	/** Replaces a reservation with the real usage once the provider has answered. */
	settle(
		id: number,
		actual: { model: string; inputTokens: number; outputTokens: number; costUsd: number },
	): void {
		this.store.db.run(
			"UPDATE ai_ledger SET model = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?, purpose = replace(purpose, ' (reservado)', '') WHERE id = ?",
			[actual.model, actual.inputTokens, actual.outputTokens, actual.costUsd, id],
		);
	}

	record(entry: LedgerEntry): void {
		this.store.db.run(
			"INSERT INTO ai_ledger (at, provider, model, purpose, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[
				this.now(),
				entry.provider,
				entry.model,
				entry.purpose,
				entry.inputTokens,
				entry.outputTokens,
				entry.costUsd,
			],
		);
	}

	summary(): { provider: string; requests: number; inputTokens: number; costUsd: number }[] {
		return this.store.db
			.query<{ provider: string; requests: number; input_tokens: number; cost: number }, []>(
				"SELECT provider, COUNT(*) AS requests, SUM(input_tokens) AS input_tokens, SUM(cost_usd) AS cost FROM ai_ledger GROUP BY provider",
			)
			.all()
			.map((r) => ({
				provider: r.provider,
				requests: r.requests,
				inputTokens: r.input_tokens,
				costUsd: r.cost,
			}));
	}
}
