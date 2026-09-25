import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NEWS_EVALUATION } from "../../src/ai/evaluation.ts";
import { type EvaluationCounts, renderEvaluation, wilson } from "./evaluation-file.ts";

const root = join(import.meta.dir, "..", "..");

test("src/ai/evaluation.ts is exactly what the generator renders from the checked-in counts", () => {
	const counts = JSON.parse(
		readFileSync(join(root, "scripts/ai/evaluation-counts.json"), "utf8"),
	) as EvaluationCounts;
	expect(readFileSync(join(root, "src/ai/evaluation.ts"), "utf8")).toBe(renderEvaluation(counts));
	// And the numbers the app shows are the counts' ratios.
	const local = counts.methods["vigia-local-news-1"];
	const b = local?.blackoutAll;
	expect<number>(NEWS_EVALUATION.results["vigia-local-news-1"].blackoutR).toBe(
		Math.round(((b?.tp ?? 0) / ((b?.tp ?? 0) + (b?.fn ?? 1))) * 1_000) / 1_000,
	);
});

test("Wilson 95 % interval", () => {
	// 21 of 23: about 0.72–0.99 (review 2, H5).
	expect(wilson(21, 23)).toEqual([0.732, 0.976]);
	expect(wilson(5, 6)).toEqual([0.436, 0.97]);
	expect(wilson(0, 0)).toEqual([0, 0]);
	expect(wilson(6, 6)[1]).toBe(1);
});
