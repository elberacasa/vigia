import { expect, test } from "bun:test";
import { MUNICIPALITIES } from "../map/municipalities.gen.ts";
import { candidatesAt, MAX_ACCURACY_M, municipalityAt, rings } from "./crowd-geo.ts";
import { muniChoices, searchMunis } from "./crowd-places.ts";
import {
	type CrowdItem,
	crowdPlaces,
	deviceToken,
	dropToken,
	heldText,
	newToken,
	publishedText,
	refusalText,
	reportsWord,
	TOKEN_KEY,
	TOKEN_MAX_AGE_MS,
	withoutHeld,
	workShare,
} from "./crowd-view.ts";
import { PLACES } from "./places.gen.ts";

/** A sessionStorage stand-in. */
function store(seed: Record<string, string> = {}) {
	const m = new Map(Object.entries(seed));
	return {
		getItem: (k: string) => m.get(k) ?? null,
		setItem: (k: string, v: string) => void m.set(k, v),
		removeItem: (k: string) => void m.delete(k),
		map: m,
	};
}

test("the device token: 16 random bytes in base64url, kept in the tab's storage for a day, then renewed", () => {
	const t = newToken((b) => b.fill(255));
	expect(t).toBe("_____________________w");
	expect(newToken()).toMatch(/^[A-Za-z0-9_-]{22}$/);
	const s = store();
	const now = 1_790_000_000_000;
	const first = deviceToken(s, now, () => "AAAAAAAAAAAAAAAAAAAAAA");
	expect(first).toBe("AAAAAAAAAAAAAAAAAAAAAA");
	expect(JSON.parse(s.map.get(TOKEN_KEY) ?? "{}")).toEqual({ token: first, createdAt: now });
	// A reload of the tab keeps it; a day later it is made anew.
	expect(deviceToken(s, now + 3_600_000, () => "BBBBBBBBBBBBBBBBBBBBBB")).toBe(first);
	expect(deviceToken(s, now + TOKEN_MAX_AGE_MS, () => "BBBBBBBBBBBBBBBBBBBBBB")).toBe(
		"BBBBBBBBBBBBBBBBBBBBBB",
	);
	// A malformed or future-dated copy is never trusted; `400 invalid` drops it.
	const bad = store({ [TOKEN_KEY]: JSON.stringify({ token: "short", createdAt: now }) });
	expect(deviceToken(bad, now, () => "CCCCCCCCCCCCCCCCCCCCCC")).toBe("CCCCCCCCCCCCCCCCCCCCCC");
	const future = store({
		[TOKEN_KEY]: JSON.stringify({ token: "DDDDDDDDDDDDDDDDDDDDDD", createdAt: now + 60_000 }),
	});
	expect(deviceToken(future, now, () => "EEEEEEEEEEEEEEEEEEEEEE")).toBe("EEEEEEEEEEEEEEEEEEEEEE");
	dropToken(s);
	expect(s.map.has(TOKEN_KEY)).toBe(false);
	// Storage blocked: a token for this page, the report still goes.
	expect(deviceToken(null, now, () => "FFFFFFFFFFFFFFFFFFFFFF")).toBe("FFFFFFFFFFFFFFFFFFFFFF");
});

test("every refusal code reads in plain Spanish, the server's own sentence kept where the contract says", () => {
	const r = (code: string, error: string | null = null, retryAfterS: number | null = null) =>
		refusalText({ code, error, retryAfterS, status: 429 }, "es");
	expect(r("rate", "Demasiados reportes desde esta conexión.", 120)).toBe(
		"Demasiados reportes desde esta conexión. Puedes volver a intentarlo en 2 min.",
	);
	expect(r("municipalities", "Máximo 6 municipios por día.", 7_200)).toContain("en 2 h");
	expect(r("busy")).toContain("Demasiados reportes en tu estado");
	expect(r("proxy", "El proxy no está declarado.")).toContain("no de tu reporte");
	for (const code of ["origin", "remote", "off", "invalid", "pow", "network"])
		expect(r(code).length).toBeGreaterThan(20);
	expect(r("network")).toContain("Nada se guardó");
	expect(r("weird")).toContain("(429)");
});

test("when a report counts, and the work's progress", () => {
	const now = Date.UTC(2026, 8, 29, 6, 5);
	// Never "it counted": the server says only "received" (counted, held or replaced is not told back).
	expect(publishedText(now, now, "es")).toBe("Si se cuenta, ya entra en lo publicado.");
	// 06:15 UTC is 02:15 in Caracas; a mirror's minimum is said.
	expect(publishedText(Date.UTC(2026, 8, 29, 6, 15), now, "es", 3)).toBe(
		"Si se cuenta, entra en lo publicado a las 02:15, al cerrar el bloque de 15 minutos. Un municipio se muestra solo con al menos 3 reportes.",
	);
	expect(workShare(0, 18)).toBe(0);
	expect(workShare(2 ** 18, 18)).toBeCloseTo(0.632, 2);
	expect(workShare(2 ** 30, 18)).toBe(0.95);
});

