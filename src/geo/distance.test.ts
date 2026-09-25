import { expect, test } from "bun:test";
import { distanceToVenezuelaKm, nearestVenezuelaPoint } from "./distance.ts";
import { distanceKm } from "./index.ts";

test("zero inside Venezuela", () => {
	expect(distanceToVenezuelaKm(10.5061, -66.9146)).toBe(0); // Caracas
	expect(distanceToVenezuelaKm(8.1222, -63.5497)).toBe(0); // Ciudad Bolívar
});

test("neighbours and sea, checked against known geography", () => {
	// Bucaramanga (Colombia) is ~120 km from the Táchira/Zulia border.
	const bucaramanga = distanceToVenezuelaKm(7.1193, -73.1227);
	expect(bucaramanga).toBeGreaterThan(80);
	expect(bucaramanga).toBeLessThan(160);
	// Willemstad, Curaçao: ~65-75 km north of the Paraguaná peninsula.
	const curacao = distanceToVenezuelaKm(12.1084, -68.9335);
	expect(curacao).toBeGreaterThan(55);
	expect(curacao).toBeLessThan(90);
	// Port of Spain, Trinidad: ~15-25 km from the Paria peninsula across the Dragon's Mouths.
	expect(distanceToVenezuelaKm(10.6596, -61.5089)).toBeLessThan(40);
});

test("far points: the nearest point agrees with a great-circle distance", () => {
	const miami = nearestVenezuelaPoint(25.76, -80.19);
	expect(Math.abs(distanceKm(25.76, -80.19, miami.lat, miami.lon) - miami.km) / miami.km).toBeLessThan(0.03);
	expect(miami.km).toBeGreaterThan(1500);
	expect(miami.km).toBeLessThan(1900);
});
