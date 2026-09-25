import { expect, test } from "bun:test";
import type { HealthLite } from "./fresh.ts";
import { clauseFeeds, clauseText, currentClauses, type HeadlineInput } from "./headline.ts";

const NOW = Date.UTC(2026, 8, 25, 0);
const NONE = new Map<string, HealthLite>();
/** Every feed live: the clauses' wording, apart from freshness. */
class AllLive extends Map<string, HealthLite> {
	override get(id: string): HealthLite {
		return { id, state: "ok", lastSuccessAt: NOW - 60_000 };
	}
	override has(): boolean {
		return true;
	}
}
const headline = (p: HeadlineInput, now: number, l: "es" | "en") => currentClauses(p, new AllLive(), now, l);
const state = (id: string, name: string, level: string) => ({ id, name, level, kind: "state" });

test("anomalies first, in plain words, each linked to its panel", () => {
	const clauses = headline(
		{
			connectivity: {
				states: [
					state("VE-K", "Lara", "drop"),
					state("VE-V", "Zulia", "severe"),
					state("VE-A", "Distrito Capital", "normal"),
				],
				summary: { allClear: false },
			},
			money: {
				official: { usd: { current: { vesPerUnit: 853.5 } } },
				yadio: { figure: { vesPerUsd: 957.27, gap: { pct: 12.16 } } },
			},
			quakes: {
				counts: { day: 3 },
				items: [
					{
						at: NOW - 3_600_000,
						maxMag: 4.2,
						placeEs: "a 10 km al N de Carúpano (Sucre)",
						zone: "venezuela",
						feltSize: true,
					},
				],
			},
		},
		NOW,
		"es",
	);
	expect(clauses.map((c) => c.text)).toEqual([
		"Caída fuerte de internet en Zulia",
		"Caída de señal en Lara",
		"Sismo M4,2 a 10 km al N de Carúpano (Sucre)",
		"Dólar BCV 853,50 Bs, Yadio +12,2 %",
	]);
	expect(clauses[0]).toMatchObject({ href: "#conectividad", tone: "alert" });
});

test("a calm day says so, but only when enough states have data (the panel decides)", () => {
	const states = [state("VE-A", "Distrito Capital", "normal")];
	const calm = headline({ connectivity: { states, summary: { allClear: true } } }, NOW, "es");
	expect(calm[0]?.text).toBe("Internet sin caídas por estado");
	const thin = headline({ connectivity: { states, summary: { allClear: false } } }, NOW, "es");
	expect(thin.map((c) => c.text)).not.toContain("Internet sin caídas por estado");
});

test("long lists are shortened", () => {
	const states = ["A", "B", "C", "D", "E"].map((n, i) => state(`VE-${n}`, n, i < 5 ? "drop" : "normal"));
	expect(headline({ connectivity: { states, summary: { allClear: false } } }, NOW, "es")[0]?.text).toBe(
		"Caída de señal en A, B y 3 más",
	);
});

test("cloudy night-light comparisons never make the headline", () => {
	const clauses = headline(
		{
			nightlights: {
				states: [
					{ name: "Zulia", pctChange: -60, comparable: false },
					{ name: "Lara", pctChange: -45, comparable: true },
				],
			},
		},
		NOW,
		"en",
	);
	expect(clauses.map((c) => c.text)).toEqual(["Less night light in Lara"]);
});

const health = (rows: [string, HealthLite["state"], number?][]) =>
	new Map(rows.map(([id, state, at]) => [id, { id, state, lastSuccessAt: at ?? NOW - 60_000 }]));
const money = {
	official: { usd: { current: { vesPerUnit: 853.5 } } },
	yadio: { figure: { vesPerUsd: 957.27, gap: { pct: 12.16 } } },
};

test("a stale Yadio gap is left out of the dollar clause; the BCV rate stays (review 3, H6)", () => {
	const fresh = currentClauses(
		{ money },
		health([
			["bcv-official", "ok"],
			["yadio", "ok"],
		]),
		NOW,
		"es",
	);
	expect(fresh.map((c) => c.text)).toEqual(["Dólar BCV 853,50 Bs, Yadio +12,2 %"]);
	expect(clauseFeeds(fresh)).toEqual(["bcv-official", "bcv-api", "yadio"]);
	const late = currentClauses(
		{ money },
		health([
			["bcv-official", "ok"],
			["yadio", "stale"],
		]),
		NOW,
		"es",
	);
	expect(late.map((c) => c.text)).toEqual(["Dólar BCV 853,50 Bs"]);
	expect(clauseFeeds(late)).toEqual(["bcv-official", "bcv-api"]);
	// Degraded (last attempt failed, data still in budget) still speaks.
	const degraded = currentClauses(
		{ money },
		health([
			["bcv-official", "ok"],
			["yadio", "degraded"],
		]),
		NOW,
		"es",
	);
	expect(degraded[0]?.text).toContain("Yadio");
});

