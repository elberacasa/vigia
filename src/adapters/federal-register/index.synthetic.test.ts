import { expect, test } from "bun:test";
import type { RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { FR_API, federalRegister, relevanceOf, shortUrl } from "./index.ts";

/** A synthetic API answer in the Federal Register's shape; documents, numbers and names are invented. */
const doc = (n: string, title: string, abstract: string | null, slugs: string[], date = "2026-01-14") => ({
	document_number: n,
	title,
	type: "Notice",
	abstract,
	publication_date: date,
	agencies: slugs.map((slug) => ({ name: slug, raw_name: slug.toUpperCase(), slug })),
	html_url: `https://www.federalregister.gov/documents/2026/01/14/${n}/${title.toLowerCase().replaceAll(" ", "-")}`,
	pdf_url: `https://www.govinfo.gov/content/pkg/FR-2026-01-14/pdf/${n}.pdf`,
});
const body = JSON.stringify({
	count: 4,
	results: [
		doc("2026-00001", "Publication of Venezuela Sanctions Regulations Web General License 99", null, [
			"foreign-assets-control-office",
		]),
		doc("2026-00002", "Notice of OFAC Sanctions Actions", "OFAC is publishing the names of persons.", [
			"foreign-assets-control-office",
		]),
		doc("2026-00003", "Decision and Order: Jane Invented, M.D.", "A registration is revoked.", [
			"drug-enforcement-administration",
		]),
		{ document_number: 5, title: "broken" },
	],
});
const raw: RawResponse = {
	url: FR_API,
	status: 200,
	contentType: "application/json",
	body,
	fetchedAt: Date.UTC(2026, 0, 15),
};

test("relevance, and nothing but the number for a body-only match", () => {
	const obs = federalRegister.normalise([raw]);
	expect(obs.map((o) => o.value.relevance)).toEqual(["title", "ofac", "text"]);
	const bodyOnly = obs[2];
	expect(bodyOnly?.value).toEqual({
		number: "2026-00003",
		type: "Notice",
		publicationDate: "2026-01-14",
		agencies: ["drug-enforcement-administration"],
		relevance: "text",
		title: null,
		abstract: null,
		htmlUrl: shortUrl("2026-00003"),
		pdfUrl: null,
	});
	expect(JSON.stringify(obs)).not.toContain("Jane");
	expect(JSON.stringify(obs)).not.toContain("jane");
	// 14 Jan 2026, 00:00 US Eastern standard time = 05:00 UTC.
	expect(new Date(obs[0]?.observedAt ?? 0).toISOString()).toBe("2026-01-14T05:00:00.000Z");
});

test("rules and envelope", () => {
	expect(relevanceOf("On venezolanos abroad", "", [])).toBe("title");
	expect(relevanceOf("Unrelated", "Venezuela is named here", [])).toBe("title");
	expect(relevanceOf("Unrelated", "", ["foreign-assets-control-office"])).toBe("ofac");
	expect(relevanceOf("Unrelated", "", ["commerce-department"])).toBe("text");
	expect(() => federalRegister.normalise([{ ...raw, body: "{}" }])).toThrow(SchemaError);
	expect(() => federalRegister.normalise([{ ...raw, body: "<html>" }])).toThrow("JSON");
});
