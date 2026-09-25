import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { type FaaPage, type FaaSection, faaProhibitions, parseFaaPage } from "./index.ts";

const raws = loadFixture(join(import.meta.dir, "fixtures", "2026-09-25"));
const [raw] = raws as [RawResponse];
const obs = faaProhibitions.normalise(raws);
const page = obs.find((o) => o.series === "faa:page")?.value as FaaPage;
const section = (s: string) => obs.find((o) => o.series === s)?.value as FaaSection | undefined;

test("24 country sections, last updated 2026-09-14, no Venezuela section or mention", () => {
	expect(page.lastUpdated).toBe("2026-09-14");
	expect(page.sections.length).toBe(24);
	expect(page.sections[0]).toBe("United States");
	expect(page.sections.at(-1)).toBe("Yemen");
	expect(page.venezuelaSection).toBe(false);
	expect(page.venezuelaMentions).toEqual([]);
	expect(obs.length).toBe(25);
	for (const o of obs) {
		expect(o.source).toBe("faa-prohibitions");
		expect(o.observedAt).toBe(Date.parse("2026-09-14T00:00:00Z"));
		expect(o.sourceUrl).toStartWith("https://www.faa.gov/air_traffic/publications/us_restrictions");
	}
});

test("neighbours: Colombia's KICZ advisory with its PDF link and page anchor", () => {
	const col = section("faa:colombia");
	expect(col?.items[0]?.title).toStartWith("KICZ NOTAM A0050/26 Security");
	expect(col?.items[0]?.url).toBe(
		"https://www.faa.gov/air_traffic/publications/us_restrictions/colombia/KICZ_ADVISORY_NOTAM_A0050_26_SKED.pdf",
	);
	expect(obs.find((o) => o.series === "faa:colombia")?.sourceUrl).toEndWith("#colombia");
	expect(section("faa:haiti")?.items[0]?.title).toContain("A0046/26");
	// The footer's menus are not sections.
	expect(page.sections).not.toContain("Policies, Rights & Legal");
});

test("a Venezuela section, or a document naming SVZM, is detected", () => {
	const add =
		'<h2><a id="venezuela"></a>Venezuela</h2><ul><li><a href="/x/KICZ_A0099_26_SVZM.pdf">KICZ NOTAM A0099/26 Security - Advisory in the Maiquetia FIR (SVZM)</a></li></ul>';
	const body = raw.body.replace('<h2 id="restrictYE">', `${add}<h2 id="restrictYE">`);
	const out = faaProhibitions.normalise([{ ...raw, body }]);
	const p = out.find((o) => o.series === "faa:page")?.value as FaaPage;
	expect(p.venezuelaSection).toBe(true);
	expect(p.venezuelaMentions[0]?.section).toBe("Venezuela");
	expect((out.find((o) => o.series === "faa:venezuela")?.value as FaaSection | undefined)?.venezuela).toBe(
		true,
	);
});

test("a changed layout fails loudly", () => {
	expect(() => parseFaaPage("<html>Access Denied</html>")).toThrow("Last updated");
	expect(() => parseFaaPage("<h2>x</h2> Last updated: Monday, September 14, 2026")).toThrow("acronyms");
});
