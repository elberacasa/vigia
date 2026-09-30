import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { FetchContext, RawResponse } from "../../core/types.ts";
import { HttpError } from "../../core/types.ts";
import {
	CONFIG_URL,
	PAGE_URL,
	parseCell,
	parseCsv,
	pointerFromConfig,
	pointerFromPage,
	updateDate,
	vesinfiltroBlocks,
} from "./index.ts";

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

// Since 2026-09-29 the CSV is a dated file named by the site's data-config.js (the old fixed path answers 404).
const moved = loadFixture(join(import.meta.dir, "fixtures", "2026-09-29"));
const [config, datedCsv] = moved as [RawResponse, RawResponse];

test("the moved list: data-config.js names the dated CSV and its date; 205 entries, 7 ISPs (G-Network gone)", () => {
	expect(pointerFromConfig(config.body)).toEqual({
		csvUrl: "https://bloqueos.vesinfiltro.org/static/blocking-data-2026-09-29.csv",
		updated: "2026-09-29",
	});
	const obs = vesinfiltroBlocks.normalise(moved);
	expect(obs.length).toBe(205);
	expect(obs.filter((o) => o.value.active).length).toBe(167);
	expect(obs.filter((o) => o.value.category === "NEWS").length).toBe(92);
	const first = obs[0];
	expect(first?.series).toBe("site:6topoder.com");
	expect(first?.observedAt).toBe(Date.UTC(2026, 8, 29, 4));
	expect(first?.value.isps.length).toBe(7);
	expect(first?.value.isps.some((c) => c.isp === "g-network")).toBe(false);
	for (const o of obs) {
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(o.sourceUrl).toBe(PAGE_URL);
	}
});

test("pointer: a config that is not the expected literal, or points outside static/, is refused", () => {
	expect(pointerFromConfig("window.VSF_DATA = {file: 'x'};")).toBeNull();
	expect(
		pointerFromConfig('window.VSF_DATA = {"file": "https://evil.example/x.csv", "updated": "2026-09-29"};'),
	).toBeNull();
	expect(pointerFromConfig('window.VSF_DATA = {"file": "static/a.csv", "updated": "ayer"};')).toBeNull();
	expect(pointerFromConfig("")).toBeNull();
	// The page's own download link and date say the same thing.
	expect(
		pointerFromPage(
			'<time datetime="2026-09-29">x</time><a href="static/blocking-data-2026-09-29.csv" download id="csv-download">',
		),
	).toEqual({
		csvUrl: "https://bloqueos.vesinfiltro.org/static/blocking-data-2026-09-29.csv",
		updated: "2026-09-29",
	});
	expect(pointerFromPage(page.body)?.csvUrl).toBe(
		"https://bloqueos.vesinfiltro.org/static/blocking-data.csv",
	);
});

function replay(answers: Record<string, RawResponse | number>): { ctx: FetchContext; asked: string[] } {
	const asked: string[] = [];
	const ctx = {
		http: {
			request: async (url: string, options?: { headers?: Record<string, string> }) => {
				asked.push(url + (options?.headers?.["if-none-match"] ? " (if-none-match)" : ""));
				const a = answers[url];
				if (a === undefined || typeof a === "number") throw new HttpError(`HTTP ${a ?? 404}`, a ?? 404, url);
				return a;
			},
		},
		key: () => null,
		now: Date.now,
		signal: new AbortController().signal,
	} as unknown as FetchContext;
	return { ctx, asked };
}

test("fetch follows data-config.js, falls back to the page, and asks If-None-Match only for the same file", async () => {
	const csvUrl = "https://bloqueos.vesinfiltro.org/static/blocking-data-2026-09-29.csv";
	const run1 = replay({ [CONFIG_URL]: config, [csvUrl]: { ...datedCsv, etag: '"e1"' } });
	expect((await vesinfiltroBlocks.fetch(run1.ctx)).length).toBe(2);
	expect(run1.asked).toEqual([CONFIG_URL, csvUrl]);
	const run2 = replay({ [CONFIG_URL]: config, [csvUrl]: { ...datedCsv, status: 304, body: "" } });
	const raws = await vesinfiltroBlocks.fetch(run2.ctx);
	expect(run2.asked).toEqual([CONFIG_URL, `${csvUrl} (if-none-match)`]);
	expect(vesinfiltroBlocks.normalise(raws)).toEqual([]);
	// No config (404): the page's link and date. A different file name: no If-None-Match.
	const pageNew = {
		...page,
		body: '<p>Actualización: <time datetime="2026-09-28">28 sep</time></p><a href="static/b-2026-09-28.csv" id="csv-download">',
	};
	const newCsv = "https://bloqueos.vesinfiltro.org/static/b-2026-09-28.csv";
	const run3 = replay({ [CONFIG_URL]: 404, [PAGE_URL]: pageNew, [newCsv]: datedCsv });
	const raws3 = await vesinfiltroBlocks.fetch(run3.ctx);
	expect(run3.asked).toEqual([CONFIG_URL, PAGE_URL, newCsv]);
	expect(vesinfiltroBlocks.normalise(raws3)[0]?.value.updated).toBe("2026-09-28");
	// Neither says where the list is: a clear error, the last good list stays.
	const run4 = replay({ [CONFIG_URL]: 404, [PAGE_URL]: { ...page, body: "<html></html>" } });
	await expect(vesinfiltroBlocks.fetch(run4.ctx)).rejects.toThrow("dónde está el CSV");
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