const item = (o: Partial<CrowdItem>): CrowdItem => ({
	level: "municipality",
	entity: "ve.miranda.chacao",
	state: "VE-M",
	service: "luz",
	reports: 5,
	connections: 2,
	answers: { si: 1, no: 3, intermitente: 1 },
	held: 0,
	heldAnswers: { si: 0, no: 0, intermitente: 0 },
	flagged: false,
	municipalities: 1,
	outage: null,
	windowMs: 7_200_000,
	name: { es: "Chacao", en: "Chacao" },
	stateName: "Miranda",
	serviceName: { es: "luz", en: "power" },
	label: { es: "Reportes de usuarios: luz", en: "User reports: power" },
	text: { es: "5 reportes de 2 conexiones en 2 h", en: "5 reports from 2 connections in 2 h" },
	method: "",
	observedAt: 1,
	fetchedAt: 1,
	stale: false,
	...o,
});

test("published figures: counts and connections in words, held reports by answer, places ranked by outage answers", () => {
	expect(reportsWord({ reports: 5, connections: 2 }, "es")).toBe("5 reportes de 2 conexiones");
	expect(reportsWord({ reports: 1, connections: 1 }, "es")).toBe("1 reporte");
	expect(heldText({ si: 40, no: 0, intermitente: 0 }, "es")).toBe(
		"posible manipulación: 40 «sí» retenidos, no se cuentan",
	);
	expect(heldText({ si: 0, no: 0, intermitente: 0 }, "es")).toBeNull();
	const places = crowdPlaces(
		[
			item({ service: "agua", answers: { si: 4, no: 0, intermitente: 0 }, reports: 4, observedAt: 5 }),
			item({}),
			item({
				entity: "ve.zulia.maracaibo",
				name: { es: "Maracaibo", en: "Maracaibo" },
				reports: 9,
				answers: { si: 9, no: 0, intermitente: 0 },
			}),
			item({ entity: "ve.lara.iribarren", reports: null, answers: null }),
			// Past its 2-hour window on this clock: dropped even if the cached view still lists it.
			item({ entity: "ve.lara.palavecino", observedAt: -10_000_000 }),
		],
		"es",
		1_000,
	);
	expect(places.map((p) => [p.entity, p.outage, p.answers])).toEqual([
		["ve.miranda.chacao", 4, 9],
		["ve.zulia.maracaibo", 0, 9],
	]);
	expect(places[0]?.items.map((i) => i.service)).toEqual(["luz", "agua"]);
	expect(places[0]?.newest).toBe(5);
	// Over 20 minutes old on this clock: out of date, whatever the cached view said.
	expect(crowdPlaces([item({ observedAt: 0 })], "es", 21 * 60_000)[0]?.stale).toBe(true);
	expect(
		withoutHeld(
			"5 reportes en 2 h: 1 «no», 0 «intermitente», 4 «sí» (40 retenidos por posible manipulación, no se cuentan)",
		),
	).toBe("5 reportes en 2 h: 1 «no», 0 «intermitente», 4 «sí»");
});

test("the municipality picker: every INE municipality once, found by name, city or state", () => {
	const all = muniChoices(PLACES);
	expect(all.length).toBe(335);
	expect(all.find((m) => m.code === "VE1507")).toMatchObject({
		id: "ve.miranda.chacao",
		name: "Chacao",
		stateIso: "VE-M",
	});
	expect(all.find((m) => m.code === "VE0203")?.id).toBe("ve.amazonas.atures");
	expect(searchMunis(all, "chacao")[0]?.code).toBe("VE1507");
	expect(searchMunis(all, "barquisimeto")[0]?.name).toBe("Iribarren");
	expect(searchMunis(all, "MARACAIBO")[0]?.code).toBe("VE2313");
	expect(searchMunis(all, "c")).toEqual([]);
	expect(searchMunis(all, "zzzz")).toEqual([]);
});

test("'usar mi ubicación' is placed on the device against the map's outlines", () => {
	expect(municipalityAt(-71.63, 10.64, MUNICIPALITIES)?.code).toBe("VE2313");
	expect(municipalityAt(-66.853, 10.497, MUNICIPALITIES)?.code).toBe("VE1507");
	expect(municipalityAt(-66.914, 10.506, MUNICIPALITIES)?.code).toBe("VE0101");
	// At sea, or on Bonaire: no municipality, the person picks.
	expect(municipalityAt(-66, 11.5, MUNICIPALITIES)).toBeNull();
	expect(municipalityAt(-68.277, 12.15, MUNICIPALITIES)).toBeNull();
	expect(rings("M0 0l10 0l0 10l-10 0zM20 20l5 0l0 5z")).toEqual([
		[
			[0, 0],
			[10, 0],
			[10, 10],
			[0, 10],
		],
		[
			[20, 20],
			[25, 20],
			[25, 25],
		],
	]);
	expect(MAX_ACCURACY_M).toBe(1_500);
	// Deep inside a large municipality at 50 m: one candidate; in Chacao at 1.5 km: its neighbours too, Chacao first.
	expect(candidatesAt(-71.63, 10.64, 50, MUNICIPALITIES).map((m) => m.code)).toEqual(["VE2313"]);
	const chacao = candidatesAt(-66.853, 10.497, 1_500, MUNICIPALITIES).map((m) => m.code);
	expect(chacao[0]).toBe("VE1507");
	expect(chacao.length).toBeGreaterThan(1);
});
