import { expect, test } from "bun:test";
import { airportNameEs, capacityMW, isGenericName, plantNameEs, simplifyLine } from "./build.ts";

test("capacity tags in OSM's many spellings; anything without a unit is unknown, not guessed", () => {
	expect(capacityMW("10235 MW")).toBe(10235);
	expect(capacityMW("2376 Mw.CORPOELEC")).toBe(2376);
	expect(capacityMW("100.32 MW")).toBe(100.32);
	expect(capacityMW("1,5 GW")).toBe(1500);
	expect(capacityMW("5 kW")).toBe(0.005);
	expect(capacityMW("120")).toBeNull();
	expect(capacityMW("yes")).toBeNull();
	expect(capacityMW(undefined)).toBeNull();
});

test("names: English OSM plant names and OurAirports names get their Spanish form by rule", () => {
	expect(plantNameEs("Termozulia I Power Plant")).toBe("Planta Termozulia I");
	expect(plantNameEs("Complejo El Tablazo Power Station")).toBe("Planta Complejo El Tablazo");
	expect(plantNameEs("Planta Centro")).toBe("Planta Centro");
	expect(airportNameEs("Simón Bolívar International Airport")).toBe("Aeropuerto Internacional Simón Bolívar");
	expect(airportNameEs("El Libertador Airbase")).toBe("Base Aérea El Libertador");
	expect(airportNameEs("Anaco Airport")).toBe("Aeropuerto Anaco");
	expect(airportNameEs("Canaima")).toBe("Canaima");
});

test("generic names (only kind words) are told apart by their municipality", () => {
	expect(isGenericName("Ambulatorio")).toBe(true);
	expect(isGenericName("Planta Eléctrica")).toBe(true);
	expect(isGenericName("Planta III")).toBe(true);
	expect(isGenericName("Hospital Central de Maracay")).toBe(false);
	expect(isGenericName("Planta Centro")).toBe(false);
});

test("line simplification keeps the ends and every vertex farther than the tolerance", () => {
	const straight: [number, number][] = [
		[8, -63],
		[8, -62.5],
		[8, -62],
	];
	expect(simplifyLine(straight, 0.1)).toEqual([
		[8, -63],
		[8, -62],
	]);
	// A 5 km bend survives a 100 m tolerance.
	const bent: [number, number][] = [
		[8, -63],
		[8.045, -62.5],
		[8, -62],
	];
	expect(simplifyLine(bent, 0.1)).toEqual(bent);
	expect(simplifyLine([[1, 1]], 0.1)).toEqual([[1, 1]]);
});
