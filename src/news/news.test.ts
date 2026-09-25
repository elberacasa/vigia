import { describe, expect, test } from "bun:test";
import { cluster, signature, similarity } from "./cluster.ts";
import { stripHtml } from "./text.ts";
import { topics } from "./topics.ts";

describe("topics", () => {
	test("electricity, the flagship", () => {
		expect(topics("Apagón deja sin luz a Maracaibo")).toContain("electricidad");
		expect(topics("Corpoelec anuncia racionamiento eléctrico en Lara")).toContain("electricidad");
		expect(topics("Vecinos de Cabimas reportan bajones de voltaje")).toContain("electricidad");
		expect(topics("La luz de la esperanza")).not.toContain("electricidad");
	});
	test("several topics at once", () => {
		expect(topics("Protestan en Maturín por fallas eléctricas y falta de agua potable")).toEqual(
			expect.arrayContaining(["protesta", "electricidad", "agua"]),
		);
	});
	test("no false friends", () => {
		expect(topics("Marchas y contramarchas del mercado")).toContain("protesta"); // known limitation, documented
		expect(topics("El presidente del club")).toContain("politica"); // known limitation, documented
		expect(topics("Receta de arepas")).toEqual([]);
	});
	test("quakes and rain", () => {
		expect(topics("Funvisis registra sismo de magnitud 3,8 en Sucre")).toContain("sismo");
		expect(topics("Desbordamiento del río deja 40 familias afectadas")).toContain("lluvias");
	});
});

describe("clustering", () => {
	const h = 3_600_000;
	const items = [
		{ id: "a", outlet: "pitazo", at: 0, title: "Apagón deja sin luz a Maracaibo y San Francisco" },
		{ id: "b", outlet: "talcual", at: 1 * h, title: "Maracaibo y San Francisco sin luz tras apagón" },
		{
			id: "c",
			outlet: "cronica",
			at: 2 * h,
			title: "Reportan apagón en Maracaibo y San Francisco este martes",
		},
		{ id: "d", outlet: "pitazo", at: 2 * h, title: "BCV fija el dólar oficial en 855 bolívares" },
		{ id: "e", outlet: "bbc", at: 60 * h, title: "Apagón deja sin luz a Maracaibo y San Francisco" },
	];
	test("same story across outlets joins; different stories and far-apart repeats stay apart", () => {
		const groups = cluster(items);
		const withA = groups.find((g) => g.includes("a"));
		expect(withA?.sort()).toEqual(["a", "b", "c"]);
		expect(groups.find((g) => g.includes("d"))).toEqual(["d"]);
		expect(groups.find((g) => g.includes("e"))).toEqual(["e"]);
	});
	test("deterministic regardless of input order", () => {
		const a = cluster(items).map((g) => [...g].sort().join());
		const b = cluster([...items].reverse()).map((g) => [...g].sort().join());
		expect(new Set(a)).toEqual(new Set(b));
	});
	test("signature ignores stopwords and plural endings", () => {
		expect([...signature("Los apagones de Maracaibo")]).toEqual(["apagon", "maracaibo"]);
		expect(similarity(signature("apagones en Zulia"), signature("apagón en Zulia")).jaccard).toBe(1);
	});
});

test("stripHtml", () => {
	expect(stripHtml("<p>Sin luz en <b>Zulia</b> &amp; Falc&#243;n</p>")).toBe("Sin luz en Zulia & Falcón");
	// A bare "<" is text, not the start of a tag (review 2, L8: it cut the rest of the summary).
	expect(stripHtml("Inflación de enero < 3%, según OVF")).toBe("Inflación de enero < 3%, según OVF");
	expect(stripHtml("a <3 b <!-- c --> d")).toBe("a <3 b d");
});

test("wire datelines are not locations", () => {
	const { stripDateline } = require("./text.ts") as typeof import("./text.ts");
	expect(stripDateline("CARACAS.- La presidenta encargada anunció")).toBe("La presidenta encargada anunció");
	expect(stripDateline("Caracas, 24 sep (EFE). El BCV publicó")).toBe("El BCV publicó");
	expect(stripDateline("MARACAIBO (Redacción) – Vecinos denuncian")).toBe("Vecinos denuncian");
	expect(stripDateline("Vecinos de Caracas denuncian")).toBe("Vecinos de Caracas denuncian");
});

test("daily programmes from one outlet do not merge; updates do", () => {
	const h = 3_600_000;
	const groups = cluster([
		{
			id: "1",
			outlet: "vtv",
			at: 0,
			title: "Titulares emisión meridiana - miércoles 23 de septiembre de 2026",
		},
		{
			id: "2",
			outlet: "vtv",
			at: 24 * h,
			title: "Titulares emisión meridiana - jueves 24 de septiembre de 2026",
		},
		{
			id: "3",
			outlet: "vtv",
			at: 25 * h,
			title: "Titulares emisión meridiana - jueves 24 de septiembre de 2026 (actualizado)",
		},
	]);
	expect(groups.find((g) => g.includes("1"))).toEqual(["1"]);
});

test("broadcast bulletins from different channels do not merge on dates alone", () => {
	const groups = cluster([
		{
			id: "1",
			outlet: "televen",
			at: 0,
			title: "Titulares emisión meridiana - jueves 24 de septiembre de 2026",
		},
		{
			id: "2",
			outlet: "vtv",
			at: 60_000,
			title: "Emisión meridiana: titulares del jueves 24 de septiembre de 2026",
		},
	]);
	expect(groups.length).toBe(2);
});

test("stripHtml is linear and never throws on hostile input", () => {
	const hostile = `${"<script>".repeat(20_000)}${"<a ".repeat(50_000)}&#99999999; &#x110000; &#55296;`;
	const t0 = performance.now();
	stripHtml(hostile);
	stripHtml(`<p>${"x".repeat(5_000_000)}`);
	expect(performance.now() - t0).toBeLessThan(200);
	expect(stripHtml("a&#99999999;b &#x41; <script>alert(1)</script>c")).toBe("a b A c");
	expect(stripHtml("<style>p{}</style><b>Mérida</b> &amp; Zulia &nbsp;")).toBe("Mérida & Zulia");
});

test("clusters do not drift: a chain A~B~C with nothing shared by A and C stays two stories", () => {
	const H = 3_600_000;
	const items = [
		{ id: "a", title: "alfa bravo charlie delta echo", at: 0, outlet: "x" },
		{ id: "b", title: "alfa bravo charlie delta foxtrot golf hotel india", at: H, outlet: "y" },
		{ id: "c", title: "foxtrot golf hotel india juliet", at: 2 * H, outlet: "z" },
	];
	const groups = cluster(items).map((g) => g.join(","));
	expect(groups.sort()).toEqual(["a,b", "c"]);
	// Single link (no seed check) would chain all three.
	expect(cluster(items, { seedOverlap: 0 }).length).toBe(1);
});
