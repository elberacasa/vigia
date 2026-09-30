import { expect, test } from "bun:test";
import {
	ANOMALY_RULES,
	anomalyRulesText,
	caracasDay,
	caracasDayStart,
	evaluateChange,
	evaluateCount,
	evaluateLevel,
	evaluateNight,
	logGamma,
	median,
	poissonTail,
	robustSigma,
} from "./anomaly.ts";

const COUNT = {
	minRatio: ANOMALY_RULES.count.minRatio,
	maxTail: ANOMALY_RULES.count.maxTail,
	minPrior: ANOMALY_RULES.count.minDays,
};

/** A deterministic wobble in [−1, 1] (no randomness in tests). */
const wobble = (i: number) => Math.sin(i * 12.9898) * 0.5 + Math.sin(i * 4.1414) * 0.5;

test("robust statistics: median, 1.4826 × MAD, an exact Poisson tail and log-gamma", () => {
	expect(median([3, 1, 2])).toBe(2);
	expect(median([4, 1, 2, 3])).toBe(2.5);
	expect(median([])).toBeNull();
	// One outlier moves neither the median nor the MAD.
	expect(robustSigma([1, 2, 3, 4, 1000], 3)).toBeCloseTo(1.4826, 4);
	expect(logGamma(10)).toBeCloseTo(Math.log(362_880), 10);
	expect(poissonTail(0, 3)).toBe(1);
	expect(poissonTail(1, 1)).toBeCloseTo(1 - Math.exp(-1), 12);
	// Checked against a naive term-by-term sum: P(X ≥ 10 | 2) = 4.6498075e-5, P(X ≥ 150 | 100) = 1.88421e-6.
	expect(poissonTail(10, 2)).toBeCloseTo(4.6498075017e-5, 14);
	expect(poissonTail(150, 100) / 1.884210466e-6).toBeCloseTo(1, 8);
	expect(poissonTail(3, 0)).toBe(0);
});

test("change class: a jump in a crawling rate is unusual; the crawl, a small move and thin history are not", () => {
	// 80 days of a rate that rises ~0.2 % a day with small noise.
	const levels: number[] = [];
	let v = 800;
	for (let i = 0; i < 80; i++) {
		v *= 1 + 0.002 + 0.0005 * wobble(i);
		levels.push(v);
	}
	const spec = { step: "daily", direction: "both", minLogChange: 0.01, sigmaFloor: 0.001 } as const;
	const quiet = evaluateChange(levels, spec);
	if (typeof quiet === "string") throw new Error(quiet);
	expect(quiet.unusual).toBe(false);
	expect(quiet.points).toBe(ANOMALY_RULES.change.daily.window);
	const jump = evaluateChange([...levels, (levels.at(-1) as number) * 1.05], spec);
	if (typeof jump === "string") throw new Error(jump);
	expect(jump).toMatchObject({ unusual: true, direction: "up" });
	expect(jump.score).toBeGreaterThan(ANOMALY_RULES.minScore);
	// The baseline is yesterday's level carried by the median change: +5 % against it, roughly +4.8 %.
	expect(jump.changePct ?? 0).toBeCloseTo(4.8, 0);
	// A move far outside the noise but under the series' minimum (1 %) is not unusual.
	const small = evaluateChange([...levels, (levels.at(-1) as number) * 1.008], spec);
	expect(typeof small !== "string" && small.unusual).toBe(false);
	// A fall counts too (direction both); an up-only series ignores it.
	const fall = [...levels, (levels.at(-1) as number) * 0.9];
	expect(evaluateChange(fall, spec)).toMatchObject({ unusual: true, direction: "down" });
	expect(evaluateChange(fall, { ...spec, direction: "up" })).toMatchObject({ unusual: false });
	expect(evaluateChange(levels.slice(0, 20), spec)).toBe("thin");
	expect(evaluateChange([...levels, 0], spec)).toBe("weak");
});

