import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { easaCzib, linksFromRss, parseOffsetDate, unescapeHtml } from "./index.ts";

const raws = loadFixture(join(import.meta.dir, "fixtures", "2026-09-25"));
const [json, rss] = raws as [RawResponse, RawResponse];
const obs = easaCzib.normalise(raws);

test("33 bulletins, 15 active; Venezuela's 2026-01-R2 is withdrawn with its dates and link", () => {
	expect(obs.length).toBe(33);
	expect(obs.filter((o) => o.value.status === "active").length).toBe(15);
	const ve = obs.filter((o) => o.value.venezuela);
	expect(ve.length).toBe(1);
	expect(ve[0]?.value).toMatchObject({
		nid: "142977",
		number: "2026-01-R2",
		name: "Venezuela and neighbouring airspace",
		status: "withdrawn",
		issuedDate: "2026-01-03",
		validUntil: "2026-02-16",
		countries: [],
	});
	expect(new Date(ve[0]?.value.issuedAt ?? 0).toISOString()).toBe("2026-01-02T22:00:00.000Z");
	expect(ve[0]?.sourceUrl).toBe("https://www.easa.europa.eu/domains/air-operations/czibs/2026-01-r2");
	for (const o of obs) {
		expect(o.source).toBe("easa-czib");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(o.basis).toBe("official");
	}
});

test("quirks: offset without colon, empty valid-until, HTML entities, multi-country", () => {
	expect(new Date(parseOffsetDate("2017-03-31T00:00:00+0300")).toISOString()).toBe(
		"2017-03-30T21:00:00.000Z",
	);
	expect(parseOffsetDate("31/10/2026")).toBeNaN();
	expect(unescapeHtml("Democratic People&#039;s Republic")).toBe("Democratic People's Republic");
	const nk = obs.find((o) => o.value.nid === "22434");
	expect(nk?.value.validUntil).toBeNull();
	expect(nk?.value.countries).toEqual(["Democratic People's Republic of Korea"]);
	expect(obs.find((o) => o.value.nid === "143899")?.value.countries.length).toBe(5);
});

test("without the RSS the bulletins still load, linking to the list page", () => {
	const only = easaCzib.normalise([json]);
	expect(only.length).toBe(33);
	expect(only[0]?.sourceUrl).toBe("https://www.easa.europa.eu/en/domains/air-operations/czibs");
	expect(only.every((o) => o.value.number === null)).toBe(true);
	expect(linksFromRss(rss.body).size).toBe(33);
});

test("a broken envelope fails the run; a bad entry is skipped", () => {
	expect(() => easaCzib.normalise([{ ...json, body: "<html>" }])).toThrow("not JSON");
	expect(() => easaCzib.normalise([{ ...json, body: '{"x":[]}' }])).toThrow("conflict_zones");
	const d = JSON.parse(json.body) as { conflict_zones: unknown[] };
	d.conflict_zones.push({ Nid: "x" });
	expect(easaCzib.normalise([{ ...json, body: JSON.stringify(d) }]).length).toBe(33);
	expect(() =>
		easaCzib.normalise([{ ...json, body: JSON.stringify({ conflict_zones: [{ Nid: "1" }] }) }]),
	).toThrow("no bulletin parsed");
});
