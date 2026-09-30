import { expect, test } from "bun:test";
import { join } from "node:path";
import { hasFixture, loadFixture } from "../../core/fixtures.ts";
import type { FetchContext, RawResponse } from "../../core/types.ts";
import { MissingKeyError } from "../../core/types.ts";
import { apiQuery, RW_API, RW_DISASTERS, RW_UPDATES, reliefwebVe } from "./index.ts";

const recorded = join(import.meta.dir, "fixtures", "2026-09-25");

test.skipIf(!hasFixture(recorded))(
	"recorded feeds: 20 reports and 20 disasters, headlines and links only",
	() => {
		const obs = reliefwebVe.normalise(loadFixture(recorded));
		const reports = obs.filter((o) => o.value.kind === "report");
		const disasters = obs.filter((o) => o.value.kind === "disaster");
		expect(reports.length).toBe(20);
		expect(disasters.length).toBe(20);
		const quake = disasters.find((o) => o.value.glide === "EQ-2026-000093-VEN");
		expect(quake?.value.title).toBe("Venezuela: Earthquakes - Jun 2026");
		expect(quake?.observedAt).toBe(Date.UTC(2026, 5, 24));
		expect(reports[0]?.value.orgs).toEqual(["UN Office for the Coordination of Humanitarian Affairs"]);
		for (const o of obs) {
			expect(o.sourceUrl.startsWith("https://reliefweb.int/")).toBe(true);
			expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
			// Only headline fields are kept, never the report body.
			expect(Object.keys(o.value).sort()).toEqual(["glide", "kind", "orgs", "title", "url"]);
		}
	},
);

const feed = (items: string) =>
	`<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${items}</channel></rss>`;
const item = (title: string, link: string, date: string, extra = "") =>
	`<item><title>${title}</title><link>${link}</link><pubDate>${date}</pubDate>${extra}</item>`;
const raw = (url: string, body: string): RawResponse => ({
	url,
	status: 200,
	contentType: "application/rss+xml",
	body,
	fetchedAt: Date.UTC(2026, 8, 25, 12),
});

test("synthetic: organisations, GLIDE, and items with a foreign link, no date or a far-future date are skipped", () => {
	const obs = reliefwebVe.normalise([
		raw(
			RW_UPDATES,
			feed(
				item(
					"Informe A &amp; B",
					"https://reliefweb.int/report/x/a",
					"Thu, 24 Sep 2026 18:03:06 +0000",
					"<author>Org Uno</author><author>Org Dos</author>",
				) +
					item("Fuera", "https://example.org/a", "Thu, 24 Sep 2026 18:03:06 +0000") +
					item("Sin fecha", "https://reliefweb.int/report/x/b", "") +
					item("Futuro", "https://reliefweb.int/report/x/c", "Thu, 01 Oct 2026 00:00:00 +0000"),
			),
		),
		raw(
			RW_DISASTERS,
			feed(
				item(
					"Venezuela: Floods - Jun 2025",
					"https://reliefweb.int/disaster/fl-2025-000090-ven",
					"Sat, 07 Jun 2025 00:00:00 +0000",
					"<category>Venezuela (Bolivarian Republic of)</category><category>FL-2025-000090-VEN</category>",
				),
			),
		),
	]);
	expect(obs.map((o) => o.value.title)).toEqual(["Informe A & B", "Venezuela: Floods - Jun 2025"]);
	expect(obs[0]?.value.orgs).toEqual(["Org Uno", "Org Dos"]);
	expect(obs[1]?.value.glide).toBe("FL-2025-000090-VEN");
});

test("a body that is not an RSS feed fails the run", () => {
	expect(() => reliefwebVe.normalise([raw(RW_UPDATES, "<html><body>busy</body></html>")])).toThrow("channel");
});

