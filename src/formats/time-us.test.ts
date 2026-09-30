import { expect, test } from "bun:test";
import { parseCsv } from "./csv.ts";
import { usEasternIsoToMs, usEasternToMs } from "./time.ts";

test("US Eastern wall time: daylight (UTC−4) from the 2nd Sunday of March to the 1st Sunday of November", () => {
	expect(new Date(usEasternToMs(2026, 9, 23, 10, 7)).toISOString()).toBe("2026-09-23T14:07:00.000Z");
	expect(new Date(usEasternToMs(2026, 1, 2, 11, 39)).toISOString()).toBe("2026-01-02T16:39:00.000Z");
	// 2026: DST from Sun 8 March to Sun 1 November.
	expect(new Date(usEasternToMs(2026, 3, 8, 1, 59)).toISOString()).toBe("2026-03-08T06:59:00.000Z");
	expect(new Date(usEasternToMs(2026, 3, 8, 3, 0)).toISOString()).toBe("2026-03-08T07:00:00.000Z");
	expect(new Date(usEasternToMs(2026, 11, 1, 0, 30)).toISOString()).toBe("2026-11-01T04:30:00.000Z");
	expect(new Date(usEasternToMs(2026, 11, 1, 3, 0)).toISOString()).toBe("2026-11-01T08:00:00.000Z");
	expect(new Date(usEasternToMs(2025, 3, 9, 12)).toISOString()).toBe("2025-03-09T16:00:00.000Z");
});

test("US Eastern ISO text", () => {
	expect(new Date(usEasternIsoToMs("2026-09-23T10:07:28.650545") ?? 0).toISOString()).toBe(
		"2026-09-23T14:07:28.000Z",
	);
	expect(new Date(usEasternIsoToMs("2026-01-02") ?? 0).toISOString()).toBe("2026-01-02T05:00:00.000Z");
	expect(usEasternIsoToMs("2026-02-30")).toBeNull();
	expect(usEasternIsoToMs("23/09/2026")).toBeNull();
});

test("CSV: quotes, doubled quotes, CRLF, blank lines", () => {
	expect(parseCsv('a,"b,c","d ""e"""\r\n\r\n1,2,3\n')).toEqual([
		["a", "b,c", 'd "e"'],
		["1", "2", "3"],
	]);
});
