import { expect, test } from "bun:test";
import { join } from "node:path";
import { hasFixture, loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import gadmJson from "./gadm.json" with { type: "json" };
import {
	ADM_DATASET,
	type AlertsWeek,
	admSql,
	downloadUrl,
	firstWeek,
	gfwAlerts,
	PA_MAX,
	versionAt,
	versionUrl,
	WDPA_DATASET,
	wdpaSql,
} from "./index.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "2026-09-29");
const recorded = hasFixture(FIXTURE);
const weeks = (obs: ReturnType<typeof gfwAlerts.normalise>) =>
	obs.filter((o) => o.value.kind === "week").map((o) => o.value as AlertsWeek);

test.skipIf(!recorded)(
	"recorded v20260929: seven weekly sums by state, municipality and protected area",
	() => {
		const obs = gfwAlerts.normalise(loadFixture(FIXTURE));
		expect(obs.map((o) => o.series)).toEqual([
			"week:2026-08-10",
			"week:2026-08-17",
			"week:2026-08-24",
			"week:2026-08-31",
			"week:2026-09-07",
			"week:2026-09-14",
			"week:2026-09-21",
			"version",
		]);
		const w = weeks(obs).find((x) => x.week === "2026-09-14");
		expect(w?.version).toBe("v20260929");
		expect(w?.ended).toBe(true);
		expect(w?.venezuela).toEqual({
			forestHa: [571.3, 895.6, 7.9],
			otherHa: [9.4, 4455.9, 0.2],
			forestAlerts: 120807,
		});
		expect(w?.protectedAreas["313"]).toMatchObject({
			name: "Canaima",
			iucn: "II",
			forestHa: [30.8, 66.7, 0.2],
		});
		expect(w?.protectedAreasWithAlerts).toBe(138);
		expect(Object.keys(w?.protectedAreas ?? {}).length).toBe(PA_MAX);
		expect(w?.municipalities["6.1"]).toMatchObject({
			gadmName: "Angostura",
			state: "VE-F",
			municipality: "VE0707",
		});
		// The states add up to the country (rounding aside).
		const sum = Object.values(w?.states ?? {}).reduce((s, x) => s + x.forestHa[1], 0);
		expect(Math.abs(sum - (w?.venezuela.forestHa[1] ?? 0))).toBeLessThan(0.1 * 25);
		for (const o of obs) {
			expect(o.source).toBe("gfw-alerts");
			expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		}
	},
);

const now = Date.UTC(2026, 8, 29, 6);
const raw = (url: string, body: unknown): RawResponse => ({
	url,
	status: 200,
	contentType: "application/json",
	body: typeof body === "string" ? body : JSON.stringify(body),
	fetchedAt: now,
});
const version = raw(`https://data-api.globalforestwatch.org/dataset/${ADM_DATASET}/v20260929`, {
	data: { dataset: ADM_DATASET, version: "v20260929" },
	status: "success",
});
const adm = (rows: unknown[]) => raw(downloadUrl(ADM_DATASET, "v20260929", admSql("2026-08-10")), rows);
const wdpa = (rows: unknown[]) => raw(downloadUrl(WDPA_DATASET, "latest", wdpaSql("2026-08-10")), rows);
const W = "2026-09-21T00:00:00+00:00";

test("synthetic: splits by forest and confidence, maps GADM ids", () => {
	const obs = gfwAlerts.normalise([
		version,
		adm([
			{ adm1: 6, adm2: 1, w: W, c: "high", nf: 1, n: 100, ha: "1.2345" },
			{ adm1: 6, adm2: 1, w: W, c: "highest", nf: 1, n: 10, ha: 0.12 },
			{ adm1: 6, adm2: 1, w: W, c: "high", nf: 0, n: 50, ha: "0.61" },
			{ adm1: 12, adm2: 3, w: W, c: "nominal", nf: 0, n: 5, ha: "0.06" },
		]),
		wdpa([
			{ id: "313", name: "Canaima", cat: "II", w: W, c: "high", nf: 1, n: 90, ha: "1.1" },
			{ id: "999", name: "Tiny", cat: null, w: W, c: "high", nf: 1, n: 1, ha: "0.01" },
		]),
	]);
	const [w] = weeks(obs);
	expect(w?.week).toBe("2026-09-21");
	expect(w?.ended).toBe(true);
	expect(w?.venezuela).toEqual({ forestHa: [0, 1.2, 0.1], otherHa: [0.1, 0.6, 0], forestAlerts: 110 });
	expect(w?.states["VE-F"]).toEqual({ forestHa: [0, 1.2, 0.1], otherHa: [0, 0.6, 0], forestAlerts: 110 });
	expect(w?.states["VE-I"]?.otherHa).toEqual([0.1, 0, 0]);
	expect(w?.municipalities["6.1"]?.municipality).toBe(
		(gadmJson as { municipalities: Record<string, { municipality: string | null }> }).municipalities["6.1"]
			?.municipality ?? "missing",
	);
	// Protected areas under 1 ha of forest alerts are counted but not listed.
	expect(Object.keys(w?.protectedAreas ?? {})).toEqual(["313"]);
	expect(w?.protectedAreasWithAlerts).toBe(2);
	expect(obs.at(-1)?.value).toEqual({ kind: "version", version: "v20260929" });
	expect(obs.at(-1)?.observedAt).toBe(versionAt("v20260929"));
});

test("synthetic: only the version (already read) stores nothing; broken answers fail the run", () => {
	expect(gfwAlerts.normalise([version])).toEqual([]);
	expect(() => gfwAlerts.normalise([])).toThrow("versión");
	expect(() => gfwAlerts.normalise([{ ...version, body: "{}" }])).toThrow("versión");
	expect(() => gfwAlerts.normalise([version, adm([]), { ...wdpa([]), body: "<html>" }])).toThrow(
		"no es JSON",
	);
	expect(() => gfwAlerts.normalise([version, adm([{ adm1: "x" }]), wdpa([])])).toThrow("municipios");
	expect(() => gfwAlerts.normalise([version, adm({ detail: 1 } as never), wdpa([])])).toThrow("lista");
	// A week still running (it ends after the version's date) is marked so.
	const [w] = weeks(
		gfwAlerts.normalise([
			version,
			adm([{ adm1: 1, adm2: 1, w: "2026-09-28T00:00:00+00:00", c: "nominal", nf: 1, n: 1, ha: 0.01 }]),
			wdpa([]),
		]),
	);
	expect(w?.ended).toBe(false);
});

test("queries: the last eight weeks from a Monday, aggregate rows only", () => {
	expect(firstWeek(now)).toBe("2026-08-10");
	expect(firstWeek(Date.UTC(2026, 8, 28))).toBe("2026-08-10");
	expect(firstWeek(Date.UTC(2026, 8, 27, 23))).toBe("2026-08-03");
	expect(admSql("2026-08-10")).toContain("iso = 'VEN'");
	expect(admSql("2026-08-10")).toContain("GROUP BY");
	expect(versionUrl(ADM_DATASET)).toEndWith("/latest");
	expect(new URL(downloadUrl(ADM_DATASET, "v1", "SELECT 1")).searchParams.get("sql")).toBe("SELECT 1");
});

test("the GADM table: 25 states, 338 municipalities, links only at ≥ 80 %", () => {
	const g = gadmJson as {
		states: Record<string, { state: string; share: number }>;
		municipalities: Record<string, { municipality: string | null; share: number }>;
	};
	expect(Object.keys(g.states).length).toBe(25);
	expect(new Set(Object.values(g.states).map((s) => s.state)).size).toBe(25);
	expect(g.states["6"]?.state).toBe("VE-F");
	expect(g.states["25"]?.state).toBe("VE-V");
	expect(Object.keys(g.municipalities).length).toBe(338);
	for (const m of Object.values(g.municipalities))
		if (m.municipality) expect(m.share).toBeGreaterThanOrEqual(0.8);
	expect(Object.values(g.municipalities).filter((m) => m.municipality).length).toBe(142);
	// Never two GADM units under one official name; a small unit inside a neighbour keeps its own name.
	const linked = Object.values(g.municipalities).flatMap((m) => (m.municipality ? [m.municipality] : []));
	expect(new Set(linked).size).toBe(linked.length);
	expect(g.municipalities["6.4"]?.municipality).toBeNull(); // El Callao (inside Sifontes)
	expect(g.municipalities["6.10"]?.municipality).toBe("VE0709"); // Sifontes
});

test("synthetic: a stray bad row is skipped; more than 1 % of bad or unknown rows fails the run", () => {
	const good = Array.from({ length: 200 }, () => ({
		adm1: 6,
		adm2: 1,
		w: W,
		c: "high",
		nf: 1,
		n: 1,
		ha: "0.1",
	}));
	const stray = { adm1: 39, adm2: 99, w: W, c: "high", nf: 1, n: 1, ha: "9" };
	const ok = weeks(gfwAlerts.normalise([version, adm([...good, stray]), wdpa([])]));
	expect(ok[0]?.venezuela.forestHa[1]).toBe(20);
	const bad = Array.from({ length: 5 }, () => ({
		adm1: 6,
		adm2: 1,
		w: W,
		c: "medium",
		nf: 1,
		n: 1,
		ha: "9",
	}));
	expect(() => gfwAlerts.normalise([version, adm([...good, ...bad]), wdpa([])])).toThrow("no válidas");
});

test("synthetic: the protected-area table's own version is kept with each week", () => {
	const wdpaV = raw(downloadUrl(WDPA_DATASET, "v20260928", wdpaSql("2026-08-10")), []);
	const [w] = weeks(
		gfwAlerts.normalise([
			version,
			raw(`https://data-api.globalforestwatch.org/dataset/${WDPA_DATASET}/v20260928`, {
				data: { dataset: WDPA_DATASET, version: "v20260928" },
			}),
			adm([{ adm1: 6, adm2: 1, w: W, c: "high", nf: 1, n: 1, ha: "0.1" }]),
			wdpaV,
		]),
	);
	expect(w?.version).toBe("v20260929");
	expect(w?.wdpaVersion).toBe("v20260928");
});
