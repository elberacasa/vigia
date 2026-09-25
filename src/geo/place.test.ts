import { expect, test } from "bun:test";
import { placeOf } from "./place.ts";

test("land, neighbour and sea", () => {
	expect(placeOf(10.5061, -66.9146)).toMatchObject({
		inVenezuela: true,
		state: "VE-A",
		borderKm: 0,
		water: null,
	});
	const col = placeOf(7.1193, -73.1227);
	expect(col).toMatchObject({ inVenezuela: false, state: null, country: "Colombia" });
	expect(col.borderKm).toBeGreaterThan(80);
	const sea = placeOf(11.5, -66.0);
	expect(sea).toMatchObject({ inVenezuela: false, country: null });
	expect(sea.placeEs).toStartWith("En el mar, ");
});

test("Lake Maracaibo is Zulia, not the sea", () => {
	const lake = placeOf(9.8, -71.6);
	expect(lake).toMatchObject({ inVenezuela: true, state: "VE-V", borderKm: 0, water: "Lago de Maracaibo" });
	expect(lake.placeEs).toStartWith("En el Lago de Maracaibo, ");
	// Tablazo bay, just inside the box.
	expect(placeOf(10.95, -71.6).state).toBe("VE-V");
	// Gulf of Venezuela, north of the box: sea.
	expect(placeOf(11.2, -71.3)).toMatchObject({ inVenezuela: false, water: null });
});
