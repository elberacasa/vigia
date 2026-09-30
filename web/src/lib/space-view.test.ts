import { expect, test } from "bun:test";
import {
	barScale,
	flightsHeadline,
	floodLine,
	forestLead,
	ha,
	km2,
	plumeRate,
	trafficWord,
	vesselLine,
} from "./space-view.ts";

test("a flood area is always said with the share the satellite could not see", () => {
	const r = { floodKm2: 58.3, recurringKm2: 7.1, cloudPct: 41.1, unseenPct: 41.1, areaKm2: 38_743 };
	expect(floodLine(r, "es")).toBe("58,3 km² de inundación vista por satélite · 41 % sin ver");
	expect(km2(202.6, "es")).toBe("203 km²");
	expect(km2(0.4, "es")).toBe("0,4 km²");
});

test("forest leads with natural forest at high or highest confidence", () => {
	expect(forestLead({ nominal: 196.2, high: 7616.2, highest: 58, total: 7870.4 }, "es")).toBe(
		"7.674 ha en bosque natural, confianza alta o máxima",
	);
	expect(ha(4.25, "es")).toBe("4,3 ha");
});

test("a plume keeps its own estimate or says there is none; never a total", () => {
	expect(plumeRate({ emissionKgH: 3574.7, uncertaintyKgH: 126.1 }, "es")).toBe("3.575 ± 126 kg/h");
	expect(plumeRate({ emissionKgH: null, uncertaintyKgH: null }, "es")).toBe("sin estimación publicada");
});

test("flights: all airline flights seen lead, never an 'international flights' zero that reads as a closure", () => {
	const day = (date: string, total: number, internationalAll: number, partial = false) => ({
		date,
		partial,
		internationalAll,
		arrival: 0,
		departure: 0,
		international: 0,
		domestic: 0,
		overflight: total - internationalAll,
		nearby: 0,
		"no-route": 0,
		total,
		snapshots: 144,
		covered: true,
	});
	const days = [
		...Array.from({ length: 9 }, (_, i) => day(`2026-09-${String(19 + i).padStart(2, "0")}`, 10, 0)),
		day("2026-09-28", 57, 0, true),
	];
	const h = flightsHeadline({ days }, "es");
	expect(h).toMatchObject({ today: 57, toVenezuela: 0, week: 70, weekDays: 7 });
	expect(h.text).toBe(
		"57 vuelos de aerolínea vistos hoy sobre o cerca de Venezuela (0 con ruta publicada a un aeropuerto venezolano)",
	);
	expect(flightsHeadline({ days: [day("2026-09-28", 1, 1, true)] }, "es").text).toBe(
		"1 vuelo de aerolínea visto hoy sobre o cerca de Venezuela (1 con ruta publicada a un aeropuerto venezolano)",
	);
	expect(h.text).not.toMatch(/^0 vuelos internacionales/);
});

test("Cloudflare's curve is an index against the usual hour; radar sums are detections, never ships", () => {
	const t = {
		points: [],
		observedAt: 0,
		fetchedAt: 0,
		stale: false,
		usualDays: 6,
		method: "",
		normalization: "",
	};
	expect(trafficWord({ ...t, pctOfUsual: 62 }, "es")).toBe(
		"ahora al 62 % de lo habitual a esta hora (6 días)",
	);
	expect(trafficWord({ ...t, pctOfUsual: null, usualDays: 2 }, "es")).toBe("sin 3 días comparables (hay 2)");
	expect(vesselLine({ detections: 41, withoutAis: 7 }, 30, "es")).toBe(
		"41 detecciones por radar en 30 días, 7 sin AIS emparejado",
	);
	expect(vesselLine({ detections: 0, withoutAis: 0 }, 30, "es")).toBe("ninguna detección en 30 días");
});

test("bars are linear to the series' own maximum; zero stays zero, a small value keeps a sliver", () => {
	expect(barScale([0, 50, 100])).toEqual([0, 0.5, 1]);
	expect(barScale([1, 1000])[0]).toBe(0.03);
	expect(barScale([0, 0])).toEqual([0, 0]);
});

test("flights: a day the feed never read has no figure; the week counts only days it read (review M9)", () => {
	const day = (date: string, total: number, covered: boolean, partial = false) => ({
		date,
		partial,
		internationalAll: 0,
		arrival: 0,
		departure: 0,
		international: 0,
		domestic: 0,
		overflight: total,
		nearby: 0,
		"no-route": 0,
		total,
		snapshots: covered ? 144 : 0,
		covered,
	});
	const days = [
		...Array.from({ length: 13 }, (_, i) => day(`2026-09-${String(16 + i).padStart(2, "0")}`, 0, false)),
		day("2026-09-29", 57, true, true),
	];
	const h = flightsHeadline({ days }, "es");
	expect(h).toMatchObject({ today: 57, week: 0, weekDays: 0 });
	const none = flightsHeadline({ days: days.map((d) => ({ ...d, covered: false, snapshots: 0 })) }, "es");
	expect(none.today).toBeNull();
	expect(none.text).toBe("sin datos de hoy: Vigía no ha leído la fuente");
});
