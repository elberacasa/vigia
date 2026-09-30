import { expect, test } from "bun:test";
import type { NewsItem, OutletSpec } from "../adapters/rss/factory.ts";
import { Store } from "../core/store.ts";
import type { Observation } from "../core/types.ts";
import { claimSignature, computeFactChecks, factCheckPanel, verdictOf } from "./factcheck.ts";

test("verdicts come from the checker's own words, never from a question", () => {
	expect(verdictOf("Es falso que el ministerio anunció un bono de 500 dólares", "")).toBe("false");
	expect(verdictOf("Engañoso: video de un operativo mezcla imágenes de otro año", "")).toBe("misleading");
	expect(verdictOf("Falta contexto: la foto del puente es de 2019", "")).toBe("context");
	expect(verdictOf("Es parcialmente falso que el embalse esté vacío", "")).toBe("partly");
	expect(verdictOf("¿Es falso que habrá racionamiento en Zulia?", "")).toBeNull();
	expect(
		verdictOf("Lo que sabemos del racionamiento", "Sin evidencia de que el anuncio sea oficial. Más texto."),
	).toBe("unproven");
	expect(
		verdictOf("Cómo funciona una red de cuentas", "Una investigación. No es falso nada aquí."),
	).toBeNull();
});

test("the claim loses the checking words before it is compared", () => {
	const sig = claimSignature("Es falso que video en redes sociales muestre apagón en Maracaibo");
	expect([...sig].sort()).toEqual(["apagon", "maracaibo", "muestre"]);
});

// An invented checker and outlets.
const checker: OutletSpec = {
	id: "verifica-ejemplo",
	name: "Verifica Ejemplo",
	url: "https://verifica.example/feed/",
	kind: "rss",
	region: "national",
	stance: "independent",
	homepage: "https://verifica.example/",
	genre: "fact-check",
};
const mirror: OutletSpec = {
	...checker,
	id: "gn-verifica-ejemplo",
	url: "https://news.google.com/rss/search?q=site:verifica.example",
	via: { kind: "google-news", host: "verifica.example" },
	publisher: "verifica-ejemplo",
};
const diario: OutletSpec = {
	...checker,
	id: "diario-ejemplo",
	name: "Diario Ejemplo",
	genre: "news",
	homepage: "https://diario.example/",
};

const NOW = Date.parse("2026-09-28T20:00:00Z");
const H = 3_600_000;
const item = (outlet: string, title: string, at: number, summary = ""): Observation<NewsItem> => ({
	source: outlet,
	series: `item:${Bun.hash(`${outlet}${title}`).toString(36)}`,
	sourceUrl: `https://${outlet}.example/${encodeURIComponent(title)}`,
	fetchedAt: at,
	observedAt: at,
	licence: "headline-link",
	value: {
		outlet,
		title,
		link: `https://${outlet}.example/${encodeURIComponent(title)}`,
		summary,
		image: null,
		dateMissing: false,
		video: false,
	},
	confidence: 1,
	basis: "report",
});

test("desmentidos: newest first, one per headline, a related story only when rare words are shared", () => {
	const store = new Store(":memory:");
	const filler = Array.from({ length: 400 }, (_, i) =>
		item(
			"diario-ejemplo",
			`Delcy Rodríguez habla sobre economía nacional número ${i}`,
			NOW - 30 * H - i * 60_000,
		),
	);
	store.insert([
		...filler,
		item("diario-ejemplo", "Corpoelec anuncia racionamiento eléctrico en Zulia", NOW - 20 * H),
		item("diario-ejemplo", "Delcy Rodríguez habla sobre economía y petróleo en la ONU", NOW - 10 * H),
		item(
			"verifica-ejemplo",
			"Es falso que Corpoelec anunció racionamiento eléctrico de 12 horas en Zulia",
			NOW - 2 * H,
		),
		item(
			"gn-verifica-ejemplo",
			"Es falso que Corpoelec anunció racionamiento eléctrico de 12 horas en Zulia",
			NOW - 2 * H,
		),
		item(
			"verifica-ejemplo",
			"Falta contexto: video de Delcy Rodríguez sobre economía es de 2023",
			NOW - 1 * H,
		),
		item("verifica-ejemplo", "Una nota vieja", NOW - 40 * 24 * H),
	]);
	const view = computeFactChecks(store, NOW, [checker, mirror, diario]);
	expect(
		view.items.map((f) => [f.title.slice(0, 20), f.verdict, f.related?.title.slice(0, 20) ?? null]),
	).toEqual([
		["Falta contexto: vide", "context", null],
		["Es falso que Corpoel", "false", "Corpoelec anuncia ra"],
	]);
	expect(view.items[1]?.related).toMatchObject({ outlet: "diario-ejemplo", outletName: "Diario Ejemplo" });
	expect(view.items[1]?.related?.sharedWords).toEqual(["corpoelec", "electrico", "racionamiento", "zulia"]);
	expect(view.byChecker).toEqual([{ id: "verifica-ejemplo", name: "Verifica Ejemplo", items: 2 }]);
	expect(view.byVerdict).toEqual({ context: 1, false: 1 });
	expect(view.related).toBe(1);
});

test("panel: on demand, fed by every fact-check outlet", () => {
	expect(factCheckPanel.onDemand).toBe(true);
	expect(factCheckPanel.sources).toContain("cazadores-fake-news");
	expect(factCheckPanel.sources).toContain("cotejo");
	expect(factCheckPanel.sources).not.toContain("el-pitazo");
	expect(computeFactChecks(new Store(":memory:"), NOW).items).toEqual([]);
});

test("site pages in a checker's feed are not fact-checks: archives, paging and author pages are dropped", async () => {
	const { notAnArticle } = await import("./factcheck.ts");
	expect(notAnArticle("Desmentidos en redes archivos - Página 217 de 217")).toBe(true);
	expect(notAnArticle("TikTok archivos")).toBe(true);
	expect(notAnArticle("Graciela Portillo Acosta")).toBe(true);
	expect(notAnArticle("Que desbloqueen a todos")).toBe(false);
	expect(notAnArticle("Es falso que Mario Silva dijo que preferiría a María Corina Machado")).toBe(false);
});
