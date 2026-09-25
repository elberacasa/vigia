import { expect, test } from "bun:test";
import { join } from "node:path";
import { hasFixture, loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { epiWeek, epiYearStart, isoDay, mppsBoletin, parseList, weekEndMs, weeksInYear } from "./index.ts";

const recorded = join(import.meta.dir, "fixtures", "2026-09-25");

test("the epidemiological calendar: weeks Sunday to Saturday, week 1 has four days in the year", () => {
	expect(isoDay(epiYearStart(2026))).toBe("2026-01-04");
	expect(isoDay(epiYearStart(2025))).toBe("2024-12-29");
	expect(isoDay(epiYearStart(2027))).toBe("2027-01-03");
	// 2025 had 53 weeks: SE 1 of 2026's bulletin compares with "SE N° 53 (2025)".
	expect(weeksInYear(2025)).toBe(53);
	expect(weeksInYear(2026)).toBe(52);
	const w36 = epiWeek(2026, 36);
	expect([isoDay(w36.from), isoDay(w36.to)]).toEqual(["2026-09-06", "2026-09-12"]);
	// 24:00 Saturday 12 September in Caracas is 04:00 UTC on the 13th.
	expect(weekEndMs(2026, 36)).toBe(Date.UTC(2026, 8, 13, 4) - 1);
});

test.skipIf(!hasFixture(recorded))(
	"recorded list: SE 1-36 of 2026, dates match the list's well-formed ranges",
	() => {
		const raws = loadFixture(recorded);
		const obs = mppsBoletin.normalise(raws);
		expect(obs.length).toBe(36);
		expect(obs[0]?.value).toEqual({
			year: 2026,
			week: 36,
			pdfUrl: "https://mpps.gob.ve/wp-content/uploads/2026/09/Boletin-Epidemiologico-SEM-36.pdf",
			from: "2026-09-06",
			to: "2026-09-12",
		});
		const months = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre"];
		let checked = 0;
		for (const e of parseList((raws[0] as RawResponse).body)) {
			// "06 al 12 septiembre de 2026", "30 de agosto al 05 septiembre de 2026": check the end day and month.
			const m = /al (\d{1,2}) (?:de )?([a-z]+) (?:de )?\d{4}$/.exec(e.rangeText);
			if (!m) continue;
			const to = epiWeek(e.year, e.week).to;
			if (new Date(to).getUTCDate() === Number(m[1]) && months[new Date(to).getUTCMonth()] === m[2])
				checked++;
		}
		// 33 well-formed ranges agree; the three with typos ("26 al 29 de marzo", "14 al 21 junio", "05 julio al 11
		// 2026") are why dates are computed, not read.
		expect(checked).toBe(33);
	},
);

test("list parsing: suffixes, disagreeing labels, and weeks past the year's end are skipped", () => {
	const a = (file: string, label: string, range: string) =>
		`<a href="https://mpps.gob.ve/wp-content/uploads/2026/07/${file}" target="_blank">${label}</a> ${range}<br />`;
	const html =
		a("Boletin-Epidemiologico-SEM-21-MM.pdf", "BOLETÍN EPIDEMIOLÓGICO SE21", "24 al 30 mayo de 2026") +
		a("Boletin-Epidemiologico-SEM-22.pdf", "BOLETÍN EPIDEMIOLÓGICO SE23", "31 mayo al 06 junio de 2026") +
		a("Boletin-Epidemiologico-SEM-53.pdf", "BOLETÍN EPIDEMIOLÓGICO SE53", "27 dic de 2026") +
		a("Boletin-Epidemiologico-SEM-05.pdf", "BOLETÍN EPIDEMIOLÓGICO SE5", "sin año");
	expect(parseList(html).map((e) => [e.year, e.week])).toEqual([[2026, 21]]);
});

test("a page with no bulletins fails the run; future weeks are dropped", () => {
	const raw: RawResponse = {
		url: "https://mpps.gob.ve/boletines-epidemiologicos/",
		status: 200,
		contentType: "text/html",
		body: "<html>mantenimiento</html>",
		fetchedAt: Date.UTC(2026, 8, 25),
	};
	expect(() => mppsBoletin.normalise([raw])).toThrow("ya no lista");
	const future = `<a href="https://mpps.gob.ve/wp-content/uploads/2026/09/Boletin-Epidemiologico-SEM-40.pdf">BOLETÍN EPIDEMIOLÓGICO SE40</a> 04 al 10 octubre de 2026`;
	expect(mppsBoletin.normalise([{ ...raw, body: future }])).toEqual([]);
});