test("level class: log scale, a minimum ratio and value; Wikipedia counts only upwards", () => {
	const days = Array.from({ length: 30 }, (_, i) => 1_000 + 60 * wobble(i));
	const spec = { direction: "both", minRatio: 1.25, minValue: 50, sigmaFloor: 0.05 } as const;
	expect(evaluateLevel([...days, 1_020], spec)).toMatchObject({ unusual: false });
	const surge = evaluateLevel([...days, 2_000], spec);
	expect(surge).toMatchObject({ unusual: true, direction: "up" });
	expect(evaluateLevel([...days, 500], spec)).toMatchObject({ unusual: true, direction: "down" });
	const wiki = { direction: "up", minRatio: 3, minValue: 100, sigmaFloor: 0.1 } as const;
	expect(evaluateLevel([...days, 500], wiki)).toMatchObject({ unusual: false });
	expect(evaluateLevel([...days, 3_500], wiki)).toMatchObject({ unusual: true });
	// A page seen 12 times a day that jumps to 60 is below the minimum value.
	const tiny = Array.from({ length: 30 }, (_, i) => 12 + 2 * wobble(i));
	expect(evaluateLevel([...tiny, 60], wiki)).toMatchObject({ unusual: false });
	expect(evaluateLevel(days.slice(0, 10), spec)).toBe("thin");
});

test("count rule: z, ratio, Poisson tail and a minimum count must all agree; a noisy series needs more", () => {
	const quietDays = Array.from({ length: 28 }, (_, i) => (i % 3 === 0 ? 1 : 0));
	const burst = evaluateCount(12, quietDays, { minCount: 10 }, COUNT);
	expect(burst).toMatchObject({ unusual: true, direction: "up", baseline: 0 });
	if (typeof burst !== "string") expect(burst.tail).toBeLessThan(1e-9);
	// Under the minimum count: nine fires after quiet days are not a list item.
	expect(evaluateCount(9, quietDays, { minCount: 10 }, COUNT)).toMatchObject({ unusual: false });
	// A busy, overdispersed series: 60 against days of 5 to 70 is ordinary.
	const noisy = Array.from({ length: 28 }, (_, i) => (i % 2 ? 5 : 70));
	expect(evaluateCount(60, noisy, { minCount: 10 }, COUNT)).toMatchObject({ unusual: false });
	// Twice the median is never enough (the ratio), however steady the series.
	const steady = Array.from({ length: 28 }, () => 40);
	expect(evaluateCount(80, steady, { minCount: 10 }, COUNT)).toMatchObject({ unusual: false });
	expect(evaluateCount(130, steady, { minCount: 10 }, COUNT)).toMatchObject({ unusual: true });
	expect(evaluateCount(130, steady.slice(0, 5), { minCount: 10 }, COUNT)).toBe("thin");
});

test("night class: the incidents' drop rule, scored against the clear nights", () => {
	const nights = [10, 10.5, 9.8, 10.2, 9.9, 10.1, 10.3, 9.7];
	expect(evaluateNight(6, nights, -40)).toMatchObject({ unusual: true, direction: "down", baseline: 10.05 });
	expect(evaluateNight(8, nights, -20)).toMatchObject({ unusual: false });
	expect(ANOMALY_RULES.nightMaxPct).toBe(-30);
});

test("Caracas days are UTC−4 all year", () => {
	const t = Date.UTC(2026, 8, 29, 3, 30); // 23:30 on the 28th in Caracas
	expect(caracasDayStart(caracasDay(t))).toBe(Date.UTC(2026, 8, 28, 4));
});

test("the rules in words carry the constants the code uses", () => {
	const es = anomalyRulesText().es.join(" ");
	expect(es).toContain(`desde ${ANOMALY_RULES.minScore}`);
	expect(es).toContain(`${ANOMALY_RULES.change.daily.window} cambios diarios`);
	expect(es).toContain(`${ANOMALY_RULES.count.window} días anteriores con datos`);
	expect(es).toContain(`${ANOMALY_RULES.hourly.days} días anteriores`);
	expect(es).toContain("30 %");
	expect(anomalyRulesText().en).toHaveLength(anomalyRulesText().es.length);
});
