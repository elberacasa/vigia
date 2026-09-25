import { describe, expect, test } from "bun:test";
import { OUTLETS } from "../adapters/rss/outlets.ts";
import { Store } from "../core/store.ts";
import type { HttpLike, RawResponse, RequestOptions } from "../core/types.ts";
import { JEV_PRICE_PER_TOKEN, JevJudge } from "./jev.ts";
import { FakeJudge } from "./judge.ts";
import { BudgetExceededError, Ledger } from "./ledger.ts";
import { LinearModel } from "./local/model.ts";
import { classifyPending, LOCAL_MODEL_ID, type RecentItem, storedLabels } from "./news-ai.ts";
import { newsQuestions } from "./news-questions.ts";

function jevHttp(calls: { url: string; options: RequestOptions }[], model = "jev-1.13.0"): HttpLike {
	return {
		async request(url, options = {}): Promise<RawResponse> {
			calls.push({ url, options });
			return {
				url,
				status: 200,
				contentType: "application/json",
				fetchedAt: 0,
				body: JSON.stringify({
					model,
					answers: { yes: { type: "noul", noul: 0.9 } },
					usage: { input_tokens: 1_000, output_tokens: 10 },
				}),
			};
		},
	};
}

describe("ledger and Jev client", () => {
	test("records cost, caches identical requests, and refuses past the budget", async () => {
		const store = new Store(":memory:");
		const calls: { url: string; options: RequestOptions }[] = [];
		let budget = 1;
		const ledger = new Ledger(store, () => budget);
		const jev = new JevJudge(() => "secret-key-123456", jevHttp(calls), ledger, store);
		const q = { yes: { type: "noul" as const, instructions: "Is it?" } };
		const first = await jev.evaluate({ text: "a" }, q, "test");
		expect(first.cached).toBe(false);
		expect(ledger.spent("typesafe")).toBeCloseTo(1_000 * JEV_PRICE_PER_TOKEN);
		const again = await jev.evaluate({ text: "a" }, q, "test");
		expect(again.cached).toBe(true);
		expect(calls.length).toBe(1);
		budget = 0;
		await expect(jev.evaluate({ text: "b" }, q, "test")).rejects.toBeInstanceOf(BudgetExceededError);
		expect(calls.length).toBe(1);
	});
	test("an answer from another Jev version is billed in the ledger but neither used nor cached", async () => {
		const store = new Store(":memory:");
		const ledger = new Ledger(store, () => 1);
		const jev = new JevJudge(() => "secret-key-123456", jevHttp([], "jev-2.0.0"), ledger, store);
		await expect(
			jev.evaluate({ text: "a" }, { yes: { type: "noul", instructions: "?" } }, "t"),
		).rejects.toThrow("jev-2.0.0");
		expect(ledger.spent("typesafe")).toBeCloseTo(1_000 * JEV_PRICE_PER_TOKEN);
		expect(store.db.query("SELECT COUNT(*) AS n FROM ai_cache").get()).toEqual({ n: 0 });
	});
	test("the key only goes in the Authorization header, to TypeSafe", async () => {
		const store = new Store(":memory:");
		const calls: { url: string; options: RequestOptions }[] = [];
		const jev = new JevJudge(() => "secret-key-123456", jevHttp(calls), new Ledger(store, () => 5), store);
		await jev.evaluate("x", { yes: { type: "noul", instructions: "?" } }, "test");
		expect(calls[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
		expect(calls[0]?.options.headers?.authorization).toBe("Bearer secret-key-123456");
		expect(calls[0]?.options.body).not.toContain("secret-key");
		const row = store.db.query<{ response: string }, []>("SELECT response FROM ai_cache").get();
		expect(row?.response).not.toContain("secret-key");
	});
	test("with no budget set, Jev makes no request at all", async () => {
		const store = new Store(":memory:");
		const calls: { url: string; options: RequestOptions }[] = [];
		const jev = new JevJudge(() => "k-123456789", jevHttp(calls), new Ledger(store, () => 0), store);
		await expect(jev.evaluate("x", newsQuestions(), "test")).rejects.toThrow("Presupuesto");
		expect(calls.length).toBe(0);
	});
});

test("local model: the serialized format round-trips to the same predictions (within int8 rounding)", () => {
	const heads = [
		{ name: "blackout", kind: "sigmoid" as const, classes: ["yes"] },
		{ name: "state", kind: "softmax" as const, classes: ["VE-A", "VE-V"] },
	];
	const rows = new Map<number, Float32Array>([
		[1, new Float32Array([2, 0.5, -0.5])],
		[2, new Float32Array([-1, -0.3, 1.2])],
	]);
	const m = new LinearModel(heads, rows);
	const back = LinearModel.deserialize(m.serialize(0));
	const x = new Map([
		[1, 0.6],
		[2, 0.8],
	]);
	const a = m.fromLogits(m.logits(x));
	const b = back.fromLogits(back.logits(x));
	expect(b.yes.blackout ?? 0).toBeCloseTo(a.yes.blackout ?? 0, 2);
	expect(b.dist.state?.["VE-V"] ?? 0).toBeCloseTo(a.dist.state?.["VE-V"] ?? 0, 2);
});

test("classifyPending: local labels are stored per model and never recomputed; off does nothing", async () => {
	const store = new Store(":memory:");
	const outlet = OUTLETS[0];
	if (!outlet) throw new Error("no outlets");
	const items: RecentItem[] = [
		{
			key: "k1",
			outlet,
			item: {
				outlet: outlet.id,
				title: "Apagón en Maracaibo",
				link: "https://x/1",
				summary: "",
				image: null,
				dateMissing: false,
				video: false,
			},
		},
	];
	const model = new LinearModel(
		[
			{ name: "about_venezuela", kind: "sigmoid", classes: ["yes"] },
			{ name: "blackout", kind: "sigmoid", classes: ["yes"] },
		],
		new Map(),
	);
	expect(
		(await classifyPending({ store, backend: "off", items, local: model, jev: null, now: 1 })).labelled,
	).toBe(0);
	expect(
		(await classifyPending({ store, backend: "local", items, local: model, jev: null, now: 1 })).labelled,
	).toBe(1);
	expect(
		(await classifyPending({ store, backend: "local", items, local: model, jev: null, now: 2 })).labelled,
	).toBe(0);
	expect(storedLabels(store, LOCAL_MODEL_ID, ["k1"]).get("k1")?.model).toBe(LOCAL_MODEL_ID);
	const judge = new FakeJudge((_s, _id, q) =>
		q.type === "noul"
			? { type: "noul", noul: 0.9 }
			: q.type === "choice"
				? { type: "choice", choice: Object.keys(q.criteria)[0] ?? "", probabilities: {}, confidence: 1 }
				: { type: "score", score: 2, probabilities: {}, confidence: 1 },
	);
	expect(
		(await classifyPending({ store, backend: "jev", items, local: null, jev: judge, now: 3 })).labelled,
	).toBe(1);
	expect(judge.calls).toBe(1);
});

test("reservations make the budget race-proof: parallel paid calls cannot overspend", async () => {
	const store = new Store(":memory:");
	const ledger = new Ledger(store, () => 0.1);
	let slow = 0;
	const http: HttpLike = {
		async request(): Promise<RawResponse> {
			await Bun.sleep(20);
			slow++;
			return {
				url: "",
				status: 200,
				contentType: "",
				fetchedAt: 0,
				body: JSON.stringify({
					model: "jev-1.13.0",
					answers: { yes: { type: "noul", noul: 1 } },
					usage: { input_tokens: 1_000_000, output_tokens: 0 },
				}),
			};
		},
	};
	const jev = new JevJudge(() => "k-123456789", http, ledger, store);
	// Each request is estimated at ~0.03 (big state); only three fit in 0.10.
	const big = "x".repeat(2_600_000);
	const results = await Promise.allSettled(
		Array.from({ length: 5 }, (_, i) =>
			jev.evaluate({ big, i }, { yes: { type: "noul", instructions: "?" } }, "t"),
		),
	);
	expect(results.filter((r) => r.status === "rejected").length).toBeGreaterThan(0);
	expect(slow).toBeLessThan(5);
});

test("a failed paid call keeps its reservation booked", async () => {
	const store = new Store(":memory:");
	const ledger = new Ledger(store, () => 1);
	const http: HttpLike = {
		request: async () => {
			throw new Error("timeout");
		},
	};
	const jev = new JevJudge(() => "k-123456789", http, ledger, store);
	await expect(jev.evaluate("x", { yes: { type: "noul", instructions: "?" } }, "t")).rejects.toThrow(
		"timeout",
	);
	expect(ledger.spent("typesafe")).toBeGreaterThan(0);
});
