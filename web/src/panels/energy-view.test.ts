import { expect, test } from "bun:test";
import { type EnergyView, energyPoints } from "./energy-view.ts";

const w = (mean: number | null) => ({
	nights: 7,
	nightsWithData: 7,
	activeNights: mean ? 7 : 0,
	detections: 0,
	frpSumMW: 0,
	meanNightFrpMW: mean,
});
function facility(id: string, mean: number | null, status: string) {
	return { id, nameEs: id, nameEn: id, kind: "refinery", lat: 10, lon: -66, d7: w(mean), status };
}

test("energyPoints: weight is the square root of power relative to the brightest; tone from status", () => {
	const view = {
		facilities: [facility("a", 100, "usual"), facility("b", 25, "up"), facility("c", null, "dark")],
	} as unknown as EnergyView;
	const pts = energyPoints(view);
	expect(pts.map((p) => p.weight)).toEqual([1, 0.5, 0]);
	expect(pts.map((p) => p.tone)).toEqual(["ok", "warn", "alert"]);
	expect(energyPoints(undefined)).toEqual([]);
});
