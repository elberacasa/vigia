import { expect, test } from "bun:test";
import { Store } from "../core/store.ts";
import { aboutVenezuela, briefView, caracasDay, caracasTime } from "./brief.ts";

test("an empty store still gives an honest brief (no invented figures)", () => {
	const now = Date.UTC(2026, 8, 25, 2);
	const brief = briefView(new Store(":memory:"), now);
	expect(brief.day).toBe("2026-09-24");
	expect(brief.stories).toEqual([]);
	expect(brief.figures.some((f) => f.label.startsWith("Dólar"))).toBe(false);
	expect(brief.text).toContain("sin IA");
	for (const f of brief.figures) expect(f.source.length).toBeGreaterThan(0);
});

test("Caracas day boundary is 04:00 UTC", () => {
	expect(caracasDay(Date.UTC(2026, 8, 25, 3, 59))).toBe("2026-09-24");
	expect(caracasDay(Date.UTC(2026, 8, 25, 4, 0))).toBe("2026-09-25");
});

const run = (store: Store, source: string, at: number) =>
	store.recordRun({
		source,
		startedAt: at - 1_000,
		finishedAt: at,
		ok: true,
		error: null,
		bytes: 1,
		received: 0,
		inserted: 0,
	});

test("no quake feed checked recently: the brief says so instead of '0 sismos' (review 2, M3)", () => {
	const now = Date.UTC(2026, 8, 25, 2);
	const store = new Store(":memory:");
	const empty = briefView(store, now).figures.find((f) => f.label.startsWith("Sismos"));
	expect(empty?.value).toBe("sin datos recientes de USGS ni FUNVISIS");
	expect(empty?.stale).toBe(true);
	// USGS checked 2 hours ago: past its 15-minute budget, still no zero.
	run(store, "usgs-quakes", now - 2 * 3_600_000);
	expect(briefView(store, now).figures.find((f) => f.label.startsWith("Sismos"))?.value).not.toMatch(/^0/);
	// Checked 5 minutes ago: now "0" is a real reading, dated by that check.
	run(store, "usgs-quakes", now - 5 * 60_000);
	const brief = briefView(store, now);
	const fresh = brief.figures.find((f) => f.label.startsWith("Sismos"));
	expect(fresh).toMatchObject({ value: "0", stale: false, observedAt: now - 5 * 60_000 });
	expect(brief.text).toContain("• Sismos en 24 h (Venezuela y cerca): 0 (dato: 21:55) [USGS, FUNVISIS]");
	// Cyclones: "no data" rather than an all-clear when NOAA was not checked.
	expect(brief.figures.find((f) => f.label === "Ciclones")?.value).toBe("sin datos recientes de NOAA");
});

test("figure times are Caracas wall-clock, with the date when not today", () => {
	const now = Date.UTC(2026, 8, 25, 16);
	expect(caracasTime(Date.UTC(2026, 8, 25, 14, 5), now)).toBe("10:05");
	expect(caracasTime(Date.UTC(2026, 8, 23, 14, 5), now)).toBe("23/09 10:05");
});

test("review 4 M1: zero states with data is 'sin datos suficientes', never 'sin caídas en los 0 estados'", () => {
	const now = Date.UTC(2026, 8, 25, 16);
	const conn = (normal: number, noData: number) => ({
		asOf: now - 5 * 3_600_000,
		summary: {
			states: { normal, drop: 0, severe: 0, noData },
			affected: [],
			allClear: normal >= 20,
		},
		country: { sourceUrl: "https://ioda.inetintel.cc.gatech.edu/country/VE" },
		states: [],
	});
	const internet = (normal: number, noData: number) =>
		briefView(new Store(":memory:"), now, (id) =>
			id === "connectivity" ? conn(normal, noData) : undefined,
		).figures.find((f) => f.label.startsWith("Internet"))?.value;
	expect(internet(0, 25)).toBe("sin datos suficientes de IODA en este momento");
	expect(internet(0, 25)).not.toContain("sin caídas");
	expect(internet(12, 13)).toBe(
		"sin caídas en los 12 estados con datos; faltan datos de 13 (se necesitan 20 para afirmar que no hay caídas)",
	);
	expect(internet(24, 1)).toBe("sin caídas de señal por estado");
});

test("review 4 L15: 'Lo más cubierto' keeps stories about Venezuela, not foreign politics carried by its outlets", () => {
	const story = (title: string, topics: string[], states: string[] = []) => ({ title, topics, states });
	expect(
		aboutVenezuela(
			story("Juez ordena dar acceso a los medios vetados por Trump en la Casa Blanca", ["politica"]),
		),
	).toBe(false);
	expect(aboutVenezuela(story("El presidente de Francia disuelve el Parlamento", ["politica"]))).toBe(false);
	expect(
		aboutVenezuela(story("Diputados aprueban en primera discusión la ley de hidrocarburos", ["politica"])),
	).toBe(true);
	expect(aboutVenezuela(story("El CNE anuncia la fecha de las elecciones regionales", ["politica"]))).toBe(
		true,
	);
	expect(aboutVenezuela(story("Delcy Rodríguez viaja a Moscú", ["politica"]))).toBe(true);
	expect(aboutVenezuela(story("Apagón en varias zonas", ["electricidad"]))).toBe(true);
	expect(aboutVenezuela(story("Protesta de docentes en Mérida", ["protesta"], ["VE-L"]))).toBe(true);
	expect(aboutVenezuela(story("Real Madrid gana el clásico", []))).toBe(false);
});
