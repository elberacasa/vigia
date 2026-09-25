import { expect, test } from "bun:test";
import type { Json } from "../core/types.ts";
import { intelSetup } from "../server/intel-fixture.ts";
import { status } from "./commands.ts";
import { renderReport, WIDTH, wrap } from "./terminal.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 8, 25, 1, 30);

const state = (id: string, name: string, level: string, pctOfBaseline: number | null) => ({
	id,
	name,
	kind: "state",
	level,
	lastBinAt: NOW - 20 * MIN,
	signals: [{ signal: "ping-slash24", pctOfBaseline }],
});

const incident = (title: string, reportsOnly: boolean, families: string[], outlets: number) => ({
	id: title,
	title: { es: title, en: title.replace("Posible apagón en", "Possible blackout in") },
	stateName: title.split(" en ")[1] ?? null,
	status: "active",
	reportsOnly,
	families,
	outlets,
	startAt: NOW - 6 * HOUR,
	lastEvidenceAt: NOW - 25 * MIN,
	strength: {
		es: reportsOnly ? `solo reportes (${outlets} medios)` : `${families.length} fuentes independientes`,
		en: reportsOnly ? `reports only (${outlets} outlets)` : `${families.length} independent sources`,
	},
});

const PANELS = {
	money: {
		official: {
			usd: { current: { vesPerUnit: 853.5, validFrom: NOW - 26 * HOUR }, change24h: { pct: 0.42 } },
		},
		yadio: { figure: { vesPerUsd: 958.8, observedAt: NOW - 38 * MIN, gap: { pct: 12.34 } } },
		p2p: [],
	},
	connectivity: {
		asOf: NOW - 20 * MIN,
		summary: { allClear: false },
		states: [
			state("VE-K", "Lara", "drop", 75.6),
			state("VE-A", "Distrito Capital", "normal", 97.2),
			state("VE-V", "Zulia", "normal", 101.4),
			state("VE-W", "Dependencias Federales", "no-data", null),
		],
	},
	quakes: {
		counts: { day: 1 },
		items: [
			{
				at: NOW - 5 * HOUR,
				maxMag: 3.6,
				placeEs: "a 13 km al O de Irapa (Sucre)",
				zone: "venezuela",
				feltSize: true,
				usgs: null,
				funvisis: {},
			},
		],
	},
	incidents: {
		incidents: [
			incident("Posible apagón en Lara", false, ["ioda", "prensa"], 1),
			incident("Posible apagón en Distrito Capital con un nombre muy largo que no cabe", true, ["prensa"], 7),
			{
				...incident("Posible apagón en Zulia", false, ["ioda", "viirs"], 0),
				lateNotes: [
					{
						es: "corroborado después por luces nocturnas (dato publicado 38 h después)",
						en: "corroborated later by night lights (published 38 h after)",
					},
				],
			},
		],
		watches: [
			{
				...incident("Caída de conectividad en Mérida", false, ["ioda"], 0),
				title: { es: "Caída de conectividad en Mérida", en: "Connectivity drop in Mérida" },
			},
		],
	},
} as unknown as Record<string, Json>;

const HEALTH = [
	{ id: "ioda-states", state: "ok" as const, lastSuccessAt: NOW - 5 * MIN },
	{ id: "bcv-official", state: "ok" as const, lastSuccessAt: NOW - HOUR },
	{ id: "yadio", state: "stale" as const, lastSuccessAt: NOW - 38 * MIN },
	{ id: "usgs-quakes", state: "ok" as const, lastSuccessAt: NOW - 3 * MIN },
	{ id: "funvisis-quakes", state: "ok" as const, lastSuccessAt: NOW - 3 * MIN },
];

const render = (lang: "es" | "en", color = false) =>
	renderReport({ panels: PANELS, health: HEALTH, now: NOW, lang, color, origin: "http://localhost:7722" });

test("the report, in Spanish (snapshot)", () => {
	expect(render("es")).toMatchSnapshot();
});

test("the report, in English (snapshot)", () => {
	expect(render("en")).toMatchSnapshot();
});

