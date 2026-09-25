import { expect, test } from "bun:test";
import { defaultPanelPrefs, reachOf, repairPanelPrefs, setPanelPrefs, storyAllowed } from "./panelprefs.ts";

const story = (outlets: { stance: string; region: string }[], states: string[] = []) => ({ outlets, states });

test("stored settings are repaired, never trusted", () => {
	expect(repairPanelPrefs(null)).toEqual(defaultPanelPrefs());
	expect(
		repairPanelPrefs({
			news: {
				hiddenStances: ["state", "state", "evil", 3],
				hiddenReaches: ["regional", "moon"],
				states: ["VE-V", "VE-ZZ"],
			},
			money: { hidden: ["p2p", "official"] },
			map: { layer: "javascript:", quakes: "no" },
		}),
	).toEqual({
		v: 1,
		news: { hiddenStances: ["state"], hiddenReaches: ["regional"], states: ["VE-V"] },
		money: { hidden: ["p2p"] },
		map: { layer: null, quakes: null },
	});
});

test("a story passes when one of its outlets passes; states narrow it; the reader's own feeds are never hidden by kind", () => {
	setPanelPrefs({
		...defaultPanelPrefs(),
		news: { hiddenStances: ["state"], hiddenReaches: ["international"], states: [] },
	});
	expect(storyAllowed(story([{ stance: "state", region: "national" }]))).toBe(false);
	expect(
		storyAllowed(
			story([
				{ stance: "state", region: "national" },
				{ stance: "independent", region: "VE-V" },
			]),
		),
	).toBe(true);
	expect(storyAllowed(story([{ stance: "independent", region: "international" }]))).toBe(false);
	expect(storyAllowed(story([{ stance: "user", region: "national" }]))).toBe(true);
	setPanelPrefs({ ...defaultPanelPrefs(), news: { hiddenStances: [], hiddenReaches: [], states: ["VE-V"] } });
	expect(storyAllowed(story([{ stance: "state", region: "national" }], ["VE-K"]))).toBe(false);
	expect(storyAllowed(story([{ stance: "state", region: "national" }], ["VE-K", "VE-V"]))).toBe(true);
	setPanelPrefs(defaultPanelPrefs());
	expect(storyAllowed(story([], []))).toBe(true);
	expect([reachOf("VE-V"), reachOf("national"), reachOf("diaspora"), reachOf("international")]).toEqual([
		"regional",
		"national",
		"diaspora",
		"international",
	]);
});
