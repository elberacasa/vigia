import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import {
	type GeneralLicence,
	issueDate,
	ofacVenezuela,
	parseActions,
	parseLicences,
	plain,
} from "./index.ts";

// Recorded 2026-09-29 02:1x UTC: OFAC's Venezuela-Related Sanctions page (public domain, no personal data).
const raws = loadFixture(join(import.meta.dir, "fixtures", "2026-09-28"));
const raw = raws[0] as RawResponse;
const obs = ofacVenezuela.normalise(raws);
const licences = obs.filter((o) => o.value.kind === "licence").map((o) => o.value as GeneralLicence);

test("43 general licences with their revision and issue date", () => {
	expect(licences.length).toBe(43);
	expect(licences.map((l) => l.id).slice(0, 7)).toEqual(["2A", "3I", "4C", "5Z", "7C", "9H", "10A"]);
	expect(licences.find((l) => l.number === "5")).toEqual({
		kind: "licence",
		id: "5Z",
		number: "5",
		revision: "Z",
		title:
			"Authorizing Certain Transactions Related to the Petróleos de Venezuela, S.A. 2020 8.5 Percent Bond on or After November 5, 2026",
		issued: "2026-09-16",
		url: "https://ofac.treasury.gov/media/936946/download?inline",
	});
	expect(licences.filter((l) => l.issued === "2026-09-28").map((l) => l.id)).toEqual(["46E", "48D", "49B"]);
	// Variants measured on the page: "7C </a>- …" and a <div> inside the <li> (GL 21).
	expect(licences.find((l) => l.id === "21")?.issued).toBe("2019-08-05");
	const gl5 = obs.find((o) => o.series === "gl:5");
	// Issued 16 Sep 2026: 00:00 US Eastern daylight time = 04:00 UTC.
	expect(new Date(gl5?.observedAt ?? 0).toISOString()).toBe("2026-09-16T04:00:00.000Z");
});

test("the latest Venezuela recent actions and the list snapshot", () => {
	const actions = obs.filter((o) => o.value.kind === "action");
	expect(actions.map((a) => [a.series, a.value.kind === "action" ? a.value.date : ""])).toEqual([
		["action:20260928", "2026-09-28"],
		["action:20260916", "2026-09-16"],
		["action:20260914", "2026-09-14"],
	]);
	const list = obs.find((o) => o.series === "list");
	expect(list?.value.kind === "list" ? list.value.ids.length : 0).toBe(43);
	expect(new Date(list?.observedAt ?? 0).toISOString()).toBe("2026-09-28T04:00:00.000Z");
	for (const o of obs) {
		expect(o.source).toBe("ofac-venezuela");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(o.sourceUrl).toStartWith("https://ofac.treasury.gov/");
	}
});

test("helpers", () => {
	expect(issueDate("Authorizing Things (September 16, 2026)")).toBe("2026-09-16");
	expect(issueDate("Authorizing Things (February 30, 2026)")).toBeNull();
	expect(issueDate("Authorizing Things")).toBeNull();
	expect(plain("Petr&oacute;leos &amp; <em>Co</em>&#8217;s")).toBe("Petr&oacute;leos & Co’s");
	expect(parseLicences("<ul><li>no licences</li></ul>")).toEqual([]);
	expect(parseActions("<p>none</p>")).toEqual([]);
});

test("a page that is not the programme page, or has lost its licences, fails loudly; 304 stores nothing", () => {
	expect(() => ofacVenezuela.normalise([{ ...raw, body: "<html>Just a moment…</html>" }])).toThrow(
		"Venezuela",
	);
	expect(() =>
		ofacVenezuela.normalise([{ ...raw, body: "<h1>Venezuela-Related Sanctions</h1><ul></ul>" }]),
	).toThrow("licencias");
	expect(ofacVenezuela.normalise([{ ...raw, status: 304, body: "" }])).toEqual([]);
});
