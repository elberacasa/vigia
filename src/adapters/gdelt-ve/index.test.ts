import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { FetchContext, HttpLike, RawResponse, RequestOptions } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import {
	batchTime,
	exportUrl,
	FIPS_VE,
	type GdeltArticle,
	type GdeltBatch,
	gdeltVe,
	likelyForeignHomonym,
	parseLastUpdate,
	readBatch,
} from "./index.ts";

// Two real batches of 2026-09-28 07:30 UTC (English and translated), GDELT open data.
const FIXTURE = loadFixture(join(import.meta.dir, "fixtures", "2026-09-28"));

describe("gdelt-ve: recorded batches", () => {
	const obs = gdeltVe.normalise(FIXTURE);
	const batch = (s: string) => obs.find((o) => o.series === `gdelt:batch:${s}`)?.value as GdeltBatch;
	const articles = obs.filter((o) => o.series.startsWith("gdelt:article:"));

	test("counts per batch: Venezuelan events kept, homonyms dropped, the rest of the world ignored", () => {
		expect(batch("en")).toMatchObject({ stream: "en", missing: false, events: 36, droppedHomonym: 0 });
		expect(batch("tr")).toMatchObject({ stream: "tr", missing: false, events: 11, droppedHomonym: 16 });
		expect(batch("en").rows).toBeGreaterThan(500);
		for (const b of [batch("en"), batch("tr")]) {
			const placed = Object.values(b.byState).reduce((n, x) => n + x, 0);
			expect(placed + b.national).toBe(b.events);
			expect(Object.values(b.byRoot).reduce((n, x) => n + x, 0)).toBe(b.events);
			for (const iso of Object.keys(b.byState)) expect(iso).toMatch(/^VE-[A-Z]$/);
		}
		for (const o of obs) {
			expect(o.source).toBe("gdelt-ve");
			expect(o.observedAt).toBe(Date.parse("2026-09-28T07:30:00Z"));
			expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
			expect(o.sourceUrl).toMatch(/^https?:\/\//);
		}
	});

	test("one record per source article, linked, with its codes and place, never an actor", () => {
		expect(articles.length).toBe(batch("en").articles + batch("tr").articles);
		for (const o of articles) {
			const a = o.value as GdeltArticle;
			expect(o.sourceUrl).toBe(a.url);
			expect(a.events).toBeGreaterThan(0);
			expect(Object.keys(a).sort()).toEqual(
				[
					"domain",
					"events",
					"goldsteinMin",
					"numArticles",
					"place",
					"placedBy",
					"quads",
					"roots",
					"state",
					"stream",
					"tone",
					"url",
				].sort(),
			);
			expect(o.confidence).toBe(0.5);
			if (a.placedBy === "point") expect(o.location?.state).toBe(a.state ?? "");
		}
	});
});

// A synthetic row in GDELT 2.0's 61-column layout: only the columns the adapter reads are filled.
function row(over: Record<number, string>): string {
	const cols = Array.from({ length: 61 }, () => "");
	cols[0] = "1";
	cols[28] = "14";
	cols[29] = "3";
	cols[30] = "-6.5";
	cols[33] = "4";
	cols[34] = "-3.21";
	cols[59] = "20260928073000";
	for (const [k, v] of Object.entries(over)) cols[Number(k)] = v;
	return cols.join("\t");
}
const caracas = {
	51: "4",
	52: "Caracas, Distrito Federal, Venezuela",
	53: "VE",
	54: "VE25",
	56: "10.5",
	57: "-66.9167",
};

describe("gdelt-ve: the rules (synthetic)", () => {
	const tsv = [
		row({ ...caracas, 60: "https://noticias.example.org/protesta-caracas" }),
		row({ ...caracas, 28: "19", 29: "4", 60: "https://noticias.example.org/protesta-caracas" }),
		row({
			51: "4",
			52: "Valencia, Carabobo, Venezuela",
			53: "VE",
			54: "VE07",
			56: "10.1621",
			57: "-68.0077",
			60: "https://diario.example.es/comunitat/valencia-pleno",
		}),
		row({
			51: "4",
			52: "Valencia, Carabobo, Venezuela",
			53: "VE",
			54: "VE07",
			56: "10.1621",
			57: "-68.0077",
			60: "https://diario.example.es/venezuela-valencia-apagon",
		}),
		row({
			51: "4",
			52: "Valencia, Carabobo, Venezuela",
			53: "VE",
			54: "VE07",
			56: "10.1621",
			57: "-68.0077",
			60: "https://regional.example.com.ve/valencia",
		}),
		row({
			51: "1",
			52: "Venezuela",
			53: "VE",
			54: "VE",
			56: "8",
			57: "-66",
			28: "04",
			29: "1",
			60: "https://agencia.example.com/ve",
		}),
		row({
			51: "4",
			52: "Somewhere, Venezuela",
			53: "VE",
			54: "VE00",
			56: "2.8",
			57: "-60.7",
			60: "https://x.example.com/a",
		}),
		row({
			51: "4",
			52: "Punto Fijo, Falcón, Venezuela",
			53: "VE",
			54: "VE11",
			56: "11.8",
			57: "-70.3",
			60: "https://y.example.com/b",
		}),
		row({
			51: "4",
			52: "Bogotá, Colombia",
			53: "CO",
			54: "CO34",
			56: "4.6",
			57: "-74.08",
			60: "https://z.example.com/c",
		}),
		"too\tshort",
		"",
	].join("\n");
	const { batch, articles } = readBatch(tsv, "tr");

	test("counts: kept, dropped homonyms, placed by point, by ADM1, national", () => {
		expect(batch).toEqual({
			stream: "tr",
			missing: false,
			rows: 9,
			events: 7,
			droppedHomonym: 1,
			national: 2,
			byState: { "VE-A": 2, "VE-G": 2, "VE-I": 1 },
			byRoot: { "14": 5, "19": 1, "04": 1 },
			byQuad: { "3": 5, "4": 1, "1": 1 },
			articles: 6,
		});
	});

	test("an article's events merge; placement says how", () => {
		const protest = articles.find((a) => a.url.endsWith("protesta-caracas"));
		expect(protest).toMatchObject({
			events: 2,
			roots: ["14", "19"],
			quads: [3, 4],
			goldsteinMin: -6.5,
			state: "VE-A",
			placedBy: "point",
			tone: -3.21,
		});
		expect(protest?.point).toEqual({ lat: 10.5, lon: -66.9167, state: "VE-A" });
		expect(articles.find((a) => a.url.endsWith("/ve"))).toMatchObject({ state: null, placedBy: "country" });
		expect(articles.find((a) => a.url.endsWith("/a"))).toMatchObject({ state: null, placedBy: "none" });
		// Offshore point, ADM1 code says Falcón.
		expect(articles.find((a) => a.url.endsWith("/b"))).toMatchObject({ state: "VE-I", placedBy: "adm1" });
	});

	test("foreign homonyms: dropped unless the source is Venezuelan or the link names Venezuela", () => {
		expect(
			likelyForeignHomonym("Valencia, Carabobo, Venezuela", "https://diario.example.es/comunitat/valencia"),
		).toBe(true);
		expect(
			likelyForeignHomonym("Valencia, Carabobo, Venezuela", "https://diario.example.es/venezuela-valencia"),
		).toBe(false);
		expect(likelyForeignHomonym("Valencia, Carabobo, Venezuela", "https://regional.example.com.ve/x")).toBe(
			false,
		);
		expect(
			likelyForeignHomonym("Mérida, Mérida, Venezuela", "https://diario.example.mx/merida-yucatan"),
		).toBe(true);
		expect(likelyForeignHomonym("Maracaibo, Zulia, Venezuela", "https://diario.example.es/x")).toBe(false);
	});

	test("file names, the lastupdate listing, the ADM1 table", () => {
		expect(batchTime("https://data.gdeltproject.org/gdeltv2/20260929014500.export.CSV.zip")).toBe(
			Date.parse("2026-09-29T01:45:00Z"),
		);
		expect(batchTime("https://data.gdeltproject.org/gdeltv2/20260929014500.translation.export.CSV.zip")).toBe(
			Date.parse("2026-09-29T01:45:00Z"),
		);
		expect(batchTime("https://data.gdeltproject.org/gdeltv2/20260929014500.gkg.csv.zip")).toBeNull();
		expect(exportUrl("tr", Date.parse("2026-09-29T01:45:00Z"))).toBe(
			"https://data.gdeltproject.org/gdeltv2/20260929014500.translation.export.CSV.zip",
		);
		const listing =
			"69963 b846 http://data.gdeltproject.org/gdeltv2/20260929014500.export.CSV.zip\n86903 cc02 http://data.gdeltproject.org/gdeltv2/20260929014500.mentions.CSV.zip\n";
		expect(parseLastUpdate(listing)).toEqual({
			url: "https://data.gdeltproject.org/gdeltv2/20260929014500.export.CSV.zip",
			at: Date.parse("2026-09-29T01:45:00Z"),
		});
		expect(parseLastUpdate("<html>")).toBeNull();
		expect(new Set(Object.values(FIPS_VE)).size).toBe(25);
	});

	test("a listed file that stays 404 is recorded as missing; a corrupt zip fails loudly", () => {
		const url = "https://data.gdeltproject.org/gdeltv2/20260928070000.translation.export.CSV.zip";
		const missing = gdeltVe.normalise([
			{ url, status: 404, contentType: "", body: "", fetchedAt: Date.parse("2026-09-28T10:00:00Z") },
		]);
		expect(missing).toHaveLength(1);
		expect(missing[0]?.value).toMatchObject({ missing: true, events: 0 });
		expect(() =>
			gdeltVe.normalise([
				{ url, status: 200, contentType: "application/zip", body: "bm90IGEgemlw", fetchedAt: 1 },
			]),
		).toThrow(SchemaError);
	});
});

describe("gdelt-ve: fetch", () => {
	test("newest batch per stream, backfills what the store lacks (8 at most), retries a young 404", async () => {
		const now = Date.parse("2026-09-29T02:05:00Z");
		const newest = "20260929014500";
		const requested: { url: string; options?: RequestOptions }[] = [];
		const http: HttpLike = {
			async request(url, options) {
				requested.push({ url, ...(options ? { options } : {}) });
				const base: RawResponse = { url, status: 200, contentType: "text/plain", body: "", fetchedAt: now };
				if (url.endsWith("lastupdate.txt"))
					return {
						...base,
						body: `1 a http://data.gdeltproject.org/gdeltv2/${newest}.export.CSV.zip\n`,
						etag: '"e1"',
					};
				if (url.endsWith("lastupdate-translation.txt"))
					return {
						...base,
						body: `1 a http://data.gdeltproject.org/gdeltv2/${newest}.translation.export.CSV.zip\n`,
					};
				if (url.includes(".translation.") && url.includes("20260929014500")) return { ...base, status: 404 };
				return { ...base, contentType: "application/zip", body: "UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==" };
			},
		};
		const seenEn = new Set([Date.parse("2026-09-29T01:30:00Z")]);
		const ctx: FetchContext = {
			http,
			key: () => undefined,
			now: () => now,
			signal: new AbortController().signal,
			seen: (series, at) => series === "gdelt:batch:en" && seenEn.has(at),
		};
		const raws = await gdeltVe.fetch(ctx);
		const en = raws.filter((r) => !r.url.includes("translation"));
		const tr = raws.filter((r) => r.url.includes("translation"));
		expect(en).toHaveLength(8);
		expect(en.some((r) => r.url.includes("20260929013000"))).toBe(false);
		// The newest translated file is 20 minutes old and 404: not recorded yet, asked for again next run.
		expect(tr).toHaveLength(7);
		expect(tr.every((r) => r.status === 200)).toBe(true);
		expect(requested.filter((r) => r.url.endsWith(".zip")).every((r) => r.options?.binary === true)).toBe(
			true,
		);
		// The next run sends the listing's ETag.
		await gdeltVe.fetch(ctx);
		const again = requested.filter((r) => r.url.endsWith("lastupdate.txt"));
		expect(again[1]?.options?.headers?.["if-none-match"]).toBe('"e1"');
	});
});
