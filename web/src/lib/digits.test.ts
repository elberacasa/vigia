import { expect, test } from "bun:test";
import { diffGlyphs } from "./digits.ts";

const changed = (a: string, b: string) =>
	diffGlyphs(a, b)
		.filter((g) => g.was !== null)
		.map((g) => `${g.was || "∅"}→${g.ch}`);

test("only the characters that changed roll; the comma stays", () => {
	expect(changed("853,50", "855,66")).toEqual(["3→5", "5→6", "0→6"]);
	expect(changed("853,50", "853,50")).toEqual([]);
});

test("aligned from the right when the figure grows", () => {
	expect(changed("99,50", "100,20")).toEqual(["∅→1", "9→0", "9→0", "5→2"]);
	expect(changed("9", "10")).toEqual(["∅→1", "9→0"]);
});

test("stagger order counts changed characters left to right", () => {
	expect(diffGlyphs("1.234", "1.299").map((g) => g.order)).toEqual([-1, -1, -1, 0, 1]);
});
