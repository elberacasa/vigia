import { expect, test } from "bun:test";
import { ANOMALY_RULES, evaluateChange, lastWeekdayOfMonth } from "./anomaly.ts";

test("the last weekday of a month, weekends skipped", () => {
	expect(lastWeekdayOfMonth("2025-05-30")).toBe(true); // Friday; the 31st is a Saturday
	expect(lastWeekdayOfMonth("2025-06-30")).toBe(true); // Monday
	expect(lastWeekdayOfMonth("2025-05-29")).toBe(false);
	expect(lastWeekdayOfMonth("2025-10-01")).toBe(false);
	expect(lastWeekdayOfMonth("not a date")).toBe(false);
});

test("month-end steps are judged against month-ends, other days against other days", () => {
	// 200 business days of reserves that barely move, with a +2 % to +4 % revaluation at every month's close.
	const dates: string[] = [];
	const levels: number[] = [];
	let v = 12_000;
	for (let t = Date.UTC(2025, 0, 2); dates.length < 200; t += 86_400_000) {
		const d = new Date(t);
		if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
		const date = d.toISOString().slice(0, 10);
		v *= lastWeekdayOfMonth(date) ? 1.02 + 0.01 * (dates.length % 3) : 1 + 0.0004 * ((dates.length % 5) - 2);
		dates.push(date);
		levels.push(v);
	}
	const spec = {
		step: "daily",
		direction: "both",
		minLogChange: 0.01,
		sigmaFloor: 0.001,
		monthEnd: true,
	} as const;
	// The series ends on a month-end (2025-09-30): an ordinary revaluation is not unusual any more.
	const end = dates.lastIndexOf("2025-09-30");
	const atClose = evaluateChange(levels.slice(0, end + 1), spec, dates.slice(0, end + 1));
	expect(atClose).toMatchObject({ unusual: false });
	if (typeof atClose !== "string")
		expect(atClose.points).toBeLessThanOrEqual(ANOMALY_RULES.change.monthEnd.window);
	// Without the split, the same close is flagged: the daily baseline never moves that much.
	expect(evaluateChange(levels.slice(0, end + 1), { ...spec, monthEnd: undefined } as never)).toMatchObject({
		unusual: true,
	});
	// A +3 % move in the middle of a month is still unusual, and a +15 % close too.
	const mid = dates.indexOf("2025-09-15");
	const bumped = [...levels.slice(0, mid), (levels[mid - 1] as number) * 1.03];
	expect(evaluateChange(bumped, spec, dates.slice(0, mid + 1))).toMatchObject({
		unusual: true,
		direction: "up",
	});
	const big = [...levels.slice(0, end), (levels[end - 1] as number) * 1.15];
	expect(evaluateChange(big, spec, dates.slice(0, end + 1))).toMatchObject({ unusual: true });
});
