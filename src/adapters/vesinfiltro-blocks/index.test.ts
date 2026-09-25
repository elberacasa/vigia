import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { parseCell, parseCsv, updateDate, vesinfiltroBlocks } from "./index.ts";

const raws = loadFixture(join(import.meta.dir, "fixtures", "2026-09-24"));
const [page, csv] = raws as [RawResponse, RawResponse];
const HEADER =
	"site,domain,abandoned,category,CANTV,Movistar,Digitel,Inter,Netuno,Airtek,G-Network,Thundernet";

test("normalises the recorded list: 202 entries, 166 active, dated by the page", () => {
	const obs = vesinfiltroBlocks.normalise(raws);
	expect(obs.length).toBe(202);
	expect(obs.filter((o) => o.value.active).length).toBe(166);
	expect(obs.filter((o) => o.value.category === "NEWS").length).toBe(91);
	const first = obs[0];
	expect(first?.series).toBe("site:tunnelbear.com");
	expect(first?.observedAt).toBe(Date.UTC(2026, 8, 21, 4));
	expect(first?.value.updated).toBe("2026-09-21");
	expect(first?.value.isps).toContainEqual({
		isp: "cantv",
		status: "blocked",
		methods: ["DNS", "HTTP/HTTPS"],
	});
	expect(first?.value.isps).toContainEqual({ isp: "thundernet", status: "no-data", methods: [] });
	expect(first?.value.isps.length).toBe(8);
	// "www.airtm.com" and "airtm.com" are separate entries; both share the OONI join key.
	const airtm = obs.filter((o) => o.value.key === "airtm.com").map((o) => o.value.domain);
	expect(airtm.sort()).toEqual(["airtm.com", "www.airtm.com"]);
	expect(obs.some((o) => o.series === "site:bit.ly/venezuela911")).toBe(true);
	for (const o of obs) {
		expect(o.source).toBe("vesinfiltro-blocks");
		expect(o.basis).toBe("report");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(o.sourceUrl).toBe("https://bloqueos.vesinfiltro.org/");
	}
});

test("cells: sets of methods split on '+', and the other states", () => {
	expect(parseCell("DNS+TCP IP")).toEqual({ status: "blocked", methods: ["DNS", "TCP IP"] });
	expect(parseCell(" ok ")).toEqual({ status: "ok", methods: [] });
	expect(parseCell("ND")).toEqual({ status: "no-data", methods: [] });
	expect(parseCell("unblocked")).toEqual({ status: "unblocked", methods: [] });
	expect(parseCell("SNI")).toBeNull();
	expect(parseCell("")).toBeNull();
});

test("CSV reader handles quotes, doubled quotes, CRLF and a BOM-free header", () => {
	expect(parseCsv('a,"b,c","d ""e"""\r\n1,2,3\n')).toEqual([
		["a", "b,c", 'd "e"'],
		["1", "2", "3"],
	]);
});

test("the update date comes from the page's <time> next to 'Actualización'", () => {
	expect(updateDate(page.body)).toBe("2026-09-21");
	expect(updateDate('<p>Actualización: <time datetime="2026-10-01">1 oct</time></p>')).toBe("2026-10-01");
	expect(updateDate("<p>sin fecha</p>")).toBeNull();
});

test("304 Not Modified stores nothing; bad rows are skipped; a broken file or page throws", () => {
	expect(vesinfiltroBlocks.normalise([page, { ...csv, status: 304, body: "" }])).toEqual([]);
	const body = `${HEADER}\nX,x.com,active,NEWS,DNS,ok,ok,ok,ok,ok,ok,ND\nBad,not a domain,active,NEWS,DNS,ok,ok,ok,ok,ok,ok,ok\nY,y.com,maybe,NEWS,DNS,ok,ok,ok,ok,ok,ok,ok\nZ,z.com,active,NEWS,SNI,ok,ok,ok,ok,ok,ok,ok\n`;
	const obs = vesinfiltroBlocks.normalise([page, { ...csv, body }]);
	expect(obs.map((o) => o.value.domain)).toEqual(["x.com", "z.com"]);
	// An unknown method drops that cell, not the site.
	expect(obs[1]?.value.isps.length).toBe(7);
	expect(() => vesinfiltroBlocks.normalise([page, { ...csv, body: "a,b\n1,2\n" }])).toThrow("columna");
	expect(() => vesinfiltroBlocks.normalise([page, { ...csv, body: `${HEADER}\n` }])).toThrow("vacía");
	expect(() => vesinfiltroBlocks.normalise([{ ...page, body: "<html></html>" }, csv])).toThrow("fecha");
	expect(() => vesinfiltroBlocks.normalise([page])).toThrow();
});