test("80 columns at most, with and without colour; colour is only ANSI around the same text", () => {
	for (const lang of ["es", "en"] as const) {
		for (const line of render(lang).split("\n")) expect(line.length).toBeLessThanOrEqual(WIDTH);
		const colored = render(lang, true);
		expect(colored).toContain("\x1b[");
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes is the point.
		expect(colored.replace(/\x1b\[\d+m/g, "")).toBe(render(lang));
	}
	expect(render("es")).not.toContain("\x1b[");
});

test("every data line names its source and age; stale feeds are marked", () => {
	const text = render("es");
	expect(text).toContain("BCV · hace 1 d");
	expect(text).toContain("Yadio · hace 38 min (retraso)");
	expect(text).toContain("IODA · hace 20 min");
	expect(text).toContain("FUNVISIS · hace 5 h");
	expect(text).toContain("Sin datos (1): Dependencias Federales");
});

test("review 3 M2: no 'Ninguno en 24 h' from late quake feeds; press-only incidents apart; old starts dated", () => {
	const noQuakes = { ...PANELS, quakes: { counts: { day: 0 }, items: [] } } as unknown as Record<
		string,
		Json
	>;
	const late = HEALTH.map((h) =>
		h.id.endsWith("quakes") ? { ...h, state: "stale" as const, lastSuccessAt: NOW - 3 * 24 * HOUR } : h,
	);
	const stale = renderReport({
		panels: noQuakes,
		health: late,
		now: NOW,
		lang: "es",
		color: false,
		origin: "x",
	});
	expect(stale).not.toContain("Ninguno en 24 h");
	expect(stale).toContain("Sin datos recientes de sismos");
	expect(stale).toContain("revisado hace 3 d");
	const fresh = renderReport({
		panels: noQuakes,
		health: HEALTH,
		now: NOW,
		lang: "es",
		color: false,
		origin: "x",
	});
	expect(fresh).toContain("Ninguno en 24 h");

	const text = render("es");
	const agreeAt = text.indexOf("INCIDENTES (FUENTES INDEPENDIENTES QUE COINCIDEN)");
	const pressAt = text.indexOf("SOLO REPORTES DE PRENSA (SIN MEDICIÓN)");
	expect(agreeAt).toBeGreaterThan(-1);
	expect(pressAt).toBeGreaterThan(agreeAt);
	// The press-only incident is listed only under its own heading; the corroborated one only under the first.
	expect(text.indexOf("○ Posible apagón en Distrito Capital")).toBeGreaterThan(pressAt);
	expect(text.indexOf("● Posible apagón en Lara")).toBeLessThan(pressAt);

	const old = {
		...PANELS,
		incidents: {
			incidents: [
				{ ...(PANELS.incidents as { incidents: object[] }).incidents[0], startAt: NOW - 30 * HOUR },
			],
		},
	} as unknown as Record<string, Json>;
	expect(
		renderReport({ panels: old, health: HEALTH, now: NOW, lang: "es", color: false, origin: "x" }),
	).toContain("desde 23 sept, 15:30");
});

test("wrap keeps words whole and indents continuation lines", () => {
	expect(wrap("uno dos tres cuatro", 9, 2)).toEqual(["uno dos", "  tres", "  cuatro"]);
});

test("routes: /ahora.txt and curl on / get text; a browser on / does not", async () => {
	const { get } = intelSetup();
	const txt = await get("/ahora.txt?lang=en");
	expect(txt.headers.get("content-type")).toBe("text/plain; charset=utf-8");
	expect(await txt.text()).toContain("VIGÍA · Venezuela now");
	const curl = await get("/", "127.0.0.1", { "user-agent": "curl/8.9.1" });
	expect(await curl.text()).toContain("INCIDENTES");
	const colored = await get("/?color=1", "127.0.0.1", { "user-agent": "Wget/1.24" });
	expect(await colored.text()).toContain("\x1b[1m");
	const browser = await get("/", "127.0.0.1", { "user-agent": "Mozilla/5.0" });
	expect(browser.headers.get("content-type")).not.toContain("text/plain");
});

test("vigia status prints the report from a running instance, or says none is running", async () => {
	let asked = "";
	let printed = "";
	const ok = await status(
		["--port", "7799", "--lang", "en"],
		{},
		true,
		(s) => {
			printed += s;
		},
		(async (url: string) => {
			asked = url;
			return new Response("REPORT\n");
		}) as unknown as typeof fetch,
	);
	expect(ok).toBe(0);
	expect(asked).toBe("http://localhost:7799/ahora.txt?lang=en&color=1");
	expect(printed).toBe("REPORT\n");
	printed = "";
	const down = await status(
		[],
		{ NO_COLOR: "1" },
		true,
		(s) => {
			printed += s;
		},
		(async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch,
	);
	expect(down).toBe(1);
	expect(printed).toContain("No hay un Vigía en marcha en http://localhost:7722");
});

test("press-only incidents are not listed as independent sources; an older start carries its date", () => {
	const report = render("es");
	const incidents = report.slice(report.indexOf("INCIDENTES"));
	const [measured, reports] = incidents.split("SOLO REPORTES DE PRENSA (SIN MEDICIÓN)");
	expect(measured).toContain("● Posible apagón en Lara");
	expect(measured).not.toContain("Distrito Capital");
	expect(reports).toContain("○ Posible apagón en Distrito Capital");
	const old = {
		...PANELS,
		incidents: {
			incidents: [
				{ ...incident("Posible apagón en Zulia", false, ["ioda", "viirs"], 0), startAt: NOW - 30 * HOUR },
			],
		},
	} as unknown as Record<string, Json>;
	const text = renderReport({ panels: old, health: HEALTH, now: NOW, lang: "es", color: false, origin: "x" });
	expect(text).toMatch(/desde 23 sept?, 15:30/);
	expect(text).not.toContain("SOLO REPORTES");
});

test("no quakes is only 'none' while a quake feed works", () => {
	const panels = { ...PANELS, quakes: { counts: { day: 0 }, items: [] } } as unknown as Record<string, Json>;
	const stale = HEALTH.map((h) => (h.id.endsWith("-quakes") ? { ...h, state: "stale" as const } : h));
	const text = renderReport({ panels, health: stale, now: NOW, lang: "es", color: false, origin: "x" });
	expect(text).toContain("Sin datos recientes");
	expect(text).not.toContain("Ninguno en 24 h");
	const ok = renderReport({ panels, health: HEALTH, now: NOW, lang: "es", color: false, origin: "x" });
	expect(ok).toContain("Ninguno en 24 h");
});

test("uncorroborated signals get their own heading; late corroboration is printed with its delay", () => {
	const text = render("es");
	const watches = text.slice(text.indexOf("SEÑALES SIN CORROBORAR"));
	expect(watches).toContain("Caída de conectividad en Mérida · IODA");
	expect(text.slice(0, text.indexOf("SEÑALES SIN CORROBORAR"))).not.toContain("Mérida");
	expect(text).toContain("corroborado después por luces nocturnas (dato publicado 38 h después)");
});

test("watch items print in the report's language", () => {
	const en = render("en");
	expect(en.slice(en.indexOf("UNCORROBORATED SIGNALS"))).toContain("Connectivity drop in Mérida · IODA");
	expect(en).not.toContain("Caída de conectividad");
});
