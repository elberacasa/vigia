import { expect, test } from "bun:test";
import { join } from "node:path";
import { hasFixture, loadFixture } from "../../core/fixtures.ts";
import { federalRegister } from "./index.ts";

// Recorded 2026-09-29 02:1x UTC (50 newest documents matching "venezuela"). Kept out of the public repository: a
// body-only match can be a notice about a private person, and the raw response carries its title. The synthetic
// test covers the parser everywhere.
const dir = join(import.meta.dir, "fixtures", "2026-09-28");
const recorded = hasFixture(dir);
const obs = recorded ? federalRegister.normalise(loadFixture(dir)) : [];

test.skipIf(!recorded)("50 documents: those about Venezuela keep their title, body-only ones do not", () => {
	expect(obs.length).toBe(50);
	const newest = obs[0]?.value;
	expect(newest).toMatchObject({
		number: "2026-19422",
		type: "Rule",
		publicationDate: "2026-09-23",
		relevance: "title",
		title: "Publication of Venezuela Sanctions Regulations Web General Licenses 5X and 5Y",
	});
	expect(newest?.agencies).toEqual(["Treasury Department", "Foreign Assets Control Office"]);
	// 23 Sep 2026, 00:00 US Eastern daylight time.
	expect(new Date(obs[0]?.observedAt ?? 0).toISOString()).toBe("2026-09-23T04:00:00.000Z");
	for (const o of obs.filter((x) => x.value.relevance === "text")) {
		expect(o.value.title).toBeNull();
		expect(o.value.abstract).toBeNull();
		expect(o.value.pdfUrl).toBeNull();
		expect(o.sourceUrl).toBe(`https://www.federalregister.gov/d/${o.value.number}`);
	}
	const counts = { title: 0, ofac: 0, text: 0 };
	for (const o of obs) counts[o.value.relevance]++;
	expect(counts.title + counts.ofac + counts.text).toBe(50);
	expect(counts.title).toBeGreaterThan(5);
});
