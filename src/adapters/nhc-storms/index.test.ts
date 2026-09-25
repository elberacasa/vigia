import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { assessThreat, bearingDeg, nhcStorms, saffirSimpson, THREAT_RULE } from "./index.ts";

const live = loadFixture(join(import.meta.dir, "fixtures", "2026-09-24"));
const withBody = (body: string): RawResponse => ({ ...(live[0] as RawResponse), body });

function storm(id: string, lat: number, lon: number, kt: number, dir: number, cls = "HU") {
	return {
		id,
		name: "Prueba",
		classification: cls,
		intensity: String(kt),
		pressure: "980",
		latitudeNumeric: lat,
		longitudeNumeric: lon,
		movementDir: dir,
		movementSpeed: 12,
		lastUpdate: "2026-09-24T21:00:00.000Z",
		publicAdvisory: { url: "https://www.nhc.noaa.gov/text/MIATCPAT2.shtml" },
		forecastGraphics: { url: "https://www.nhc.noaa.gov/graphics_at2.shtml" },
	};
}

test("live feed: only the Atlantic storm (Fay) is kept, far from Venezuela, no threat", () => {
	const obs = nhcStorms.normalise(live);
	expect(JSON.parse(live[0]?.body ?? "{}").activeStorms.length).toBe(4); // 1 Atlantic + 3 Pacific
	expect(obs.length).toBe(1);
	const fay = obs[0];
	expect(fay?.series).toBe("storm:al062026");
	expect(fay?.value).toMatchObject({
		name: "Fay",
		classificationEs: "Tormenta tropical",
		windKt: 45,
		windKmh: 83,
		category: null,
		movementKmh: 10, // 6 mph
		threat: false,
	});
	expect(fay?.value.distanceKm).toBeGreaterThan(2500);
	expect(fay?.observedAt).toBe(Date.UTC(2026, 8, 24, 21));
	expect(fay?.observedAt).toBeLessThanOrEqual(fay?.fetchedAt ?? 0);
	expect(fay?.sourceUrl).toBe("https://www.nhc.noaa.gov/graphics_at1.shtml");
	expect(fay?.basis).toBe("official");
});

test("threat rule: near is a threat; mid-range only when heading toward Venezuela", () => {
	// 150 km north of Margarita.
	const near = assessThreat(12.4, -64.0, 270);
	expect(near.threat).toBe(true);
	expect(near.distanceKm).toBeLessThanOrEqual(THREAT_RULE.threatKm);
	// ~700-800 km NE of the Paria peninsula, moving WSW toward it, then moving N away from it.
	const toward = assessThreat(15.5, -57.0, 235);
	expect(toward.distanceKm).toBeGreaterThan(THREAT_RULE.threatKm);
	expect(toward.distanceKm).toBeLessThanOrEqual(THREAT_RULE.watchKm);
	expect(toward.headingTowardVenezuela).toBe(true);
	expect(toward.threat).toBe(true);
	const away = assessThreat(15.5, -57.0, 0);
	expect(away.headingTowardVenezuela).toBe(false);
	expect(away.threat).toBe(false);
	expect(away.reasonEs).toContain("sin rumbo hacia Venezuela");
	// No movement given: only the distance clause can fire.
	expect(assessThreat(15.5, -57.0, null).threat).toBe(false);
});

test("Saffir-Simpson categories and bearings", () => {
	expect([63, 64, 83, 96, 113, 137].map(saffirSimpson)).toEqual([null, 1, 2, 3, 4, 5]);
	expect(Math.round(bearingDeg(10, -66, 11, -66))).toBe(0);
	expect(Math.round(bearingDeg(10, -66, 10, -67))).toBe(270);
});

test("a hurricane near the coast: category, threat, Pacific ids ignored", () => {
	const body = JSON.stringify({
		activeStorms: [storm("al092026", 12.2, -65.5, 100, 280), storm("ep092026", 12.2, -85, 100, 280)],
	});
	const obs = nhcStorms.normalise([withBody(body)]);
	expect(obs.length).toBe(1);
	expect(obs[0]?.value).toMatchObject({ category: 3, threat: true, classificationEs: "Huracán" });
});

test("no active storms, one malformed storm, wrong envelope", () => {
	expect(nhcStorms.normalise([withBody('{"activeStorms":[]}')])).toEqual([]);
	const bad = { ...storm("al092026", 12.2, -65.5, 100, 280), intensity: "strong" };
	const body = JSON.stringify({ activeStorms: [bad, storm("al102026", 20, -60, 50, 300, "TS")] });
	expect(nhcStorms.normalise([withBody(body)]).map((o) => o.series)).toEqual(["storm:al102026"]);
	expect(() => nhcStorms.normalise([withBody("{}")])).toThrow("NHC");
});
