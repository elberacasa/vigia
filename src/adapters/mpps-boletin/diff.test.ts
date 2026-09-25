import { expect, test } from "bun:test";
import { diffWeeks, missingFigures, type Week } from "./diff.ts";

const week = (n: number, over: Partial<Week> = {}): Week => ({
	year: 2026,
	week: n,
	pdfUrl: `https://mpps.gob.ve/wp-content/uploads/2026/09/SEM-${n}.pdf`,
	coveragePct: 50,
	dengueWeek: 10,
	dengueYear: 100,
	malariaWeek: 1,
	malariaYear: 2,
	malariaPrevYear: 3,
	diarrhoeaWeek: 4,
	respiratoryWeek: 5,
	pneumoniaWeek: 6,
	measlesSuspected: null,
	measlesDiscarded: null,
	measlesInvestigating: null,
	yellowFeverCases: null,
	yellowFeverDeaths: null,
	...over,
});

test("a new week is added; a re-read week shows each changed figure; nothing else is reported", () => {
	const d = diffWeeks([week(35), week(36)], [week(35), week(36, { dengueWeek: 12 }), week(37)]);
	expect(d.added.map((w) => w.week)).toEqual([37]);
	expect(d.removed).toEqual([]);
	expect(d.changed).toEqual([{ key: "2026-SE36", field: "dengueWeek", from: 10, to: 12 }]);
});

test("a week no longer listed is reported as removed; a re-uploaded PDF shows its new address", () => {
	const d = diffWeeks([week(1), week(2)], [week(2, { pdfUrl: "https://mpps.gob.ve/x/SEM-02-MM.pdf" })]);
	expect(d.removed.map((w) => w.week)).toEqual([1]);
	expect(d.changed.map((c) => c.field)).toEqual(["pdfUrl"]);
});

test("missing figures are named", () => {
	expect(missingFigures(week(1, { coveragePct: null }))).toContain("coveragePct");
	expect(missingFigures(week(1))).not.toContain("dengueWeek");
});
