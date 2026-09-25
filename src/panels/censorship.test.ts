import { expect, test } from "bun:test";
import { join } from "node:path";
import type { OoniValue } from "../adapters/ooni-ve/index.ts";
import { ooniVe } from "../adapters/ooni-ve/index.ts";
import { type VsfCell, type VsfSite, vesinfiltroBlocks } from "../adapters/vesinfiltro-blocks/index.ts";
import { loadFixture } from "../core/fixtures.ts";
import { Store } from "../core/store.ts";
import type { Observation } from "../core/types.ts";
import { censorshipView } from "./censorship.ts";

const NOW = Date.UTC(2026, 8, 25, 12);
const RUN = NOW - 3_600_000;

function ooni(series: string, value: OoniValue, fetchedAt = RUN): Observation<OoniValue> {
	return {
		source: "ooni-ve",
		series,
		sourceUrl: "https://explorer.ooni.org/country/VE",
		fetchedAt,
		observedAt: fetchedAt,
		licence: "cc-by-nc-sa-4.0-ooni",
		value,
		confidence: 0.9,
		basis: "measurement",
	};
}
const W = { since: "2026-09-18", until: "2026-09-26" };
const dom = (domain: string, category: string, flaggedOn: string[], fetchedAt = RUN) =>
	ooni(
		`domain:${domain}`,
		{
			kind: "domain",
			domain,
			category,
			measurements: 100,
			anomalies: 80,
			confirmed: 0,
			anomalyRate: 0.8,
			isps: ["cantv", "inter", "airtek"].map((isp) => ({
				isp,
				measurements: 30,
				anomalies: flaggedOn.includes(isp) ? 27 : 1,
				anomalyRate: flaggedOn.includes(isp) ? 0.9 : 0.033,
				flagged: flaggedOn.includes(isp),
			})),
			...W,
		},
		fetchedAt,
	);

function vsf(
	domain: string,
	category: string,
	cells: Record<string, string>,
	active = true,
	updated = "2026-09-21",
) {
	const isps: VsfCell[] = Object.entries(cells).map(([isp, v]) =>
		v === "ok" || v === "no-data"
			? { isp, status: v, methods: [] }
			: { isp, status: "blocked", methods: v.split("+") as VsfCell["methods"] },
	);
	const value: VsfSite = {
		site: domain.toUpperCase(),
		domain,
		key: domain.replace(/^www\./, ""),
		active,
		category,
		isps,
		updated,
	};
	return {
		source: "vesinfiltro-blocks",
		series: `site:${domain}`,
		sourceUrl: "https://bloqueos.vesinfiltro.org/",
		fetchedAt: RUN,
		observedAt: Date.parse(`${updated}T04:00:00Z`),
		licence: "cc-by-nc-sa-4.0-vesinfiltro",
		value,
		confidence: 1,
		basis: "report" as const,
	};
}