test("a stale all-normal clause is dropped; a stale anomaly stays with its age", () => {
	const calm = {
		connectivity: { states: [state("VE-A", "Distrito Capital", "normal")], summary: { allClear: true } },
	};
	expect(currentClauses(calm, health([["ioda-states", "stale"]]), NOW, "es")).toEqual([]);
	expect(currentClauses({ money }, health([["bcv-official", "failing"]]), NOW, "es")).toEqual([]);
	// The second route to the same official figure (bcv-api) keeps the dollar clause current.
	const viaMirror = currentClauses(
		{ money },
		health([
			["bcv-official", "failing"],
			["bcv-api", "ok"],
		]),
		NOW,
		"es",
	);
	expect(viaMirror[0]?.text).toContain("Dólar BCV");
	const drop = {
		connectivity: { states: [state("VE-K", "Lara", "drop")], summary: { allClear: false } },
	};
	const [c] = currentClauses(drop, health([["ioda-states", "stale", NOW - 3 * 3_600_000]]), NOW, "es");
	expect(c).toMatchObject({ text: "Caída de señal en Lara", stale: true, lastAt: NOW - 3 * 3_600_000 });
	if (!c) throw new Error("clause");
	expect(clauseText(c, NOW, "es")).toBe("Caída de señal en Lara (dato de hace 3 h)");
});

test("a clause is current while any one of its feeds is live", () => {
	const quakes = {
		counts: { day: 1 },
		items: [
			{ at: NOW - 3_600_000, maxMag: 4.5, placeEs: "cerca de Cumaná", zone: "venezuela", feltSize: true },
		],
	};
	const one = currentClauses(
		{ quakes },
		health([
			["usgs-quakes", "stale"],
			["funvisis-quakes", "ok"],
		]),
		NOW,
		"es",
	);
	expect(one[0]?.stale).toBe(false);
	const none = currentClauses(
		{ quakes },
		health([
			["usgs-quakes", "stale"],
			["funvisis-quakes", "stale"],
		]),
		NOW,
		"es",
	);
	expect(none[0]?.stale).toBe(true);
});

test("an active corroborated incident leads and its state is not repeated as a plain drop; press-only and ended ones do not lead", () => {
	const inc = (title: string, status: string, reportsOnly: boolean, families: string[]) => ({
		title: { es: title, en: title },
		status,
		reportsOnly,
		families,
		lastEvidenceAt: NOW - 3_600_000,
		stateName: title.split(" en ")[1] ?? null,
	});
	const clauses = headline(
		{
			connectivity: {
				states: [
					{ id: "VE-K", name: "Lara", level: "drop", kind: "state" },
					{ id: "VE-V", name: "Zulia", level: "drop", kind: "state" },
				],
				summary: { allClear: false },
			},
			incidents: {
				incidents: [
					inc("Posible apagón en Lara", "active", false, ["ioda", "prensa"]),
					inc("Reportes en Zulia", "active", true, ["prensa"]),
					inc("Caída terminada en Miranda", "ended", false, ["ioda", "ripe-atlas"]),
				],
			},
		},
		NOW,
		"es",
	);
	expect(clauses.map((c) => c.text)).toEqual([
		"Posible apagón en Lara (IODA y prensa, última señal hace 1 h)",
		"Caída de señal en Zulia",
	]);
	expect(clauses[0]).toMatchObject({ href: "#incidentes", tone: "alert" });
});

test("before health loads, a feed is unknown, not live: no all-clear and no Yadio gap, anomalies still said (review 4 L7)", () => {
	const calm = {
		connectivity: { states: [state("VE-A", "Distrito Capital", "normal")], summary: { allClear: true } },
		money,
	};
	expect(currentClauses(calm, NONE, NOW, "es")).toEqual([]);
	const drop = {
		connectivity: { states: [state("VE-K", "Lara", "drop")], summary: { allClear: false } },
	};
	expect(currentClauses(drop, NONE, NOW, "es").map((c) => c.text)).toEqual(["Caída de señal en Lara"]);
	// Once BCV's health is known, its clause is said, without the gap of a Yadio whose health is still unknown.
	const partial = currentClauses({ money }, health([["bcv-official", "ok"]]), NOW, "es");
	expect(partial.map((c) => c.text)).toEqual(["Dólar BCV 853,50 Bs"]);
});