// Since 2026-09-29: reliefweb.int answers 444 ("not available for scraping"), so Vigía reads the API with an
// approved appname. A synthetic answer in the API's documented shape (apidoc.reliefweb.int/result-structure).
const api = (kind: "reports" | "disasters", data: unknown[]): RawResponse => ({
	url: apiQuery(kind),
	status: 200,
	contentType: "application/json",
	body: JSON.stringify({ time: 5, href: "x", totalCount: data.length, count: data.length, data }),
	fetchedAt: Date.UTC(2026, 8, 29, 12),
});

test("API: reports and disasters give the same values the RSS gave; bad rows skipped", () => {
	const obs = reliefwebVe.normalise([
		api("reports", [
			{
				id: 1,
				fields: {
					title: "Informe  de situación",
					url: "https://reliefweb.int/node/1",
					url_alias: "https://reliefweb.int/report/venezuela/informe-de-situacion",
					source: [{ name: "Organización Uno" }, { name: "Organización Dos" }],
					date: { created: "2026-09-28T14:00:00+00:00" },
				},
			},
			{
				id: 2,
				fields: {
					title: "Fuera",
					url: "https://example.org/x",
					date: { created: "2026-09-28T14:00:00+00:00" },
				},
			},
			{ id: 3, fields: { title: "Sin fecha", url: "https://reliefweb.int/node/3" } },
			{ id: 4, fields: { title: 7 } },
		]),
		api("disasters", [
			{
				id: 9,
				fields: {
					name: "Venezuela: Floods - Jun 2025",
					url: "https://reliefweb.int/taxonomy/term/9",
					url_alias: "https://reliefweb.int/disaster/fl-2025-000090-ven",
					glide: "FL-2025-000090-VEN",
					date: { event: "2025-06-07T00:00:00+00:00", created: "2025-06-09T10:00:00+00:00" },
				},
			},
		]),
	]);
	expect(obs.map((o) => o.value.title)).toEqual(["Informe de situación", "Venezuela: Floods - Jun 2025"]);
	expect(obs[0]?.value).toEqual({
		kind: "report",
		title: "Informe de situación",
		url: "https://reliefweb.int/report/venezuela/informe-de-situacion",
		orgs: ["Organización Uno", "Organización Dos"],
		glide: null,
	});
	expect(obs[0]?.observedAt).toBe(Date.UTC(2026, 8, 28, 14));
	expect(obs[1]?.value.glide).toBe("FL-2025-000090-VEN");
	// A disaster is dated by the event, as the RSS did.
	expect(obs[1]?.observedAt).toBe(Date.UTC(2025, 5, 7));
	expect(() => reliefwebVe.normalise([{ ...api("reports", []), body: '{"error":{}}' }])).toThrow("data");
	expect(() => reliefwebVe.normalise([{ ...api("reports", []), body: "<html>444</html>" }])).toThrow("JSON");
});

test("API: locked without an appname; the appname is sent but never stored in the recorded URL", async () => {
	const asked: string[] = [];
	const ctx = (key: string | null) =>
		({
			http: {
				request: async (url: string) => {
					asked.push(url);
					return { ...api(url.includes("/reports") ? "reports" : "disasters", []), url };
				},
			},
			key: () => key,
			now: Date.now,
			signal: new AbortController().signal,
		}) as unknown as FetchContext;
	await expect(reliefwebVe.fetch(ctx(null))).rejects.toBeInstanceOf(MissingKeyError);
	expect(asked).toEqual([]);
	const raws = await reliefwebVe.fetch(ctx("yo-vigia-x7k2"));
	expect(asked.every((u) => u.startsWith(RW_API) && u.includes("appname=yo-vigia-x7k2"))).toBe(true);
	expect(raws.map((r) => r.url)).toEqual([apiQuery("reports"), apiQuery("disasters")]);
	expect(raws.some((r) => r.url.includes("appname"))).toBe(false);
	expect(apiQuery("reports")).toContain("filter%5Bfield%5D=primary_country.iso3");
});
