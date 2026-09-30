import { expect, test } from "bun:test";
import {
	changesByMonth,
	dayText,
	groupOffices,
	licenceBadge,
	monthText,
	officeLine,
	programText,
} from "./sanctions-view.ts";

test("a source's calendar date is printed as is, never shifted by a time zone", () => {
	expect(dayText("2026-09-23", "es")).toBe("23 sept 2026");
	expect(dayText("2026-01-05", "en")).toBe("Jan 5, 2026");
	expect(dayText("not a date", "es")).toBe("not a date");
});

test("programme tags read as words", () => {
	expect(programText("VENEZUELA")).toBe("Venezuela");
	expect(programText("VENEZUELA-EO13850")).toBe("Venezuela · EO 13850");
	expect(programText("RUSSIA-EO14024")).toBe("Russia · EO 14024");
	expect(programText("SDGT")).toBe("SDGT");
});

test("a recent licence is new without a revision letter, amended with one; an older one has no badge", () => {
	expect(licenceBadge({ recent: true, revision: "" })).toBe("new");
	expect(licenceBadge({ recent: true, revision: "E" })).toBe("amended");
	expect(licenceBadge({ recent: false, revision: "E" })).toBeNull();
});

test("twelve Caracas months, oldest first, counting each action in the month OFAC published it", () => {
	const now = Date.UTC(2026, 8, 28, 12); // 28 Sept 2026
	const bins = changesByMonth(
		[
			{ at: Date.UTC(2026, 7, 18, 12), action: "add" },
			{ at: Date.UTC(2026, 7, 20, 12), action: "add" },
			{ at: Date.UTC(2026, 8, 1, 2), action: "remove" }, // 31 Aug, 22:00 in Caracas
			{ at: Date.UTC(2025, 8, 15), action: "update" }, // outside the twelve months
		],
		now,
	);
	expect(bins).toHaveLength(12);
	expect(bins[0]?.month).toBe("2025-10");
	expect(bins[11]?.month).toBe("2026-09");
	expect(bins[10]).toEqual({ month: "2026-08", add: 2, remove: 1, update: 0 });
	expect(bins.reduce((n, b) => n + b.update, 0)).toBe(0);
	expect(monthText("2026-08", "es")).toBe("ago 26");
});

test("months roll over the year correctly", () => {
	const bins = changesByMonth([], Date.UTC(2027, 0, 10, 12));
	expect(bins[0]?.month).toBe("2026-02");
	expect(bins[10]?.month).toBe("2026-12");
	expect(bins[11]?.month).toBe("2027-01");
});

test("offices group by kind in the fixed order; empty kinds are dropped", () => {
	const groups = groupOffices([
		{ kind: "governor" as const },
		{ kind: "president" as const },
		{ kind: "governor" as const },
	]);
	expect(groups.map((g) => [g.kind, g.offices.length])).toEqual([
		["president", 1],
		["governor", 2],
	]);
});

test("an office says only what Wikidata records: holder since, ended without successor, or no dated term", () => {
	const term = (over: object) => ({
		person: { qid: "Q1", label: "X" },
		start: "2021-01-05",
		end: null,
		died: null,
		datesInconsistent: false,
		...over,
	});
	expect(officeLine({ status: "current", latestTerm: term({}) }, "es")).toBe("desde el 5 ene 2021");
	expect(officeLine({ status: "ended", latestTerm: term({ end: "2026-01-03" }) }, "es")).toBe(
		"terminó el 3 ene 2026; sin sucesor registrado (período desde el 5 ene 2021)",
	);
	expect(officeLine({ status: "ended", latestTerm: term({ died: "2023-04-12" }) }, "en")).toBe(
		"died Apr 12, 2023; no successor recorded (term from Jan 5, 2021)",
	);
	expect(officeLine({ status: "unknown", latestTerm: null }, "es")).toBe(
		"sin períodos con fecha en Wikidata",
	);
});