const HOUR = 3_600_000;
const zulia = (over: Partial<{ families: string[]; lastEvidenceAt: number; status: string }> = {}) => ({
	title: { es: "Posible apagón en Zulia", en: "Possible blackout in Zulia" },
	status: "active",
	reportsOnly: false,
	families: ["ioda", "prensa"],
	lastEvidenceAt: NOW - 20 * 60_000,
	stateName: "Zulia",
	...over,
});
const calmStates = [state("VE-V", "Zulia", "normal"), state("VE-A", "Distrito Capital", "normal")];

test("review 4 H4: no 'Internet sin caídas' while a corroborated incident is active", () => {
	const both = headline(
		{
			connectivity: { states: calmStates, summary: { allClear: true } },
			incidents: { incidents: [zulia()] },
			money,
		},
		NOW,
		"es",
	).map((c) => c.text);
	expect(both).toEqual([
		"Posible apagón en Zulia (IODA y prensa, última señal hace 20 min)",
		"Dólar BCV 853,50 Bs, Yadio +12,2 %",
	]);
	expect(both.join(" · ")).not.toContain("sin caídas");
	// A press-only incident does not lead and does not block the all-clear (IODA measures every state).
	const pressOnly = headline(
		{
			connectivity: { states: calmStates, summary: { allClear: true } },
			incidents: { incidents: [{ ...zulia({ families: ["prensa"] }), reportsOnly: true }] },
		},
		NOW,
		"es",
	);
	expect(pressOnly.map((c) => c.text)).toEqual(["Internet sin caídas por estado"]);
});

test("review 4 H4: press is named, never counted as an independent measurement", () => {
	const text = (families: string[], l: "es" | "en" = "es") =>
		headline({ incidents: { incidents: [zulia({ families })] } }, NOW, l)[0]?.text;
	expect(text(["ioda", "prensa"])).toBe("Posible apagón en Zulia (IODA y prensa, última señal hace 20 min)");
	expect(text(["prensa", "ioda", "ioda"], "en")).toBe(
		"Possible blackout in Zulia (IODA and press, last signal 20 min ago)",
	);
	expect(text(["ioda", "ripe-atlas"])).toBe(
		"Posible apagón en Zulia (2 mediciones independientes: IODA y RIPE Atlas, última señal hace 20 min)",
	);
	expect(text(["viirs", "ioda", "prensa"])).toBe(
		"Posible apagón en Zulia (IODA, luces nocturnas de NASA y prensa, última señal hace 20 min)",
	);
	for (const t of [text(["ioda", "prensa"]), text(["ioda", "prensa"], "en")])
		expect(t).not.toMatch(/fuentes independientes|independent sources/);
});

test("review 4 H4: a quiet incident says since when; past the active window it is not said", () => {
	const at = (lastEvidenceAt: number, activeMs?: number) =>
		headline(
			{ incidents: { incidents: [zulia({ lastEvidenceAt })], ...(activeMs ? { activeMs } : {}) } },
			NOW,
			"es",
		).map((c) => c.text);
	// NOW is 20:00 in Caracas; 2 h 10 min before is 17:50.
	expect(at(NOW - 130 * 60_000)).toEqual([
		"Posible apagón en Zulia (IODA y prensa, sin señal nueva desde las 17:50, hace 2 h)",
	]);
	expect(at(NOW - 59 * 60_000)[0]).toContain("última señal hace 59 min");
	// The incidents panel can itself be late: an incident past its active window has ended, whatever it says.
	expect(at(NOW - 3 * HOUR)).toEqual([]);
	expect(at(NOW - 90 * 60_000, HOUR)).toEqual([]);
});

test("review 4 H4: the incident clause ages with its measured feeds, like every other clause", () => {
	const input = { incidents: { incidents: [zulia({ families: ["ioda", "ripe-atlas", "prensa"] })] } };
	const [live] = currentClauses(input, health([["ioda-states", "ok"]]), NOW, "es");
	expect(live).toMatchObject({ stale: false, feeds: ["ioda-states", "ioda-events", "ripe-atlas-probes"] });
	const [late] = currentClauses(
		input,
		health([
			["ioda-states", "stale", NOW - 5 * HOUR],
			["ioda-events", "stale", NOW - 5 * HOUR],
			["ripe-atlas-probes", "failing", NOW - 4 * HOUR],
		]),
		NOW,
		"es",
	);
	if (!late) throw new Error("an anomaly stays, marked stale");
	expect(late.stale).toBe(true);
	expect(clauseText(late, NOW, "es")).toBe(
		"Posible apagón en Zulia (IODA, RIPE Atlas y prensa, última señal hace 20 min) (dato de hace 4 h)",
	);
});
