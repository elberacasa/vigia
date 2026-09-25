import { expect, test } from "bun:test";
import { join } from "node:path";
import { hasFixture, loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { RW_DISASTERS, RW_UPDATES, reliefwebVe } from "./index.ts";

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
