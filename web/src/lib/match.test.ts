import { expect, test } from "bun:test";
import { prepare, rank, score } from "./match.ts";

const index = [
	prepare({ label: "Capacho Nuevo", keywords: ["ciudad", "Táchira"] }),
	prepare({ label: "Satélite", keywords: ["capa", "mapa", "layer", "goes"] }),
	prepare({ label: "Satélite", keywords: ["panel", "nubes"] }),
	prepare({ label: "Zulia", keywords: ["estado", "Maracaibo"] }),
	prepare({ label: "Internet por estado", keywords: ["capa", "mapa", "ioda"] }),
];

test("a phrase still matches as before", () => {
	expect(rank(index, "sate", 5).map((i) => i.folded.words[0])).toEqual(["capa", "panel"]);
	expect(score({ label: "dolar bcv", words: [] }, "Dólar BCV")).toBe(0);
});

test("several words match when each matches somewhere (label or keyword), weakest word + 1", () => {
	// "capa satélite" used to find nothing: no label or keyword holds the whole phrase.
	const hits = rank(index, "capa satélite", 5);
	expect(hits.map((i) => [i.label, i.folded.words[0]])).toEqual([["Satélite", "capa"]]);
	expect(score(index[1]?.folded ?? { label: "", words: [] }, "capa satélite")).toBe(4);
	expect(rank(index, "mapa internet", 5).map((i) => i.label)).toEqual(["Internet por estado"]);
});

test("a multi-word query where one word matches nothing matches nothing", () => {
	expect(rank(index, "capa zzz", 5)).toEqual([]);
	expect(rank(index, "zulia zzz", 5)).toEqual([]);
});

test("a phrase match outranks a word-by-word match", () => {
	const items = [
		prepare({ label: "Nubes y capa", keywords: ["satelite"] }),
		prepare({ label: "Capa satelite" }),
	];
	expect(rank(items, "capa satelite", 2).map((i) => i.label)).toEqual(["Capa satelite", "Nubes y capa"]);
});
