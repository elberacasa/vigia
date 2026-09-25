import { expect, test } from "bun:test";
import { join } from "node:path";
import { hasFixture, loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { headline, monthStartMs, r4vFigures, r4vMonth, slug, tableRows } from "./index.ts";

const recorded = join(import.meta.dir, "fixtures", "2026-09-25");

test.skipIf(!hasFixture(recorded))(
	"recorded page: the regional headline and 31 countries, each with its own date",
	() => {
		const obs = r4vFigures.normalise(loadFixture(recorded));
		expect(obs.length).toBe(32);
		const total = obs.find((o) => o.series === "total-lac");
		expect(total?.value.people).toBe(6_978_009);
		expect(total?.value.month).toBe("2026-08");
		expect(total?.observedAt).toBe(Date.UTC(2026, 7, 1));
		const col = obs.find((o) => o.series === "country:colombia")?.value;
		expect(col).toMatchObject({
			people: 2_844_498,
			previous: 2_845_187,
			month: "2026-04",
			publishedMonth: "2026-05",
		});
		const peru = obs.find((o) => o.series === "country:peru")?.value;
		// The source's columns are swapped: Spanish in `source`, English in `fuente`.
		expect(peru?.publisherEs).toBe("Superintendencia Nacional de Migraciones (SNM)");
		expect(peru?.publisherEn).toBe("National Superintendence of Migration (SNM)");
		// Trailing comma in the source's country name is dropped.
		expect(obs.some((o) => o.value.countryEs?.endsWith(","))).toBe(false);
		for (const o of obs) {
			expect(o.source).toBe("r4v-figures");
			expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		}
	},
);

const row = (over: Record<string, unknown> = {}) => ({
	pais: "Tierra Firme",
	country: "Mainland",
	fuente: "Invented Office",
	source: "Oficina Inventada",
	fecha: "26-Apr",
	"Publicacion R4V": "26-May",
	poblacion: 1000,
	anterior: 900,
	...over,
});
const page = (rows: unknown[]) =>
	`<html><h6>Personas venezolanas refugiadas y migrantes en América Latina y el Caribe</h6><p><font size="6"><strong>1.234.567</strong></font></p><p>Última actualización de agosto de&nbsp;2026</p><script type="application/json" data-drupal-selector="drupal-settings-json">${JSON.stringify(
		{
			tables: { "r4v-table": { data: rows } },
		},
	)}</script></html>`;
const synthetic = (body: string): RawResponse[] => [
	{
		url: "https://www.r4v.info/es/refugiadosymigrantes",
		status: 200,
		contentType: "text/html",
		body,
		fetchedAt: Date.UTC(2026, 8, 25),
	},
];

test("synthetic page: headline, rows, and a malformed row skipped", () => {
	const obs = r4vFigures.normalise(
		synthetic(page([row(), row({ poblacion: "mucho" }), row({ fecha: "abril" })])),
	);
	expect(obs.map((o) => o.series)).toEqual(["total-lac", "country:mainland"]);
	expect(obs[0]?.value.people).toBe(1_234_567);
	expect(obs[1]?.value).toMatchObject({ people: 1000, previous: 900, publisherEs: "Oficina Inventada" });
});

test("a page without the table fails the run; a figure dated in the future is dropped", () => {
	expect(() => r4vFigures.normalise(synthetic("<html></html>"))).toThrow("drupal-settings-json");
	expect(r4vFigures.normalise(synthetic(page([row({ fecha: "27-Jan" })]))).map((o) => o.series)).toEqual([
		"total-lac",
	]);
});

test("helpers: R4V's 'YY-Mon' months, headline text, slugs", () => {
	expect(r4vMonth("26-Apr")).toBe("2026-04");
	expect(r4vMonth("24-Dec")).toBe("2024-12");
	expect(r4vMonth("26-Abr")).toBeNull();
	expect(monthStartMs("2026-04")).toBe(Date.UTC(2026, 3, 1));
	expect(headline(page([]))).toEqual({ people: 1_234_567, month: "2026-08" });
	expect(headline("<p>6.978.009</p>")).toBeNull();
	expect(slug("Trinidad & Tobago")).toBe("trinidad-tobago");
	expect(slug("Curaçao")).toBe("curacao");
	expect(tableRows(page([row()])).length).toBe(1);
});