test("two sources side by side: agreement, per category, per ISP, never summed", () => {
	const store = new Store(":memory:");
	store.insert([
		// An older OONI run flagged old.org; the newest run does not: it must not show.
		dom("old.org", "NEWS", ["cantv"], RUN - 3 * 3_600_000),
		dom("a.org", "NEWS", ["cantv", "inter"]),
		dom("b.org", "ANON", ["cantv"]),
		ooni("isp:cantv", {
			kind: "isp",
			isp: "cantv",
			measurements: 1_000,
			anomalies: 250,
			anomalyRate: 0.25,
			domainsTested: 300,
			domainsFlagged: 2,
			...W,
		}),
		{
			...ooni("country:VE:summary", {
				kind: "summary",
				measurements: 5_000,
				anomalies: 900,
				confirmed: 0,
				domainsTested: 400,
				domainsFlagged: 2,
				newestMeasurementAt: RUN - 60_000,
				runAt: RUN,
				...W,
			}),
			observedAt: RUN - 60_000,
		},
		vsf("a.org", "NEWS", { cantv: "DNS", inter: "DNS+HTTP/HTTPS", airtek: "ok" }),
		// "www.c.org" and "c.org" are one site with the union of their blocks.
		vsf("www.c.org", "POLR", { cantv: "TCP IP", inter: "ok", airtek: "no-data" }),
		vsf("c.org", "POLR", { cantv: "ok", inter: "DNS", airtek: "no-data" }),
		vsf("gone.org", "NEWS", { cantv: "DNS" }, false),
		// An older list version of a site that the newest update dropped.
		vsf("dropped.org", "NEWS", { cantv: "DNS" }, true, "2026-09-01"),
	]);
	const v = censorshipView(store, NOW);
	expect(v.ooni).toMatchObject({
		domainsFlagged: 2,
		measurements: 5_000,
		observedAt: RUN - 60_000,
		fetchedAt: RUN,
	});
	expect(v.vsf).toMatchObject({ updated: "2026-09-21", sitesListed: 4, sitesActive: 3, sitesBlocked: 2 });
	expect(v.agreement).toEqual({ both: 1, vsfOnly: 1, ooniOnly: 1 });
	expect(v.sites.map((s) => [s.key, s.agreement])).toEqual([
		["a.org", "both"],
		["c.org", "vsf-only"],
		["b.org", "ooni-only"],
	]);
	const a = v.sites[0];
	expect(a?.name).toBe("A.ORG");
	expect(a?.vsf).toEqual({ blockedOn: ["cantv", "inter"], methods: ["DNS", "HTTP/HTTPS"], active: true });
	expect(a?.ooni).toMatchObject({ flaggedOn: ["cantv", "inter"], anomalyRatePct: 80, measurements: 100 });
	expect(v.sites[1]?.vsf).toEqual({
		blockedOn: ["cantv", "inter"],
		methods: ["DNS", "TCP IP"],
		active: true,
	});
	expect(v.byCategory).toEqual([
		{ code: "NEWS", label: "Noticias", ooni: 1, vsf: 1 },
		{ code: "ANON", label: "Anonimato y evasión de censura", ooni: 1, vsf: 0 },
		{ code: "POLR", label: "Crítica política", ooni: 0, vsf: 1 },
	]);
	const cantv = v.byIsp.find((i) => i.isp === "cantv");
	expect(cantv?.ooni).toEqual({ flagged: 2, tested: 300, measurements: 1_000, anomalyRatePct: 25 });
	expect(cantv?.vsf).toEqual({
		blocked: 2,
		methods: [
			{ method: "DNS", count: 1 },
			{ method: "TCP IP", count: 1 },
		],
		noData: 0,
	});
	expect(v.byIsp.find((i) => i.isp === "airtek")?.vsf).toEqual({ blocked: 0, methods: [], noData: 1 });
	expect(v.byIsp.find((i) => i.isp === "movilnet")).toEqual({
		isp: "movilnet",
		name: "Movilnet",
		ooni: null,
		vsf: null,
	});
});

test("a thin or empty newest OONI run does not empty the panel: the last complete run stays, with its age", () => {
	const store = new Store(":memory:");
	const summary = (fetchedAt: number, measurements: number, flagged: number) =>
		ooni(
			"country:VE:summary",
			{
				kind: "summary",
				measurements,
				anomalies: 0,
				confirmed: 0,
				domainsTested: 400,
				domainsFlagged: flagged,
				newestMeasurementAt: null,
				runAt: fetchedAt,
				...W,
			},
			fetchedAt,
		);
	const H3 = 3 * 3_600_000;
	store.insert([
		summary(RUN - 2 * H3, 400_000, 2),
		dom("a.org", "NEWS", ["cantv"], RUN - 2 * H3),
		dom("b.org", "NEWS", ["inter"], RUN - 2 * H3),
		summary(RUN - H3, 0, 0),
		summary(RUN, 90_000, 1),
		dom("a.org", "NEWS", ["cantv"], RUN),
	]);
	const v = censorshipView(store, NOW);
	expect(v.ooni).toMatchObject({ fetchedAt: RUN - 2 * H3, domainsFlagged: 2, measurements: 400_000 });
	expect(v.sites.map((s) => s.key).sort()).toEqual(["a.org", "b.org"]);
});

test("empty store: both sources null, nothing invented", () => {
	const v = censorshipView(new Store(":memory:"), NOW);
	expect(v.ooni).toBeNull();
	expect(v.vsf).toBeNull();
	expect(v.sites).toEqual([]);
	expect(v.agreement).toEqual({ both: 0, vsfOnly: 0, ooniOnly: 0 });
});

test("censorship panel over the recorded OONI and VE sin Filtro captures", () => {
	const store = new Store(":memory:");
	store.insert(
		ooniVe.normalise(
			loadFixture(join(import.meta.dir, "..", "adapters", "ooni-ve", "fixtures", "2026-09-24")),
		),
	);
	store.insert(
		vesinfiltroBlocks.normalise(
			loadFixture(join(import.meta.dir, "..", "adapters", "vesinfiltro-blocks", "fixtures", "2026-09-24")),
		),
	);
	const v = censorshipView(store, Date.UTC(2026, 8, 25));
	expect(v.vsf?.sitesBlocked).toBe(139);
	expect(v.ooni?.domainsFlagged).toBe(235);
	expect(v.agreement.both + v.agreement.vsfOnly).toBe(139);
	expect(v.agreement.both + v.agreement.ooniOnly).toBe(235);
	expect(v.agreement.both).toBe(124);
	expect(v.byIsp.find((i) => i.isp === "cantv")?.vsf?.blocked).toBe(100);
	expect(JSON.stringify(v).length).toBeLessThan(120_000);
});
