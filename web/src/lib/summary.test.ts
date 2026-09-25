import { expect, test } from "bun:test";
import type { HealthLite } from "./fresh.ts";

// These modules read the browser at import (the route, stored prefs): a minimal stand-in, then import them.
// Another test file in the same run may have set its own `location`: it is put back after the imports.
const g = globalThis as Record<string, unknown>;
const had = Object.hasOwn(g, "location");
const before = g.location;
g.location = { pathname: "/", search: "", hash: "", origin: "http://localhost" };
const { health, now, panels } = await import("./data.ts");
const { PANEL_META } = await import("./panel-meta.ts");
const { SUMMARY_FEEDS, summarize, summaryFeeds } = await import("./summary.ts");
if (had) g.location = before;
else delete g.location;

test("review 4 M2: every panel in panel-meta has a summary freshness entry", () => {
	expect(Object.keys(SUMMARY_FEEDS).sort()).toEqual(Object.keys(PANEL_META).sort());
	// Each gate names feeds its panel's badge also reads (the summary never ages on a feed the panel ignores).
	for (const id of Object.keys(PANEL_META) as (keyof typeof PANEL_META)[]) {
		const badge = new Set(PANEL_META[id].feeds());
		for (const f of summaryFeeds(id))
			expect({ id, f, inBadge: badge.has(f) }).toEqual({ id, f, inBadge: true });
	}
});

test("review 4 M2: 'no incident' on stale inputs becomes 'Sin datos recientes (último …)'", () => {
	const NOW = Date.UTC(2026, 8, 25, 7);
	now.value = NOW;
	panels.value = {
		incidents: {
			incidents: [],
			watches: [],
			feeds: ["ioda-states", "ripe-atlas-probes"],
		},
	};
	const h = (id: string, state: HealthLite["state"], at: number) =>
		({ id, state, lastSuccessAt: at }) as (typeof health.value)[number];
	health.value = [h("ioda-states", "ok", NOW - 60_000), h("ripe-atlas-probes", "ok", NOW - 60_000)];
	expect(summarize("incidentes")?.text).toBe("Ninguna coincidencia de fuentes ahora");
	health.value = [
		h("ioda-states", "stale", NOW - 5 * 3_600_000),
		h("ripe-atlas-probes", "failing", NOW - 9 * 3_600_000),
	];
	expect(summarize("incidentes")?.text).toBe("Sin datos recientes (último hace 5 h)");
});
