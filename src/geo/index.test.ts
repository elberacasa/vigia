import { expect, test } from "bun:test";
import { bearingEs, describe as describePoint, distanceKm, locate, states } from "./index.ts";

test("25 first-level units with ISO codes", () => {
	const all = states();
	expect(all.length).toBe(25);
	expect(new Set(all.map((s) => s.iso)).size).toBe(25);
	expect(all.find((s) => s.iso === "VE-V")?.name).toBe("Zulia");
});

test("locates cities in the right state", () => {
	expect(locate(10.6545, -71.6406).state?.name).toBe("Zulia"); // Maracaibo
	expect(locate(10.5061, -66.9146).state?.name).toBe("Distrito Capital"); // Caracas, Plaza Bolívar
	expect(locate(7.7669, -72.225).state?.name).toBe("Táchira"); // San Cristóbal
	expect(locate(8.1222, -63.5497).state?.name).toBe("Bolívar"); // Ciudad Bolívar
	expect(locate(10.9577, -63.8697).state?.name).toBe("Nueva Esparta"); // Porlamar
});

test("neighbours and sea", () => {
	expect(locate(7.1193, -73.1227)).toEqual({ inVenezuela: false, country: "Colombia" }); // Bucaramanga
	expect(locate(12.5, -70.0).inVenezuela).toBe(false); // Aruba area
	expect(locate(11.5, -66.0)).toEqual({ inVenezuela: false }); // Caribbean Sea
});

test("distance and bearing", () => {
	expect(Math.round(distanceKm(10.5, -66.9, 10.5, -67.9))).toBe(109);
	expect(bearingEs(10, -66, 11, -66)).toBe("N");
	expect(bearingEs(10, -66, 10, -67)).toBe("O");
	expect(bearingEs(10, -66, 9, -65)).toBe("SE");
});

test("Spanish descriptions", () => {
	// USGS: "45 km NNW of Duaca, Venezuela" at 10.6842, -69.2782.
	const text = describePoint(10.6842, -69.2782);
	expect(text).toMatch(/^(En el mar, )?a \d+ km al [NSEO]{1,3} de .+ \(.+\)$/);
	expect(describePoint(7.1193, -73.1227)).toStartWith("Colombia, ");
});
