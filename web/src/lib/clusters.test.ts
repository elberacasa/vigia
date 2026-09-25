import { expect, test } from "bun:test";
import { outletsSince, topClusters } from "./clusters.ts";

const H = 3_600_000;
const NOW = 100 * H;
const story = (id: string, reports: [string, number][]) => ({
	id,
	at: Math.max(...reports.map(([, h]) => NOW - h * H)),
	outlets: reports.map(([o, h]) => ({ id: o, at: NOW - h * H })),
});

test("one outlet publishing twice counts once, and only reports inside the window count", () => {
	const s = story("a", [
		["pitazo", 1],
		["pitazo", 2],
		["cocuyo", 3],
		["talcual", 30],
	]);
	expect(outletsSince(s, NOW - 12 * H)).toBe(2);
	expect(outletsSince(s, NOW - 48 * H)).toBe(3);
});

test("ranked by distinct outlets in 12 h, ties to the latest report; single-outlet stories never qualify", () => {
	const stories = [
		story("two-old", [
			["a", 5],
			["b", 6],
		]),
		story("three", [
			["a", 1],
			["b", 2],
			["c", 3],
		]),
		story("two-new", [
			["a", 1],
			["b", 1],
		]),
		story("one", [["a", 0]]),
		story("big-but-old", [
			["a", 20],
			["b", 21],
			["c", 22],
			["d", 23],
		]),
	];
	const top = topClusters(stories, NOW);
	expect(top.hours).toBe(12);
	expect(top.items.map((x) => `${x.story.id}:${x.outlets}`)).toEqual(["three:3", "two-new:2", "two-old:2"]);
});

test("widens to 24 h, then 48 h, when 12 h has fewer than three clusters", () => {
	const stories = [
		story("x", [
			["a", 1],
			["b", 2],
		]),
		story("y", [
			["a", 13],
			["b", 14],
		]),
		story("z", [
			["a", 20],
			["b", 21],
			["c", 22],
		]),
	];
	const top = topClusters(stories, NOW);
	expect(top.hours).toBe(24);
	expect(top.items.map((x) => x.story.id)).toEqual(["z", "x", "y"]);
	expect(
		topClusters(
			[
				story("q", [
					["a", 40],
					["b", 41],
				]),
			],
			NOW,
		).hours,
	).toBe(48);
});
